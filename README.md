# DMA Leads Webhook + Admin

Receives leads from GHL, CheckCherry, and anywhere else, stores them in a
local database on this service, and gives Christine/Richard a password-
protected admin page to view, edit, and manually add leads — no Google
Sheets, no Apps Script, no external auth of any kind.

This replaced an earlier design that forwarded every lead to a Google Apps
Script Web App bound to a spreadsheet. That path was unreliable in practice
— Apps Script would often run successfully but the HTTP response back to
this server got mangled, and every code change needed a manual copy/paste +
redeploy cycle in the Apps Script editor. This version has no such moving
parts: leads write straight into this service's own SQLite database on a
Railway Volume.

## What it does

`POST /webhook/lead` accepts a JSON body describing a lead/status event:

```json
{
  "source": "GHL",
  "email": "person@company.com",
  "name": "Jane Klein",
  "company": "",
  "phone": "",
  "location": "Chicago, IL",
  "interest": "Looking to rent a humanoid robot",
  "status": "Proposal Sent",
  "notes": "Left a voicemail 9/2",
  "nextFollowUp": "Yes",
  "owner": "Christine"
}
```

- If a lead with that email already exists (within the same DMA/BuyAndRentRobots bucket), its Status / Notes / Next Follow-up / Owner are updated in place.
- Otherwise a new lead row is inserted.
- Leads whose `source` or `interest` mentions "humanoid", "robot rental", or "buyandrentrobots" are filed under BuyAndRentRobots; everything else under DMA.

`GET /admin` (HTTP Basic Auth) shows both lists as editable tables — change
a status, add notes, or use "Add a lead manually" for a phone-in or walk-up
lead. `GET /admin/export.csv?target=DMA` (or `target=BARR`) downloads a CSV
snapshot at any time — hand that to anyone who wants an Excel/Sheets copy.

## One-time setup

1. **Add a Railway Volume** mounted at `/data` on this service (Settings →
   Volumes → New Volume, mount path `/data`). This is where `leads.db`
   lives — without it, data is wiped on every redeploy.
2. **Set environment variables** in Railway:
   - `WEBHOOK_SECRET` — random string; callers must send it back as the `x-webhook-secret` header
   - `ADMIN_PASSWORD` — password for `/admin`
   - `ADMIN_USER` — username for `/admin` (optional, defaults to `admin`)
   - `DB_PATH` — optional, defaults to `/data/leads.db`
3. **Generate a public domain** for the service (Settings → Networking →
   Generate Domain) if it doesn't have one already.
4. **In GHL**: on the workflow(s) that change contact/opportunity status,
   add a Webhook action → POST to `https://<your-domain>/webhook/lead` with
   the `x-webhook-secret` header set, and map GHL fields into the JSON shape
   above.
5. **In CheckCherry**: check Settings → Integrations for an outgoing webhook
   option and point it at the same URL. If CheckCherry only offers a pull
   API (no outgoing webhooks), that's a separate polling job — ask about
   that when you're ready to wire it up.
6. **Bookmark `https://<your-domain>/admin`** — that's the leads page.

## Local test

```
npm install
DB_PATH=./leads.db WEBHOOK_SECRET=test ADMIN_PASSWORD=test npm start
curl -X POST localhost:3000/webhook/lead \
  -H 'content-type: application/json' -H 'x-webhook-secret: test' \
  -d '{"source":"GHL","email":"klein@example.com","name":"Klein","interest":"humanoid robot Chicago","status":"New"}'
# then open http://localhost:3000/admin (user: admin, password: test)
```

## Pushing new leads into GHL

New leads from **Wix Forms, Meta Ads, Google Ads and CheckCherry** are pushed
into the DMA Events GHL location as they are captured. The polling syncs and
the Google Ads webhook store the lead exactly as before, then hand the new row
to `ghl-push.js` (`pushLeadToGhl` — one shared implementation; per-source
differences live in `SOURCE_PROFILES`). The old `/api/leads/wix` relay was
retired — Wix now flows only through the Wix Forms sync.

What a push does: find the contact by email (else phone), create or update it
(canonical fields only, never overwriting a value with a blank), apply tags,
add a note. It does **not** create opportunities/tasks or send email/SMS —
GHL's own workflow does that when `new-lead` is applied.

| Source | Source tag | DMA Lead Source |
|---|---|---|
| Wix Forms (`Wix Form - …`) | `source-wix` | Website Form |
| Meta Ads | `source-meta` | Meta Ad |
| Google Ads | `source-google-ads` | Google Ad |
| CheckCherry (`/leads` feed only) | `source-checkcherry` | Check Cherry |

**Three destinations, no overlap.** After the duplicate lookup, an *existing*
GHL contact is put in exactly one bucket (tags matched by exact name, case-
insensitive — see `ADVANCED_TAGS` / `DEAD_DEAL_TAGS` in `ghl-canonical.js`;
never keywords):

| Bucket | Who | What the push does |
|---|---|---|
| **Skip** (active/booked) | carries any of the 16 `ADVANCED_TAGS`, **or** Lead Status beyond Nurture other than Lost / Not Ready | minimal update (last-activity + note). **No tags.** |
| **Re-engage** (dead deal) | carries one of the 5 `DEAD_DEAL_TAGS`, **or** Lead Status is Lost / Not Ready | minimal update + tag **`newsletter-reengagement`** only. Never `new-lead`. |
| **New-lead** (cold) | brand-new contact, or an existing one in neither bucket above | source tag + **`new-lead`** (unless already present) — but **only if CheckCherry has no event (proposal/booking) for that email, whichever source the lead came through.** |

**One email, several sources.** Leads dedupe by email *and* target, so the same
person arriving via Wix and CheckCherry is two rows but one GHL contact. Each
row is pushed on its own, so the decisions must agree regardless of order. They
do because the proposal check is shared: every successful CheckCherry cycle
stores its set of proposal emails (`proposal_emails` table) and **every** source
consults it — a proposal blocks `new-lead` for that email from any door. Until
that set has loaded once, non-CheckCherry pushes wait (fail closed); CheckCherry
leads always need this cycle's fresh set.

Active always wins: a contact that is both a dead deal and active (e.g. `proposal
expired` + `deposit`, or tag `expired-proposal` + Lead Status Won) is Skip.

`newsletter-reengagement` only *tags* the contact. The monthly newsletter itself
is a separate GHL workflow/broadcast that must also check **DMA Marketing Consent
= Yes** (CASL) before sending.

**Never pushed:** leads with status **Spam** (CheckCherry's spam flag, or set in `/admin` — re-checked at push time), BuyAndRentRobots leads (any lead whose text/UTMs match the
BARR keywords `humanoid | robot rental | buyandrentrobots`, or that is filed
under the BARR tab), Chat Lead (already in GHL), manual `/admin` entries,
`/webhook/lead` events, and CheckCherry proposal-event rows.

### Safety controls (env vars, set in Railway)

| Variable | Effect |
|---|---|
| *(none set)* | **DRY-RUN — the default.** Logs `[ghl-push][DRY-RUN] WOULD …` lines; sends nothing; marks nothing. Makes only read calls to GHL so the log reflects what live would do. |
| `GHL_PUSH_LIVE=true` | Send for real. **Requires** `GHL_PUSH_CUTOFF_DATE`; without a valid one it refuses and pushes nothing. |
| `GHL_PUSH_CUTOFF_DATE=YYYY-MM-DD` | Go-live date. Rows received before it never push. |
| `GHL_PUSH_DISABLED=true` | **Kill switch.** Nothing is evaluated or sent. (Railway restarts the service on a variable change.) |
| `GHL_CHECKCHERRY_SETTLE_MINUTES` | Hold a brand-new CheckCherry lead this long (default 10) so a proposal created moments later is caught on the next cycle. |

The `leads.ghl_pushed` column records push state per row. On first boot after
this change every existing row is stamped `legacy` (in the same transaction as
the `ALTER TABLE`), so the back catalog can never be sent. `NULL` = pending.
Other terminal values: `pushed`, `excluded_barr`, `excluded_source`,
`excluded_proposal`, `excluded_spam`, `skipped_no_contact`. A pending row that fails (GHL error)
or is deferred (CheckCherry events unavailable / settle window) is retried on
the next 15-minute cycle.

### Reading the dry-run list

- Railway logs: filter on `[ghl-push]`. Startup logs `GHL lead push mode: …`.
- **`GET /admin/ghl-preview?since=YYYY-MM-DD[&limit=50]`** (admin login):
  read-only. Runs already-stored rows received since that date through the same
  decision path and lists what would be pushed / tagged / skipped / excluded —
  the way to review real records before going live, since legacy rows are
  otherwise locked out. For every proposal match it prints the CheckCherry
  event(s) behind it (status, how created, date, which address, before/after the
  lead), a breakdown of possibly over-broad matches, and a section for emails
  that appear in more than one row (flags any disagreement as CONFLICT).

### Local test

`npm test` — GHL is fully mocked; nothing touches a real contact.
