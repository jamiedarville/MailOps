// Resend webhooks: marks contacts as bounced or complained, and counts deliveries for reports.
// Resend signs each webhook the Svix way; the secret (whsec_…) is RESEND_WEBHOOK_SECRET.
import { GitHub } from "./github.js";
import { updateContacts } from "./contacts.js";
import { ID_PATTERN } from "./campaigns.js";
import { recordEvent } from "./public.js";
import { safeEqual } from "./tokens.js";

const TOLERANCE_SECONDS = 5 * 60;

export async function handleResendWebhook(request, env, config) {
  if (!env.RESEND_WEBHOOK_SECRET) return new Response("Webhooks are not set up", { status: 404 });
  const body = await request.text();
  if (!(await verifySignature(request.headers, body, env.RESEND_WEBHOOK_SECRET))) return new Response("Invalid signature", { status: 401 });

  const event = JSON.parse(body);
  const data = event.data ?? {};
  const email = Array.isArray(data.to) ? data.to[0] : data.to;
  const tags = data.tags ?? {};
  const kind = {
    "email.delivered": "delivered",
    "email.complained": "complaint",
    // Temporary bounces (a full mailbox, say) don't remove anyone.
    "email.bounced": data.bounce?.type === "Permanent" ? "bounce" : null,
  }[event.type];
  if (!kind || !email) return new Response("Ignored");

  if (kind !== "delivered") {
    const status = kind === "bounce" ? "bounced" : "complained";
    await updateContacts(new GitHub(env, config), config, `Mark contact as ${status}`, (list) => {
      const contact = list.find(email);
      if (!contact || contact.Status === status) return false;
      contact.Status = status;
      contact.UpdatedAt = new Date().toISOString();
      return true;
    });
  }
  if (ID_PATTERN.test(tags.campaign ?? "") && /^\d+$/.test(tags.rid ?? "")) {
    await recordEvent(env, tags.campaign, { rid: Number(tags.rid), kind });
  }
  return new Response("OK");
}

export async function verifySignature(headers, body, secret) {
  const id = headers.get("svix-id");
  const timestamp = headers.get("svix-timestamp");
  const signatures = headers.get("svix-signature");
  if (!id || !timestamp || !signatures) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > TOLERANCE_SECONDS) return false;

  const keyBytes = Uint8Array.from(atob(secret.replace(/^whsec_/, "")), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${body}`));
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));
  return signatures.split(" ").some((entry) => {
    const [version, signature] = entry.split(",");
    return version === "v1" && typeof signature === "string" && safeEqual(signature, expected);
  });
}
