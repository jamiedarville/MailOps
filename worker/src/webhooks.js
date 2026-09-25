// Delivery feedback from the email provider: marks contacts as bounced or complained, and counts
// deliveries for campaign reports.
//
//   POST /webhooks/resend  Resend webhooks, signed the Svix way with RESEND_WEBHOOK_SECRET.
//   POST /webhooks/ses     Amazon SNS messages carrying SES events, signed by AWS. Only topics
//                          listed in SES_SNS_TOPIC_ARN are accepted.
import { GitHub } from "./github.js";
import { updateContacts } from "./contacts.js";
import { ID_PATTERN } from "./campaigns.js";
import { recordEvent } from "./public.js";
import { safeEqual } from "./tokens.js";

const TOLERANCE_SECONDS = 5 * 60;

export async function handleResendWebhook(request, env, config) {
  if (!env.RESEND_WEBHOOK_SECRET) return new Response("Webhooks are not set up", { status: 404 });
  const body = await request.text();
  if (!(await verifySvixSignature(request.headers, body, env.RESEND_WEBHOOK_SECRET))) return new Response("Invalid signature", { status: 401 });

  const event = JSON.parse(body);
  const data = event.data ?? {};
  const kind = {
    "email.delivered": "delivered",
    "email.complained": "complaint",
    // Temporary bounces (a full mailbox, say) don't remove anyone.
    "email.bounced": data.bounce?.type === "Permanent" ? "bounce" : null,
  }[event.type];
  const tags = data.tags ?? {};
  await applyFeedback(env, config, { kind, emails: [].concat(data.to ?? []), campaign: tags.campaign, rid: tags.rid });
  return new Response("OK");
}

export async function handleSesWebhook(request, env, config) {
  const allowedTopics = config.SES_SNS_TOPIC_ARN.split(",").map((arn) => arn.trim()).filter(Boolean);
  if (!allowedTopics.length) return new Response("SES feedback is not set up", { status: 404 });
  let message;
  try {
    message = JSON.parse(await request.text());
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  // Anyone can make an SNS topic, so the topic must be ours as well as the signature being valid.
  if (!allowedTopics.includes(message.TopicArn)) return new Response("Unknown topic", { status: 403 });
  if (!(await verifySnsSignature(message))) return new Response("Invalid signature", { status: 401 });

  if (message.Type === "SubscriptionConfirmation") {
    const subscribe = new URL(message.SubscribeURL);
    if (subscribe.protocol !== "https:" || !SNS_HOST.test(subscribe.hostname)) return new Response("Bad subscribe URL", { status: 400 });
    const res = await fetch(subscribe.href);
    if (!res.ok) throw new Error(`Confirming the SNS subscription failed (HTTP ${res.status}).`);
    console.log(`Confirmed SNS subscription to ${message.TopicArn}`);
    return new Response("Subscribed");
  }
  if (message.Type !== "Notification") return new Response("OK");

  let event;
  try {
    event = JSON.parse(message.Message);
  } catch {
    return new Response("Ignored"); // e.g. SES's "Successfully validated SNS topic" test message
  }
  // Configuration-set event publishing uses eventType; identity notifications use notificationType.
  const type = event.eventType ?? event.notificationType;
  const kind = { Delivery: "delivered", Complaint: "complaint", Bounce: event.bounce?.bounceType === "Permanent" ? "bounce" : null }[type];
  const recipients = {
    Delivery: event.delivery?.recipients,
    Complaint: event.complaint?.complainedRecipients?.map((r) => r.emailAddress),
    Bounce: event.bounce?.bouncedRecipients?.map((r) => r.emailAddress),
  }[type];
  const tags = event.mail?.tags ?? {};
  await applyFeedback(env, config, {
    kind,
    emails: (recipients ?? event.mail?.destination ?? []).map((address) => /<([^>]+)>/.exec(address)?.[1] ?? address),
    campaign: [].concat(tags.campaign ?? [])[0],
    rid: [].concat(tags.rid ?? [])[0],
  });
  return new Response("OK");
}

// Updates the contact list and the campaign's report for one delivery, bounce or complaint.
async function applyFeedback(env, config, { kind, emails, campaign, rid }) {
  if (!kind || !emails.length) return;
  if (kind !== "delivered") {
    const status = kind === "bounce" ? "bounced" : "complained";
    await updateContacts(new GitHub(env, config), config, `Mark contact as ${status}`, (list) => {
      let changed = false;
      for (const email of emails) {
        const contact = list.find(email);
        if (!contact || contact.Status === status) continue;
        contact.Status = status;
        contact.UpdatedAt = new Date().toISOString();
        changed = true;
      }
      return changed;
    });
  }
  if (ID_PATTERN.test(campaign ?? "") && /^\d+$/.test(rid ?? "")) {
    await recordEvent(env, campaign, { rid: Number(rid), kind });
  }
}

export async function verifySvixSignature(headers, body, secret) {
  const id = headers.get("svix-id");
  const timestamp = headers.get("svix-timestamp");
  const signatures = headers.get("svix-signature");
  if (!id || !timestamp || !signatures) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > TOLERANCE_SECONDS) return false;

  const keyBytes = Uint8Array.from(atob(secret.replace(/^whsec_/, "")), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${body}`));
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));
  return signatures.split(" ").some((entry) => {
    const [version, signature] = entry.split(",");
    return version === "v1" && typeof signature === "string" && safeEqual(signature, expected);
  });
}

// ---------------------------------------------------------------------------------------------
// SNS message signatures: https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message.html

const SNS_HOST = /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/;
const certificateKeys = new Map();

export async function verifySnsSignature(message) {
  const hash = { 1: "SHA-1", 2: "SHA-256" }[message.SignatureVersion];
  if (!hash || typeof message.Signature !== "string") return false;
  let certUrl;
  try {
    certUrl = new URL(message.SigningCertURL);
  } catch {
    return false;
  }
  // The certificate must come from SNS itself, over HTTPS.
  if (certUrl.protocol !== "https:" || !SNS_HOST.test(certUrl.hostname) || !certUrl.pathname.endsWith(".pem")) return false;

  const fields =
    message.Type === "Notification"
      ? ["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"]
      : ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"];
  const signed = fields
    .filter((field) => message[field] !== undefined && message[field] !== null)
    .map((field) => `${field}\n${message[field]}\n`)
    .join("");

  const cacheKey = `${hash} ${certUrl.href}`;
  if (!certificateKeys.has(cacheKey)) certificateKeys.set(cacheKey, loadCertificateKey(certUrl.href, hash));
  let key;
  try {
    key = await certificateKeys.get(cacheKey);
  } catch (err) {
    certificateKeys.delete(cacheKey);
    throw err;
  }
  const signature = Uint8Array.from(atob(message.Signature), (c) => c.charCodeAt(0));
  return crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, new TextEncoder().encode(signed));
}

async function loadCertificateKey(url, hash) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Couldn't fetch the SNS signing certificate (HTTP ${res.status}).`);
  const pem = await res.text();
  const der = Uint8Array.from(atob(pem.replace(/-----(BEGIN|END) CERTIFICATE-----|\s/g, "")), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("spki", publicKeyInfo(der), { name: "RSASSA-PKCS1-v1_5", hash }, false, ["verify"]);
}

// Pulls the SubjectPublicKeyInfo out of an X.509 certificate (DER):
// Certificate ::= SEQUENCE { tbsCertificate SEQUENCE { [0] version, serialNumber, signature,
//                            issuer, validity, subject, subjectPublicKeyInfo, … }, … }
export function publicKeyInfo(der) {
  const certificate = readTlv(der, 0);
  const tbs = readTlv(der, certificate.contentStart);
  let position = tbs.contentStart;
  if (der[position] === 0xa0) position = readTlv(der, position).end;
  for (let i = 0; i < 5; i++) position = readTlv(der, position).end;
  return der.slice(position, readTlv(der, position).end);
}

function readTlv(bytes, position) {
  let length = bytes[position + 1];
  let contentStart = position + 2;
  if (length & 0x80) {
    const count = length & 0x7f;
    length = 0;
    for (let i = 0; i < count; i++) length = length * 256 + bytes[position + 2 + i];
    contentStart += count;
  }
  if (contentStart + length > bytes.length) throw new Error("The SNS signing certificate couldn't be read.");
  return { tag: bytes[position], contentStart, end: contentStart + length };
}
