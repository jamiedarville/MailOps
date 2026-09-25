// Page layout and small building blocks for the admin pages.
import { escapeHtml, htmlResponse } from "../html.js";

const NOTICES = {
  saved: "Saved.",
  deleted: "Deleted.",
  "test-sent": "Test email sent.",
  scheduled: "Campaign scheduled.",
  sending: "Campaign is sending.",
  cancelled: "Schedule cancelled. The campaign is a draft again.",
  stopped: "Sending stopped.",
  resumed: "Sending resumed.",
  duplicated: "Copied into a new draft.",
  updated: "Contacts updated.",
};

export function adminPage(title, body, { url, refresh, status = 200 } = {}) {
  const notice = url && NOTICES[url.searchParams.get("notice")];
  const section = url?.pathname.split("/")[2] ?? "";
  const nav = [
    ["", "Dashboard"],
    ["contacts", "Contacts"],
    ["campaigns", "Campaigns"],
  ]
    .map(([path, label]) => `<a href="/admin/${path}"${section === path ? ' aria-current="page"' : ""}>${label}</a>`)
    .join("");
  return htmlResponse(
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
${refresh ? `<meta http-equiv="refresh" content="${refresh}">` : ""}
<title>${escapeHtml(title)} · MailOps</title>
<style>${CSS}</style>
</head>
<body>
<header class="top">
<strong class="brand">MailOps</strong>
<nav>${nav}</nav>
<form method="post" action="/admin/logout"><button class="link">Log out</button></form>
</header>
<main>
${notice ? `<p class="notice" role="status">${escapeHtml(notice)}</p>` : ""}
<h1>${escapeHtml(title)}</h1>
${body}
</main>
</body>
</html>`,
    status,
  );
}

export function loginPage(error = "") {
  return htmlResponse(
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Log in · MailOps</title>
<style>${CSS}</style>
</head>
<body>
<main class="narrow">
<h1>MailOps</h1>
${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
<form method="post" action="/admin/login" class="card">
<label for="password">Password</label>
<input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
<button class="primary">Log in</button>
</form>
</main>
</body>
</html>`,
    error ? 401 : 200,
  );
}

export function redirect(location, notice) {
  const url = notice ? `${location}${location.includes("?") ? "&" : "?"}notice=${notice}` : location;
  return new Response(null, { status: 303, headers: { Location: url, "Cache-Control": "no-store" } });
}

export function badge(status) {
  return `<span class="badge ${escapeHtml(status)}">${escapeHtml(status)}</span>`;
}

export function problems(list) {
  return list.length ? `<div class="error"><ul>${list.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></div>` : "";
}

export function percent(part, whole) {
  return whole ? `${Math.round((part / whole) * 1000) / 10}%` : "–";
}

const CSS = `
:root { color-scheme: light dark; --bg: #f6f7f9; --card: #fff; --text: #18181b; --muted: #6b7280; --line: #e5e7eb; --accent: #2563eb; --accent-text: #fff; --danger: #b91c1c; --ok: #15803d; --warn: #a16207; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; line-height: 1.5; }
@media (prefers-color-scheme: dark) { :root { --bg: #111318; --card: #1a1d24; --text: #e5e7eb; --muted: #9ca3af; --line: #2d323c; --accent: #60a5fa; --accent-text: #0b1220; --danger: #f87171; --ok: #4ade80; --warn: #facc15; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); }
a { color: var(--accent); }
main { max-width: 72rem; margin: 0 auto; padding: 1.5rem 1rem 4rem; }
main.narrow { max-width: 24rem; margin-top: 4rem; }
h1 { font-size: 1.6rem; margin: 0.5rem 0 1.25rem; }
h2 { font-size: 1.15rem; margin: 2rem 0 0.75rem; }
.top { display: flex; align-items: center; gap: 1.5rem; padding: 0.75rem 1rem; background: var(--card); border-bottom: 1px solid var(--line); flex-wrap: wrap; }
.top nav { display: flex; gap: 1rem; flex: 1; }
.top nav a { text-decoration: none; color: var(--muted); font-weight: 500; }
.top nav a[aria-current] { color: var(--text); }
.top form { margin: 0; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 1.25rem; margin-bottom: 1.25rem; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr)); gap: 0.75rem; margin-bottom: 1.25rem; }
.stat { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 0.9rem 1rem; }
.stat b { display: block; font-size: 1.5rem; }
.stat span { color: var(--muted); font-size: 0.85rem; }
.cols { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 1.25rem; align-items: start; }
@media (max-width: 60rem) { .cols { grid-template-columns: 1fr; } }
label { display: block; font-weight: 600; margin: 0.9rem 0 0.3rem; }
label.check { font-weight: 400; display: inline-flex; align-items: center; gap: 0.35rem; margin: 0.2rem 1rem 0.2rem 0; }
input, select, textarea { font: inherit; color: inherit; background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 0.45rem 0.6rem; }
input:not([type=checkbox]):not([type=radio]), select, textarea { width: 100%; }
textarea { min-height: 22rem; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.9rem; }
textarea.short { min-height: 8rem; }
.hint { color: var(--muted); font-size: 0.85rem; margin: 0.25rem 0 0; font-weight: 400; }
button, .button { font: inherit; display: inline-block; cursor: pointer; border: 1px solid var(--line); background: var(--card); color: var(--text); border-radius: 6px; padding: 0.45rem 0.9rem; text-decoration: none; margin: 0.75rem 0.4rem 0 0; }
button.primary, .button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-text); font-weight: 600; }
button.danger { color: var(--danger); }
button.link { border: 0; background: none; color: var(--muted); padding: 0; margin: 0; }
.row { display: flex; gap: 0.75rem; flex-wrap: wrap; align-items: end; }
.row > * { flex: 1; min-width: 9rem; }
.row > button, .row > .button { flex: 0 0 auto; }
table { width: 100%; border-collapse: collapse; background: var(--card); border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
th, td { text-align: left; padding: 0.55rem 0.75rem; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.03em; color: var(--muted); }
tr:last-child td { border-bottom: 0; }
td.num, th.num { text-align: right; }
.table-wrap { overflow-x: auto; }
.badge { display: inline-block; font-size: 0.75rem; font-weight: 600; padding: 0.1rem 0.5rem; border-radius: 999px; border: 1px solid currentColor; text-transform: capitalize; }
.badge.subscribed, .badge.sent { color: var(--ok); }
.badge.pending, .badge.scheduled, .badge.sending { color: var(--warn); }
.badge.unsubscribed, .badge.draft, .badge.stopped { color: var(--muted); }
.badge.bounced, .badge.complained, .badge.failed { color: var(--danger); }
.tag { display: inline-block; font-size: 0.75rem; background: var(--bg); border: 1px solid var(--line); border-radius: 4px; padding: 0 0.35rem; margin: 0 0.2rem 0.2rem 0; }
.notice { background: color-mix(in srgb, var(--ok) 12%, var(--card)); border: 1px solid var(--ok); padding: 0.6rem 0.9rem; border-radius: 8px; }
.error { background: color-mix(in srgb, var(--danger) 10%, var(--card)); border: 1px solid var(--danger); padding: 0.6rem 0.9rem; border-radius: 8px; margin-bottom: 1rem; }
.error ul { margin: 0; padding-left: 1.2rem; }
.muted { color: var(--muted); }
.progress { height: 0.6rem; background: var(--line); border-radius: 999px; overflow: hidden; }
.progress > div { height: 100%; background: var(--accent); }
iframe.preview { width: 100%; height: 44rem; border: 1px solid var(--line); border-radius: 10px; background: #fff; }
.pager { display: flex; gap: 1rem; align-items: center; margin-top: 1rem; }
details summary { cursor: pointer; font-weight: 600; }
code { font-size: 0.9em; }
`;
