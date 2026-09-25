// Signed tokens for links in emails (unsubscribe, confirm, tracking) and the admin session cookie.

const encoder = new TextEncoder();
const keys = new Map();

function key(secret) {
  if (!secret) throw new Error("The SIGNING_SECRET secret is not set (see SETUP.md).");
  if (!keys.has(secret)) {
    keys.set(secret, crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]));
  }
  return keys.get(secret);
}

export async function sign(secret, ...parts) {
  const signature = await crypto.subtle.sign("HMAC", await key(secret), encoder.encode(parts.join("\n")));
  return toBase64Url(new Uint8Array(signature)).slice(0, 22);
}

export async function verify(secret, signature, ...parts) {
  if (typeof signature !== "string" || !signature) return false;
  return safeEqual(await sign(secret, ...parts), signature);
}

export function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function toBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function encodeParam(text) {
  return toBase64Url(encoder.encode(text));
}

export function decodeParam(value) {
  try {
    const binary = atob(String(value).replace(/-/g, "+").replace(/_/g, "/"));
    return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
  } catch {
    return "";
  }
}
