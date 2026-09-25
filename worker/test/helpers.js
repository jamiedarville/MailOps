// In-memory stand-ins for GitHub, Resend, Turnstile and Durable Objects, so the Worker can be
// tested without any network access.
import assert from "node:assert/strict";
import worker, { CampaignRunner } from "../src/index.js";

export const HEADER = "Email,FirstName,LastName,Phone,Status,Tags,Source,CreatedAt,UpdatedAt\n";
export const BASE = "https://mailops.example";
export const PASSWORD = "correct horse battery staple";

const realFetch = globalThis.fetch;

export function restore() {
  globalThis.fetch = realFetch;
}

class FakeStorage {
  constructor() {
    this.data = new Map();
    this.alarm = null;
  }
  async get(key) {
    if (Array.isArray(key)) return new Map(key.filter((k) => this.data.has(k)).map((k) => [k, structuredClone(this.data.get(k))]));
    return structuredClone(this.data.get(key));
  }
  async put(key, value) {
    if (typeof key === "object") for (const [k, v] of Object.entries(key)) this.data.set(k, structuredClone(v));
    else this.data.set(key, structuredClone(value));
  }
  async setAlarm(time) {
    this.alarm = time;
  }
  async deleteAlarm() {
    this.alarm = null;
  }
}

// Sets up a fake world. `files` are the data repository's files, by path.
export function setup(files = {}, { env: extraEnv = {}, turnstile = true, resendStatus = 200 } = {}) {
  const world = {
    files: new Map(Object.entries(files)),
    versions: new Map(),
    commits: [],
    emails: [],
    batches: [],
    requests: [],
    runners: new Map(),
    pending: [],
    resendStatus,
  };
  const env = {
    GITHUB_TOKEN: "test-token",
    RESEND_API_KEY: "re_test",
    SIGNING_SECRET: "test-signing-secret",
    ADMIN_PASSWORD: PASSWORD,
    FROM_EMAIL: "News <news@example.com>",
    MAILING_ADDRESS: "1 Main St, Montréal QC",
    ORG_NAME: "Example Co",
    PUBLIC_URL: BASE,
    ...extraEnv,
  };
  env.CAMPAIGNS = {
    idFromName: (name) => name,
    get: (id) => ({ fetch: (url, init) => world.runner(id).fetch(new Request(url, init)) }),
  };
  world.env = env;
  world.runner = (id) => {
    if (!world.runners.has(id)) world.runners.set(id, new CampaignRunner({ storage: new FakeStorage() }, env));
    return world.runners.get(id);
  };
  // Fires due alarms until every campaign is idle.
  world.runAlarms = async () => {
    for (let round = 0; round < 1000; round++) {
      const due = [...world.runners.values()].filter((runner) => runner.storage.alarm !== null);
      if (!due.length) return;
      for (const runner of due) {
        runner.storage.alarm = null;
        await runner.alarm();
      }
    }
    throw new Error("Alarms never stopped");
  };
  world.contacts = () => world.files.get("contacts.csv");
  world.campaigns = () => JSON.parse(world.files.get("campaigns.json") ?? '{"campaigns":[]}').campaigns;

  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    world.requests.push({ url, init });
    if (url.startsWith("https://challenges.cloudflare.com/")) return Response.json({ success: turnstile });
    if (url.startsWith("https://api.resend.com/")) {
      assert.equal(init.headers.Authorization, "Bearer re_test");
      if (world.resendStatus !== 200) return new Response("nope", { status: world.resendStatus });
      const body = JSON.parse(init.body);
      if (url.endsWith("/emails/batch")) {
        world.batches.push({ key: init.headers["Idempotency-Key"], emails: body });
        world.emails.push(...body);
        return Response.json({ data: body.map((_, i) => ({ id: `email-${world.emails.length + i}` })) });
      }
      world.emails.push(body);
      return Response.json({ id: `email-${world.emails.length}` });
    }
    const match = /^https:\/\/api\.github\.com\/repos\/jamiedarville\/mailops-data\/contents\/([^?]+)/.exec(url);
    assert.ok(match, `Unexpected request to ${url}`);
    assert.equal(init.headers.Authorization, "Bearer test-token");
    const path = decodeURIComponent(match[1]);
    const version = world.versions.get(path) ?? 1;
    if (!init.method || init.method === "GET") {
      if (!world.files.has(path)) return new Response("Not found", { status: 404 });
      const content = Buffer.from(world.files.get(path)).toString("base64").replace(/.{60}/g, "$&\n");
      return Response.json({ type: "file", encoding: "base64", content, sha: `${path}@${version}` });
    }
    const body = JSON.parse(init.body);
    if (world.files.has(path) ? body.sha !== `${path}@${version}` : body.sha) return Response.json({ message: "conflict" }, { status: 409 });
    assert.equal(body.branch, "main");
    world.files.set(path, Buffer.from(body.content, "base64").toString("utf8"));
    world.versions.set(path, version + 1);
    world.commits.push({ path, message: body.message });
    return Response.json({ content: {} });
  };
  return world;
}

export function call(world, path, { method = "GET", form, headers = {}, body } = {}) {
  const init = { method, headers: { ...headers } };
  if (form) init.body = form instanceof FormData ? form : new URLSearchParams(form);
  if (body) init.body = body;
  const ctx = { waitUntil: (promise) => world.pending.push(promise) };
  return worker.fetch(new Request(BASE + path, init), world.env, ctx);
}

// Logs in to the admin pages and returns a function for making admin requests.
export async function admin(world) {
  const res = await call(world, "/admin/login", { method: "POST", form: { password: PASSWORD }, headers: { Origin: BASE } });
  assert.equal(res.status, 303);
  const cookie = res.headers.get("Set-Cookie").split(";")[0];
  return (path, options = {}) => call(world, path, { ...options, headers: { Cookie: cookie, Origin: BASE, ...options.headers } });
}

export function contactRow(email, { first = "", last = "", status = "subscribed", tags = "" } = {}) {
  return `${email},${first},${last},,${status},${tags},Test,2026-01-01T00:00:00.000Z,2026-01-01T00:00:00.000Z\n`;
}
