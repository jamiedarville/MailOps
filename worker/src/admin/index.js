// Routes for the admin pages under /admin.
import { GitHub } from "../github.js";
import { STATUSES, loadContacts } from "../contacts.js";
import { loadCampaigns } from "../campaigns.js";
import { escapeHtml, formatDate, page } from "../html.js";
import { isOn } from "../config.js";
import { isLoggedIn, isSameOrigin, login, logout } from "./auth.js";
import { adminPage, badge, loginPage, redirect } from "./layout.js";
import { bulkAction, contactsPage, editContactPage, exportContacts, importContacts, importPage, saveContact } from "./contacts.js";
import { campaignAction, campaignPage, campaignsPage, createCampaign, saveCampaign } from "./campaigns.js";

export async function handleAdmin(request, env, config) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/admin";

  if (!env.ADMIN_PASSWORD || !env.SIGNING_SECRET) {
    return page(503, "Admin not set up", "<p>Set the <code>ADMIN_PASSWORD</code> and <code>SIGNING_SECRET</code> secrets to use the admin pages. See SETUP.md, step 4.</p>");
  }
  if (request.method === "POST" && !isSameOrigin(request)) return new Response("Forbidden", { status: 403 });
  if (path === "/admin/login") return request.method === "POST" ? login(request, env) : loginPage();
  if (path === "/admin/logout" && request.method === "POST") return logout();
  if (!(await isLoggedIn(request, env))) return redirect("/admin/login");

  try {
    return await route(request, url, path, env, config);
  } catch (err) {
    // Admins see the actual problem, which usually names the setting to fix.
    console.error(err);
    return adminPage("Something went wrong", `<div class="error">${escapeHtml(err.message ?? err)}</div><p><button type="button" onclick="history.back()">Go back</button></p>`, { url, status: 500 });
  }
}

async function route(request, url, path, env, config) {
  const github = new GitHub(env, config);
  if (request.method === "GET") {
    switch (path) {
      case "/admin": return dashboard(url, env, github, config);
      case "/admin/contacts": return contactsPage(url, github, config);
      case "/admin/contacts/new": return editContactPage(new URL("/admin/contacts/new", url), github, config);
      case "/admin/contacts/edit": return editContactPage(url, github, config);
      case "/admin/contacts/export": return exportContacts(url, github, config);
      case "/admin/contacts/import": return importPage(url);
      case "/admin/campaigns": return campaignsPage(url, github, config);
      case "/admin/campaigns/view": return campaignPage(url, env, github, config);
    }
  }
  if (request.method === "POST") {
    const form = await request.formData();
    switch (path) {
      case "/admin/contacts/save": return saveContact(form, url, github, config);
      case "/admin/contacts/bulk": return bulkAction(form, github, config);
      case "/admin/contacts/import": return importContacts(form, url, github, config);
      case "/admin/campaigns/new": return createCampaign(form, github, config);
      case "/admin/campaigns/save": return saveCampaign(form, request, env, github, config);
      case "/admin/campaigns/action": return campaignAction(form, env, github, config);
    }
  }
  return adminPage("Page not found", `<p><a href="/admin">Back to the dashboard</a></p>`, { url, status: 404 });
}

async function dashboard(url, env, github, config) {
  const [contacts, campaigns] = await Promise.all([loadContacts(github, config), loadCampaigns(github, config)]);
  const counts = Object.fromEntries(STATUSES.map((status) => [status, 0]));
  for (const record of contacts.records) counts[record.Status]++;
  const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const recent = contacts.records.filter((record) => record.Status === "subscribed" && String(record.CreatedAt) >= monthAgo).length;

  const checks = [
    [env.GITHUB_TOKEN, "GITHUB_TOKEN secret (saving contacts and campaigns)"],
    [env.RESEND_API_KEY, "RESEND_API_KEY secret (sending email)"],
    [config.FROM_EMAIL, "FROM_EMAIL variable (who campaigns come from)"],
    [config.MAILING_ADDRESS, "MAILING_ADDRESS variable (required by anti-spam laws)"],
    [config.PUBLIC_URL, "PUBLIC_URL variable (the address used in email links)"],
    [env.RESEND_WEBHOOK_SECRET, "RESEND_WEBHOOK_SECRET secret (removes bounced addresses automatically)"],
    [env.TURNSTILE_SECRET_KEY, "TURNSTILE_SECRET_KEY secret (spam protection for the signup form)"],
  ];
  const missing = checks.filter(([value]) => !value);
  const recentCampaigns = [...campaigns]
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .slice(0, 5)
    .map((c) => `<tr><td><a href="/admin/campaigns/view?id=${encodeURIComponent(c.id)}">${escapeHtml(c.name)}</a></td><td>${badge(c.status)}</td><td class="muted">${escapeHtml(formatDate(c.sentAt || c.sendAt || c.updatedAt, config.TIMEZONE))}</td></tr>`)
    .join("");

  const body = `
<div class="grid">
<div class="stat"><b>${counts.subscribed}</b><span>Subscribed</span></div>
<div class="stat"><b>${recent}</b><span>New in the last 30 days</span></div>
<div class="stat"><b>${counts.pending}</b><span>Waiting to confirm</span></div>
<div class="stat"><b>${counts.unsubscribed}</b><span>Unsubscribed</span></div>
<div class="stat"><b>${counts.bounced + counts.complained}</b><span>Bounced or complained</span></div>
</div>
${
  missing.length
    ? `<div class="card"><h2 style="margin-top:0">Finish setting up</h2><p class="muted">These settings aren't set yet (see SETUP.md):</p><ul>${missing.map(([, label]) => `<li>${escapeHtml(label)}</li>`).join("")}</ul></div>`
    : ""
}
<div class="card"><p style="margin:0">Signup form: <a href="/">${escapeHtml(url.origin)}/</a> · Double opt-in is <b>${isOn(config.DOUBLE_OPT_IN) ? "on" : "off"}</b> · Tracking is <b>${isOn(config.TRACKING) ? "on" : "off"}</b></p></div>
<h2>Recent campaigns</h2>
<div class="table-wrap"><table><thead><tr><th>Campaign</th><th>Status</th><th>Date</th></tr></thead>
<tbody>${recentCampaigns || `<tr><td colspan="3" class="muted">None yet. <a href="/admin/campaigns">Create your first campaign</a>.</td></tr>`}</tbody></table></div>`;
  return adminPage("Dashboard", body, { url });
}
