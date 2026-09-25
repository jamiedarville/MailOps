# MailOps

Basic email marketing, like a small Mailchimp, that runs on a free Cloudflare Worker and keeps your data as plain files in a **private** GitHub repository.

It grew out of [email-db](https://github.com/jamiedarville/email-db) (a signup form that saves to a CSV on GitHub) and keeps that idea: your list is a `contacts.csv` you can open in any spreadsheet, and every change is a commit you can look back on.

**Setup instructions: [SETUP.md](SETUP.md)**

## What it does

- **Signup forms** for your website, with spam protection (hidden spam trap and Cloudflare Turnstile), optional **double opt-in** by email, and optional interest checkboxes that tag people.
- **Contacts**: search, filter by status or tag, edit, tag in bulk, **import** CSV (including exports from email-db and Mailchimp) and **export** CSV.
- **Campaigns**: write in Markdown (or HTML) with merge tags like `{{FirstName|there}}`, preview, send yourself a test, choose an audience by tag, then **send now** or **schedule**.
- **Reports**: sent, delivered, opens, clicks (per link), unsubscribes, bounces and spam complaints.
- **Compliance built in**: every campaign has an unsubscribe link and your postal address, and supports one-click unsubscribe (required by Gmail and Yahoo for bulk senders). Hard bounces and spam complaints are removed from your list automatically.

## How it fits together

```
Your website's form ─┐
                     ▼
               Cloudflare Worker ──── reads/writes ───▶ contacts.csv, campaigns.json
               /admin dashboard                        in your PRIVATE GitHub repository
                     │
                     ▼
        CampaignRunner (Durable Object) ── sends in batches of 100 ──▶ Resend ──▶ inboxes
        keeps each campaign's report                                     │
                     ▲                                                   │
                     └──── opens, clicks, unsubscribes, bounces ◀────────┘
```

**This repository is public and holds only code.** Contacts never go in it: the Worker saves them to a separate private repository (`mailops-data` by default), and `.gitignore` blocks CSV files here as a safety net.

| Path | What it is |
| --- | --- |
| [`worker/`](worker) | The Cloudflare Worker: signup form, admin dashboard, sending, tracking |
| [`form/signup-form.html`](form/signup-form.html) | The form to copy into your website |
| [`data-template/`](data-template) | Empty starting files for your private data repository |
| [`SETUP.md`](SETUP.md) | Step-by-step setup guide and reference |

## Development

```sh
cd worker
npm install
npm test          # runs everything against in-memory fakes of GitHub and Resend
npx wrangler dev  # local server; put secrets in worker/.dev.vars
```
