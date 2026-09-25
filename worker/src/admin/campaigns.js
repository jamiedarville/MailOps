// Admin pages for campaigns: list, write and preview, test, schedule or send, and reports.
import { publicUrl } from "../config.js";
import { loadContacts } from "../contacts.js";
import { campaignFromForm, findCampaign, loadCampaigns, newCampaignId, sendProblems, setCampaignFields, updateCampaigns } from "../campaigns.js";
import { escapeHtml, formatDate, utcToZonedInput, zonedTimeToUtc } from "../html.js";
import { unsubscribeUrl } from "../links.js";
import { sendEmail } from "../mailer.js";
import { callRunner } from "../public.js";
import { buildTemplate, personalize } from "../render.js";
import { adminPage, badge, percent, problems, redirect } from "./layout.js";

const SAMPLE_CONTACT = { Email: "ada@example.com", FirstName: "Ada", LastName: "Lovelace", Phone: "" };
const STARTER_BODY = `# Hello {{FirstName|there}}!

Write your update here. You can use **bold**, *italics*, [links](https://example.com) and lists:

- One thing
- Another thing

[[Read more]](https://example.com)

Thanks for reading,
Your name`;

function audienceLabel(campaign) {
  const tags = campaign.audience?.tags ?? [];
  return tags.length ? `Tagged ${tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join(" or ")}` : "All subscribed contacts";
}

export async function campaignsPage(url, github, config) {
  const campaigns = await loadCampaigns(github, config);
  campaigns.sort((a, b) => String(b.sentAt || b.sendAt || b.updatedAt).localeCompare(String(a.sentAt || a.sendAt || a.updatedAt)));
  const rows = campaigns
    .map((campaign) => {
      const when = campaign.sentAt || campaign.startedAt || campaign.sendAt;
      const whenLabel = campaign.status === "draft" ? `Edited ${formatDate(campaign.updatedAt, config.TIMEZONE)}` : formatDate(when, config.TIMEZONE);
      return `<tr>
<td><a href="/admin/campaigns/view?id=${encodeURIComponent(campaign.id)}">${escapeHtml(campaign.name)}</a><br><span class="muted">${escapeHtml(campaign.subject || "No subject yet")}</span></td>
<td>${badge(campaign.status)}</td>
<td>${audienceLabel(campaign)}</td>
<td class="num">${campaign.sent ?? campaign.recipients ?? "–"}</td>
<td class="muted">${escapeHtml(whenLabel)}</td>
</tr>`;
    })
    .join("");
  const body = `
<form method="post" action="/admin/campaigns/new" class="card row">
<div><label for="name">New campaign</label><input id="name" name="name" placeholder="e.g. October newsletter" required maxlength="150"></div>
<button class="primary">Create draft</button>
</form>
<div class="table-wrap"><table>
<thead><tr><th>Campaign</th><th>Status</th><th>Audience</th><th class="num">Recipients</th><th>Date</th></tr></thead>
<tbody>${rows || `<tr><td colspan="5" class="muted">No campaigns yet. Create one above.</td></tr>`}</tbody>
</table></div>`;
  return adminPage("Campaigns", body, { url });
}

export async function createCampaign(form, github, config) {
  const now = new Date().toISOString();
  const name = String(form.get("name") ?? "").replace(/\s+/g, " ").trim().slice(0, 150) || "Untitled campaign";
  const campaign = { id: newCampaignId(name), name, subject: "", preheader: "", format: "markdown", body: STARTER_BODY, audience: { tags: [] }, status: "draft", createdAt: now, updatedAt: now };
  await updateCampaigns(github, config, `Create campaign ${campaign.id}`, (campaigns) => {
    campaigns.push(campaign);
  });
  return redirect(`/admin/campaigns/view?id=${campaign.id}`);
}

export async function campaignPage(url, env, github, config, errors = [], draft) {
  const id = url.searchParams.get("id");
  const saved = await findCampaign(github, config, id);
  if (!saved) return adminPage("Campaign not found", `<p><a href="/admin/campaigns">Back to campaigns</a></p>`, { url, status: 404 });
  if (saved.status !== "draft") return reportPage(url, env, config, saved);
  return editorPage(url, github, config, { ...saved, ...draft }, errors);
}

async function editorPage(url, github, config, campaign, errors) {
  const contacts = await loadContacts(github, config);
  const allTags = contacts.allTags();
  const chosen = campaign.audience?.tags ?? [];
  const audienceSize = contacts.audience(campaign.audience).length;
  const preview = personalize(buildTemplate(campaign, config), SAMPLE_CONTACT, { unsubscribe: "#unsubscribe" });
  const tagBoxes = [...new Set([...allTags, ...chosen])]
    .map((tag) => `<label class="check"><input type="checkbox" name="tags" value="${escapeHtml(tag)}"${chosen.some((t) => t.toLowerCase() === tag.toLowerCase()) ? " checked" : ""}> ${escapeHtml(tag)}</label>`)
    .join("");
  const defaultTime = utcToZonedInput(campaign.sendAt || Date.now() + 60 * 60 * 1000, config.TIMEZONE);

  const body = `
${problems(errors)}
<form method="post" action="/admin/campaigns/save">
<input type="hidden" name="id" value="${escapeHtml(campaign.id)}">
<div class="cols">
<div>
<div class="card">
<label for="c-name">Campaign name <span class="hint">(only you see this)</span></label>
<input id="c-name" name="name" value="${escapeHtml(campaign.name)}" required maxlength="150">
<label for="c-subject">Subject line</label>
<input id="c-subject" name="subject" value="${escapeHtml(campaign.subject)}" maxlength="200" placeholder="What's new this month">
<label for="c-preheader">Preview text <span class="hint">(shown after the subject in most inboxes)</span></label>
<input id="c-preheader" name="preheader" value="${escapeHtml(campaign.preheader)}" maxlength="200">
<label>Audience</label>
${tagBoxes || `<p class="hint">You have no tags yet, so this goes to everyone subscribed.</p>`}
<p class="hint">Tick tags to send only to contacts with at least one of them. Leave all unticked to send to everyone subscribed. <b>${audienceSize}</b> subscribed contact${audienceSize === 1 ? "" : "s"} match right now.</p>
</div>
<div class="card">
<div class="row">
<div><label for="c-format">Content format</label>
<select id="c-format" name="format"><option value="markdown"${campaign.format !== "html" ? " selected" : ""}>Markdown (recommended)</option><option value="html"${campaign.format === "html" ? " selected" : ""}>HTML</option></select></div>
</div>
<label for="c-body">Content</label>
<textarea id="c-body" name="body">${escapeHtml(campaign.body)}</textarea>
<p class="hint">Personalize with <code>{{FirstName}}</code>, <code>{{LastName}}</code>, <code>{{Email}}</code>, or a fallback like <code>{{FirstName|there}}</code>.
Markdown: <code># Heading</code>, <code>**bold**</code>, <code>*italic*</code>, <code>[link](https://…)</code>, <code>![image](https://…)</code>, <code>- list</code>, <code>---</code>, and buttons: <code>[[Button text]](https://…)</code>.
An unsubscribe link and your mailing address are added to the footer automatically.</p>
<button class="primary" name="intent" value="save">Save and preview</button>
<a class="button" href="/admin/campaigns">Back</a>
</div>
<div class="card">
<h2 style="margin-top:0">Send a test</h2>
<label for="c-test">Send the current version to</label>
<input id="c-test" name="testTo" type="email" placeholder="you@example.com">
<button name="intent" value="test">Save and send test</button>
</div>
<div class="card">
<h2 style="margin-top:0">Send</h2>
<label for="c-when">Send at (${escapeHtml(config.TIMEZONE)})</label>
<input id="c-when" name="sendAt" type="datetime-local" value="${escapeHtml(defaultTime)}">
<button name="intent" value="schedule" onclick="return confirm('Schedule this campaign?')">Schedule</button>
<button class="primary" name="intent" value="send-now" onclick="return confirm('Send this campaign to ${audienceSize} contact${audienceSize === 1 ? "" : "s"} now?')">Send now</button>
</div>
<div class="card">
<button class="danger" name="intent" value="delete" formnovalidate onclick="return confirm('Delete this draft?')">Delete draft</button>
<button name="intent" value="duplicate" formnovalidate>Duplicate</button>
</div>
</div>
<div>
<h2 style="margin-top:0">Preview</h2>
<p class="muted"><b>Subject:</b> ${escapeHtml(preview.subject || "(none yet)")}<br><span class="hint">Shown for a sample contact (Ada Lovelace). Save to update it.</span></p>
<iframe class="preview" sandbox title="Email preview" srcdoc="${escapeHtml(preview.html)}"></iframe>
<details class="card" style="margin-top:1rem"><summary>Plain-text version</summary><pre style="white-space:pre-wrap">${escapeHtml(preview.text)}</pre></details>
</div>
</div>
</form>`;
  return adminPage(campaign.name, body, { url });
}

export async function saveCampaign(form, request, env, github, config) {
  const url = new URL(request.url);
  const id = String(form.get("id") ?? "");
  const intent = String(form.get("intent") ?? "save");
  const view = `/admin/campaigns/view?id=${encodeURIComponent(id)}`;
  const viewUrl = new URL(view, url);

  if (intent === "delete") {
    const deleted = await updateCampaigns(github, config, `Delete campaign ${id}`, (campaigns) => {
      const index = campaigns.findIndex((c) => c.id === id && c.status === "draft");
      if (index === -1) return false;
      campaigns.splice(index, 1);
    });
    return deleted === false ? redirect(view) : redirect("/admin/campaigns", "deleted");
  }

  const { fields, errors } = campaignFromForm(form);
  if (errors.length) return campaignPage(viewUrl, env, github, config, errors, fields);
  const campaign = await updateCampaigns(github, config, `Save campaign ${id}`, (campaigns) => {
    const found = campaigns.find((c) => c.id === id);
    if (!found || found.status !== "draft") return false;
    Object.assign(found, fields, { updatedAt: new Date().toISOString() });
    return found;
  });
  if (!campaign) return redirect(view);

  if (intent === "duplicate") return duplicate(campaign, github, config);
  if (intent === "test") {
    const problemsFound = [...sendProblems(campaign), ...setupProblems(env, config)];
    const to = String(form.get("testTo") ?? "").trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) problemsFound.push("Enter the email address to send the test to.");
    if (problemsFound.length) return campaignPage(viewUrl, env, github, config, problemsFound);
    await sendTest(env, config, github, campaign, to, publicUrl(config, request));
    return redirect(view, "test-sent");
  }
  if (intent === "schedule" || intent === "send-now") {
    const sendAt = intent === "send-now" ? Date.now() : zonedTimeToUtc(String(form.get("sendAt") ?? ""), config.TIMEZONE);
    const problemsFound = [...sendProblems(campaign), ...setupProblems(env, config)];
    if (Number.isNaN(sendAt)) problemsFound.push("Choose when to send the campaign.");
    else if (intent === "schedule" && sendAt < Date.now() - 60_000) problemsFound.push("The send time is in the past.");
    const audience = (await loadContacts(github, config)).audience(campaign.audience).length;
    if (!audience) problemsFound.push("No subscribed contacts match this audience.");
    if (problemsFound.length) return campaignPage(viewUrl, env, github, config, problemsFound);
    return schedule(campaign, sendAt, intent, env, github, config, publicUrl(config, request));
  }
  return redirect(view, "saved");
}

function setupProblems(env, config) {
  const missing = [];
  if (!config.FROM_EMAIL) missing.push("Set the FROM_EMAIL variable (SETUP.md).");
  if (!env.RESEND_API_KEY) missing.push("Set the RESEND_API_KEY secret (SETUP.md).");
  if (!env.CAMPAIGNS) missing.push("The CAMPAIGNS Durable Object binding is missing. Deploy with `npx wrangler deploy` (SETUP.md).");
  if (!config.MAILING_ADDRESS) missing.push("Set the MAILING_ADDRESS variable. Anti-spam laws require a postal address in every campaign (SETUP.md).");
  return missing;
}

async function sendTest(env, config, github, campaign, to, base) {
  const contact = (await loadContacts(github, config)).find(to) ?? { ...SAMPLE_CONTACT, Email: to };
  const unsubscribe = await unsubscribeUrl(base, env.SIGNING_SECRET, to);
  const message = personalize(buildTemplate(campaign, config), contact, { unsubscribe });
  await sendEmail(env, {
    from: config.FROM_EMAIL,
    to: [to],
    subject: `[Test] ${message.subject}`,
    html: message.html,
    text: message.text,
    ...(config.REPLY_TO && { reply_to: config.REPLY_TO }),
    tags: [{ name: "category", value: "test" }],
  });
}

async function schedule(campaign, sendAt, intent, env, github, config, base) {
  const sendAtIso = new Date(sendAt).toISOString();
  const scheduled = await setCampaignFields(github, config, campaign.id, { status: "scheduled", sendAt: sendAtIso }, `Schedule campaign ${campaign.id}`);
  try {
    await callRunner(env, campaign.id, "schedule", { campaign: scheduled, sendAt, baseUrl: base });
  } catch (err) {
    await setCampaignFields(github, config, campaign.id, { status: "draft" }, `Unschedule campaign ${campaign.id}`);
    throw err;
  }
  return redirect(`/admin/campaigns/view?id=${encodeURIComponent(campaign.id)}`, intent === "send-now" ? "sending" : "scheduled");
}

async function duplicate(campaign, github, config) {
  const now = new Date().toISOString();
  const name = `${campaign.name} (copy)`.slice(0, 150);
  const copy = { id: newCampaignId(name), name, subject: campaign.subject, preheader: campaign.preheader, format: campaign.format, body: campaign.body, audience: campaign.audience, status: "draft", createdAt: now, updatedAt: now };
  await updateCampaigns(github, config, `Create campaign ${copy.id}`, (campaigns) => {
    campaigns.push(copy);
  });
  return redirect(`/admin/campaigns/view?id=${copy.id}`, "duplicated");
}

// Cancel a schedule, stop sending, resume after a failure, or copy a sent campaign.
export async function campaignAction(form, env, github, config) {
  const id = String(form.get("id") ?? "");
  const action = form.get("action");
  const view = `/admin/campaigns/view?id=${encodeURIComponent(id)}`;
  const campaign = await findCampaign(github, config, id);
  if (!campaign) return redirect("/admin/campaigns");

  if (action === "duplicate") return duplicate(campaign, github, config);
  if (action === "cancel") {
    const result = await callRunner(env, id, "cancel");
    if (result.state === "cancelled" || result.state === "none") {
      await setCampaignFields(github, config, id, { status: "draft", sendAt: null }, `Unschedule campaign ${id}`);
      return redirect(view, "cancelled");
    }
    if (result.state === "stopped") await setCampaignFields(github, config, id, { status: "stopped", sent: result.sent }, `Stop campaign ${id}`);
    return redirect(view, "stopped");
  }
  if (action === "resume") {
    await callRunner(env, id, "resume");
    await setCampaignFields(github, config, id, { status: "sending" }, `Resume campaign ${id}`);
    return redirect(view, "resumed");
  }
  return redirect(view);
}

async function reportPage(url, env, config, campaign) {
  let run;
  try {
    run = await callRunner(env, campaign.id, "status");
  } catch (err) {
    console.error(err);
    run = { state: "unknown", stats: {} };
  }
  const stats = run.stats ?? {};
  const sent = run.sent ?? campaign.sent ?? 0;
  const total = run.total ?? campaign.recipients ?? 0;
  const state = { scheduled: "scheduled", sending: "sending", done: "sent", stopped: "stopped", cancelled: "draft", failed: "failed" }[run.state] ?? campaign.status;
  const sendingNow = state === "sending";

  const tiles = [
    [total, "Recipients"],
    [sent, "Sent"],
    [stats.delivered ?? 0, `Delivered · ${percent(stats.delivered ?? 0, sent)}`],
    [stats.uniqueOpens ?? 0, `Opened · ${percent(stats.uniqueOpens ?? 0, sent)}`],
    [stats.uniqueClicks ?? 0, `Clicked · ${percent(stats.uniqueClicks ?? 0, sent)}`],
    [stats.unsubscribes ?? 0, `Unsubscribed · ${percent(stats.unsubscribes ?? 0, sent)}`],
    [stats.bounces ?? 0, "Bounced"],
    [stats.complaints ?? 0, "Marked as spam"],
  ]
    .map(([value, label]) => `<div class="stat"><b>${value}</b><span>${escapeHtml(label)}</span></div>`)
    .join("");

  const links = (run.links ?? [])
    .map((link, index) => ({ link, clicks: stats.links?.[index] ?? 0 }))
    .sort((a, b) => b.clicks - a.clicks)
    .map(({ link, clicks }) => `<tr><td style="word-break:break-all">${escapeHtml(link)}</td><td class="num">${clicks}</td></tr>`)
    .join("");

  const button = (action, label, extra = "") =>
    `<form method="post" action="/admin/campaigns/action" style="display:inline"><input type="hidden" name="id" value="${escapeHtml(campaign.id)}"><button name="action" value="${action}" ${extra}>${label}</button></form>`;
  const actions = [
    state === "scheduled" && button("cancel", "Cancel schedule (back to draft)"),
    sendingNow && button("cancel", "Stop sending", `class="danger" onclick="return confirm('Stop sending? People not yet emailed won\\'t get this campaign.')"`),
    state === "failed" && button("resume", "Try again", 'class="primary"'),
    button("duplicate", "Duplicate"),
  ]
    .filter(Boolean)
    .join(" ");

  const preview = personalize(buildTemplate(campaign, config), SAMPLE_CONTACT, { unsubscribe: "#unsubscribe" });
  const body = `
<p>${badge(state)} · ${audienceLabel(campaign)}${
    state === "scheduled" ? ` · Sends ${escapeHtml(formatDate(campaign.sendAt, config.TIMEZONE))}` : ""
  }${campaign.sentAt ? ` · Sent ${escapeHtml(formatDate(campaign.sentAt, config.TIMEZONE))}` : ""}</p>
${run.lastError ? `<div class="error"><b>Sending problem${state === "failed" ? " (gave up)" : " (will retry)"}:</b> ${escapeHtml(run.lastError)}</div>` : ""}
${sendingNow && total ? `<div class="card"><p>Sending: ${sent} of ${total}</p><div class="progress"><div style="width:${percent(sent, total) === "–" ? 0 : percent(sent, total)}"></div></div></div>` : ""}
<div class="grid">${tiles}</div>
<p class="muted hint">Opens are estimates: some mail apps load images automatically, others block them. Clicks are more reliable.</p>
<p>${actions}</p>
<h2>Links clicked</h2>
<div class="table-wrap"><table><thead><tr><th>Link</th><th class="num">Clicks</th></tr></thead>
<tbody>${links || `<tr><td colspan="2" class="muted">No tracked links${state === "sent" ? " were clicked" : " yet"}.</td></tr>`}</tbody></table></div>
<h2>Email</h2>
<p><b>Subject:</b> ${escapeHtml(campaign.subject)}</p>
<iframe class="preview" sandbox title="Email preview" srcdoc="${escapeHtml(preview.html)}"></iframe>`;
  return adminPage(campaign.name, body, { url, refresh: sendingNow || state === "scheduled" ? 15 : 0 });
}
