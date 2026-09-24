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

## Wix → GHL lead intake (`POST /api/leads/wix`)

A second, separate endpoint: receives a lead submitted through the Wix
public website form (via a Wix Velo backend `.jsw` function — see
`wix-example/`) and creates/updates the matching DMA Events GHL contact
directly, using only the canonical DMA fields/tags documented in
`docs/ghl-canonical-fields.md` / `docs/ghl-canonical-tags.md`. It does
**not** touch the local `leads.db` used by everything else in this
README — it's a push straight to GHL, kept deliberately separate from the
pull-based syncs above.

It deliberately does **not** create an opportunity, create a sales task, or
send any email/SMS — Workflow 1 ("New Lead- Send Services - Email
Sequence", GHL workflow ID `d79a76bd-c787-425a-8588-2b3594714d64`) already
does all of that the moment a new contact is created. See
`docs/wix-ghl-existing-contact-behavior.md` for what happens (and doesn't)
when Wix submits a lead who's already a GHL contact.

### Setup

1. **Environment variables** (in addition to the ones above):
   - `WIX_WEBHOOK_SECRET` — random string; the Wix backend function must send
     it back as `Authorization: Bearer <secret>` (or an `x-wix-webhook-secret`
     header). Separate from `WEBHOOK_SECRET` above — different callers,
     rotate independently.
   - `GHL_API_KEY` / `GHL_LOCATION_ID` — already used by `sync.js`'s GHL
     chat-lead pull; reused here for the push direction too.
2. **In Wix**: add `wix-example/backend.jsw` and `wix-example/frontend.js`
   (or your own equivalents) to your site, following the setup comments at
   the top of `backend.jsw` (Secrets Manager entry + real deployed URL).

### Local test

```
DB_PATH=:memory: WIX_WEBHOOK_SECRET=test GHL_API_KEY=test GHL_LOCATION_ID=WWFoHKH8wu9QTuAKBUzK npm start
curl -X POST localhost:3000/api/leads/wix \
  -H 'content-type: application/json' -H 'authorization: Bearer test' \
  -d '{"firstName":"Jane","email":"jane@example.com","eventType":"Corporate","interest":"AI Photo Booth"}'
```

Note this will make a *real* call to the GHL API if `GHL_API_KEY` is a real
key — for local development against fake data, use the automated tests
instead (`npm test`), which mock the GHL API entirely and never touch a
real DMA contact.
