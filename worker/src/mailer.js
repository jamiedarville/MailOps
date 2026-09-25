// Sends email through Resend (https://resend.com).

const API = "https://api.resend.com";
export const BATCH_SIZE = 100; // Resend's limit per batch request

export async function sendEmail(env, email) {
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
  const res = await fetch(API + path, {
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
