// CampaignRunner: a Durable Object that sends one campaign and keeps its report.
//
// There's one per campaign. When a campaign is scheduled it sets an alarm for the send time.
// The alarm takes a snapshot of the audience from contacts.csv, then sends in batches of 100,
// setting a new alarm after each couple of batches until everyone has been emailed. It also
// counts deliveries, opens, clicks, unsubscribes, bounces and complaints for the report.
import { isOn, settings } from "./config.js";
import { GitHub } from "./github.js";
import { loadContacts } from "./contacts.js";
import { setCampaignFields } from "./campaigns.js";
import { buildTemplate, personalize } from "./render.js";
import { BATCH_SIZE, sendBatch } from "./mailer.js";
import { trackingUrls, unsubscribeUrl } from "./links.js";

const BATCHES_PER_RUN = 2; // Resend allows a few requests a second
const PAUSE_MS = 1000;
const MAX_ATTEMPTS = 8;
const FLAGS = { delivered: 1, open: 2, click: 4, unsubscribe: 8, bounce: 16, complaint: 32 };
const DO_NOT_SEND = FLAGS.unsubscribe | FLAGS.bounce | FLAGS.complaint;
// Contact columns that aren't sent along as merge fields.
const INTERNAL_COLUMNS = ["Status", "Source", "CreatedAt", "UpdatedAt"];

export function emptyStats() {
  return { delivered: 0, opens: 0, uniqueOpens: 0, clicks: 0, uniqueClicks: 0, unsubscribes: 0, bounces: 0, complaints: 0, links: {} };
}

export class CampaignRunner {
  constructor(ctx, env) {
    this.storage = ctx.storage;
    this.env = env;
  }

  // The Worker talks to this object with POST requests: /schedule, /cancel, /resume, /status, /record, /click.
  async fetch(request) {
    const action = new URL(request.url).pathname.slice(1);
    if (!["schedule", "cancel", "resume", "status", "record", "click"].includes(action)) return new Response("Not found", { status: 404 });
    const input = request.method === "POST" ? await request.json() : {};
    try {
      return Response.json(await this[action](input));
    } catch (err) {
      return Response.json({ error: err.message }, { status: 409 });
    }
  }

  async schedule({ campaign, sendAt, baseUrl }) {
    const meta = await this.storage.get("meta");
    if (meta && ["sending", "done"].includes(meta.state)) throw new Error("This campaign has already been sent.");
    await this.storage.put("meta", { id: campaign.id, state: "scheduled", sendAt, baseUrl, campaign });
    await this.storage.setAlarm(Math.max(sendAt, Date.now()));
    return { state: "scheduled" };
  }

  async cancel() {
    const meta = await this.storage.get("meta");
    if (!meta || !["scheduled", "sending", "failed"].includes(meta.state)) return { state: meta?.state ?? "none" };
    meta.state = meta.state === "scheduled" ? "cancelled" : "stopped";
    await this.storage.put("meta", meta);
    await this.storage.deleteAlarm();
    return { state: meta.state, sent: meta.sent ?? 0 };
  }

  // Tries again after sending failed repeatedly.
  async resume() {
    const meta = await this.storage.get("meta");
    if (meta?.state !== "failed") throw new Error("Only a failed campaign can be resumed.");
    meta.state = meta.batches === undefined ? "scheduled" : "sending";
    meta.attempts = 0;
    delete meta.lastError;
    await this.storage.put("meta", meta);
    await this.storage.setAlarm(Date.now());
    return { state: meta.state };
  }

  async status() {
    const meta = (await this.storage.get("meta")) ?? { state: "none" };
    const template = await this.storage.get("template");
    const { campaign, ...rest } = meta;
    return { ...rest, stats: (await this.storage.get("stats")) ?? emptyStats(), links: template?.links ?? [] };
  }

  // Counts an event for one recipient: delivered, open, click, unsubscribe, bounce or complaint.
  async record({ rid, kind, link }) {
    const flag = FLAGS[kind];
    const meta = await this.storage.get("meta");
    if (!flag || !meta || !Number.isInteger(rid) || rid < 0 || rid >= (meta.total ?? 0)) return { recorded: false };
    const stats = (await this.storage.get("stats")) ?? emptyStats();
    let seen = (await this.storage.get(`seen:${rid}`)) ?? 0;
    const first = !(seen & flag);
    if (kind === "open" || kind === "click") {
      stats[kind === "open" ? "opens" : "clicks"]++;
      if (first) stats[kind === "open" ? "uniqueOpens" : "uniqueClicks"]++;
      // A click means the email was opened, even if the tracking pixel was blocked.
      if (kind === "click" && !(seen & FLAGS.open)) {
        stats.uniqueOpens++;
        seen |= FLAGS.open;
      }
      if (kind === "click") stats.links[link] = (stats.links[link] ?? 0) + 1;
    } else if (first) {
      stats[{ delivered: "delivered", unsubscribe: "unsubscribes", bounce: "bounces", complaint: "complaints" }[kind]]++;
    }
    seen |= flag;
    await this.storage.put({ stats, [`seen:${rid}`]: seen });
    return { recorded: true };
  }

  // Records a click and returns where the link goes, with merge tags filled in for this recipient.
  async click({ rid, link }) {
    const template = await this.storage.get("template");
    const url = template?.links?.[link];
    if (!url) return { url: null };
    await this.record({ rid, kind: "click", link });
    const recipient = (await this.storage.get(`batch:${Math.floor(rid / BATCH_SIZE)}`))?.[rid % BATCH_SIZE];
    const filled = url.replace(/\{\{\s*([A-Za-z]\w*)\s*\}\}/g, (match, name) =>
      recipient && name in recipient.fields ? encodeURIComponent(recipient.fields[name]) : match,
    );
    return { url: filled };
  }

  async alarm() {
    let meta = await this.storage.get("meta");
    if (!meta || !["scheduled", "sending"].includes(meta.state)) return;
    try {
      if (meta.state === "scheduled") meta = await this.prepare(meta);
      for (let i = 0; i < BATCHES_PER_RUN && meta.state === "sending" && meta.nextBatch < meta.batches; i++) {
        meta = await this.sendNextBatch(meta);
      }
      if (meta.state !== "sending") return;
      if (meta.nextBatch < meta.batches) {
        await this.storage.setAlarm(Date.now() + PAUSE_MS);
      } else {
        await this.finish(meta);
      }
    } catch (err) {
      console.error(`Campaign ${meta.id}:`, err);
      const latest = (await this.storage.get("meta")) ?? meta;
      if (!["scheduled", "sending"].includes(latest.state)) return;
      latest.attempts = (latest.attempts ?? 0) + 1;
      latest.lastError = String(err.message ?? err).slice(0, 500);
      if (latest.attempts >= MAX_ATTEMPTS) {
        latest.state = "failed";
        await this.storage.put("meta", latest);
        await this.saveStatus(latest, { status: "failed" }).catch((error) => console.error(error));
      } else {
        await this.storage.put("meta", latest);
        await this.storage.setAlarm(Date.now() + 30_000 * latest.attempts);
      }
    }
  }

  // Takes a snapshot of who gets the campaign, and renders it once for everyone.
  async prepare(meta) {
    const config = settings(this.env);
    if (!config.FROM_EMAIL) throw new Error("FROM_EMAIL is not set (see SETUP.md).");
    if (!this.env.SIGNING_SECRET) throw new Error("The SIGNING_SECRET secret is not set (see SETUP.md).");
    const contacts = await loadContacts(new GitHub(this.env, config), config);
    const recipients = contacts.audience(meta.campaign.audience).map((record, rid) => ({
      rid,
      email: record.Email,
      fields: Object.fromEntries(Object.entries(record).filter(([column]) => !INTERNAL_COLUMNS.includes(column))),
    }));
    const template = buildTemplate(meta.campaign, config, { tracking: isOn(config.TRACKING) });

    const latest = await this.storage.get("meta");
    if (latest?.state !== "scheduled") return latest ?? meta;
    const batches = Math.ceil(recipients.length / BATCH_SIZE);
    for (let b = 0; b < batches; b++) await this.storage.put(`batch:${b}`, recipients.slice(b * BATCH_SIZE, (b + 1) * BATCH_SIZE));
    await this.storage.put("template", template);
    Object.assign(latest, { state: "sending", total: recipients.length, batches, nextBatch: 0, sent: 0, skipped: 0, startedAt: new Date().toISOString() });
    await this.storage.put("meta", latest);
    await this.saveStatus(latest, { status: "sending", startedAt: latest.startedAt, recipients: latest.total }).catch((err) => console.error(err));
    return latest;
  }

  async sendNextBatch(meta) {
    const config = settings(this.env);
    const batch = meta.nextBatch;
    const recipients = (await this.storage.get(`batch:${batch}`)) ?? [];
    const template = await this.storage.get("template");
    const seen = recipients.length ? await this.storage.get(recipients.map((r) => `seen:${r.rid}`)) : new Map();
    const tracking = isOn(config.TRACKING);

    const emails = [];
    for (const recipient of recipients) {
      if ((seen.get(`seen:${recipient.rid}`) ?? 0) & DO_NOT_SEND) continue;
      const unsubscribe = await unsubscribeUrl(meta.baseUrl, this.env.SIGNING_SECRET, recipient.email, meta.id, recipient.rid);
      const urls = { unsubscribe, ...(tracking && (await trackingUrls(meta.baseUrl, this.env.SIGNING_SECRET, meta.id, recipient.rid))) };
      const message = personalize(template, recipient.fields, urls);
      emails.push({
        from: config.FROM_EMAIL,
        to: [recipient.email],
        subject: message.subject,
        html: message.html,
        text: message.text,
        ...(config.REPLY_TO && { reply_to: config.REPLY_TO }),
        headers: { "List-Unsubscribe": `<${unsubscribe}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
        tags: [
          { name: "campaign", value: meta.id },
          { name: "rid", value: String(recipient.rid) },
        ],
      });
    }
    await sendBatch(this.env, emails, `${meta.id}-batch-${batch}`);

    // Re-read, in case the campaign was stopped while this batch was sending.
    const latest = await this.storage.get("meta");
    latest.nextBatch = batch + 1;
    latest.sent = (latest.sent ?? 0) + emails.length;
    latest.skipped = (latest.skipped ?? 0) + recipients.length - emails.length;
    latest.attempts = 0;
    delete latest.lastError;
    await this.storage.put("meta", latest);
    return latest;
  }

  async finish(meta) {
    const sentAt = new Date().toISOString();
    await this.saveStatus(meta, { status: "sent", sentAt, recipients: meta.total, sent: meta.sent });
    meta.state = "done";
    meta.finishedAt = sentAt;
    await this.storage.put("meta", meta);
  }

  // Records the campaign's progress in campaigns.json.
  saveStatus(meta, fields) {
    const config = settings(this.env);
    return setCampaignFields(new GitHub(this.env, config), config, meta.id, fields, `Campaign ${meta.id}: ${fields.status}`);
  }
}
