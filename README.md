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

This uses OAuth (your own Google account's login), not a service account —
no JSON key file, no extra sharing step. The sheets just need to already be
in the Google account you authorize with below (photoworkshops@gmail.com).

1. **Create an OAuth 2.0 Client ID** in Google Cloud Console → APIs &
   Services → Credentials → Create Credentials → OAuth client ID.
   - Application type: **Web application**
   - Authorized redirect URIs: add `https://developers.google.com/oauthplayground`
   - Save it, then copy the **Client ID** and **Client Secret** it shows you.
2. **Enable the Google Sheets API** on that same GCP project (APIs &
   Services → Library → search "Google Sheets API" → Enable), if it isn't
   already.
3. **Get a refresh token** using Google's OAuth Playground
   (https://developers.google.com/oauthplayground):
   - Click the gear icon (top right) → check "Use your own OAuth
     credentials" → paste in the Client ID and Client Secret from step 1.
   - In Step 1 on the left, find and select the scope
     `https://www.googleapis.com/auth/spreadsheets` → Authorize APIs.
   - Sign in as **photoworkshops@gmail.com** (the account that owns/edits
     the sheets) and accept.
   - In Step 2, click **Exchange authorization code for tokens** → copy the
     **Refresh token** it gives you.
4. **Deploy this repo to Railway** (or wherever) and set these environment
   variables:
   - `GOOGLE_CLIENT_ID` — from step 1
   - `GOOGLE_CLIENT_SECRET` — from step 1
   - `GOOGLE_REFRESH_TOKEN` — from step 3
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

Note: a refresh token obtained this way keeps working indefinitely as long
as it's used at least once every 6 months and access isn't revoked from the
Google account's "Third-party apps & services" settings — no need to redo
this setup periodically.

## Local test

```
npm install
GOOGLE_CLIENT_ID='...' GOOGLE_CLIENT_SECRET='...' GOOGLE_REFRESH_TOKEN='...' MASTER_SHEET_ID=... MASTER_TAB_NAME='All DMA Leads' BARR_SHEET_ID=... WEBHOOK_SECRET=test npm start
curl -X POST localhost:3000/webhook/lead \
  -H 'content-type: application/json' -H 'x-webhook-secret: test' \
  -d '{"source":"GHL","email":"klein@example.com","name":"Klein","interest":"humanoid robot Chicago","status":"New"}'
```
