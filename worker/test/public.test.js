import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { HEADER, call, contactRow, restore, setup } from "./helpers.js";
import { ContactList } from "../src/contacts.js";
import { unsubscribeUrl } from "../src/links.js";

afterEach(restore);

const PERSON = { FirstName: "Ada", LastName: "Lovelace", Email: "ada@example.com", Phone: "(514) 555-0123" };
const signup = (world, fields) => call(world, "/", { method: "POST", form: fields });

test("GET / shows a signup form with every field and the spam trap", async () => {
  const world = setup();
  const html = await (await call(world, "/")).text();
  for (const name of ["FirstName", "LastName", "Email", "Phone", "website"]) assert.match(html, new RegExp(`name="${name}"`));
  assert.doesNotMatch(html, /name="Tags"/);
});

test("the form offers interest checkboxes for SIGNUP_TAGS", async () => {
  const world = setup({}, { env: { SIGNUP_TAGS: "Newsletter, Events" } });
  const html = await (await call(world, "/")).text();
  assert.match(html, /name="Tags" value="Newsletter"/);
  assert.match(html, /name="Tags" value="Events"/);
});

test("a signup creates contacts.csv and adds a subscribed contact", async () => {
  const world = setup();
  const res = await signup(world, PERSON);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Thanks for signing up/);
  const [contact] = new ContactList(world.contacts()).records;
  assert.equal(contact.Email, "ada@example.com");
  assert.equal(contact.Phone, "5145550123");
  assert.equal(contact.Status, "subscribed");
  assert.equal(contact.Source, "Signup form");
  assert.ok(contact.CreatedAt);
  assert.equal(world.commits[0].message, "Add signup");
  assert.doesNotMatch(world.commits[0].message, /ada/);
});

test("only tags listed in SIGNUP_TAGS are saved", async () => {
  const world = setup({ "contacts.csv": HEADER }, { env: { SIGNUP_TAGS: "Newsletter" } });
  const form = new URLSearchParams(PERSON);
  form.append("Tags", "newsletter");
  form.append("Tags", "vip");
  await call(world, "/", { method: "POST", form });
  assert.equal(new ContactList(world.contacts()).find("ada@example.com").Tags, "Newsletter");
});

test("signing up again doesn't duplicate, but brings back someone who unsubscribed", async () => {
  const world = setup({ "contacts.csv": HEADER + contactRow("ada@example.com", { first: "Ada", last: "Lovelace" }) });
  await signup(world, { ...PERSON, Email: "ADA@example.com", Phone: "" });
  assert.equal(world.commits.length, 0);

  world.files.set("contacts.csv", HEADER + contactRow("ada@example.com", { status: "unsubscribed" }));
  await signup(world, PERSON);
  const contact = new ContactList(world.contacts()).find("ada@example.com");
  assert.equal(contact.Status, "subscribed");
  assert.equal(contact.FirstName, "Ada", "empty details are filled in");
  assert.equal(new ContactList(world.contacts()).records.length, 1);
});

test("the spam trap drops the submission but looks successful", async () => {
  const world = setup();
  const res = await signup(world, { ...PERSON, website: "http://spam.example" });
  assert.equal(res.status, 200);
  assert.equal(world.requests.length, 0);
});

test("invalid fields are reported and nothing is saved", async () => {
  const world = setup();
  const res = await signup(world, { FirstName: "Ada", Email: "not-an-email", Phone: "12" });
  assert.equal(res.status, 400);
  const html = await res.text();
  assert.match(html, /Last name is required/);
  assert.match(html, /Email doesn&#39;t look like a valid email address/);
  assert.match(html, /Phone should have between 7 and 15 digits/);
  assert.equal(world.requests.length, 0);
});

test("Turnstile is checked when its secret is set", async () => {
  const world = setup({}, { env: { TURNSTILE_SECRET_KEY: "secret" }, turnstile: false });
  const res = await signup(world, { ...PERSON, "cf-turnstile-response": "token" });
  assert.equal(res.status, 400);
  assert.equal(world.commits.length, 0);
});

test("redirects to SUCCESS_URL when set", async () => {
  const world = setup({}, { env: { SUCCESS_URL: "https://example.com/thanks" } });
  const res = await signup(world, PERSON);
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("Location"), "https://example.com/thanks");
});

test("double opt-in: the contact is pending until they confirm", async () => {
  const world = setup({}, { env: { DOUBLE_OPT_IN: "true" } });
  const res = await signup(world, PERSON);
  assert.match(await res.text(), /Check your inbox/);
  assert.equal(new ContactList(world.contacts()).find("ada@example.com").Status, "pending");

  const [email] = world.emails;
  assert.deepEqual(email.to, ["ada@example.com"]);
  const link = /https:\/\/mailops\.example\/confirm\?[^\s"]+/.exec(email.text)[0];
  const path = link.slice("https://mailops.example".length);

  // Opening the link (as a mail scanner would) changes nothing.
  const page = await call(world, path);
  assert.match(await page.text(), /<button type="submit">Confirm<\/button>/);
  assert.equal(new ContactList(world.contacts()).find("ada@example.com").Status, "pending");

  const confirmed = await call(world, path, { method: "POST" });
  assert.match(await confirmed.text(), /You&#39;re subscribed/);
  assert.equal(new ContactList(world.contacts()).find("ada@example.com").Status, "subscribed");

  const forged = await call(world, path.replace(/s=[^&]+/, "s=forged"), { method: "POST" });
  assert.equal(forged.status, 400);
});

test("unsubscribe links are signed and unsubscribe on POST", async () => {
  const world = setup({ "contacts.csv": HEADER + contactRow("ada@example.com") + contactRow("bob@example.com") });
  const link = await unsubscribeUrl("https://mailops.example", "test-signing-secret", "Ada@Example.com");
  const path = link.slice("https://mailops.example".length);

  assert.match(await (await call(world, path)).text(), /Stop sending emails to <strong>ada@example.com<\/strong>/);
  assert.equal(world.commits.length, 0);

  const res = await call(world, path, { method: "POST", form: { "List-Unsubscribe": "One-Click" } });
  assert.equal(res.status, 200);
  const list = new ContactList(world.contacts());
  assert.equal(list.find("ada@example.com").Status, "unsubscribed");
  assert.equal(list.find("bob@example.com").Status, "subscribed");

  const other = path.replace(/e=[^&]+/, `e=${Buffer.from("bob@example.com").toString("base64url")}`);
  assert.equal((await call(world, other, { method: "POST" })).status, 400, "a signature only works for its own address");
});

test("unknown pages get a 404", async () => {
  const world = setup();
  assert.equal((await call(world, "/nope")).status, 404);
});
