// Pages and endpoints anyone can reach: the signup form, confirming, unsubscribing, and tracking.
import { isOn, publicUrl, requireSecret } from "./config.js";
import { GitHub } from "./github.js";
import { EMAIL_PATTERN, FORM_FIELDS, addTags, normalizeEmail, parseTags, updateContacts } from "./contacts.js";
import { BACK_BUTTON, errorPage, escapeHtml, page } from "./html.js";
import { confirmUrl } from "./links.js";
import { sendEmail } from "./mailer.js";
import { decodeParam, verify } from "./tokens.js";
import { ID_PATTERN } from "./campaigns.js";

// A hidden field people never see. Submissions that fill it in are from bots and are dropped.
export const HONEYPOT_FIELD = "website";
const MAX_BODY_BYTES = 16 * 1024;
const TRANSPARENT_GIF = Uint8Array.from(atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"), (c) => c.charCodeAt(0));

export function signupForm(config) {
  const inputs = FORM_FIELDS.map((field) => {
    const id = escapeHtml(field.name);
    return `<label for="${id}">${escapeHtml(field.label)}${field.required ? "" : " (optional)"}</label>
<input id="${id}" name="${id}" type="${field.type ?? "text"}" maxlength="${field.maxLength}" autocomplete="${field.autocomplete ?? "on"}"${field.required ? " required" : ""}>`;
  }).join("\n");
  const tags = parseTags(config.SIGNUP_TAGS);
  const interests = tags.length
    ? `<fieldset style="margin-top:1rem"><legend>Interests</legend>${tags
        .map((tag) => `<label class="check"><input type="checkbox" name="Tags" value="${escapeHtml(tag)}"> ${escapeHtml(tag)}</label>`)
        .join("")}</fieldset>`
    : "";
  const siteKey = escapeHtml(config.TURNSTILE_SITE_KEY);
  const turnstile = siteKey
    ? `<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
<div class="cf-turnstile" data-sitekey="${siteKey}"></div>`
    : "";
  return page(
    200,
    "Sign up",
    `<form method="post">
${inputs}
${interests}
<div class="hidden-field" aria-hidden="true">
<label for="${HONEYPOT_FIELD}">Leave this empty</label>
<input id="${HONEYPOT_FIELD}" name="${HONEYPOT_FIELD}" tabindex="-1" autocomplete="off">
</div>
${turnstile}
<button type="submit">Sign up</button>
</form>`,
  );
}

export async function handleSignup(request, env, config) {
  if (Number(request.headers.get("Content-Length")) > MAX_BODY_BYTES) {
    return page(413, "Submission too large", `<p>That submission was too large to save.</p>${BACK_BUTTON}`);
  }
  let form;
  try {
    form = await request.formData();
  } catch {
    return errorPage(["The form couldn't be read. Please try again."]);
  }

  // Look successful, so bots don't learn they were caught.
  if (form.get(HONEYPOT_FIELD)) return thankYou(config, false);

  if (env.TURNSTILE_SECRET_KEY) {
    const passed = await verifyTurnstile(form.get("cf-turnstile-response"), env.TURNSTILE_SECRET_KEY, request.headers.get("CF-Connecting-IP"));
    if (!passed) return errorPage(["The spam check didn't pass. Please try again."]);
  }

  const { values, errors } = validate(form);
  if (errors.length) return errorPage(errors);

  const doubleOptIn = isOn(config.DOUBLE_OPT_IN);
  if (doubleOptIn) {
    requireSecret(env, "SIGNING_SECRET");
    requireSecret(env, "RESEND_API_KEY");
    if (!config.FROM_EMAIL) throw new Error("DOUBLE_OPT_IN is on but FROM_EMAIL is not set (see SETUP.md).");
  }
  const allowedTags = parseTags(config.SIGNUP_TAGS);
  const tags = parseTags(form.getAll("Tags")).flatMap((tag) => allowedTags.filter((allowed) => allowed.toLowerCase() === tag.toLowerCase()));
  const source = clean(form.get("Source")).slice(0, 60) || "Signup form";
  const now = new Date().toISOString();

  let needsConfirmation = false;
  await updateContacts(new GitHub(env, config), config, "Add signup", (list) => {
    const existing = list.find(values.Email);
    if (!existing) {
      list.add({ ...values, Status: doubleOptIn ? "pending" : "subscribed", Tags: tags.join("; "), Source: source }, now);
      needsConfirmation = doubleOptIn;
      return true;
    }
    let changed = addTags(existing, tags);
    for (const field of FORM_FIELDS) {
      if (!existing[field.name] && values[field.name]) {
        existing[field.name] = values[field.name];
        changed = true;
      }
    }
    // Someone who left, bounced or never confirmed is signing up again.
    if (existing.Status !== "subscribed") {
      existing.Status = doubleOptIn ? "pending" : "subscribed";
      changed = true;
    }
    needsConfirmation = changed && doubleOptIn && existing.Status === "pending";
    if (!changed) return false;
    existing.UpdatedAt = now;
  });

  if (needsConfirmation) await sendConfirmation(env, config, publicUrl(config, request), values);
  return thankYou(config, doubleOptIn);
}

async function sendConfirmation(env, config, base, values) {
  const link = await confirmUrl(base, env.SIGNING_SECRET, values.Email);
  const name = config.ORG_NAME || "our mailing list";
  const greeting = values.FirstName ? `Hi ${values.FirstName},` : "Hi,";
  await sendEmail(env, {
    from: config.FROM_EMAIL,
    to: [values.Email],
    subject: `Please confirm your subscription to ${name}`,
    ...(config.REPLY_TO && { reply_to: config.REPLY_TO }),
    text: `${greeting}\n\nPlease confirm that you want to receive emails from ${name}:\n\n${link}\n\nIf you didn't sign up, ignore this email and you won't hear from us.\n${config.MAILING_ADDRESS ? `\n${config.MAILING_ADDRESS}\n` : ""}`,
    html: `<p>${escapeHtml(greeting)}</p><p>Please confirm that you want to receive emails from ${escapeHtml(name)}.</p><p><a href="${escapeHtml(link)}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;font-weight:600;padding:12px 24px;border-radius:6px;">Confirm my subscription</a></p><p>If you didn't sign up, ignore this email and you won't hear from us.</p>${config.MAILING_ADDRESS ? `<p style="color:#71717a;font-size:12px">${escapeHtml(config.MAILING_ADDRESS)}</p>` : ""}`,
    tags: [{ name: "category", value: "confirm_email" }],
  });
}

function validate(form) {
  const values = {};
  const errors = [];
  for (const field of FORM_FIELDS) {
    let value = clean(form.get(field.name));
    if (value.length > field.maxLength) {
      errors.push(`${field.label} is too long (${field.maxLength} characters at most).`);
    } else if (!value) {
      if (field.required) errors.push(`${field.label} is required.`);
    } else if (field.type === "email" && !EMAIL_PATTERN.test(value)) {
      errors.push(`${field.label} doesn't look like a valid email address.`);
    } else if (field.type === "tel") {
      // Keep digits only.
      value = value.replace(/\D/g, "");
      if (value.length < 7 || value.length > 15) errors.push(`${field.label} should have between 7 and 15 digits.`);
    }
    values[field.name] = value;
  }
  return { values, errors };
}

// Turns a form value into a single line of trimmed text.
export function clean(value) {
  if (typeof value !== "string") return "";
  return value.normalize("NFC").replace(/[\s\u0000-\u001f\u007f]+/g, " ").trim();
}

async function verifyTurnstile(token, secret, ip) {
  if (typeof token !== "string" || !token) return false;
  const body = new FormData();
  body.append("secret", secret);
  body.append("response", token);
  if (ip) body.append("remoteip", ip);
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body });
  const result = res.ok ? await res.json() : { success: false, "error-codes": [`HTTP ${res.status}`] };
  if (!result.success) console.warn("Turnstile check failed:", result["error-codes"]);
  return result.success === true;
}

function thankYou(config, doubleOptIn) {
  if (config.SUCCESS_URL) {
    try {
      return Response.redirect(new URL(config.SUCCESS_URL).href, 303);
    } catch {
      console.error(`SUCCESS_URL is not a valid URL: ${config.SUCCESS_URL}`);
    }
  }
  return doubleOptIn
    ? page(200, "Almost done!", "<p>Check your inbox for an email to confirm your subscription.</p>")
    : page(200, "Thanks for signing up!", "<p>You're on the list.</p>");
}

// GET shows a button and POST does the work, so link scanners in mail systems can't confirm by accident.
export async function handleConfirm(request, env, config) {
  const url = new URL(request.url);
  const email = normalizeEmail(decodeParam(url.searchParams.get("e")));
  if (!email || !(await verify(env.SIGNING_SECRET, url.searchParams.get("s"), "confirm", email))) {
    return page(400, "This link doesn't work", "<p>The confirmation link is incomplete or has been changed. Try copying the whole link from the email.</p>");
  }
  if (request.method !== "POST") {
    return page(200, "Confirm your subscription", `<p>Confirm that <strong>${escapeHtml(email)}</strong> should receive our emails.</p><form method="post"><button type="submit">Confirm</button></form>`);
  }
  const found = await updateContacts(new GitHub(env, config), config, "Confirm subscription", (list) => {
    const contact = list.find(email);
    if (!contact) return "missing";
    if (contact.Status === "subscribed") return false;
    // Only a pending signup can be confirmed; someone who unsubscribed later must sign up again.
    if (contact.Status !== "pending") return false;
    contact.Status = "subscribed";
    contact.UpdatedAt = new Date().toISOString();
    return true;
  });
  if (found === "missing") return page(404, "Subscription not found", "<p>We couldn't find this subscription. Please sign up again.</p>");
  return page(200, "You're subscribed!", "<p>Thanks for confirming. You'll now receive our emails.</p>");
}

// GET shows a button; POST unsubscribes. Mail apps' one-click unsubscribe (RFC 8058) POSTs here directly.
export async function handleUnsubscribe(request, env, config) {
  const url = new URL(request.url);
  const email = normalizeEmail(decodeParam(url.searchParams.get("e")));
  const campaignId = url.searchParams.get("c") ?? "";
  const rid = url.searchParams.get("r") ?? "";
  if (!email || !(await verify(env.SIGNING_SECRET, url.searchParams.get("s"), "unsubscribe", email, campaignId, rid))) {
    return page(400, "This link doesn't work", "<p>The unsubscribe link is incomplete or has been changed. Try copying the whole link from the email, or reply to the email and ask to be removed.</p>");
  }
  if (request.method !== "POST") {
    return page(200, "Unsubscribe", `<p>Stop sending emails to <strong>${escapeHtml(email)}</strong>?</p><form method="post"><button type="submit">Unsubscribe</button></form>`);
  }
  await updateContacts(new GitHub(env, config), config, "Unsubscribe", (list) => {
    const contact = list.find(email);
    if (!contact || ["unsubscribed", "bounced", "complained"].includes(contact.Status)) return false;
    contact.Status = "unsubscribed";
    contact.UpdatedAt = new Date().toISOString();
    return true;
  });
  if (campaignId && ID_PATTERN.test(campaignId) && /^\d+$/.test(rid)) {
    await recordEvent(env, campaignId, { rid: Number(rid), kind: "unsubscribe" });
  }
  return page(200, "You've been unsubscribed", "<p>You won't receive any more emails from us. If this was a mistake, you can sign up again at any time.</p>");
}

// /t/o/<campaign>/<rid>/<signature> is the open pixel; /t/c/<campaign>/<rid>/<link>/<signature> is a tracked link.
export async function handleTracking(request, env, ctx) {
  const parts = new URL(request.url).pathname.split("/").slice(2);
  const [kind, campaignId, ridText] = parts;
  const signature = parts.at(-1);
  const rid = Number(ridText);
  const valid =
    ID_PATTERN.test(campaignId ?? "") &&
    /^\d+$/.test(ridText ?? "") &&
    ((kind === "o" && parts.length === 4) || (kind === "c" && parts.length === 5 && /^\d+$/.test(parts[3]))) &&
    (await verify(env.SIGNING_SECRET, signature, "track", campaignId, ridText));

  if (kind === "o") {
    if (valid) ctx.waitUntil(recordEvent(env, campaignId, { rid, kind: "open" }).catch((err) => console.error(err)));
    return new Response(TRANSPARENT_GIF, { headers: { "Content-Type": "image/gif", "Cache-Control": "no-store, max-age=0" } });
  }
  if (!valid) return page(404, "Link not found", "<p>This link is incomplete or has been changed.</p>");
  const { url } = await campaignStub(env, campaignId).fetch("https://runner/click", { method: "POST", body: JSON.stringify({ rid, link: Number(parts[3]) }) }).then((res) => res.json());
  if (!url) return page(404, "Link not found", "<p>This link is no longer available.</p>");
  return new Response(null, { status: 302, headers: { Location: url, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}

export function campaignStub(env, campaignId) {
  if (!env.CAMPAIGNS) throw new Error("The CAMPAIGNS Durable Object binding is missing. Deploy with `npx wrangler deploy` (see SETUP.md).");
  return env.CAMPAIGNS.get(env.CAMPAIGNS.idFromName(campaignId));
}

export async function callRunner(env, campaignId, action, input = {}) {
  const res = await campaignStub(env, campaignId).fetch(`https://runner/${action}`, { method: "POST", body: JSON.stringify(input) });
  const result = await res.json();
  if (result.error) throw new Error(result.error);
  return result;
}

export function recordEvent(env, campaignId, event) {
  return callRunner(env, campaignId, "record", event);
}
