// Admin login: one password (the ADMIN_PASSWORD secret) and a signed session cookie.
import { safeEqual, sign, verify } from "../tokens.js";
import { loginPage } from "./layout.js";

const COOKIE = "mailops_session";
const MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

export async function isLoggedIn(request, env) {
  const cookie = request.headers.get("Cookie") ?? "";
  const value = cookie.split(/;\s*/).find((part) => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  const [expires, signature] = (value ?? "").split(".");
  if (!expires || Number(expires) < Date.now() / 1000) return false;
  // Signing the password in means changing it logs everyone out.
  return verify(env.SIGNING_SECRET, signature, "session", expires, env.ADMIN_PASSWORD);
}

export async function login(request, env) {
  const form = await request.formData();
  const password = String(form.get("password") ?? "");
  // Compare signatures rather than the passwords themselves, so the comparison takes the same time.
  const matches = safeEqual(await sign(env.SIGNING_SECRET, "password", password), await sign(env.SIGNING_SECRET, "password", env.ADMIN_PASSWORD));
  if (!matches) {
    console.warn("Failed admin login");
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return loginPage("That password isn't right.");
  }
  const expires = String(Math.floor(Date.now() / 1000) + MAX_AGE_SECONDS);
  const signature = await sign(env.SIGNING_SECRET, "session", expires, env.ADMIN_PASSWORD);
  return new Response(null, {
    status: 303,
    headers: {
      Location: "/admin/",
      "Set-Cookie": `${COOKIE}=${expires}.${signature}; Path=/admin; Max-Age=${MAX_AGE_SECONDS}; HttpOnly; Secure; SameSite=Strict`,
    },
  });
}

export function logout() {
  return new Response(null, {
    status: 303,
    headers: { Location: "/admin/login", "Set-Cookie": `${COOKIE}=; Path=/admin; Max-Age=0; HttpOnly; Secure; SameSite=Strict` },
  });
}

// Admin forms may only be sent from the admin pages themselves (protection against CSRF).
export function isSameOrigin(request) {
  const origin = request.headers.get("Origin");
  if (origin) return origin === new URL(request.url).origin;
  return request.headers.get("Sec-Fetch-Site") === "same-origin";
}
