import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { BASE, HEADER, admin, call, contactRow, restore, setup } from "./helpers.js";
import { ContactList } from "../src/contacts.js";

afterEach(restore);

const CONTACTS =
  HEADER +
  contactRow("ada@example.com", { first: "Ada", tags: "Newsletter" }) +
  contactRow("bob@example.com", { first: "Bob", tags: "Events" }) +
  contactRow("cy@example.com", { first: "", tags: "Newsletter" }) +
  contactRow("gone@example.com", { first: "Gone", status: "unsubscribed", tags: "Newsletter" });

// Creates a campaign through the admin pages and returns its id.
async function createCampaign(adminFetch, world, fields = {}, intent = "save") {
  const res = await adminFetch("/admin/campaigns/new", { method: "POST", form: { name: "October news" } });
  assert.equal(res.status, 303);
  const id = new URL(res.headers.get("Location"), BASE).searchParams.get("id");
  const form = new URLSearchParams({ id, name: "October news", subject: "News for {{FirstName|you}}", preheader: "", format: "markdown", body: "Hi {{FirstName|there}}!\n\n[Read it](https://example.com/post)", intent, ...fields });
  if (fields.tags) {
    form.delete("tags");
    for (const tag of [].concat(fields.tags)) form.append("tags", tag);
  }
  const saved = await adminFetch("/admin/campaigns/save", { method: "POST", form });
  return { id, res: saved };
}

test("admin pages need a login", async () => {
  const world = setup({ "contacts.csv": CONTACTS });
  const res = await call(world, "/admin");
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("Location"), "/admin/login");

  const wrong = await call(world, "/admin/login", { method: "POST", form: { password: "nope" }, headers: { Origin: BASE } });
  assert.equal(wrong.status, 401);

  const adminFetch = await admin(world);
  const dashboard = await adminFetch("/admin");
  assert.equal(dashboard.status, 200);
  assert.match(await dashboard.text(), /<b>3<\/b><span>Subscribed/);
});

test("admin forms sent from another site are refused", async () => {
  const world = setup({ "contacts.csv": CONTACTS });
  const adminFetch = await admin(world);
  const res = await adminFetch("/admin/contacts/bulk", { method: "POST", form: { email: "ada@example.com", action: "delete" }, headers: { Origin: "https://evil.example" } });
  assert.equal(res.status, 403);
  assert.equal(world.commits.length, 0);
});

test("without ADMIN_PASSWORD the admin pages are closed", async () => {
  const world = setup({}, { env: { ADMIN_PASSWORD: "" } });
  assert.equal((await call(world, "/admin")).status, 503);
});

test("contacts can be searched, filtered, edited and exported", async () => {
  const world = setup({ "contacts.csv": CONTACTS });
  const adminFetch = await admin(world);

  const list = await (await adminFetch("/admin/contacts?tag=Newsletter&status=subscribed")).text();
  assert.match(list, /ada@example\.com/);
  assert.match(list, /cy@example\.com/);
  assert.doesNotMatch(list, /bob@example\.com|gone@example\.com/);

  const save = await adminFetch("/admin/contacts/save", {
    method: "POST",
    form: { original: "bob@example.com", Email: "bob@example.com", FirstName: "Robert", LastName: "", Phone: "", Status: "subscribed", Tags: "Events; VIP" },
  });
  assert.equal(save.status, 303);
  assert.equal(new ContactList(world.contacts()).find("bob@example.com").Tags, "Events; VIP");

  const duplicate = await adminFetch("/admin/contacts/save", { method: "POST", form: { original: "", Email: "ADA@example.com", Status: "subscribed" } });
  assert.match(await duplicate.text(), /already has that email address/);

  const exported = await adminFetch("/admin/contacts/export?tag=VIP");
  assert.match(exported.headers.get("Content-Disposition"), /attachment; filename="contacts-/);
  const csv = await exported.text();
  assert.match(csv, /bob@example\.com/);
  assert.doesNotMatch(csv, /ada@example\.com/);
});

test("bulk actions tag, unsubscribe and delete", async () => {
  const world = setup({ "contacts.csv": CONTACTS });
  const adminFetch = await admin(world);
  const bulk = (action, emails, tag = "") => {
    const form = new URLSearchParams({ action, tag });
    for (const email of emails) form.append("email", email);
    return adminFetch("/admin/contacts/bulk", { method: "POST", form });
  };
  await bulk("add-tag", ["ada@example.com", "bob@example.com"], "VIP");
  await bulk("unsubscribe", ["bob@example.com"]);
  await bulk("delete", ["cy@example.com"]);
  const list = new ContactList(world.contacts());
  assert.equal(list.find("ada@example.com").Tags, "Newsletter; VIP");
  assert.equal(list.find("bob@example.com").Status, "unsubscribed");
  assert.equal(list.find("cy@example.com"), undefined);
});

test("import maps common column names and never resubscribes anyone", async () => {
  const world = setup({ "contacts.csv": CONTACTS });
  const adminFetch = await admin(world);
  const csv = "Email Address,First Name,Last Name,TAGS\nnew@example.com,New,Person,Imported\ngone@example.com,Gone,Again,\nnot-an-email,,,\n";
  const form = new FormData();
  form.set("csv", csv);
  form.set("tags", "Spring 2026");
  form.set("consent", "yes");
  const res = await adminFetch("/admin/contacts/import", { method: "POST", form });
  const html = await res.text();
  assert.match(html, /Added 1, updated 1, unchanged 0, skipped 1 row/);
  const list = new ContactList(world.contacts());
  assert.equal(list.find("new@example.com").Status, "subscribed");
  assert.equal(list.find("new@example.com").Tags, "Imported; Spring 2026");
  assert.equal(list.find("gone@example.com").Status, "unsubscribed");
  assert.equal(list.find("gone@example.com").LastName, "Again");
});

test("a campaign is written, previewed, test-sent and sent to its audience", async () => {
  const world = setup({ "contacts.csv": CONTACTS });
  const adminFetch = await admin(world);
  const { id, res } = await createCampaign(adminFetch, world, { tags: "newsletter" });
  assert.equal(res.status, 303);

  const editor = await (await adminFetch(`/admin/campaigns/view?id=${id}`)).text();
  assert.match(editor, /<b>2<\/b> subscribed contacts match/);
  assert.match(editor, /srcdoc="[^"]*Hi Ada!/, "preview uses a sample contact");

  const test = await createCampaign(adminFetch, world, { testTo: "me@example.com" }, "test");
  assert.equal(test.res.status, 303);
  assert.equal(world.emails.at(-1).subject, "[Test] News for Ada");

  const send = await adminFetch("/admin/campaigns/save", {
    method: "POST",
    form: new URLSearchParams([["id", id], ["name", "October news"], ["subject", "News for {{FirstName|you}}"], ["format", "markdown"], ["body", "Hi {{FirstName|there}}!\n\n[Read it](https://example.com/post?who={{Email}})"], ["tags", "Newsletter"], ["intent", "send-now"]]),
  });
  assert.equal(send.status, 303);
  assert.equal(world.campaigns().find((c) => c.id === id).status, "scheduled");

  world.emails.length = 0;
  await world.runAlarms();

  assert.deepEqual(world.emails.map((e) => e.to[0]).sort(), ["ada@example.com", "cy@example.com"]);
  const ada = world.emails.find((e) => e.to[0] === "ada@example.com");
  const cy = world.emails.find((e) => e.to[0] === "cy@example.com");
  assert.equal(ada.subject, "News for Ada");
  assert.equal(cy.subject, "News for you");
  assert.equal(ada.from, "News <news@example.com>");
  assert.match(ada.headers["List-Unsubscribe"], /^<https:\/\/mailops\.example\/unsubscribe\?/);
  assert.equal(ada.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
  assert.deepEqual(ada.tags[0], { name: "campaign", value: id });
  assert.match(ada.html, /Hi Ada!/);
  assert.match(ada.text, /Hi Ada!/);
  assert.equal(world.batches[0].key, `${id}-batch-0`);

  const saved = world.campaigns().find((c) => c.id === id);
  assert.equal(saved.status, "sent");
  assert.equal(saved.sent, 2);
  assert.ok(saved.sentAt);

  // Tracking: the open pixel and the tracked link.
  const pixel = /<img src="https:\/\/mailops\.example(\/t\/o\/[^"]+)"/.exec(ada.html)[1];
  const open = await call(world, pixel);
  assert.equal(open.headers.get("Content-Type"), "image/gif");
  await Promise.all(world.pending);

  const link = /href="https:\/\/mailops\.example(\/t\/c\/[^"]+)"/.exec(ada.html)[1];
  const click = await call(world, link);
  assert.equal(click.status, 302);
  assert.equal(click.headers.get("Location"), "https://example.com/post?who=ada%40example.com");

  const forged = await call(world, link.replace(/\/[^/]+$/, "/forged"));
  assert.equal(forged.status, 404);

  // One-click unsubscribe from the header.
  const unsubscribe = ada.headers["List-Unsubscribe"].slice(1, -1).slice(BASE.length);
  await call(world, unsubscribe, { method: "POST", form: { "List-Unsubscribe": "One-Click" } });
  assert.equal(new ContactList(world.contacts()).find("ada@example.com").Status, "unsubscribed");

  const report = await (await adminFetch(`/admin/campaigns/view?id=${id}`)).text();
  assert.match(report, /<b>2<\/b><span>Sent/);
  assert.match(report, /<b>1<\/b><span>Opened · 50%/);
  assert.match(report, /<b>1<\/b><span>Clicked · 50%/);
  assert.match(report, /<b>1<\/b><span>Unsubscribed · 50%/);
  assert.match(report, /https:\/\/example\.com\/post\?who=\{\{Email\}\}<\/td><td class="num">1/);
});

test("large audiences are sent in batches of 100, each with its own idempotency key", async () => {
  let csv = HEADER;
  for (let i = 0; i < 250; i++) csv += contactRow(`person${i}@example.com`);
  const world = setup({ "contacts.csv": csv });
  const adminFetch = await admin(world);
  const { id } = await createCampaign(adminFetch, world, {}, "send-now");
  await world.runAlarms();
  assert.deepEqual(world.batches.map((b) => b.emails.length), [100, 100, 50]);
  assert.deepEqual(world.batches.map((b) => b.key), [`${id}-batch-0`, `${id}-batch-1`, `${id}-batch-2`]);
  assert.equal(new Set(world.emails.map((e) => e.to[0])).size, 250);
  assert.equal(world.campaigns().find((c) => c.id === id).sent, 250);
});

test("a scheduled campaign can be cancelled back to a draft", async () => {
  const world = setup({ "contacts.csv": CONTACTS });
  const adminFetch = await admin(world);
  const { id, res } = await createCampaign(adminFetch, world, { sendAt: "2099-01-01T09:00" }, "schedule");
  assert.equal(res.status, 303);
  const scheduled = world.campaigns().find((c) => c.id === id);
  assert.equal(scheduled.status, "scheduled");
  assert.equal(scheduled.sendAt, "2099-01-01T14:00:00.000Z");

  await adminFetch("/admin/campaigns/action", { method: "POST", form: { id, action: "cancel" } });
  assert.equal(world.campaigns().find((c) => c.id === id).status, "draft");
  await world.runAlarms();
  assert.equal(world.emails.length, 0);
});

test("sending is refused without a subject or a mailing address", async () => {
  const world = setup({ "contacts.csv": CONTACTS }, { env: { MAILING_ADDRESS: "" } });
  const adminFetch = await admin(world);
  const { id, res } = await createCampaign(adminFetch, world, { subject: "" }, "send-now");
  const html = await res.text();
  assert.match(html, /needs a subject line/);
  assert.match(html, /MAILING_ADDRESS/);
  assert.equal(world.campaigns().find((c) => c.id === id).status, "draft");
});

test("sending failures are retried, then reported, and can be resumed", async (t) => {
  t.mock.method(console, "error", () => {});
  const world = setup({ "contacts.csv": CONTACTS }, { resendStatus: 500 });
  const adminFetch = await admin(world);
  const { id } = await createCampaign(adminFetch, world, {}, "send-now");
  await world.runAlarms();
  assert.equal(world.campaigns().find((c) => c.id === id).status, "failed");
  const report = await (await adminFetch(`/admin/campaigns/view?id=${id}`)).text();
  assert.match(report, /Sending problem \(gave up\):.*HTTP 500/);

  world.resendStatus = 200;
  const resumed = await adminFetch("/admin/campaigns/action", { method: "POST", form: { id, action: "resume" } });
  assert.equal(resumed.status, 303);
  await world.runAlarms();
  assert.equal(world.campaigns().find((c) => c.id === id).status, "sent");
  assert.equal(world.emails.length, 3);
});

test("Resend webhooks mark hard bounces and complaints, and check the signature", async () => {
  const secretBytes = Buffer.from("webhook-secret-bytes");
  const secret = `whsec_${secretBytes.toString("base64")}`;
  const world = setup({ "contacts.csv": CONTACTS }, { env: { RESEND_WEBHOOK_SECRET: secret } });
  const send = (event, signWith = secretBytes) => {
    const body = JSON.stringify(event);
    const id = "msg_1";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac("sha256", signWith).update(`${id}.${timestamp}.${body}`).digest("base64");
    return call(world, "/webhooks/resend", { method: "POST", body, headers: { "svix-id": id, "svix-timestamp": timestamp, "svix-signature": `v1,${signature}` } });
  };

  assert.equal((await send({ type: "email.bounced", data: { to: ["ada@example.com"], bounce: { type: "Permanent" } } }, Buffer.from("wrong"))).status, 401);
  assert.equal(world.commits.length, 0);

  await send({ type: "email.bounced", data: { to: ["ada@example.com"], bounce: { type: "Temporary" } } });
  assert.equal(world.commits.length, 0, "temporary bounces are ignored");

  await send({ type: "email.bounced", data: { to: ["ada@example.com"], bounce: { type: "Permanent" } } });
  await send({ type: "email.complained", data: { to: ["bob@example.com"] } });
  const list = new ContactList(world.contacts());
  assert.equal(list.find("ada@example.com").Status, "bounced");
  assert.equal(list.find("bob@example.com").Status, "complained");
});
