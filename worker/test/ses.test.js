import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createSign, generateKeyPairSync } from "node:crypto";
import { BASE, HEADER, admin, call, contactRow, restore, setup } from "./helpers.js";
import { ContactList } from "../src/contacts.js";
import { signRequest } from "../src/aws.js";
import { encodeAddress, encodeHeaderText, sendWithSes, toSesRequest } from "../src/mailer.js";
import { publicKeyInfo } from "../src/webhooks.js";

afterEach(restore);

const SES_ENV = {
  EMAIL_PROVIDER: "ses",
  AWS_ACCESS_KEY_ID: "AKIATEST",
  AWS_SECRET_ACCESS_KEY: "test-secret-key",
  AWS_REGION: "ca-central-1",
  SES_CONFIGURATION_SET: "mailops",
  SES_SNS_TOPIC_ARN: "arn:aws:sns:ca-central-1:123456789012:mailops-feedback",
  // Big waves keep the tests fast; pacing is tested separately.
  SES_MAX_SEND_RATE: "500",
};
const TOPIC = SES_ENV.SES_SNS_TOPIC_ARN;

function contacts(count) {
  let csv = HEADER;
  for (let i = 0; i < count; i++) csv += contactRow(`person${i}@example.com`, { first: i % 2 ? "Zoé" : "Sam" });
  return csv;
}

async function sendCampaign(world, subject = "Nouvelles de Montréal pour {{FirstName}}") {
  const adminFetch = await admin(world);
  const created = await adminFetch("/admin/campaigns/new", { method: "POST", form: { name: "Fall news" } });
  const id = new URL(created.headers.get("Location"), BASE).searchParams.get("id");
  const res = await adminFetch("/admin/campaigns/save", {
    method: "POST",
    form: { id, name: "Fall news", subject, format: "markdown", body: "Bonjour {{FirstName}}!\n\n[Read](https://example.com/read)", intent: "send-now" },
  });
  assert.equal(res.status, 303, await res.text());
  await world.runAlarms();
  return { id, adminFetch };
}

function decodeWords(text) {
  // Whitespace between two encoded words is ignored; anywhere else it's kept.
  return text.replace(/\?= (?==\?)/g, "?=").replace(/=\?UTF-8\?B\?([^?]*)\?=/g, (_, b64) => Buffer.from(b64, "base64").toString("utf8"));
}

test("SigV4 signatures match AWS's algorithm", async () => {
  // Reference value produced by the aws4fetch library for the same request.
  const headers = await signRequest({
    method: "POST",
    url: "https://email.ca-central-1.amazonaws.com/v2/email/outbound-emails",
    body: '{"hello":"Montréal"}',
    accessKeyId: "AKIDEXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
    region: "ca-central-1",
    service: "ses",
    date: new Date("2026-09-25T12:34:56Z"),
  });
  assert.equal(headers["x-amz-date"], "20260925T123456Z");
  assert.equal(
    headers.authorization,
    "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20260925/ca-central-1/ses/aws4_request, SignedHeaders=host;x-amz-date, Signature=7cd243cd0b106c129e762e6170cfba81f33d773e7bd4ff806107803bae33e3d8",
  );
});

test("subjects and sender names outside ASCII are encoded for SES", () => {
  assert.equal(encodeHeaderText("Plain subject"), "Plain subject");
  const encoded = encodeHeaderText("Nouvelles de Montréal 🍁 — ".repeat(4));
  assert.match(encoded, /^[\x20-\x7e]+$/);
  for (const word of encoded.split(" ")) assert.ok(word.length <= 75, word);
  assert.equal(decodeWords(encoded), "Nouvelles de Montréal 🍁 — ".repeat(4));

  assert.equal(encodeAddress("news@example.com"), "news@example.com");
  assert.equal(encodeAddress("Example News <news@example.com>"), "Example News <news@example.com>");
  assert.equal(encodeAddress("Smith, Jo <jo@example.com>"), '"Smith, Jo" <jo@example.com>');
  assert.equal(decodeWords(encodeAddress("Café Crème <cafe@example.com>")), "Café Crème <cafe@example.com>");
});

test("emails become SES SendEmail requests with headers, tags and the configuration set", () => {
  const request = toSesRequest(
    {
      from: "News <news@example.com>",
      to: ["ada@example.com"],
      reply_to: "hello@example.com",
      subject: "Hi",
      html: "<p>Hi</p>",
      text: "Hi",
      headers: { "List-Unsubscribe": "<https://u.example>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
      tags: [{ name: "campaign", value: "fall-abc123" }],
    },
    { SES_CONFIGURATION_SET: "mailops" },
  );
  assert.deepEqual(request, {
    FromEmailAddress: "News <news@example.com>",
    Destination: { ToAddresses: ["ada@example.com"] },
    ReplyToAddresses: ["hello@example.com"],
    Content: {
      Simple: {
        Subject: { Data: "Hi", Charset: "UTF-8" },
        Body: { Html: { Data: "<p>Hi</p>", Charset: "UTF-8" }, Text: { Data: "Hi", Charset: "UTF-8" } },
        Headers: [
          { Name: "List-Unsubscribe", Value: "<https://u.example>" },
          { Name: "List-Unsubscribe-Post", Value: "List-Unsubscribe=One-Click" },
        ],
      },
    },
    EmailTags: [{ Name: "campaign", Value: "fall-abc123" }],
    ConfigurationSetName: "mailops",
  });
});

test("a campaign is sent through SES, one signed request per recipient", async () => {
  const world = setup({ "contacts.csv": contacts(95) }, { env: SES_ENV });
  const { id } = await sendCampaign(world);

  assert.equal(world.sesRequests.length, 95);
  assert.equal(new Set(world.emails.map((e) => e.to[0])).size, 95);
  assert.ok(world.sesRequests.every((r) => r.region === "ca-central-1" && r.body.ConfigurationSetName === "mailops"));
  const zoe = world.emails.find((e) => e.to[0] === "person1@example.com");
  assert.equal(decodeWords(zoe.subject), "Nouvelles de Montréal pour Zoé");
  assert.match(zoe.subject, /^[\x20-\x7e]+$/);
  assert.match(zoe.html, /Bonjour Zoé!/);
  assert.match(zoe.headers["List-Unsubscribe"], /^<https:\/\/mailops\.example\/unsubscribe\?/);
  assert.equal(zoe.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
  assert.deepEqual(zoe.tags, [{ name: "campaign", value: id }, { name: "rid", value: "1" }]);
  assert.equal(world.batches.length, 0, "Resend isn't used");

  const campaign = world.campaigns().find((c) => c.id === id);
  assert.equal(campaign.status, "sent");
  assert.equal(campaign.sent, 95);
});

test("each run sends at most SES_EMAILS_PER_RUN emails", async () => {
  const world = setup({ "contacts.csv": contacts(95) }, { env: { ...SES_ENV, SES_EMAILS_PER_RUN: "40" } });
  const adminFetch = await admin(world);
  const created = await adminFetch("/admin/campaigns/new", { method: "POST", form: { name: "Runs" } });
  const id = new URL(created.headers.get("Location"), BASE).searchParams.get("id");
  await adminFetch("/admin/campaigns/save", { method: "POST", form: { id, name: "Runs", subject: "Hi", body: "Hi", intent: "send-now" } });

  const runner = world.runner(id);
  const counts = [];
  while (runner.storage.alarm !== null) {
    runner.storage.alarm = null;
    const before = world.sesRequests.length;
    await runner.alarm();
    counts.push(world.sesRequests.length - before);
  }
  assert.deepEqual(counts, [40, 40, 15]);
});

test("SES_MAX_SEND_RATE paces the emails within a run", async () => {
  const world = setup({ "contacts.csv": contacts(6) }, { env: { ...SES_ENV, SES_MAX_SEND_RATE: "3" } });
  const started = Date.now();
  await sendCampaign(world, "Hi");
  assert.equal(world.sesRequests.length, 6);
  assert.ok(Date.now() - started >= 1000, "two waves of 3 take at least a second");
});

test("after a failure part way, sending resumes without emailing anyone twice", async (t) => {
  t.mock.method(console, "error", () => {});
  const world = setup({ "contacts.csv": contacts(120) }, { env: { ...SES_ENV, SES_MAX_SEND_RATE: "10" } });
  let failed = 0;
  world.sesFailure = (n) => {
    if (n === 57 || n === 58) {
      failed++;
      return Response.json({ message: "Maximum sending rate exceeded." }, { status: 429, headers: { "x-amzn-ErrorType": "TooManyRequestsException:" } });
    }
  };
  const { id } = await sendCampaign(world, "Hi");
  assert.equal(failed, 2);
  const delivered = world.emails.map((e) => e.to[0]);
  assert.equal(delivered.length, 120, "every recipient got exactly one email");
  assert.equal(new Set(delivered).size, 120);
  assert.equal(world.campaigns().find((c) => c.id === id).sent, 120);
});

test("SES errors explain the likely fix", async () => {
  const world = setup({}, { env: SES_ENV });
  world.sesFailure = () =>
    Response.json({ message: "Email address is not verified. The following identities failed the check in region CA-CENTRAL-1: ada@example.com" }, { status: 400, headers: { "x-amzn-ErrorType": "MessageRejected:" } });
  const email = { from: "news@example.com", to: ["ada@example.com"], subject: "Hi", text: "Hi" };
  await assert.rejects(sendWithSes(world.env, { AWS_REGION: "ca-central-1", SES_CONFIGURATION_SET: "" }, email), /SES HTTP 400 MessageRejected.*sandbox/);
});

test("double opt-in and test emails also go through SES", async () => {
  const world = setup({}, { env: { ...SES_ENV, DOUBLE_OPT_IN: "true" } });
  await call(world, "/", { method: "POST", form: { FirstName: "Ada", LastName: "Lovelace", Email: "ada@example.com" } });
  assert.equal(world.sesRequests.length, 1);
  assert.match(world.emails[0].text, /\/confirm\?/);
});

test("the admin pages ask for the AWS keys when SES is chosen", async () => {
  const world = setup({ "contacts.csv": contacts(2) }, { env: { ...SES_ENV, AWS_ACCESS_KEY_ID: "" } });
  const adminFetch = await admin(world);
  const html = await (await adminFetch("/admin")).text();
  assert.match(html, /AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY secrets/);
  assert.match(html, /Sending with <b>Amazon SES \(ca-central-1\)<\/b>/);
  assert.doesNotMatch(html, /RESEND_API_KEY/);
});

// ---------------------------------------------------------------------------------------------
// SNS feedback

// A stand-in for SNS: a key pair and a minimal certificate holding its public key.
// Each gets its own certificate address, because the Worker caches keys by address.
let certificates = 0;
function fakeSns(world) {
  const certUrl = `https://sns.ca-central-1.amazonaws.com/SimpleNotificationService-test${++certificates}.pem`;
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const tlv = (tag, content) => {
    const length = content.length < 128 ? Buffer.from([content.length]) : content.length < 256 ? Buffer.from([0x81, content.length]) : Buffer.from([0x82, content.length >> 8, content.length & 255]);
    return Buffer.concat([Buffer.from([tag]), length, content]);
  };
  const seq = (...parts) => tlv(0x30, Buffer.concat(parts));
  const spki = publicKey.export({ type: "spki", format: "der" });
  const tbs = seq(tlv(0xa0, tlv(0x02, Buffer.from([2]))), tlv(0x02, Buffer.from([1])), seq(), seq(), seq(), seq(), spki);
  const der = seq(tbs, seq(), tlv(0x03, Buffer.from([0])));
  world.snsCertPem = `-----BEGIN CERTIFICATE-----\n${der.toString("base64").replace(/.{64}/g, "$&\n")}\n-----END CERTIFICATE-----\n`;
  assert.deepEqual(Buffer.from(publicKeyInfo(new Uint8Array(der))), spki);

  return (fields, { version = "2", topic = TOPIC } = {}) => {
    const message = { MessageId: "m-1", TopicArn: topic, Timestamp: new Date().toISOString(), SignatureVersion: version, SigningCertURL: certUrl, ...fields };
    const order = message.Type === "Notification" ? ["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"] : ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"];
    const text = order.filter((f) => message[f] != null).map((f) => `${f}\n${message[f]}\n`).join("");
    message.Signature = createSign(version === "1" ? "RSA-SHA1" : "RSA-SHA256").update(text).sign(privateKey, "base64");
    return message;
  };
}

const post = (world, message) => call(world, "/webhooks/ses", { method: "POST", body: JSON.stringify(message), headers: { "Content-Type": "text/plain; charset=UTF-8" } });

test("SNS subscription confirmations are confirmed after checking the signature", async () => {
  const world = setup({}, { env: SES_ENV });
  const sign = fakeSns(world);
  const confirm = "https://sns.ca-central-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn=x&Token=abc";
  const res = await post(world, sign({ Type: "SubscriptionConfirmation", Message: "You have chosen to subscribe…", SubscribeURL: confirm, Token: "abc" }));
  assert.equal(res.status, 200);
  assert.ok(world.snsFetches.includes(confirm));
});

test("SNS messages from other topics, with bad signatures or foreign certificates are refused", async () => {
  const world = setup({ "contacts.csv": contacts(1) }, { env: SES_ENV });
  const sign = fakeSns(world);
  const bounce = { Type: "Notification", Message: JSON.stringify({ eventType: "Bounce", bounce: { bounceType: "Permanent", bouncedRecipients: [{ emailAddress: "person0@example.com" }] }, mail: {} }) };

  assert.equal((await post(world, sign(bounce, { topic: "arn:aws:sns:us-east-1:999999999999:someone-else" }))).status, 403);
  assert.equal((await post(world, { ...sign(bounce), Message: bounce.Message.replace("person0", "person1") })).status, 401);
  assert.equal((await post(world, { ...sign(bounce), SigningCertURL: "https://evil.example/cert.pem" })).status, 401);
  assert.equal(world.commits.length, 0);

  const closed = setup({}, { env: { ...SES_ENV, SES_SNS_TOPIC_ARN: "" } });
  assert.equal((await post(closed, sign(bounce))).status, 404);
});

test("SES bounces, complaints and deliveries update contacts and the campaign report", async () => {
  const world = setup({ "contacts.csv": contacts(4) }, { env: SES_ENV });
  const { id, adminFetch } = await sendCampaign(world, "Hi");
  const sign = fakeSns(world);
  const notify = (event, version) => post(world, sign({ Type: "Notification", Message: JSON.stringify(event) }, { version }));
  const mail = (rid) => ({ destination: [`person${rid}@example.com`], tags: { campaign: [id], rid: [String(rid)], "ses:configuration-set": ["mailops"] } });

  assert.equal((await notify({ eventType: "Delivery", mail: mail(0), delivery: { recipients: ["person0@example.com"] } })).status, 200);
  await notify({ eventType: "Delivery", mail: mail(1), delivery: { recipients: ["person1@example.com"] } }, "1");
  await notify({ eventType: "Bounce", mail: mail(2), bounce: { bounceType: "Transient", bouncedRecipients: [{ emailAddress: "person2@example.com" }] } });
  await notify({ eventType: "Bounce", mail: mail(2), bounce: { bounceType: "Permanent", bouncedRecipients: [{ emailAddress: "person2@example.com" }] } });
  await notify({ notificationType: "Complaint", mail: mail(3), complaint: { complainedRecipients: [{ emailAddress: "Person3@Example.com" }] } });

  const list = new ContactList(world.contacts());
  assert.equal(list.find("person0@example.com").Status, "subscribed");
  assert.equal(list.find("person2@example.com").Status, "bounced");
  assert.equal(list.find("person3@example.com").Status, "complained");

  const report = await (await adminFetch(`/admin/campaigns/view?id=${id}`)).text();
  assert.match(report, /<b>2<\/b><span>Delivered · 50%/);
  assert.match(report, /<b>1<\/b><span>Bounced/);
  assert.match(report, /<b>1<\/b><span>Marked as spam/);
});
