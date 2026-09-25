// Reads and saves files in the data repository through GitHub's contents API.

const MAX_SAVE_ATTEMPTS = 4;

export class GitHub {
  constructor(env, config) {
    if (!env.GITHUB_TOKEN) throw new Error("The GITHUB_TOKEN secret is not set (see SETUP.md).");
    this.token = env.GITHUB_TOKEN;
    this.config = config;
  }

  url(path) {
    const { GITHUB_OWNER, GITHUB_REPO } = this.config;
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    return `https://api.github.com/repos/${encodeURIComponent(GITHUB_OWNER)}/${encodeURIComponent(GITHUB_REPO)}/contents/${encoded}`;
  }

  request(url, init = {}, accept = "application/vnd.github+json") {
    return fetch(url, {
      ...init,
      cache: "no-store",
      headers: {
        Accept: accept,
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        "User-Agent": "mailops-worker",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
  }

  // Returns { text, sha }, or null when the file doesn't exist yet.
  async read(path) {
    const url = `${this.url(path)}?ref=${encodeURIComponent(this.config.GITHUB_BRANCH)}`;
    const res = await this.request(url);
    if (res.status === 404) return null;
    if (!res.ok) throw await githubError(res, "read", path);
    const file = await res.json();
    if (file.type !== "file") throw new Error(`${path} is not a file in the data repository.`);
    if (file.encoding === "base64") return { text: decodeBase64(file.content), sha: file.sha };
    // Files over 1 MB come without content; fetch them raw instead.
    const raw = await this.request(url, {}, "application/vnd.github.raw");
    if (!raw.ok) throw await githubError(raw, "read", path);
    return { text: new TextDecoder("utf-8", { ignoreBOM: true }).decode(await raw.arrayBuffer()), sha: file.sha };
  }

  // Reads the file, passes its text (or null if missing) to `change`, and saves what it returns.
  // `change` returns undefined to leave the file alone. Retries when someone else saved in the meantime.
  async update(path, message, change) {
    for (let attempt = 1; ; attempt++) {
      const file = await this.read(path);
      const text = change(file ? file.text : null);
      if (text === undefined || text === file?.text) return false;
      const res = await this.request(this.url(path), {
        method: "PUT",
        body: JSON.stringify({ message, content: encodeBase64(text), branch: this.config.GITHUB_BRANCH, ...(file && { sha: file.sha }) }),
      });
      if (res.ok) return true;
      // 409: the file changed after we read it. 422 without a sha: someone created it at the same time.
      const conflict = res.status === 409 || (res.status === 422 && !file);
      if (conflict && attempt < MAX_SAVE_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, 250 * attempt + Math.random() * 250));
        continue;
      }
      throw await githubError(res, "save", path);
    }
  }
}

async function githubError(res, action, path) {
  const hints = {
    401: "The GitHub token is wrong or has expired. Create a new one and update the GITHUB_TOKEN secret.",
    403: "The GitHub token needs 'Contents: Read and write' access to the data repository, or GitHub's rate limit was reached.",
    404: "Check GITHUB_OWNER, GITHUB_REPO and GITHUB_BRANCH, and that the token has access to the data repository.",
  };
  const detail = (await res.text()).slice(0, 300);
  return new Error(`GitHub ${action} of ${path} failed (HTTP ${res.status}). ${hints[res.status] ?? ""} Response: ${detail}`);
}

function decodeBase64(base64) {
  const binary = atob(base64.replace(/\s/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  // ignoreBOM keeps a leading byte order mark (added by Excel) so it's written back unchanged.
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
}

function encodeBase64(text) {
  const bytes = new TextEncoder().encode(text);
  // Converted in chunks and joined once, which is far faster than one big call on large files.
  const chunks = [];
  for (let i = 0; i < bytes.length; i += 0x2000) chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, i + 0x2000)));
  return btoa(chunks.join(""));
}
