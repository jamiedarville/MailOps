// Signs requests to AWS APIs (Signature Version 4), so the Worker can call Amazon SES
// without the AWS SDK. https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html
const encoder = new TextEncoder();

export async function signRequest({ method, url, headers = {}, body = "", accessKeyId, secretAccessKey, region, service, date = new Date() }) {
  const { host, pathname, searchParams } = new URL(url);
  const amzDate = date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const day = amzDate.slice(0, 8);
  const scope = `${day}/${region}/${service}/aws4_request`;

  const all = { ...Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), String(value).trim().replace(/\s+/g, " ")])), host, "x-amz-date": amzDate };
  const names = Object.keys(all).sort();
  const query = [...searchParams].map(([k, v]) => [uriEncode(k), uriEncode(v)]).sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : 1) : a < b ? -1 : 1));
  const canonicalRequest = [
    method,
    // Every service except S3 encodes the (already encoded) path a second time.
    pathname.split("/").map((segment) => uriEncode(segment)).join("/"),
    query.map(([k, v]) => `${k}=${v}`).join("&"),
    names.map((name) => `${name}:${all[name]}\n`).join(""),
    names.join(";"),
    await sha256Hex(body),
  ].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256Hex(canonicalRequest)].join("\n");

  let key = encoder.encode(`AWS4${secretAccessKey}`);
  for (const part of [day, region, service, "aws4_request"]) key = await hmac(key, part);
  const signature = toHex(await hmac(key, stringToSign));

  const { host: _, ...rest } = all;
  return { ...rest, authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}` };
}

function uriEncode(text) {
  return encodeURIComponent(text).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

async function hmac(keyBytes, text) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(text)));
}

async function sha256Hex(text) {
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text))));
}

function toHex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
