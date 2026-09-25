// Campaigns: campaigns.json in the data repository.
import { parseTags } from "./contacts.js";

// draft → scheduled → sending → sent. A scheduled campaign can go back to draft; a sending one
// can be stopped. "failed" means sending kept failing and needs attention (see the campaign page).
export const CAMPAIGN_STATUSES = ["draft", "scheduled", "sending", "sent", "stopped", "failed"];
export const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,59}$/;
export const MAX_BODY_LENGTH = 100_000;

export async function loadCampaigns(github, config) {
  const file = await github.read(config.CAMPAIGNS_PATH);
  return parse(file?.text);
}

export async function findCampaign(github, config, id) {
  return (await loadCampaigns(github, config)).find((campaign) => campaign.id === id);
}

// Loads the campaigns, lets `change` edit the array, and saves it. `change` returns false to skip saving.
export async function updateCampaigns(github, config, message, change) {
  let result;
  await github.update(config.CAMPAIGNS_PATH, message, (text) => {
    const campaigns = parse(text);
    result = change(campaigns);
    return result === false ? undefined : JSON.stringify({ campaigns }, null, 2) + "\n";
  });
  return result;
}

// Changes some fields of one campaign. Returns the updated campaign, or undefined if it wasn't found.
export function setCampaignFields(github, config, id, fields, message = `Update campaign ${id}`) {
  return updateCampaigns(github, config, message, (campaigns) => {
    const campaign = campaigns.find((item) => item.id === id);
    if (!campaign) return false;
    Object.assign(campaign, fields, { updatedAt: new Date().toISOString() });
    return campaign;
  });
}

export function newCampaignId(name) {
  const slug = String(name ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  const random = crypto.getRandomValues(new Uint32Array(1))[0].toString(36).padStart(6, "0").slice(-6);
  return `${slug || "campaign"}-${random}`;
}

// Reads the editable fields from the campaign form. Returns { fields, errors }.
export function campaignFromForm(form) {
  const text = (name, max) => String(form.get(name) ?? "").replace(/\s+/g, " ").trim().slice(0, max);
  const fields = {
    name: text("name", 150),
    subject: text("subject", 200),
    preheader: text("preheader", 200),
    format: form.get("format") === "html" ? "html" : "markdown",
    body: String(form.get("body") ?? "").replace(/\r\n?/g, "\n"),
    audience: { tags: parseTags(form.getAll("tags")) },
  };
  const errors = [];
  if (!fields.name) errors.push("Give the campaign a name.");
  if (fields.body.length > MAX_BODY_LENGTH) errors.push(`The content is too long (${MAX_BODY_LENGTH.toLocaleString("en")} characters at most).`);
  return { fields, errors };
}

// Problems that stop a campaign from being sent (as opposed to saved).
export function sendProblems(campaign) {
  const problems = [];
  if (!campaign.subject) problems.push("The campaign needs a subject line.");
  if (!campaign.body?.trim()) problems.push("The campaign has no content.");
  return problems;
}

function parse(text) {
  if (!text?.trim()) return [];
  const data = JSON.parse(text);
  return Array.isArray(data.campaigns) ? data.campaigns : [];
}
