// DMA & BuyAndRentRobots — Leads webhook receiver + admin page
//
// Receives lead/status events from GHL and CheckCherry and writes them
// straight into a local SQLite database on this service's own Railway
// Volume. A password-protected /admin page lets Christine/Richard view,
// edit, and manually add leads.
//
// This replaces the earlier design that round-tripped every lead through a
// Google Apps Script Web App bound to a spreadsheet. That path turned out to
// be unreliable in practice: Apps Script would run the request successfully
// server-side, but the HTTP response back to the caller was inconsistent,
// and every code change needed a manual copy/paste + redeploy cycle in the
// Apps Script editor. A local database with its own admin UI has no such
// moving parts.
//
// Required environment variables (set these in Railway):
//   WEBHOOK_SECRET   - shared secret; incoming lead requests must send it
//                       back as the x-webhook-secret header
//   ADMIN_PASSWORD   - password for the /admin page (Basic Auth)
//   ADMIN_USER       - username for /admin (optional, defaults to "admin")
//   DB_PATH          - where to store the SQLite file (optional, defaults
//                       to /data/leads.db — requires a Railway Volume
//                       mounted at /data)

const express = require('express');
const { upsertLead } = require('./db');
const adminRouter = require('./admin');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

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

app.use('/admin', adminRouter);

// Single normalized endpoint. Point both GHL and CheckCherry webhook actions
// here; use the "source" field (or a query param ?source=ghl) to tag origin.
app.post('/webhook/lead', (req, res) => {
  if (!checkSecret(req, res)) return;
  try {
    const data = { ...req.body };
    if (!data.source && req.query.source) data.source = req.query.source;

    const result = upsertLead(data);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, () => console.log(`Leads webhook listening on ${PORT}`));
