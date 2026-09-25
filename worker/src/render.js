// Turns a campaign into an email: Markdown (or HTML) → a styled HTML email plus a plain-text version,
// then fills in merge tags such as {{FirstName}} for each recipient.
import { escapeHtml } from "./html.js";

const ACCENT = "#2563eb";
const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const SAFE_URL = /^(https?:|mailto:|tel:|\{\{)/i;

// Builds the parts of the email that are the same for everyone. Links are numbered for click
// tracking ({{__link:N}}) and an {{__open}} placeholder marks where the tracking pixel goes.
export function buildTemplate(campaign, config, { tracking = false } = {}) {
  const content = campaign.format === "html" ? campaign.body ?? "" : markdownToHtml(campaign.body ?? "");
  let html = campaign.format === "html" && /<\/body>/i.test(content) ? injectFooter(content, config) : layout(content, campaign, config);

  const links = [];
  if (tracking) {
    html = html.replace(/href="([^"]+)"/g, (match, href) => {
      const url = unescapeHtml(href);
      if (!/^https?:\/\//i.test(url) || url.includes("{{UnsubscribeURL}}")) return match;
      let index = links.indexOf(url);
      if (index === -1) index = links.push(url) - 1;
      return `href="{{__link:${index}}}"`;
    });
  }

  const body = campaign.format === "html" ? htmlToText(content) : markdownToText(campaign.body ?? "");
  const text = `${body}\n\n--\n${footerLines(config).join("\n")}\nUnsubscribe: {{UnsubscribeURL}}\n`;
  return { subject: campaign.subject ?? "", html, text, links };
}

// Fills in the merge tags for one recipient. `urls` gives the unsubscribe link and, when
// tracking, functions for the tracked link and open-pixel addresses.
export function personalize(template, fields, urls) {
  const values = { ...fields, UnsubscribeURL: urls.unsubscribe };
  const openPixel = urls.open ? `<img src="${escapeHtml(urls.open)}" width="1" height="1" alt="" style="display:block;border:0;width:1px;height:1px;">` : "";
  const html = template.html
    .replace("{{__open}}", openPixel)
    .replace(/\{\{__link:(\d+)\}\}/g, (_, index) => escapeHtml(urls.link ? urls.link(Number(index)) : template.links[index]));
  return {
    subject: mergeTags(template.subject, values, String),
    html: mergeTags(html, values, escapeHtml),
    text: mergeTags(template.text, values, String),
  };
}

// {{FirstName}} → the value; {{FirstName|there}} → the value, or "there" when it's empty.
// Tags that aren't contact columns are left as they are, so typos show up in the preview.
export function mergeTags(text, values, escape) {
  return text.replace(/\{\{\s*([A-Za-z][\w]*)\s*(?:\|([^}]*))?\}\}/g, (match, name, fallback) => {
    if (!(name in values) && fallback === undefined) return match;
    const value = String(values[name] ?? "").trim() || (fallback ?? "").trim();
    return escape(value);
  });
}

function layout(content, campaign, config) {
  const preheader = campaign.preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(campaign.preheader)}${"&#847;&zwnj;&nbsp;".repeat(30)}</div>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${escapeHtml(campaign.subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f5;">
${preheader}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:8px;">
<tr><td style="padding:32px;font-family:${FONT};font-size:16px;line-height:1.6;color:#18181b;">
${content}
</td></tr>
</table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;">
<tr><td style="padding:16px 32px;font-family:${FONT};font-size:12px;line-height:1.5;color:#71717a;text-align:center;">
${footerHtml(config)}
</td></tr>
</table>
</td></tr>
</table>
{{__open}}
</body>
</html>`;
}

function injectFooter(html, config) {
  const footer = html.includes("{{UnsubscribeURL}}")
    ? ""
    : `<div style="padding:16px;font-family:${FONT};font-size:12px;color:#71717a;text-align:center;">${footerHtml(config)}</div>`;
  return html.replace(/<\/body>/i, `${footer}{{__open}}</body>`);
}

function footerHtml(config) {
  const lines = footerLines(config).map(escapeHtml);
  lines.push(`<a href="{{UnsubscribeURL}}" style="color:#71717a;">Unsubscribe</a>`);
  return lines.join("<br>");
}

function footerLines(config) {
  const name = config.ORG_NAME || "our mailing list";
  return [`You're receiving this email because you signed up for ${name}.`, config.MAILING_ADDRESS].filter(Boolean);
}

// A small, safe subset of Markdown: headings, paragraphs, bold, italic, links, images, lists,
// quotes, horizontal rules, and buttons written as [[Button text]](https://example.com).
export function markdownToHtml(markdown) {
  const blocks = [];
  let paragraph = [];
  let list = null;
  const flush = () => {
    if (paragraph.length) blocks.push(`<p style="margin:0 0 16px;">${paragraph.map(inline).join("<br>")}</p>`);
    if (list) blocks.push(`<${list.tag} style="margin:0 0 16px;padding-left:24px;">${list.items.map((item) => `<li style="margin:0 0 4px;">${inline(item)}</li>`).join("")}</${list.tag}>`);
    paragraph = [];
    list = null;
  };
  const sizes = { 1: 28, 2: 22, 3: 18 };

  for (const raw of String(markdown).replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    let match;
    if (!line.trim()) {
      flush();
    } else if ((match = /^(#{1,3})\s+(.*)$/.exec(line))) {
      flush();
      const level = match[1].length;
      blocks.push(`<h${level} style="margin:0 0 16px;font-size:${sizes[level]}px;line-height:1.3;">${inline(match[2])}</h${level}>`);
    } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      blocks.push(`<hr style="border:0;border-top:1px solid #e4e4e7;margin:24px 0;">`);
    } else if ((match = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(line))) {
      const tag = match[1] ? "ul" : "ol";
      if (paragraph.length || (list && list.tag !== tag)) flush();
      list ??= { tag, items: [] };
      list.items.push(match[3]);
    } else if ((match = /^>\s?(.*)$/.exec(line))) {
      flush();
      blocks.push(`<blockquote style="margin:0 0 16px;padding-left:16px;border-left:4px solid #e4e4e7;color:#52525b;">${inline(match[1])}</blockquote>`);
    } else if (list && /^\s{2,}\S/.test(raw)) {
      list.items[list.items.length - 1] += ` ${line.trim()}`;
    } else {
      if (list) flush();
      paragraph.push(line.trim());
    }
  }
  flush();
  return blocks.join("\n");
}

function inline(text) {
  const saved = [];
  const keep = (html) => `\u0000${saved.push(html) - 1}\u0000`;
  const url = (href) => (SAFE_URL.test(unescapeHtml(href)) ? href : "#");
  return escapeHtml(text)
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, src) => keep(`<img src="${url(src)}" alt="${alt}" style="max-width:100%;height:auto;border:0;display:block;margin:0 auto;">`))
    .replace(/\[\[([^\]]+)\]\]\(([^)\s]+)\)/g, (_, label, href) =>
      keep(`<a href="${url(href)}" style="display:inline-block;background:${ACCENT};color:#ffffff;text-decoration:none;font-weight:600;padding:12px 24px;border-radius:6px;">${label}</a>`),
    )
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => keep(`<a href="${url(href)}" style="color:${ACCENT};">${label}</a>`))
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^\w*])\*(?!\s)(.+?)\*(?!\w)/g, "$1<em>$2</em>")
    .replace(/(^|[^\w])_(?!\s)(.+?)_(?!\w)/g, "$1<em>$2</em>")
    .replace(/\u0000(\d+)\u0000/g, (_, index) => saved[index]);
}

export function markdownToText(markdown) {
  return String(markdown)
    .replace(/\r\n?/g, "\n")
    .replace(/!\[([^\]]*)\]\([^)\s]+\)/g, "$1")
    .replace(/\[\[([^\]]+)\]\]\(([^)\s]+)\)/g, "$1: $2")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => (label === href ? href : `${label} (${href})`))
    .replace(/^#{1,3}\s+/gm, "")
    .replace(/^\s*([-*_])(\s*\1){2,}\s*$/gm, "----")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/(^|[^\w*])\*(?!\s)(.+?)\*(?!\w)/g, "$1$2")
    .replace(/(^|[^\w])_(?!\s)(.+?)_(?!\w)/g, "$1$2")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function htmlToText(html) {
  return unescapeHtml(
    String(html)
      .replace(/<(head|style|script|title)[\s\S]*?<\/\1>/gi, "")
      .replace(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, label) => {
        label = label.replace(/<[^>]+>/g, "").trim();
        return !label || label === href ? href : `${label} (${href})`;
      })
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|h[1-6]|li|tr|blockquote|table)>/gi, "\n\n")
      .replace(/<li[^>]*>/gi, "- ")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function unescapeHtml(text) {
  return String(text).replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, name) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " " })[name]);
}
