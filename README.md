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
| **Skip** (active/booked) | carries any of the 16 `ADVANCED_TAGS`, **or** Lead Status beyond Nurture other than Lost / Not Ready | minimal update (last-activity + note). No source / new-lead / nurture tags — only the event tags below. |
| **Re-engage** (dead deal) | carries one of the 5 `DEAD_DEAL_TAGS`, **or** Lead Status is Lost / Not Ready | minimal update + tag **`newsletter-reengagement`** (+ the event tags below). Never `new-lead`. |
| **New-lead** (cold) | a **brand-new** contact (created by the push) | source tag + **`new-lead`** — but **only if CheckCherry has no event (proposal/booking) for that email, whichever source the lead came through.** An *existing* contact never gets `new-lead` from the push; it gets `repeat-inquiry` instead (below). |

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

**Standard lead shape.** Every source fills the same 11 fields — `eventDate`,
`eventType`, `guestCount`, `budgetRange`, `city`, `interest`, `secondaryInterest`,
`leadType`, `marketingConsent`, `campaign`, `owner` (`lead-shape.js`; stored as real
`leads` columns). Answers no field can take go to `leads.extra` and the GHL note.
`toPlanBody` passes all of them to `buildLeadPlan`, which matches picklists
(event type, budget, interest, lead type), writes Guest Count as a number, and
keeps anything unmatched in the note. **Marketing Consent is written as exactly `Yes` when
consent was given, and not written otherwise** (never `No`, never `Unknown`). Lead Score is
not written. Last Activity reads like `Wix Form Submission — <form> — <what they asked for>`.

**Every submission counts.** Leads dedupe by email in the database, so a second submission only
updates the stored row; each source's own submission id (Wix submission id, Meta leadgen id,
Google lead id, CheckCherry lead id — stored in `submissions`) is what lets every NEW submission
reach GHL, exactly once, as a repeat inquiry (live: dated on/after `GHL_PUSH_CUTOFF_DATE`; a
`legacy` row's own back-catalog submission is never re-pushed). Email stays the contact match key.

**Marketing consent for Canadian numbers:** when there is no consent answer and the phone is Canadian
(libphonenumber region CA, so US `+1` numbers don't count), Marketing Consent is set to `Yes` if empty
or `Unknown`, and the contact gets `consent-implied-inquiry`. An existing `No` (or `Yes`) and an
explicit `No` answer on the form are never overridden; non-Canadian or missing numbers are left alone;
advanced / dead-deal contacts are not touched; the backfill never implies consent.

**Existing GHL contacts** (matched by email, else phone):
- `repeat-inquiry` is added to **every** existing contact (removed first if already present, so a GHL
  *Tag Added* trigger fires each time). `new-lead` is applied only when the contact is created.
- Lead Score, Lead Status and Lead Source are never written to an existing contact; Sales Owner only
  fills an empty one. Every other field is written **only if empty** (name, phone, company, city,
  campaign, event type, budget, lead type, consent `Yes`; a picklist value that isn't one of the field's options, e.g. an Event Type of `estimated_guest_count:` left by a broken upstream parser, counts as empty), except **event date** (replaced when the new
  date is later than the one on file) and **guest count** (replaced when the event isn't older; with no
  new date it only fills an empty field). Interest is merged into what the contact already has.
  Last Activity is always updated.
- Source-form tags apply to new and existing contacts alike, and like `repeat-inquiry` are removed then re-added when already present so they fire every time: `proposal-requested` (form name matches
  quote/proposal) and `quiz-completed` (form name matches quiz) — rules in `FORM_TAG_RULES`, `config.js`.
- **CheckCherry proposal sent:** when the events feed shows a proposal out (status
  `proposal_date_open` / `proposal_date_reserved` / `awaiting_signature`) for someone who already exists
  in GHL, that contact gets `cc-proposal-sent` (primary email only; never creates a contact; dry-run
  logs `WOULD TAG`; live only for events created on/after `GHL_PUSH_CUTOFF_DATE`; each event once).

**19 standard fields** (what dry-run lines report as `fields n/19 set=[…] blank=[…]
not-written-by-design=[Lead Score]`): Lead Source, Campaign, Lead Type, Company, Contact,
Email, Mobile, Event Date, City, Guest Count, Interested In, Secondary Interest, Budget
Range, Event Type, Lead Score, Sales Owner, Status, Last Activity, Marketing Consent.
Lead Score is never written, so it is reported as "by design", not blank.
A range guest count (`100-150`) writes the **high end** and keeps the original text in
the note.

**BuyAndRentRobots exclusion** (push guard only, exclusion only): besides the keyword list in
`db.js` (`BARR_PATTERN`, unchanged), `BARR_EXCLUSION` in `config.js` excludes by source pattern
(`/^BuyAndRentRobots/i`), campaign pattern (`/buyandrentrobots/i`) and exact `campaignNames`
(empty until real BARR campaigns are identified). For **CheckCherry** leads the keyword scan covers
only source, campaign/UTM and the lead's own inquiry (packages, event type, their own message),
never staff notes, company or venue — a Won DMA booking with "Humanoid Bot" in its notes is not BARR.

**Test / internal leads** never enter the funnel (terminal state `excluded_test`;
dry run logs `WOULD EXCLUDE … — reason`): anything matching `TEST DMA` in name, email or
company, plus exact addresses / `@domain`s in `INTERNAL_EXCLUDE` (`config.js`) or the
`GHL_EXCLUDE_EMAILS` env var (comma-separated).

**CheckCherry attributes** are read strictly from `CHECKCHERRY_ATTRIBUTES` in `config.js`
(one exact name per field, no fall-through; a missing attribute leaves the field blank and
logs one `[checkcherry-mapper]` line per lead). `null` entries stay blank until confirmed.

One-time setup / maintenance (both **dry-run by default**, `--apply` to write).

> **`railway ssh` vs `railway run`.** The leads database exists only on the Railway volume
> (`/data/leads.db`, inside the container). Anything that touches the database must run
> in the container with `railway ssh -- sh -c 'cd /app && node scripts/…'`. `railway run`
> executes on your own machine (with Railway's variables), where that path does not exist.
> `scripts/create-ghl-fields.js` is the one that works with `railway run`: it only calls GHL.


- `railway run node scripts/create-ghl-fields.js` — (re-checks for an existing field of the same name right before every create, so it never duplicates; sends the *full* merged option list when updating a picklist and verifies afterwards that no original option was lost) creates Guest Count (number) and Lead Type
  (single select), adds Glambot / Robotics / LED Tunnel / DMA Engage / Holiday /
  Headshot to the interest picklist, prints the IDs to set as
  `GHL_FIELD_GUEST_COUNT_ID` and `GHL_FIELD_LEAD_TYPE_ID`. Until those are set,
  Lead Type is not written and Guest Count is kept in the note.
- `railway ssh -- sh -c 'cd /app && node scripts/backfill-ghl-fields.js [--source wix|meta|google|checkcherry] [--limit N] [--apply]'`
  — walks the stored lead rows (not GHL tags), looks each contact up in GHL by email,
  fills only blank fields (never overwrites; skips advanced / dead-deal contacts, rows
  with no email, and BARR / spam / test rows) and reports, per source, rows matched,
  contacts not found in GHL, and how many contacts are still missing each field.
  `--limit N` = first N contacts (newest first) per source.
- `CHECKCHERRY_API_KEY=… node scripts/inspect-checkcherry-leads.js` — lists the real
  `/leads` attribute names, then set them in `CHECKCHERRY_ATTRIBUTES` (`config.js`).

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
Other terminal values: `pushed`, `excluded_barr`, `excluded_source`, `excluded_test`,
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

## Google Ads offline conversions (CheckCherry leads -> Google Sheet)

When `syncCheckCherry` inserts a **new** lead, `google-ads.js` appends one row to the **first tab** of the
sheet in `GOOGLE_ADS_CONVERSION_SHEET_ID`, which Google Ads imports on a schedule (Conversions > Uploads >
Google Sheets). Columns, in order: **A** Google Click ID (gclid, blank if none) · **B** Conversion Time
(`America/Toronto`, DST aware, `yyyy-MM-dd HH:mm:ss±HH:MM`) · **C** Conversion Value (blank) · **D** Currency
(`CAD`) · **E** Order ID (the CheckCherry lead id) · **F** SHA-256 of the email (trimmed, lowercased) ·
**G** SHA-256 of the phone as E.164.

A row is appended only if it has a gclid, an email or a phone, and its Order ID is not already in column E.
Existing leads are never back-filled; spam and test leads (and test data: a gclid starting with `TEST`, or `utm_campaign` "test") are skipped; a lead with a gclid older than 90 days
is skipped. Every attempt is logged (`[google-ads] …`) and recorded in `ads_conversions` (`error` is retried
up to 5 times on later syncs). The gclid is stored on the lead row (`gclid`, `gbraid`, `wbraid`; fill-only).
The landing page must pass the click id into CheckCherry (a hidden `gclid` field populated from the URL).

At startup the app logs which Google account the Sheets token belongs to: **share the sheet with that
account as Editor**.

| Env var | Purpose |
|---|---|
| `GOOGLE_ADS_CONVERSION_SHEET_ID` | **Required.** The Google Sheet to append to |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` | OAuth; the refresh token needs the `spreadsheets` scope |
| `GOOGLE_ADS_UPLOAD_DRY_RUN=true` | Log the row (hashes only) instead of appending; no network calls, nothing recorded |
| `GOOGLE_ADS_UPLOAD_DISABLED=true` | Kill switch |

## Marketing attribution (CheckCherry -> GHL)

CheckCherry leads and events expose `gclid` and the five `utm_*` values as attributes, plus `source` and
`origin` ("Online Booking" / "Lead Form"). `attribution.js` extracts them (stored on the lead row), derives
`lead_channel`, and the GHL push writes them to contact fields **first touch wins** (new contact: written;
existing contact: only into a blank field, via the same fill-blank logic as every other field).

`lead_channel`: a gclid/gbraid/wbraid => **Google Ads** (the only value that gets the `google-ads` tag);
`utm_content=hero_cta` without a click id => **Website**; `utm_source=google` + `utm_medium=cpc` without a click id =>
**Google (unverified)**; facebook/instagram/meta => **Meta Ads**; otherwise `utm_source`, or **Direct / Unknown**.
Spam leads get no attribution.

Setup: `railway run node scripts/create-ghl-fields.js` (dry run) then `--apply` creates the TEXT fields `DMA gclid`,
`DMA utm_source`, `DMA utm_medium`, `DMA utm_campaign`, `DMA utm_term`, `DMA utm_content`, `lead_channel`, `lead_origin`
(names that collide with GHL standard/attribution fields get a "DMA " prefix; the contacts API cannot set the standard `gclid`)
and prints
`GHL_FIELD_GCLID_ID`, `GHL_FIELD_UTM_SOURCE_ID`, ... to set on Railway. Until set, those fields are skipped (the tag still applies).

Backfill (last 60 days, matches by email then phone, never creates contacts):
`railway run npm run backfill:attribution` (dry run) / `railway run node scripts/backfill-attribution.js --apply`.

## BuyAndRentRobots intake (`POST /webhook/barr-lead`)

Takes a BuyAndRentRobots lead (`type`: `supplier`, `renter` or `buyer`) and upserts it into GHL
with the same field mapping as every other source. It does **not** go through the DMA push guard
(which excludes BuyAndRentRobots on purpose) and never writes the leads database.

- **Auth:** `x-barr-secret` header = `BARR_INTAKE_SECRET`. Unset secret = every request refused (503).
- **Mode:** dry-run by default (read-only GHL lookups, nothing written). `BARR_INTAKE_LIVE=true` writes.
  `GHL_PUSH_DISABLED=true` (the existing kill switch) turns it off.
- **Match:** lowercase email; with no email, exact company name (case/whitespace-insensitive). Never phone.
  A request needs an email or a company.
- **Tags:** exactly one of `barr-supplier`, `barr-renter`, `barr-buyer`, plus `barr-event-passed` when `eventDate` is before today. Never `new-lead`, `repeat-inquiry`
  or any source/interest/lead-type tag; nothing is removed.
- **Lead Source:** native contact source `BuyAndRentRobots` always; the DMA Lead Source field gets
  `BuyAndRentRobots` on new contacts only once that option exists in the GHL picklist (add it by hand).
- **Body:** `type`, `email`, `name`, `phone`, `company`, `city`, `message`, `interest`, `eventType`, `eventDate`,
  `guestCount`, `budgetRange`, `campaign`, `pageUrl`, `website`. Responses: 200 `{ok, mode, action, contactId, matchedBy, tags}`,
  400 invalid, 401 bad secret, 502 GHL failed (retry).

Backfill: `node scripts/backfill-barr-leads.js [--file barr_leads_review.csv] [--limit N]` is a dry run;
add `--commit` to write. Oldest row first, undated rows last; column names are matched by alias.

**Dashboard.** A live request (`BARR_INTAKE_LIVE=true`) also adds the lead to the `/admin` BuyAndRentRobots tab
(source `BuyAndRentRobots Website`, `ghl_pushed = excluded_source`, so the DMA push never touches it). Matched on
email, else company; an existing row keeps its status and notes. `dateReceived` (YYYY-MM-DD) sets the received date.
`dashboardOnly: true` writes only the dashboard row and nothing to GHL. Backfill:
`railway run -- node scripts/backfill-barr-leads.js --file x.csv --dashboard-only --dashboard-url https://<host> [--commit]`
(add `--dashboard-url` without `--dashboard-only` to do GHL and the dashboard together).
