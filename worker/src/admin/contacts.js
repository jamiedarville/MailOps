// Admin pages for contacts: list, search, edit, bulk actions, import and export.
import { COLUMNS, EMAIL_PATTERN, STATUSES, addTags, loadContacts, normalizeEmail, parseTags, setTags, tagsOf, updateContacts } from "../contacts.js";
import { parseCsv, stringifyCsv } from "../csv.js";
import { escapeHtml, formatDate } from "../html.js";
import { clean } from "../public.js";
import { adminPage, badge, problems, redirect } from "./layout.js";

const PAGE_SIZE = 50;
const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

function filtered(list, url) {
  const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
  const status = url.searchParams.get("status") ?? "";
  const tag = (url.searchParams.get("tag") ?? "").toLowerCase();
  return list.records.filter(
    (record) =>
      (!status || record.Status === status) &&
      (!tag || tagsOf(record).some((t) => t.toLowerCase() === tag)) &&
      (!q || [record.Email, record.FirstName, record.LastName, record.Phone].some((value) => String(value ?? "").toLowerCase().includes(q))),
  );
}

export async function contactsPage(url, github, config) {
  const list = await loadContacts(github, config);
  const matches = filtered(list, url).sort((a, b) => String(b.CreatedAt).localeCompare(String(a.CreatedAt)));
  const pageNumber = Math.max(1, Number(url.searchParams.get("page")) || 1);
  const shown = matches.slice((pageNumber - 1) * PAGE_SIZE, pageNumber * PAGE_SIZE);
  const q = url.searchParams.get("q") ?? "";
  const status = url.searchParams.get("status") ?? "";
  const tag = url.searchParams.get("tag") ?? "";
  const pageLink = (n) => {
    const params = new URLSearchParams(url.searchParams);
    params.set("page", n);
    params.delete("notice");
    return `/admin/contacts?${params}`;
  };
  const exportParams = new URLSearchParams({ q, status, tag });

  const rows = shown
    .map(
      (record) => `<tr>
<td><input type="checkbox" name="email" value="${escapeHtml(record.Email)}" aria-label="Select ${escapeHtml(record.Email)}"></td>
<td><a href="/admin/contacts/edit?email=${encodeURIComponent(record.Email)}">${escapeHtml(record.Email)}</a></td>
<td>${escapeHtml([record.FirstName, record.LastName].filter(Boolean).join(" "))}</td>
<td>${badge(record.Status)}</td>
<td>${tagsOf(record).map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join("")}</td>
<td class="muted">${escapeHtml(formatDate(record.CreatedAt, config.TIMEZONE))}</td>
</tr>`,
    )
    .join("");

  const body = `
<form method="get" class="card row">
<div><label for="q">Search</label><input id="q" name="q" value="${escapeHtml(q)}" placeholder="Name, email or phone"></div>
<div><label for="status">Status</label><select id="status" name="status"><option value="">Any</option>${STATUSES.map((s) => `<option${s === status ? " selected" : ""}>${s}</option>`).join("")}</select></div>
<div><label for="tag">Tag</label><select id="tag" name="tag"><option value="">Any</option>${list.allTags().map((t) => `<option${t === tag ? " selected" : ""}>${escapeHtml(t)}</option>`).join("")}</select></div>
<button class="primary">Filter</button>
</form>
<p>
<a class="button primary" href="/admin/contacts/new">Add contact</a>
<a class="button" href="/admin/contacts/import">Import CSV</a>
<a class="button" href="/admin/contacts/export?${exportParams}">Export ${matches.length === list.records.length ? "all" : "these"} (${matches.length})</a>
</p>
<form method="post" action="/admin/contacts/bulk">
<div class="table-wrap"><table>
<thead><tr><th></th><th>Email</th><th>Name</th><th>Status</th><th>Tags</th><th>Added</th></tr></thead>
<tbody>${rows || `<tr><td colspan="6" class="muted">No contacts ${list.records.length ? "match" : "yet"}.</td></tr>`}</tbody>
</table></div>
<div class="pager">
${pageNumber > 1 ? `<a href="${pageLink(pageNumber - 1)}">← Previous</a>` : ""}
<span class="muted">${matches.length} contact${matches.length === 1 ? "" : "s"}${matches.length > PAGE_SIZE ? `, page ${pageNumber} of ${Math.ceil(matches.length / PAGE_SIZE)}` : ""}</span>
${pageNumber * PAGE_SIZE < matches.length ? `<a href="${pageLink(pageNumber + 1)}">Next →</a>` : ""}
</div>
<div class="card row" style="margin-top:1rem">
<div><label for="bulk-action">With selected contacts</label><select id="bulk-action" name="action">
<option value="add-tag">Add tag</option><option value="remove-tag">Remove tag</option><option value="unsubscribe">Unsubscribe</option><option value="delete">Delete permanently</option>
</select></div>
<div><label for="bulk-tag">Tag</label><input id="bulk-tag" name="tag" list="all-tags"></div>
<datalist id="all-tags">${list.allTags().map((t) => `<option value="${escapeHtml(t)}">`).join("")}</datalist>
<button onclick="return confirm('Apply to the selected contacts?')">Apply</button>
</div>
</form>`;
  return adminPage("Contacts", body, { url });
}

export async function bulkAction(form, github, config) {
  const emails = new Set(form.getAll("email").map(normalizeEmail));
  const action = form.get("action");
  const tag = clean(form.get("tag"));
  if (!emails.size || ((action === "add-tag" || action === "remove-tag") && !tag)) return redirect("/admin/contacts");
  const now = new Date().toISOString();
  await updateContacts(github, config, "Update contacts", (list) => {
    if (action === "delete") {
      list.records = list.records.filter((record) => !emails.has(normalizeEmail(record.Email)));
      return;
    }
    for (const record of list.records) {
      if (!emails.has(normalizeEmail(record.Email))) continue;
      if (action === "add-tag") addTags(record, [tag]);
      if (action === "remove-tag") setTags(record, tagsOf(record).filter((t) => t.toLowerCase() !== tag.toLowerCase()));
      if (action === "unsubscribe" && ["subscribed", "pending"].includes(record.Status)) record.Status = "unsubscribed";
      record.UpdatedAt = now;
    }
  });
  return redirect("/admin/contacts", "updated");
}

export async function editContactPage(url, github, config, errors = [], values) {
  const email = url.searchParams.get("email");
  const list = await loadContacts(github, config);
  const record = values ?? (email ? list.find(email) : { Status: "subscribed" });
  if (!record) return adminPage("Contact not found", `<p><a href="/admin/contacts">Back to contacts</a></p>`, { url, status: 404 });
  const isNew = !email;
  const input = (name, label, attrs = "") =>
    `<label for="f-${name}">${label}</label><input id="f-${name}" name="${name}" value="${escapeHtml(record[name] ?? "")}" ${attrs}>`;
  const extra = list.header.filter((column) => !COLUMNS.includes(column)).map((column) => input(column, escapeHtml(column))).join("");
  const body = `
${problems(errors)}
<div class="cols">
<form method="post" action="/admin/contacts/save" class="card">
<input type="hidden" name="original" value="${escapeHtml(isNew ? "" : email)}">
${input("Email", "Email", 'type="email" required maxlength="254"')}
<div class="row"><div>${input("FirstName", "First name", 'maxlength="100"')}</div><div>${input("LastName", "Last name", 'maxlength="100"')}</div></div>
${input("Phone", "Phone", 'maxlength="30"')}
<label for="f-Status">Status</label>
<select id="f-Status" name="Status">${STATUSES.map((s) => `<option${s === record.Status ? " selected" : ""}>${s}</option>`).join("")}</select>
${isNew ? `<p class="hint">Only add people as <b>subscribed</b> if they agreed to receive your emails.</p>` : ""}
${input("Tags", "Tags", 'list="all-tags"')}
<p class="hint">Separate tags with semicolons, e.g. <code>newsletter; events</code>.</p>
<datalist id="all-tags">${list.allTags().map((t) => `<option value="${escapeHtml(t)}">`).join("")}</datalist>
${extra}
<button class="primary">${isNew ? "Add contact" : "Save"}</button>
<a class="button" href="/admin/contacts">Cancel</a>
</form>
${
  isNew
    ? ""
    : `<div class="card">
<p><b>Source:</b> ${escapeHtml(record.Source || "–")}<br>
<b>Added:</b> ${escapeHtml(formatDate(record.CreatedAt, config.TIMEZONE) || "–")}<br>
<b>Last changed:</b> ${escapeHtml(formatDate(record.UpdatedAt, config.TIMEZONE) || "–")}</p>
<form method="post" action="/admin/contacts/bulk" onsubmit="return confirm('Delete this contact permanently? To stop emailing them but keep a record, set their status to unsubscribed instead.')">
<input type="hidden" name="email" value="${escapeHtml(record.Email)}">
<input type="hidden" name="action" value="delete">
<button class="danger">Delete contact</button>
</form>
</div>`
}
</div>`;
  return adminPage(isNew ? "Add contact" : record.Email, body, { url });
}

export async function saveContact(form, url, github, config) {
  const original = normalizeEmail(form.get("original"));
  const values = {};
  for (const [key, value] of form) if (key !== "original") values[key] = clean(value);
  values.Email = values.Email ?? "";
  values.Phone = (values.Phone ?? "").replace(/[^\d]/g, "");
  values.Tags = parseTags(values.Tags).join("; ");
  const errors = [];
  if (!EMAIL_PATTERN.test(values.Email)) errors.push("That email address doesn't look valid.");
  if (!STATUSES.includes(values.Status)) errors.push("Choose a status.");

  if (!errors.length) {
    const now = new Date().toISOString();
    let outcome;
    await updateContacts(github, config, original ? "Update contact" : "Add contact", (list) => {
      outcome = undefined;
      const existing = original ? list.find(original) : null;
      if (original && !existing) outcome = "missing";
      const clash = list.find(values.Email);
      if (clash && clash !== existing) outcome = "duplicate";
      if (outcome) return false;
      const { Source, CreatedAt, UpdatedAt, ...editable } = values;
      if (existing) Object.assign(existing, editable, { UpdatedAt: now });
      else list.add({ ...editable, Source: "Added by admin" }, now);
    });
    if (outcome === "missing") errors.push("This contact was deleted in the meantime.");
    if (outcome === "duplicate") errors.push("Another contact already has that email address.");
    if (!errors.length) return redirect(`/admin/contacts/edit?email=${encodeURIComponent(values.Email)}`, "saved");
  }
  const editUrl = new URL(url);
  editUrl.search = original ? `?email=${encodeURIComponent(original)}` : "";
  return editContactPage(editUrl, github, config, errors, values);
}

export async function exportContacts(url, github, config) {
  const list = await loadContacts(github, config);
  const csv = stringifyCsv({ header: list.header, records: filtered(list, url), bom: "﻿", newline: "\r\n" });
  const date = new Date().toISOString().slice(0, 10);
  return new Response(csv, {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="contacts-${date}.csv"`, "Cache-Control": "no-store" },
  });
}

export function importPage(url, result, errors = []) {
  const summary = result
    ? `<div class="notice">Added ${result.added}, updated ${result.updated}, unchanged ${result.unchanged}${result.invalid.length ? `, skipped ${result.invalid.length} row(s) without a valid email address` : ""}.</div>
${result.invalid.length ? `<details class="card"><summary>Skipped rows</summary><p class="muted">${result.invalid.slice(0, 50).map((line) => `Row ${line}`).join(", ")}${result.invalid.length > 50 ? ", …" : ""}</p></details>` : ""}`
    : "";
  const body = `
${summary}
${problems(errors)}
<form method="post" action="/admin/contacts/import" enctype="multipart/form-data" class="card">
<label for="file">CSV file</label>
<input id="file" name="file" type="file" accept=".csv,text/csv">
<label for="csv">…or paste CSV here</label>
<textarea id="csv" name="csv" class="short" placeholder="Email,FirstName,LastName&#10;ada@example.com,Ada,Lovelace"></textarea>
<p class="hint">The first row must name the columns. Recognized: Email, FirstName (or "First name"), LastName, Phone, Tags, Status. Other columns are added to your list as they are. Works with exports from email-db, Mailchimp and most other tools.</p>
<label for="tags">Add these tags to everyone imported (optional)</label>
<input id="tags" name="tags" placeholder="e.g. imported-2026; conference">
<label class="check"><input type="checkbox" name="consent" value="yes" required> Everyone in this file agreed to receive emails from me.</label>
<p class="hint">Existing contacts keep their status, so people who unsubscribed stay unsubscribed. Their tags are added to and empty details filled in.</p>
<button class="primary">Import</button>
</form>`;
  return adminPage("Import contacts", body, { url });
}

const ALIASES = {
  email: "Email", "e-mail": "Email", "email address": "Email", "e-mail address": "Email",
  firstname: "FirstName", "first name": "FirstName", fname: "FirstName", "given name": "FirstName",
  lastname: "LastName", "last name": "LastName", lname: "LastName", surname: "LastName", "family name": "LastName",
  phone: "Phone", "phone number": "Phone", mobile: "Phone",
  tags: "Tags", tag: "Tags", status: "Status",
};

export async function importContacts(form, url, github, config) {
  const file = form.get("file");
  let text = typeof file === "object" && file?.size ? await file.text() : String(form.get("csv") ?? "");
  if (!text.trim()) return importPage(url, null, ["Choose a file or paste some CSV."]);
  if (text.length > MAX_IMPORT_BYTES) return importPage(url, null, ["That file is too large (5 MB at most)."]);
  const parsed = parseCsv(text);
  const columns = parsed.header.map((name) => ALIASES[name.toLowerCase().replace(/[_-]+/g, " ").trim()] ?? ALIASES[name.toLowerCase()] ?? name);
  if (!columns.includes("Email")) return importPage(url, null, ["The first row needs an Email column."]);

  const extraTags = parseTags(form.get("tags"));
  const now = new Date().toISOString();
  let counts;
  await updateContacts(github, config, "Import contacts", (list) => {
    counts = { added: 0, updated: 0, unchanged: 0, invalid: [] };
    for (const column of columns) if (column && !list.header.includes(column)) list.header.push(column);
    parsed.records.forEach((raw, index) => {
      const row = {};
      parsed.header.forEach((name, i) => (row[columns[i]] = clean(raw[name])));
      if (!EMAIL_PATTERN.test(row.Email ?? "")) return counts.invalid.push(index + 2);
      if (row.Phone) row.Phone = row.Phone.replace(/\D/g, "");
      const tags = [...parseTags(row.Tags), ...extraTags];
      const existing = list.find(row.Email);
      if (!existing) {
        const status = STATUSES.includes(row.Status?.toLowerCase()) ? row.Status.toLowerCase() : "subscribed";
        list.add({ ...row, Status: status, Tags: tags.join("; "), Source: "Import" }, now);
        counts.added++;
        return;
      }
      let changed = addTags(existing, tags);
      for (const [column, value] of Object.entries(row)) {
        if (["Email", "Status", "Tags"].includes(column) || !value || existing[column]) continue;
        existing[column] = value;
        changed = true;
      }
      if (changed) existing.UpdatedAt = now;
      counts[changed ? "updated" : "unchanged"]++;
    });
    if (!counts.added && !counts.updated) return false;
  });
  return importPage(url, counts);
}
