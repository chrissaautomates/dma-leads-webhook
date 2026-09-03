// DMA & BuyAndRentRobots — Leads webhook receiver
//
// Receives lead/status events from GHL and CheckCherry and writes them
// straight into the Master Leads Tracker Google Sheet (and the
// BuyAndRentRobots companion sheet), matching existing rows by email or
// appending a new row when there's no match.
//
// Required environment variables (set these in Railway):
//   GOOGLE_CLIENT_ID      - OAuth 2.0 Client ID (Google Cloud Console -> Credentials)
//   GOOGLE_CLIENT_SECRET  - OAuth 2.0 Client Secret for that same client
//   GOOGLE_REFRESH_TOKEN  - refresh token obtained once via Google's OAuth
//                           Playground, authorizing the
//                           https://www.googleapis.com/auth/spreadsheets scope
//                           as the Google account that owns/edits the sheets
//   MASTER_SHEET_ID       - Drive file ID of "DMA & BuyAndRentRobots — Master Leads Tracker"
//   MASTER_TAB_NAME       - tab name inside that file holding DMA leads (e.g. "All DMA Leads")
//   BARR_SHEET_ID         - Drive file ID of the "BuyAndRentRobots — Leads" companion sheet
//   WEBHOOK_SECRET        - shared secret; incoming requests must send header x-webhook-secret
//
// Because auth is just the Google account's own OAuth token, both sheets
// only need to already be accessible to (owned by / shared with) that same
// Google account — no service account or extra sharing step required.

const express = require('express');
const { google } = require('googleapis');

const app = express();
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 3000;

function getAuth() {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return oauth2Client;
}

async function getSheetsClient() {
  const auth = getAuth();
  return google.sheets({ version: 'v4', auth });
}

// Reads header + all rows for a given spreadsheet/tab.
async function readTable(sheets, spreadsheetId, tabName) {
  const range = tabName ? `'${tabName}'!A1:Z10000` : 'A1:Z10000';
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  const rows = res.data.values || [];
  const header = rows[0] || [];
  return { header, rows, range: tabName || (res.data.range || '').split('!')[0] };
}

function colLetter(index) {
  let n = index + 1;
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - m) / 26);
  }
  return s;
}

// Tries to update an existing row matched by email. Returns true if it updated one.
async function updateExisting(sheets, spreadsheetId, tabPrefix, header, rows, data) {
  const emailCol = header.indexOf('Email');
  if (emailCol === -1 || !data.email) return false;
  const email = String(data.email).trim().toLowerCase();

  const patchCols = {
    Status: data.status,
    Notes: data.notes,
    'Next Follow-up': data.nextFollowUp,
    Owner: data.owner,
  };

  for (let i = 1; i < rows.length; i++) {
    const rowEmail = String(rows[i][emailCol] || '').trim().toLowerCase();
    if (rowEmail && rowEmail === email) {
      const updates = [];
      for (const [name, value] of Object.entries(patchCols)) {
        if (value === undefined || value === null || value === '') continue;
        const idx = header.indexOf(name);
        if (idx === -1) continue;
        const a1 = `${tabPrefix}${colLetter(idx)}${i + 1}`;
        updates.push({ range: a1, values: [[value]] });
      }
      if (updates.length) {
        await sheets.spreadsheets.values.batchUpdate({
          spreadsheetId,
          requestBody: { valueInputOption: 'USER_ENTERED', data: updates },
        });
      }
      return true;
    }
  }
  return false;
}

// Appends a brand new lead row, mapping known fields onto whatever columns exist.
async function appendNew(sheets, spreadsheetId, tabPrefix, header, data) {
  const fieldMap = {
    'Date Received': new Date().toISOString().slice(0, 10),
    Source: data.source || '',
    Name: data.name || '',
    Company: data.company || '',
    Email: data.email || '',
    Phone: data.phone || '',
    Location: data.location || '',
    'Interest / Request': data.interest || '',
    'Robot / Interest': data.interest || '',
    Status: data.status || 'New',
    Owner: data.owner || '',
    Notes: data.notes || '',
    'Next Follow-up': data.nextFollowUp || 'Yes',
  };
  const row = header.map((h) => (h in fieldMap ? fieldMap[h] : ''));
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${tabPrefix.replace(/!$/, '')}`.length ? tabPrefix.slice(0, -1) : 'A1',
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] },
  });
}

async function upsertLead(sheets, spreadsheetId, tabName, data) {
  const { header, rows } = await readTable(sheets, spreadsheetId, tabName);
  const tabPrefix = tabName ? `'${tabName}'!` : '';
  const updated = await updateExisting(sheets, spreadsheetId, tabPrefix, header, rows, data);
  if (!updated) {
    await appendNew(sheets, spreadsheetId, tabPrefix, header, data);
  }
  return { updated };
}

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

    const sheets = await getSheetsClient();
    const masterId = process.env.MASTER_SHEET_ID;
    const masterTab = process.env.MASTER_TAB_NAME || 'All DMA Leads';
    const barrId = process.env.BARR_SHEET_ID;

    const targetIsBarr = /humanoid|robot rental|buyandrentrobots/i.test(
      `${data.source || ''} ${data.interest || ''}`
    );

    let result;
    if (targetIsBarr && barrId) {
      result = await upsertLead(sheets, barrId, null, data);
    } else {
      result = await upsertLead(sheets, masterId, masterTab, data);
    }
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, () => console.log(`Leads webhook listening on ${PORT}`));
