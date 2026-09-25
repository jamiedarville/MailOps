import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCsv, stringifyCsv } from "../src/csv.js";
import { ContactList, inAudience } from "../src/contacts.js";
import { buildTemplate, markdownToHtml, markdownToText, mergeTags, personalize } from "../src/render.js";
import { zonedTimeToUtc, utcToZonedInput } from "../src/html.js";
import { newCampaignId, ID_PATTERN } from "../src/campaigns.js";

test("CSV round trip keeps quotes, line breaks, a byte order mark and Windows line endings", () => {
  const text = '﻿Email,Notes\r\na@example.com,"Hello, ""world""\r\nsecond line"\r\n';
  const parsed = parseCsv(text);
  assert.deepEqual(parsed.header, ["Email", "Notes"]);
  assert.equal(parsed.records[0].Notes, 'Hello, "world"\r\nsecond line');
  assert.equal(stringifyCsv(parsed), text);
});

test("formula guard is applied once, however many times the file is rewritten", () => {
  let text = stringifyCsv({ header: ["Name"], records: [{ Name: "=HYPERLINK(1)" }] });
  assert.equal(text, "Name\n'=HYPERLINK(1)\n");
  for (let i = 0; i < 3; i++) text = stringifyCsv(parseCsv(text));
  assert.equal(text, "Name\n'=HYPERLINK(1)\n");
});

test("an email-db list.csv gains the new columns and keeps its rows", () => {
  const list = new ContactList("FirstName,LastName,Email,Phone\nAda,Lovelace,ada@example.com,5145550123\n");
  assert.deepEqual(list.header, ["FirstName", "LastName", "Email", "Phone", "Status", "Tags", "Source", "CreatedAt", "UpdatedAt"]);
  assert.equal(list.find("ADA@example.com").Status, "subscribed");
});

test("audiences: subscribed only, filtered by any of the tags", () => {
  const ada = { Status: "subscribed", Tags: "Newsletter; Events" };
  assert.ok(inAudience(ada, {}));
  assert.ok(inAudience(ada, { tags: ["events"] }));
  assert.ok(!inAudience(ada, { tags: ["VIP"] }));
  assert.ok(!inAudience({ ...ada, Status: "unsubscribed" }, {}));
  assert.ok(!inAudience({ ...ada, Status: "pending" }, {}));
});

test("Markdown becomes safe email HTML", () => {
  const html = markdownToHtml("# Hi\n\nSome **bold** and *it* text with [a link](https://example.com?a=1&b=2).\n\n- one\n- two\n\n[[Buy now]](https://shop.example)\n\n<script>alert(1)</script> [x](javascript:alert(1))");
  assert.match(html, /<h1[^>]*>Hi<\/h1>/);
  assert.match(html, /<strong>bold<\/strong> and <em>it<\/em>/);
  assert.match(html, /<a href="https:\/\/example\.com\?a=1&amp;b=2"[^>]*>a link<\/a>/);
  assert.match(html, /<ul[^>]*><li[^>]*>one<\/li><li[^>]*>two<\/li><\/ul>/);
  assert.match(html, /<a href="https:\/\/shop\.example"[^>]*background:[^>]*>Buy now<\/a>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<a href="#"/);
  assert.doesNotMatch(html, /javascript:/);
});

test("underscores in links aren't turned into italics", () => {
  assert.match(markdownToHtml("[docs](https://example.com/some_long_path_name)"), /href="https:\/\/example\.com\/some_long_path_name"/);
});

test("plain-text version", () => {
  assert.equal(markdownToText("# Hi\n\n**Bold** [site](https://example.com)\n\n[[Go]](https://go.example)"), "Hi\n\nBold site (https://example.com)\n\nGo: https://go.example");
});

test("merge tags with fallbacks, escaped in HTML", () => {
  const values = { FirstName: "<Ada>", LastName: "" };
  assert.equal(mergeTags("Hi {{FirstName}} {{LastName|friend}} {{Unknown}}", values, String), "Hi <Ada> friend {{Unknown}}");
  assert.equal(mergeTags("{{ FirstName }}", values, (v) => v.replace("<", "&lt;").replace(">", "&gt;")), "&lt;Ada&gt;");
});

test("a campaign renders with footer, unsubscribe link and tracked links", () => {
  const config = { ORG_NAME: "Example Co", MAILING_ADDRESS: "1 Main St" };
  const campaign = { subject: "Hi {{FirstName}}", preheader: "Peek", format: "markdown", body: "Hello {{FirstName|there}}\n\n[Site](https://example.com) and [again](https://example.com)" };
  const template = buildTemplate(campaign, config, { tracking: true });
  assert.deepEqual(template.links, ["https://example.com"]);
  const message = personalize(template, { FirstName: "Ada" }, { unsubscribe: "https://u.example/x?a=1&b=2", open: "https://t.example/o", link: (i) => `https://t.example/c/${i}` });
  assert.equal(message.subject, "Hi Ada");
  assert.match(message.html, /Hello Ada/);
  assert.match(message.html, /href="https:\/\/t\.example\/c\/0"/);
  assert.match(message.html, /href="https:\/\/u\.example\/x\?a=1&amp;b=2"[^>]*>Unsubscribe/);
  assert.match(message.html, /1 Main St/);
  assert.match(message.html, /<img src="https:\/\/t\.example\/o"/);
  assert.match(message.html, /Peek/);
  assert.match(message.text, /Site \(https:\/\/example\.com\)/);
  assert.match(message.text, /Unsubscribe: https:\/\/u\.example\/x\?a=1&b=2/);
});

test("HTML campaigns get a footer unless they include their own unsubscribe link", () => {
  const config = { ORG_NAME: "Example Co" };
  const withBody = buildTemplate({ format: "html", body: "<html><body><p>Hi</p></body></html>" }, config);
  assert.match(withBody.html, /\{\{UnsubscribeURL\}\}.*<\/body>/s);
  const own = buildTemplate({ format: "html", body: '<html><body><a href="{{UnsubscribeURL}}">Leave</a></body></html>' }, config);
  assert.equal(own.html.match(/UnsubscribeURL/g).length, 1);
});

test("scheduling times convert from the configured time zone", () => {
  // 9:30 in Toronto in September is 13:30 UTC (daylight time); in January it's 14:30 UTC.
  assert.equal(new Date(zonedTimeToUtc("2026-09-25T09:30", "America/Toronto")).toISOString(), "2026-09-25T13:30:00.000Z");
  assert.equal(new Date(zonedTimeToUtc("2026-01-15T09:30", "America/Toronto")).toISOString(), "2026-01-15T14:30:00.000Z");
  assert.equal(utcToZonedInput("2026-09-25T13:30:00.000Z", "America/Toronto"), "2026-09-25T09:30");
  assert.ok(Number.isNaN(zonedTimeToUtc("tomorrow", "America/Toronto")));
});

test("campaign ids are safe for URLs and Resend tags", () => {
  const id = newCampaignId("Café news: October!");
  assert.match(id, /^cafe-news-october-[a-z0-9]{6}$/);
  assert.ok(ID_PATTERN.test(id));
  assert.ok(ID_PATTERN.test(newCampaignId("!!!")));
});
