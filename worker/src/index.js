/**
 * MailOps: basic email marketing on Cloudflare Workers, with your data kept as files in a
 * private GitHub repository. Setup steps: SETUP.md.
 *
 *   GET  /                 a simple signup form (handy for testing)
 *   POST /                 saves a signup to contacts.csv
 *   /confirm               confirms a signup (when DOUBLE_OPT_IN is on)
 *   /unsubscribe           unsubscribes, including one-click unsubscribe from mail apps
 *   /t/…                   open and click tracking
 *   POST /webhooks/resend  bounces and spam complaints from Resend
 *   /admin                 the dashboard: contacts, campaigns, reports
 */
import { settings } from "./config.js";
import { page, BACK_BUTTON } from "./html.js";
import { handleConfirm, handleSignup, handleTracking, handleUnsubscribe, signupForm } from "./public.js";
import { handleResendWebhook } from "./webhooks.js";
import { handleAdmin } from "./admin/index.js";

export { CampaignRunner } from "./runner.js";

export default {
  async fetch(request, env, ctx) {
    const config = settings(env);
    const { pathname } = new URL(request.url);
    const method = request.method;
    try {
      if (pathname === "/admin" || pathname.startsWith("/admin/")) return await handleAdmin(request, env, config);
      if (pathname.startsWith("/t/") && (method === "GET" || method === "HEAD")) return await handleTracking(request, env, ctx);
      if (pathname === "/unsubscribe" && ["GET", "HEAD", "POST"].includes(method)) return await handleUnsubscribe(request, env, config);
      if (pathname === "/confirm" && ["GET", "HEAD", "POST"].includes(method)) return await handleConfirm(request, env, config);
      if (pathname === "/webhooks/resend" && method === "POST") return await handleResendWebhook(request, env, config);
      if (pathname === "/" || pathname === "/subscribe") {
        if (method === "GET" || method === "HEAD") return signupForm(config);
        if (method === "POST") return await handleSignup(request, env, config);
        return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD, POST" } });
      }
      return page(404, "Page not found", "<p>There's nothing here.</p>");
    } catch (err) {
      console.error(err);
      return page(500, "Something went wrong", `<p>That didn't work. Please try again in a few minutes.</p>${BACK_BUTTON}`);
    }
  },
};
