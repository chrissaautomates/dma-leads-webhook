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

- If a row with that email already exists in the target sheet, it patches
  Status / Notes / Next Follow-up / Owner in place.
- If not, it appends a brand new row — so every new lead lands automatically
  too, not just status changes.
- Leads that look robot/BuyAndRentRobots-related route to the companion
  sheet; everything else goes to the DMA tab.

## One-time setup

1. **Create a Google service account** (Google Cloud Console → IAM & Admin →
   Service Accounts → Create → skip roles → Keys → Add key → JSON). Download
   the JSON key file.
2. **Enable the Google Sheets API** on that same GCP project.
3. **Share both sheets** (Master Leads Tracker and the BuyAndRentRobots
   companion sheet) with the service account's `client_email` (found inside
   the JSON key) as **Editor**.
4. **Deploy this repo to Railway** (or wherever) and set these environment
   variables:
   - `GOOGLE_SERVICE_ACCOUNT_JSON` — the entire JSON key file content, as one
     line (e.g. `cat key.json | jq -c .` to collapse it)
   - `MASTER_SHEET_ID` — the Drive file ID from the Master Tracker's URL
   - `MASTER_TAB_NAME` — `All DMA Leads`
   - `BARR_SHEET_ID` — the Drive file ID of the BuyAndRentRobots companion sheet
   - `WEBHOOK_SECRET` — any random string; callers must send it back as the
     `x-webhook-secret` header
5. **Generate a public domain** for the service (Railway → service → Settings
   → Networking → Generate Domain).
6. **In GHL**: on the workflow(s) that change contact/opportunity status, add
   a Webhook action → POST to `https://<your-domain>/webhook/lead` with the
   `x-webhook-secret` header set, and map GHL fields into the JSON shape
   above.
7. **In CheckCherry**: check Settings → Integrations for an outgoing webhook
   option and point it at the same URL. CheckCherry's payload field names
   will likely differ — once you see a sample payload, this server's mapping
   in `server.js` can be adjusted to match.

## Local test

```
npm install
GOOGLE_SERVICE_ACCOUNT_JSON='...' MASTER_SHEET_ID=... MASTER_TAB_NAME='All DMA Leads' BARR_SHEET_ID=... WEBHOOK_SECRET=test npm start
curl -X POST localhost:3000/webhook/lead \
  -H 'content-type: application/json' -H 'x-webhook-secret: test' \
  -d '{"source":"GHL","email":"klein@example.com","name":"Klein","interest":"humanoid robot Chicago","status":"New"}'
```
