# Setting up MailOps

This guide takes you from nothing to sending your first campaign. It's written to be followed in order.

**Time needed:** about an hour, most of it waiting for your email domain to be verified.

**You'll need:**

- A Cloudflare account. The free plan is enough.
- A GitHub account.
- A [Resend](https://resend.com) account for sending email. The free plan is enough to start (see [Limits](#limits)).
- A domain you can add DNS records to, such as `example.com`. Emails will come from an address on it.
- [Node.js](https://nodejs.org) 22 or newer and git on your computer.

## Contents

- [Step 1: Create the private data repository](#step-1-create-the-private-data-repository)
- [Step 2: Create a GitHub token](#step-2-create-a-github-token)
- [Step 3: Set up Resend](#step-3-set-up-resend)
- [Step 4: Deploy the Worker](#step-4-deploy-the-worker)
- [Step 5: Add the settings](#step-5-add-the-settings)
- [Step 6: Log in and bring in your contacts](#step-6-log-in-and-bring-in-your-contacts)
- [Step 7: Handle bounces and spam complaints](#step-7-handle-bounces-and-spam-complaints)
- [Step 8: Add the signup form to your website](#step-8-add-the-signup-form-to-your-website)
- [Step 9: Turn on spam protection (Turnstile)](#step-9-turn-on-spam-protection-turnstile)
- [Sending a campaign](#sending-a-campaign)
- [Optional extras](#optional-extras)
- [Settings reference](#settings-reference)
- [How it works](#how-it-works)
- [Limits](#limits)
- [Troubleshooting](#troubleshooting)
- [Maintenance](#maintenance)

---

## Step 1: Create the private data repository

MailOps keeps its code (this repository, which is **public**) apart from your data. Your contacts go in a second repository that **must be private**, because anyone can read a public repository.

1. On GitHub, select **+** (top right), then **New repository**.
2. Name it `mailops-data`, choose **Private**, and tick **Add a README file** (the repository needs at least one commit). Select **Create repository**.

That's all. The Worker creates `contacts.csv` and `campaigns.json` the first time it needs them. [`data-template/`](data-template) shows what they look like.

> **Coming from email-db?** Don't copy `list.csv` into this public repository. Bring it in through the dashboard in [step 6](#step-6-log-in-and-bring-in-your-contacts) instead.

## Step 2: Create a GitHub token

The Worker uses this token to read and save the files in `mailops-data`, and nothing else.

1. On GitHub, select your profile picture, then **Settings** → **Developer settings** → **Personal access tokens** → **Fine-grained tokens** → **Generate new token**.
2. Fill in the form:
   - **Token name:** `MailOps`
   - **Expiration:** up to a year away. Put a reminder in your calendar a week before it; see [Replacing the GitHub token](#replacing-the-github-token).
   - **Repository access:** **Only select repositories** → **mailops-data**.
   - **Permissions** → **Repository permissions** → **Contents:** **Read and write**. Leave everything else at **No access**.
3. Select **Generate token**, and copy the token (it starts with `github_pat_`) somewhere safe, such as a password manager, until step 5.

## Step 3: Set up Resend

Resend delivers the emails. MailOps talks to it with an API key.

1. Sign up at [resend.com](https://resend.com).
2. **Verify your domain:** go to **Domains** → **Add Domain**. Resend suggests a subdomain such as `send.example.com` or you can use your main domain. Add the DNS records it shows (SPF and DKIM) at your DNS provider, then select **Verify**. This can take from a few minutes to a few hours.
3. **Add a DMARC record** if your domain doesn't have one. Gmail and Yahoo require it for bulk senders. The simplest one is a TXT record named `_dmarc` with the value `v=DMARC1; p=none;`.
4. **Turn off Resend's own tracking:** open the domain, and make sure **Click tracking** and **Open tracking** are off. MailOps does its own tracking, and having both would rewrite every link twice.
5. **Create an API key:** go to **API Keys** → **Create API Key**, give it **Sending access** to your domain, and copy it (it starts with `re_`).

## Step 4: Deploy the Worker

MailOps uses a Durable Object (Cloudflare's way of running something in the background, used here to send campaigns in batches), so it has to be deployed from the command line.

```sh
git clone https://github.com/jamiedarville/MailOps.git
cd MailOps/worker
npm install
npx wrangler login     # opens your browser so you can allow access to your Cloudflare account
npx wrangler deploy
```

`wrangler deploy` prints the Worker's address when it finishes, like `https://mailops.<your-subdomain>.workers.dev`. Write it down.

If your GitHub account isn't `jamiedarville` or your data repository isn't called `mailops-data`, set `GITHUB_OWNER` and `GITHUB_REPO` in step 5.

## Step 5: Add the settings

In the Cloudflare dashboard, go to **Workers & Pages** → **mailops** → **Settings** → **Variables and Secrets**. For each row below select **Add**, choose the **Type**, enter the **Variable name** exactly as shown, and the value. Select **Deploy** when you've added them all.

**Secrets** (encrypted; Cloudflare never shows them again):

| Name | Value |
| --- | --- |
| `GITHUB_TOKEN` | The token from step 2. |
| `RESEND_API_KEY` | The API key from step 3. |
| `ADMIN_PASSWORD` | A long password for the dashboard. Use a password manager to make one. |
| `SIGNING_SECRET` | A long random value. Run `openssl rand -base64 32` to make one, or use a password manager. It signs unsubscribe links, so **don't change it later**: links in emails already sent would stop working. |

**Text variables:**

| Name | Example | What it's for |
| --- | --- | --- |
| `FROM_EMAIL` | `Jamie at Example <news@example.com>` | Who your emails come from. Must use the domain you verified in step 3. |
| `MAILING_ADDRESS` | `123 Main St, Montréal QC H2X 1Y4, Canada` | Shown in every email. Anti-spam laws (Canada's CASL, the US CAN-SPAM Act) require a postal address. A PO box is fine. |
| `ORG_NAME` | `Example Co` | Used in the footer: "You're receiving this email because you signed up for Example Co." |
| `PUBLIC_URL` | `https://mailops.<your-subdomain>.workers.dev` | The Worker's address from step 4, used for links in emails. |

You can also set these from the command line (in the `worker` folder): `npx wrangler secret put GITHUB_TOKEN`, and so on.

## Step 6: Log in and bring in your contacts

1. Open `https://mailops.<your-subdomain>.workers.dev/admin` and log in with `ADMIN_PASSWORD`.
2. The dashboard lists any settings still missing under **Finish setting up**.
3. To bring in an existing list (for example email-db's `list.csv`, or a Mailchimp export), go to **Contacts** → **Import CSV**, choose the file, tick the consent box, and select **Import**.
   - The first row must name the columns. Email is required; first name, last name, phone, tags and status are recognized under their common names. Other columns are kept.
   - Everyone new is added as **subscribed**, unless the file has a Status column.
   - People already on your list keep their status, so anyone who unsubscribed stays unsubscribed.

## Step 7: Handle bounces and spam complaints

When an address doesn't exist, or someone marks your email as spam, you must stop emailing them, or your emails start landing in spam for everyone. Resend tells MailOps about these through a webhook.

1. In Resend, go to **Webhooks** → **Add Webhook**.
2. **Endpoint URL:** `https://mailops.<your-subdomain>.workers.dev/webhooks/resend`
3. **Events:** `email.bounced`, `email.complained` and `email.delivered` (the last one is for the "Delivered" count in reports).
4. Create it, then copy its **Signing Secret** (it starts with `whsec_`).
5. In Cloudflare, add a **Secret** called `RESEND_WEBHOOK_SECRET` with that value, and select **Deploy**.

From then on, hard bounces are marked **bounced** and complaints **complained**, and neither gets another campaign.

## Step 8: Add the signup form to your website

1. Open [`form/signup-form.html`](form/signup-form.html) and copy everything between `<!-- COPY FROM HERE -->` and `<!-- COPY TO HERE -->`.
2. Replace `https://mailops.YOUR-SUBDOMAIN.workers.dev` with your Worker's address.
3. Paste it into your website: into the page's HTML, or into a **Custom HTML** / **Code** / **Embed** block in a site builder such as WordPress, Squarespace, Wix or Webflow.
4. Submit the form once. The new contact appears in **Contacts** in the dashboard. Delete it afterwards (open it, then **Delete contact**).

Keep the input names (`FirstName`, `LastName`, `Email`, `Phone`, `Tags`, `Source`) as they are. The label text and ids can change. The hidden `website` field is a spam trap: people never see it, but bots fill it in, and those submissions are dropped.

The Worker's own address (`https://mailops.<your-subdomain>.workers.dev/`) also shows a plain signup form, handy for testing or as a link to share.

**Send people back to your website afterwards (recommended):** add a Text variable `SUCCESS_URL` with the address of a thank-you page on your site, such as `https://example.com/thanks`.

## Step 9: Turn on spam protection (Turnstile)

1. In the Cloudflare dashboard, open **Turnstile** → **Add widget**. Name it `Signup form`, add your website's domain under **Hostnames** (and the Worker's `workers.dev` hostname, to protect its test form too), and choose **Managed** mode.
2. Copy the **Site Key** and **Secret Key**.
3. **First,** in the form on your website, delete the `<!-- TURNSTILE-START` and `TURNSTILE-END -->` lines, replace `YOUR-TURNSTILE-SITE-KEY` with your site key, and publish your website.
4. **Then** add a **Secret** called `TURNSTILE_SECRET_KEY` to the Worker with your secret key, and select **Deploy**. From now on every signup must pass the check, which is why the website goes first.
5. Optional: add a Text variable `TURNSTILE_SITE_KEY` with the site key to show the check on the Worker's own test form.

---

## Sending a campaign

1. In the dashboard, go to **Campaigns**, type a name (only you see it), and select **Create draft**.
2. Fill in the **subject line** and, optionally, the **preview text** (shown after the subject in most inboxes).
3. Choose the **audience**: tick one or more tags to send only to contacts with at least one of them, or leave them all unticked to send to everyone subscribed. The page shows how many contacts match.
4. Write the **content**. Select **Save and preview** to see it on the right, as a sample contact would.
5. Enter your own address under **Send a test** and select **Save and send test**. Check it on your phone and computer.
6. Select **Send now**, or pick a date and time and select **Schedule**. A scheduled campaign can be cancelled (it goes back to being a draft) until it starts.

While a campaign sends, its page shows progress and refreshes itself. You can **Stop sending** part way. Once it's sent, the same page is its report.

### Writing content

Markdown is the easiest way to write a good-looking email:

| You write | You get |
| --- | --- |
| `# Big heading`, `## Smaller heading` | Headings |
| `**bold**`, `*italic*` | **bold**, *italic* |
| `[our website](https://example.com)` | A link |
| `[[Shop the sale]](https://example.com/sale)` | A big button |
| `![A photo](https://example.com/photo.jpg)` | An image (it must be online already; upload it to your website first) |
| `- item` or `1. item` | A list |
| `> A quote` | A quote |
| `---` | A dividing line |

A blank line starts a new paragraph.

**Merge tags** fill in each person's details: `{{FirstName}}`, `{{LastName}}`, `{{Email}}`, or any other column in `contacts.csv`. Add a fallback for when it's empty: `Hi {{FirstName|there}}` becomes "Hi Ada", or "Hi there" when the first name is missing. They work in the subject line too.

To use your own HTML design instead, set **Content format** to **HTML**. If it's a full page (with `<body>`), MailOps adds the footer before `</body>` unless your design already includes `{{UnsubscribeURL}}`.

The footer with your `ORG_NAME`, `MAILING_ADDRESS` and an **Unsubscribe** link is added to every campaign automatically.

### Reading a report

- **Delivered:** accepted by the recipient's mail server (needs the webhook from step 7).
- **Opened:** estimated from a tiny image in the email. Some mail apps (notably Apple Mail) load images automatically, which counts as an open, and others block them. Treat it as a trend, not a fact. A click also counts as an open.
- **Clicked:** people who clicked at least one link. The table below shows clicks per link.
- **Unsubscribed, Bounced, Marked as spam:** people removed from the list because of this campaign.

## Optional extras

- **Double opt-in:** set the Text variable `DOUBLE_OPT_IN` to `true`. New signups get an email with a **Confirm** link, and only join the list (status **subscribed**) once they select it. Until then they're **pending**. This proves consent, which CASL and many European laws expect, and keeps fake addresses off your list.
- **Interest tags on the form:** set `SIGNUP_TAGS` to a comma-separated list, such as `Newsletter, Events`. Uncomment the interests block in the form on your website and give its checkboxes those values. People get the tags they tick, so you can send to just the people interested in events, for example. Tags that aren't in `SIGNUP_TAGS` are ignored, so nobody can invent their own.
- **Several forms:** use a different hidden `Source` value on each (such as `Website footer` and `Contest page`), to see in each contact's details where they signed up.
- **Your own domain for the Worker:** in Cloudflare, go to **Workers & Pages** → **mailops** → **Settings** → **Domains & Routes** → **Add** → **Custom domain**, such as `mail.example.com`. Then update `PUBLIC_URL`, the form's `action`, and the Resend webhook address.
- **Extra protection for the dashboard:** put [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/) in front of `/admin*` so only your email address can reach it, even before the password.
- **No tracking:** set `TRACKING` to `false` to leave out the open pixel and link redirects.

## Settings reference

Defaults are in [`worker/src/config.js`](worker/src/config.js). Override any of them with a Worker variable of the same name, then select **Deploy**. `wrangler deploy` keeps variables set in the dashboard, because `worker/wrangler.jsonc` sets `"keep_vars": true`.

| Name | Type | Default | What it does |
| --- | --- | --- | --- |
| `GITHUB_TOKEN` | Secret | **required** | Token for the data repository (step 2). |
| `RESEND_API_KEY` | Secret | **required to send** | Resend API key (step 3). |
| `ADMIN_PASSWORD` | Secret | **required for /admin** | Password for the dashboard. Changing it logs everyone out. |
| `SIGNING_SECRET` | Secret | **required** | Signs unsubscribe, confirm and tracking links, and the login cookie. Don't change it. |
| `RESEND_WEBHOOK_SECRET` | Secret | not set | Turns on the bounce and complaint webhook (step 7). |
| `TURNSTILE_SECRET_KEY` | Secret | not set | When set, every signup must pass Turnstile (step 9). |
| `FROM_EMAIL` | Text | **required to send** | Sender, e.g. `Name <news@example.com>`. |
| `REPLY_TO` | Text | empty | Where replies go, if not `FROM_EMAIL`. |
| `ORG_NAME` | Text | empty | Your name or organization, used in the footer and confirmation email. |
| `MAILING_ADDRESS` | Text | **required to send** | Postal address shown in every email. |
| `PUBLIC_URL` | Text | the dashboard's address | The Worker's address, used for links in emails. |
| `TIMEZONE` | Text | `America/Toronto` | Time zone for dates in the dashboard and for scheduling. Any [IANA name](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones), e.g. `Europe/London`. |
| `DOUBLE_OPT_IN` | Text | `false` | `true` to email new signups a confirmation link. |
| `SIGNUP_TAGS` | Text | empty | Tags a signup form may set, comma-separated. |
| `TRACKING` | Text | `true` | `false` turns off open and click tracking. |
| `SUCCESS_URL` | Text | empty | Where people go after signing up. Empty shows a built-in thank-you page. |
| `TURNSTILE_SITE_KEY` | Text | empty | Shows Turnstile on the Worker's own test form. |
| `GITHUB_OWNER` | Text | `jamiedarville` | Owner of the data repository. |
| `GITHUB_REPO` | Text | `mailops-data` | The data repository. **Must be private.** |
| `GITHUB_BRANCH` | Text | `main` | Branch to save to. |
| `CONTACTS_PATH` | Text | `contacts.csv` | Path of the contacts file in the data repository. |
| `CAMPAIGNS_PATH` | Text | `campaigns.json` | Path of the campaigns file in the data repository. |

## How it works

### Your data

- **`contacts.csv`**: one row per person, with columns `Email, FirstName, LastName, Phone, Status, Tags, Source, CreatedAt, UpdatedAt`. You can add columns of your own (say, `City`), and use them as merge tags. Tags are separated by semicolons.
- **Status** is one of: **subscribed** (gets campaigns), **pending** (signed up, hasn't confirmed yet), **unsubscribed**, **bounced** or **complained**. Only subscribed contacts are ever emailed.
- **`campaigns.json`**: every campaign's content, audience and status (draft, scheduled, sending, sent, stopped or failed).
- Every change is a commit. Commit messages never contain anyone's details. On GitHub the commits appear as made by you, because the token is yours.
- **Reports** (opens, clicks and so on) live in each campaign's Durable Object at Cloudflare rather than on GitHub, because they change far too often for a commit each time.

### Signups

1. The spam trap and (if set up) Turnstile are checked.
2. Details are tidied and checked: first name, last name and email are required, the email must look valid, and phone numbers keep only their digits.
3. If the email address is already on the list, nothing is duplicated: their tags are added to and empty details filled in. Someone who unsubscribed and signs up again is subscribed again.
4. The visitor sees the same thank-you page either way, so the form never reveals who's on the list.

### Sending

When a campaign's send time comes, its Durable Object takes a snapshot of who matches the audience, renders the email once, then sends it through Resend in batches of 100, pausing about a second after every two batches. Each batch has an idempotency key, so if anything fails part way the batch is retried without anyone getting it twice. If sending keeps failing (for example, Resend's daily quota is reached), it retries with growing pauses for about 15 minutes, then marks the campaign **failed** and shows the reason, with a **Try again** button.

Every email has a personal unsubscribe link and the `List-Unsubscribe` headers that let Gmail, Yahoo and Apple Mail show their own **Unsubscribe** button. Unsubscribing takes one click on a confirmation page (so link-checking software in mail systems can't unsubscribe people by accident), and it's immediate: someone who unsubscribes from a campaign that's still sending is skipped for the rest of it.

## Limits

- **Resend's free plan** allows about 3,000 emails a month and 100 a day ([current pricing](https://resend.com/pricing)). A campaign bigger than the daily allowance will fail part way; the paid plans remove the daily limit.
- **Cloudflare Workers free plan:** 100,000 requests a day, and 10 ms of CPU time per request. Each signup and admin action reads and rewrites the whole `contacts.csv`, so the time grows with the list. Up to a few thousand contacts works well. Beyond that, large imports or signups may fail with error 1102; the fix is the Workers Paid plan ($5 a month), which also raises the Durable Object limits.
- **GitHub** limits how many commits can be made, roughly 80 a minute and 500 an hour. Each signup, unsubscribe and bounce is one commit, which is plenty for a normal list, but a flood of bot signups could reach it, which is another reason to use Turnstile.
- **Campaign content** can be up to 100,000 characters. Images must be hosted elsewhere (such as on your website) and linked; attachments aren't supported.

## Troubleshooting

**Start with the logs.** In Cloudflare, go to **Workers & Pages** → **mailops** → **Logs**, or run `npx wrangler tail` in the `worker` folder, then try again. Errors in the dashboard also show the actual problem.

| What you see | What's wrong and how to fix it |
| --- | --- |
| **Admin not set up** | Add the `ADMIN_PASSWORD` and `SIGNING_SECRET` secrets (step 5), then **Deploy**. |
| An error mentioning `HTTP 401` from GitHub | The GitHub token is wrong or has expired. See [Replacing the GitHub token](#replacing-the-github-token). |
| `HTTP 403` or `HTTP 404` from GitHub | The token can't reach the data repository. Check its **Repository access** and **Contents: Read and write**, and that `GITHUB_OWNER` and `GITHUB_REPO` are right. The repository must have at least one commit. |
| `Sending failed (HTTP 403)` | `FROM_EMAIL` isn't on a domain verified in Resend, or the domain isn't verified yet. |
| `Sending failed (HTTP 429)` | Resend's rate limit or daily quota was reached. Wait, or upgrade your Resend plan, then select **Try again** on the campaign. |
| `The CAMPAIGNS Durable Object binding is missing` | The Worker was deployed some other way. Deploy it with `npx wrangler deploy` (step 4). |
| Campaign links go to the wrong address | Set `PUBLIC_URL` to the Worker's address (step 5). |
| Emails land in spam | Check that SPF, DKIM and DMARC are set up (step 3), that the webhook is removing bounces (step 7), and that everyone on your list asked to hear from you. Avoid sending to old lists that haven't heard from you in years. |
| Opens look too high | Apple Mail loads images automatically for privacy, which counts as an open. Rely on clicks instead. |
| The thank-you page appears but no contact is added | The email address is already on the list. Test with a different one. |
| **The spam check didn't pass** every time | `TURNSTILE_SECRET_KEY` is set but the form has no Turnstile widget, the keys come from different widgets, or your domain isn't in the widget's **Hostnames**. |

## Maintenance

### Replacing the GitHub token

GitHub emails you before the token expires. Open it under **Developer settings** → **Fine-grained tokens**, select **Regenerate token**, and copy the new value. Then in Cloudflare, edit the `GITHUB_TOKEN` secret, paste the new value and select **Deploy** (or run `npx wrangler secret put GITHUB_TOKEN`). If a token is ever leaked, delete it on GitHub right away and make a new one.

### Updating MailOps

```sh
cd MailOps
git pull
cd worker
npm install
npm test
npx wrangler deploy
```

### Working with the data directly

- **Download your list:** use **Export** on the Contacts page, or open `contacts.csv` in `mailops-data` on GitHub and select **Download raw file**.
- **Edit on GitHub:** you can edit `contacts.csv` on GitHub at any time. If a signup arrives while you're editing, GitHub may refuse to save your change; reload the page and make it again.
- **Edited in Excel?** Keep the header row and save as **CSV UTF-8** so accented names stay intact.
- **Removing someone's data** (for example, if they ask you to): open the contact in the dashboard and select **Delete contact**. Their details stay in the data repository's commit history; to remove them from there too, see GitHub's guide to [removing sensitive data](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository).
