// Sends email through Resend (https://resend.com) or Amazon SES, chosen by EMAIL_PROVIDER.
// Emails are passed around in one shape: { from, to: [address], subject, html, text, reply_to, headers, tags: [{ name, value }] }.
import { settings } from "./config.js";
import { signRequest } from "./aws.js";

export const BATCH_SIZE = 100; // recipients per stored batch, and Resend's limit per batch request

export function providerName(config) {
  return String(config.EMAIL_PROVIDER).trim().toLowerCase() === "ses" ? "ses" : "resend";
}

// Settings the chosen provider still needs, as sentences for the admin pages.
export function providerProblems(env, config) {
  if (providerName(config) === "ses") {
    return [
      !env.AWS_ACCESS_KEY_ID && "Set the AWS_ACCESS_KEY_ID secret (SETUP.md, Amazon SES).",
      !env.AWS_SECRET_ACCESS_KEY && "Set the AWS_SECRET_ACCESS_KEY secret (SETUP.md, Amazon SES).",
    ].filter(Boolean);
  }
  return env.RESEND_API_KEY ? [] : ["Set the RESEND_API_KEY secret (SETUP.md)."];
}

export async function sendEmail(env, email) {
  const config = settings(env);
  return providerName(config) === "ses" ? sendWithSes(env, config, email) : sendWithResend(env, email);
}

// ---------------------------------------------------------------------------------------------
// Resend

async function sendWithResend(env, email) {
  const res = await resend(env, "/emails", email);
  return (await res.json()).id;
}

// Sends up to 100 emails in one request. Resend ignores a repeat of the same idempotency key
// for 24 hours, so retrying a batch after a crash never sends it twice.
export async function sendBatch(env, emails, idempotencyKey) {
  if (!emails.length) return [];
  const res = await resend(env, "/emails/batch", emails, idempotencyKey);
  return ((await res.json()).data ?? []).map((item) => item.id);
}

async function resend(env, path, body, idempotencyKey) {
  if (!env.RESEND_API_KEY) throw new Error("The RESEND_API_KEY secret is not set (see SETUP.md).");
  const res = await fetch(`https://api.resend.com${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
      "User-Agent": "mailops-worker",
      ...(idempotencyKey && { "Idempotency-Key": idempotencyKey }),
    },
    body: JSON.stringify(body),
  });
  if (res.ok) return res;
  const hints = {
    401: "The RESEND_API_KEY is wrong.",
    403: "Resend refused: check that FROM_EMAIL uses a domain you verified in Resend.",
    422: "Resend rejected the email: check FROM_EMAIL and REPLY_TO.",
    429: "Resend's rate limit or daily quota was reached.",
  };
  const detail = (await res.text()).slice(0, 300);
  throw new Error(`Sending failed (HTTP ${res.status}). ${hints[res.status] ?? ""} Response: ${detail}`);
}

// ---------------------------------------------------------------------------------------------
// Amazon SES (API v2, SendEmail). One request per email.

export async function sendWithSes(env, config, email) {
  if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) throw new Error("The AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY secrets are not set (see SETUP.md).");
  const region = config.AWS_REGION;
  const url = `https://email.${region}.amazonaws.com/v2/email/outbound-emails`;
  const body = JSON.stringify(toSesRequest(email, config));
  const headers = await signRequest({
    method: "POST",
    url,
    headers: { "content-type": "application/json" },
    body,
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    region,
    service: "ses",
  });
  const res = await fetch(url, { method: "POST", headers, body });
  if (res.ok) return (await res.json()).MessageId;

  const type = (res.headers.get("x-amzn-ErrorType") ?? "").split(":")[0];
  let message = "";
  try {
    message = (await res.json()).message ?? "";
  } catch {}
  const hints = {
    403: "Check AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY and AWS_REGION, and that the IAM user may use ses:SendEmail.",
    429: "SES's sending rate or daily quota was reached. Lower SES_MAX_SEND_RATE, or ask AWS for a higher quota.",
  };
  const sandbox = /not verified/i.test(message)
    ? "Your SES account may still be in the sandbox, which only sends to verified addresses; request production access (SETUP.md)."
    : "";
  throw new Error(`Sending failed (SES HTTP ${res.status}${type ? ` ${type}` : ""}). ${hints[res.status] ?? ""} ${sandbox} ${message}`.replace(/\s+/g, " ").trim());
}

export function toSesRequest(email, config) {
  const content = (data) => ({ Data: data, Charset: "UTF-8" });
  const headers = Object.entries(email.headers ?? {}).map(([Name, Value]) => ({ Name, Value }));
  return {
    FromEmailAddress: encodeAddress(email.from),
    Destination: { ToAddresses: [].concat(email.to).map(encodeAddress) },
    ...(email.reply_to && { ReplyToAddresses: [].concat(email.reply_to).map(encodeAddress) }),
    Content: {
      Simple: {
        Subject: content(encodeHeaderText(email.subject)),
        Body: { ...(email.html && { Html: content(email.html) }), ...(email.text && { Text: content(email.text) }) },
        ...(headers.length && { Headers: headers }),
      },
    },
    ...(email.tags?.length && { EmailTags: email.tags.map(({ name, value }) => ({ Name: name, Value: value })) }),
    ...(config.SES_CONFIGURATION_SET && { ConfigurationSetName: config.SES_CONFIGURATION_SET }),
  };
}

// SES only accepts plain ASCII in the subject and sender name, so anything else (é, emoji…) is
// written as RFC 2047 encoded words: =?UTF-8?B?…?=, each under the 75-character limit.
export function encodeHeaderText(text) {
  text = String(text ?? "");
  if (/^[\x20-\x7e]*$/.test(text)) return text;
  const words = [];
  let chunk = "";
  for (const char of text) {
    if (new TextEncoder().encode(chunk + char).length > 45) {
      words.push(chunk);
      chunk = "";
    }
    chunk += char;
  }
  if (chunk) words.push(chunk);
  return words.map((word) => `=?UTF-8?B?${bytesToBase64(new TextEncoder().encode(word))}?=`).join(" ");
}

// "Café Crème <news@example.com>" → "=?UTF-8?B?…?= <news@example.com>"
export function encodeAddress(value) {
  const match = /^\s*(.*?)\s*<([^<>]+)>\s*$/.exec(String(value ?? ""));
  if (!match) return String(value ?? "").trim();
  let [, name, address] = match;
  name = name.replace(/^"(.*)"$/, "$1");
  if (!name) return address;
  if (/[^\x20-\x7e]/.test(name)) return `${encodeHeaderText(name)} <${address}>`;
  if (/[()<>\[\]:;@\\,."]/.test(name)) return `"${name.replace(/(["\\])/g, "\\$1")}" <${address}>`;
  return `${name} <${address}>`;
}

function bytesToBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
