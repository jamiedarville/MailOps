// The contact list: contacts.csv in the data repository, one row per email address.
import { parseCsv, stringifyCsv } from "./csv.js";

export const COLUMNS = ["Email", "FirstName", "LastName", "Phone", "Status", "Tags", "Source", "CreatedAt", "UpdatedAt"];

// subscribed: gets campaigns. pending: signed up but hasn't confirmed yet (double opt-in).
// unsubscribed, bounced, complained: never emailed again unless they sign up again.
export const STATUSES = ["subscribed", "pending", "unsubscribed", "bounced", "complained"];

// Columns anyone can fill in on the signup form, with their checks.
export const FORM_FIELDS = [
  { name: "FirstName", label: "First name", required: true, maxLength: 100, autocomplete: "given-name" },
  { name: "LastName", label: "Last name", required: true, maxLength: 100, autocomplete: "family-name" },
  { name: "Email", label: "Email", required: true, maxLength: 254, autocomplete: "email", type: "email" },
  { name: "Phone", label: "Phone", required: false, maxLength: 30, autocomplete: "tel", type: "tel" },
];

export const EMAIL_PATTERN = /^[A-Za-z0-9][\w.%+'-]*@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;

export class ContactList {
  constructor(text) {
    const { header, records, bom, newline } = parseCsv(text ?? "");
    this.header = [...header];
    for (const column of COLUMNS) if (!this.header.includes(column)) this.header.push(column);
    this.records = records.filter((record) => record.Email);
    for (const record of this.records) {
      record.Email = record.Email.trim();
      record.Status = STATUSES.includes(record.Status?.trim().toLowerCase()) ? record.Status.trim().toLowerCase() : "subscribed";
    }
    this.bom = bom;
    this.newline = newline;
  }

  toString() {
    return stringifyCsv(this);
  }

  find(email) {
    const wanted = normalizeEmail(email);
    return this.records.find((record) => normalizeEmail(record.Email) === wanted);
  }

  add(fields, now = new Date().toISOString()) {
    const record = Object.fromEntries(this.header.map((column) => [column, ""]));
    Object.assign(record, fields, { CreatedAt: fields.CreatedAt || now, UpdatedAt: now });
    record.Status ||= "subscribed";
    this.records.push(record);
    return record;
  }

  remove(email) {
    const record = this.find(email);
    if (record) this.records.splice(this.records.indexOf(record), 1);
    return Boolean(record);
  }

  allTags() {
    return [...new Set(this.records.flatMap(tagsOf))].sort((a, b) => a.localeCompare(b));
  }

  audience(audience) {
    return this.records.filter((record) => inAudience(record, audience));
  }
}

export function normalizeEmail(email) {
  return String(email ?? "").trim().toLowerCase();
}

export function tagsOf(record) {
  return parseTags(record.Tags);
}

export function parseTags(value) {
  const list = Array.isArray(value) ? value : String(value ?? "").split(/[;,]/);
  const tags = list.map((tag) => String(tag).replace(/\s+/g, " ").trim()).filter(Boolean);
  return [...new Map(tags.map((tag) => [tag.toLowerCase(), tag])).values()];
}

export function setTags(record, tags) {
  record.Tags = parseTags(tags).join("; ");
}

export function addTags(record, tags) {
  const before = record.Tags;
  setTags(record, [...tagsOf(record), ...parseTags(tags)]);
  return record.Tags !== before;
}

// A campaign audience is every subscribed contact, or only those with at least one of `audience.tags`.
export function inAudience(record, audience = {}) {
  if (record.Status !== "subscribed") return false;
  const wanted = parseTags(audience.tags).map((tag) => tag.toLowerCase());
  if (!wanted.length) return true;
  return tagsOf(record).some((tag) => wanted.includes(tag.toLowerCase()));
}

export async function loadContacts(github, config) {
  const file = await github.read(config.CONTACTS_PATH);
  return new ContactList(file?.text);
}

// Loads the list, lets `change` edit it, and saves it. `change` returns false to skip saving.
// It may run more than once if someone else saves at the same time, so it must only touch the list.
export async function updateContacts(github, config, message, change) {
  let result;
  await github.update(config.CONTACTS_PATH, message, (text) => {
    const list = new ContactList(text);
    result = change(list);
    return result === false ? undefined : list.toString();
  });
  return result;
}
