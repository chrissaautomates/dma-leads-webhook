# DMA Leads Webhook

Keeps the "DMA & BuyAndRentRobots — Master Leads Tracker" Google Sheet (and its
BuyAndRentRobots companion sheet) updated automatically from GHL and
CheckCherry, instead of anyone editing it by hand.

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

This service checks the shared secret and forwards the data to a Google Apps
Script Web App bound to the spreadsheet. The Apps Script does the actual
writing:

- If a row with that email already exists in the target sheet, it patches
  Status / Notes / Next Follow-up / Owner in place.
- If not, it appends a brand new row — so every new lead lands automatically
  too, not just status changes.
- Leads that look robot/BuyAndRentRobots-related route to the companion
  sheet; everything else goes to the DMA tab.

There's no Google OAuth client, service account, or refresh token anywhere in
this service — Apps Script runs as whoever deployed it, using their own
already-authorized Google session, so there's nothing for this server to
authenticate as.

## One-time setup

1. **Set up the Apps Script side** (do this once, in the spreadsheet itself):
   - Open the Master Leads Tracker in Google Sheets, as an account that can
     edit it (e.g. chrissaautomates@gmail.com).
   - Extensions → Apps Script. Delete any starter code, paste in the contents
     of `leads_webhook.gs` from this repo.
   - Deploy → New deployment → type **Web app** → Execute as: **Me** → Who
     has access: **Anyone** → Deploy. Authorize when prompted (a normal
     one-click consent for your own script, not a third-party OAuth app).
   - Copy the Web app URL it gives you.
   - To push a change to the script later without the URL changing: Deploy →
     Manage deployments → pencil icon → Version: New version → Deploy.
2. **Deploy this repo to Railway** (or wherever) and set these environment
   variables:
   - `APPS_SCRIPT_URL` — the Web app URL from step 1
   - `WEBHOOK_SECRET` — any random string; callers must send it back as the
     `x-webhook-secret` header
3. **Generate a public domain** for the service (Railway → service → Settings
   → Networking → Generate Domain).
4. **In GHL**: on the workflow(s) that change contact/opportunity status, add
   a Webhook action → POST to `https://<your-domain>/webhook/lead` with the
   `x-webhook-secret` header set, and map GHL fields into the JSON shape
   above.
5. **In CheckCherry**: check Settings → Integrations for an outgoing webhook
   option and point it at the same URL. CheckCherry's payload field names
   will likely differ — once you see a sample payload, the mapping in
   `leads_webhook.gs` can be adjusted to match.

## Local test

```
npm install
APPS_SCRIPT_URL='...' WEBHOOK_SECRET=test npm start
curl -X POST localhost:3000/webhook/lead \
  -H 'content-type: application/json' -H 'x-webhook-secret: test' \
  -d '{"source":"GHL","email":"klein@example.com","name":"Klein","interest":"humanoid robot Chicago","status":"New"}'
```
