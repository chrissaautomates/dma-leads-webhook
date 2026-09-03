// DMA & BuyAndRentRobots — Leads webhook receiver
//
// Receives lead/status events from GHL and CheckCherry, checks the shared
// secret, and forwards them to a Google Apps Script Web App bound to the
// Master Leads Tracker spreadsheet. The Apps Script does the actual sheet
// writing (matching by email to update an existing row, or appending a new
// one) and its own routing between the DMA tab and the BuyAndRentRobots
// companion sheet.
//
// This avoids needing any Google OAuth client, service account, or refresh
// token in this service at all — Apps Script runs as whoever deployed it,
// using their own already-authorized Google session, so there's no
// client_id/secret/token to manage or for Google to reject.
//
// Required environment variables (set these in Railway):
//   APPS_SCRIPT_URL   - the Web App URL from Deploy > New deployment, in the
//                        spreadsheet's Extensions > Apps Script editor
//   WEBHOOK_SECRET    - shared secret; incoming requests must send header
//                       x-webhook-secret

const express = require('express');

const app = express();
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 3000;

function checkSecret(req, res) {
  const expected = process.env.WEBHOOK_SECRET;
  if (!expected) return true; // no secret configured — allow (not recommended)
  if (req.get('x-webhook-secret') !== expected) {
    res.status(401).json({ ok: false, error: 'bad secret' });
    return false;
  }
  return true;
}

app.get('/health', (req, res) => res.json({ ok: true }));

// Single normalized endpoint. Point both GHL and CheckCherry webhook actions
// here; use the "source" field (or a query param ?source=ghl) to tag origin.
app.post('/webhook/lead', async (req, res) => {
  if (!checkSecret(req, res)) return;
  try {
    const data = { ...req.body };
    if (!data.source && req.query.source) data.source = req.query.source;

    const scriptUrl = process.env.APPS_SCRIPT_URL;
    if (!scriptUrl) {
      return res.status(500).json({ ok: false, error: 'APPS_SCRIPT_URL is not set' });
    }

    const upstream = await fetch(scriptUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(data),
      redirect: 'follow',
    });
    const text = await upstream.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }

    res.json({ ok: true, appsScript: parsed });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, () => console.log(`Leads webhook listening on ${PORT}`));
