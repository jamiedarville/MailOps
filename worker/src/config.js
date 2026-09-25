// Settings. Change the defaults here, or override any of them with a Worker variable of
// the same name (Cloudflare dashboard → your Worker → Settings → Variables and Secrets).
export const DEFAULTS = {
  // The PRIVATE repository that holds your data (contacts.csv and campaigns.json).
  // Never point this at a public repository: contacts.csv holds names and email addresses.
  GITHUB_OWNER: "jamiedarville",
  GITHUB_REPO: "mailops-data",
  GITHUB_BRANCH: "main",
  CONTACTS_PATH: "contacts.csv",
  CAMPAIGNS_PATH: "campaigns.json",

  // Who emails come from, e.g. "Jamie at Example <news@example.com>". The domain must be verified in Resend.
  FROM_EMAIL: "",
  REPLY_TO: "",
  // Shown in the footer of every email. Anti-spam laws (CASL, CAN-SPAM) require a postal address.
  ORG_NAME: "",
  MAILING_ADDRESS: "",
  // The Worker's public address, e.g. https://mailops.example.workers.dev. Used in links inside emails.
  // When empty, the address the admin pages were opened on is used.
  PUBLIC_URL: "",
  // Time zone for showing dates and for scheduling campaigns.
  TIMEZONE: "America/Toronto",

  // Signup form
  SUCCESS_URL: "",
  TURNSTILE_SITE_KEY: "",
  // "true": new signups get a confirmation email and only join the list once they confirm.
  DOUBLE_OPT_IN: "false",
  // Tags a signup form is allowed to set (comma-separated), e.g. "newsletter, events".
  SIGNUP_TAGS: "",
  // "false" turns off open and click tracking.
  TRACKING: "true",
};

export function settings(env) {
  const config = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    if (typeof env[key] === "string" && env[key].trim()) config[key] = env[key].trim();
  }
  return config;
}

export function isOn(value) {
  return /^(true|yes|on|1)$/i.test(String(value).trim());
}

export function publicUrl(config, request) {
  const base = config.PUBLIC_URL || (request ? new URL(request.url).origin : "");
  return base.replace(/\/+$/, "");
}

export function requireSecret(env, name) {
  if (!env[name]) throw new Error(`The ${name} secret is not set (see SETUP.md).`);
  return env[name];
}
