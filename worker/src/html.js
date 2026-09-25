// HTML helpers and the page layout for the public pages (signup, unsubscribe, confirm).

export function escapeHtml(text) {
  return String(text ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

export const BACK_BUTTON = `<p><button type="button" onclick="history.back()">Go back</button></p>`;

export function htmlResponse(html, status = 200, headers = {}) {
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer", ...headers },
  });
}

export function page(status, title, body) {
  return htmlResponse(
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; line-height: 1.5; }
  body { max-width: 30rem; margin: 3rem auto; padding: 0 1rem; }
  label { display: block; margin-top: 1rem; font-weight: 600; }
  label.check { font-weight: 400; }
  input:not([type=checkbox]) { width: 100%; box-sizing: border-box; padding: 0.5rem; font: inherit; }
  button { margin-top: 1.5rem; padding: 0.6rem 1.2rem; font: inherit; cursor: pointer; }
  .cf-turnstile { margin-top: 1.5rem; }
  .hidden-field { position: absolute; left: -10000px; }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
${body}
</body>
</html>`,
    status,
  );
}

export function errorPage(errors) {
  const items = errors.map((error) => `<li>${escapeHtml(error)}</li>`).join("");
  return page(400, "Please check the form", `<ul>${items}</ul>${BACK_BUTTON}`);
}

// Formats a date in the configured time zone, e.g. "Sep 25, 2026, 9:30 a.m.".
export function formatDate(value, timeZone) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("en-CA", { timeZone, dateStyle: "medium", timeStyle: "short" }).format(date);
}

// Turns a "2026-09-25T09:30" wall-clock time in `timeZone` into a UTC timestamp (ms).
export function zonedTimeToUtc(local, timeZone) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local ?? "");
  if (!match) return NaN;
  const [, y, mo, d, h, mi] = match.map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let utc = guess - offset(guess, timeZone);
  const corrected = offset(utc, timeZone);
  if (guess - corrected !== utc) utc = guess - corrected;
  return utc;
}

// The inverse: a UTC time as the "YYYY-MM-DDTHH:mm" value of a datetime-local input.
export function utcToZonedInput(value, timeZone) {
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return "";
  return new Date(time + offset(time, timeZone)).toISOString().slice(0, 16);
}

function offset(time, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(new Date(time))
      .map((part) => [part.type, Number(part.value)]),
  );
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - Math.floor(time / 1000) * 1000;
}
