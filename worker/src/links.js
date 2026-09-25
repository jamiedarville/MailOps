// Signed addresses used in emails. The signature stops people from unsubscribing someone else
// or inventing opens and clicks.
import { normalizeEmail } from "./contacts.js";
import { encodeParam, sign } from "./tokens.js";

export async function unsubscribeUrl(base, secret, email, campaignId = "", rid = "") {
  const params = new URLSearchParams({ e: encodeParam(normalizeEmail(email)) });
  if (campaignId) params.set("c", campaignId);
  if (campaignId && rid !== "") params.set("r", String(rid));
  params.set("s", await sign(secret, "unsubscribe", normalizeEmail(email), campaignId, rid));
  return `${base}/unsubscribe?${params}`;
}

export async function confirmUrl(base, secret, email) {
  const params = new URLSearchParams({ e: encodeParam(normalizeEmail(email)), s: await sign(secret, "confirm", normalizeEmail(email)) });
  return `${base}/confirm?${params}`;
}

export async function trackingUrls(base, secret, campaignId, rid) {
  const signature = await sign(secret, "track", campaignId, rid);
  return {
    open: `${base}/t/o/${campaignId}/${rid}/${signature}`,
    link: (index) => `${base}/t/c/${campaignId}/${rid}/${index}/${signature}`,
  };
}
