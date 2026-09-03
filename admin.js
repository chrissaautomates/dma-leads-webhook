// Simple server-rendered admin page for viewing/editing leads directly —
// no Google Sheets, no Apps Script. Protected with HTTP Basic Auth using
// ADMIN_USER / ADMIN_PASSWORD env vars, plus a magic-link cookie login:
// visit /admin/login?key=<ADMIN_PASSWORD> once and a long-lived cookie logs
// you in on every visit after that, without the browser's Basic Auth popup.

const crypto = require('crypto');
const express = require('express');
const { listLeads, getLead, updateLeadFromAdmin, addLeadFromAdmin } = require('./db');

const router = express.Router();
const SESSION_COOKIE_NAME = 'dma_admin_session';

// The cookie's value is a hash derived from ADMIN_PASSWORD, not the raw
// password itself — deterministic (same password -> same token), so it
// isn't a per-session secret and can't be individually revoked without
// rotating ADMIN_PASSWORD, but it does mean the password itself is never
// sitting in a cookie readable via document.cookie or a browser history
// entry.
function sessionToken() {
  const pass = process.env.ADMIN_PASSWORD || '';
  return crypto.createHash('sha256').update(`dma-leads-admin-session:${pass}`).digest('hex');
}

// Express has no cookie-parsing middleware installed (no cookie-parser
// dependency) — parse the raw Cookie header directly rather than add one
// just for this.
function parseCookies(req) {
  const header = req.get('cookie') || '';
  const out = {};
  header.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    const key = part.slice(0, idx).trim();
    if (!key) return;
    out[key] = decodeURIComponent(part.slice(idx + 1).trim());
  });
  return out;
}

// Registered before router.use(basicAuth) below so the login route itself
// isn't gated by the auth it's meant to grant.
router.get('/login', (req, res) => {
  const pass = process.env.ADMIN_PASSWORD;
  if (!pass) {
    return res.status(500).send('ADMIN_PASSWORD is not set on the server.');
  }
  if (req.query.key !== pass) {
    return res.status(401).send('Wrong key.');
  }
  // ~1 year, HttpOnly (not readable from JS), SameSite=Lax (still sent on a
  // plain top-level navigation to this link, but not on cross-site POSTs).
  res.set(
    'Set-Cookie',
    `${SESSION_COOKIE_NAME}=${sessionToken()}; Max-Age=31536000; Path=/; HttpOnly; SameSite=Lax`
  );
  res.redirect('/admin');
});

function basicAuth(req, res, next) {
  const user = process.env.ADMIN_USER || 'admin';
  const pass = process.env.ADMIN_PASSWORD;
  if (!pass) {
    return res.status(500).send('ADMIN_PASSWORD is not set on the server.');
  }

  // Session cookie from a prior /login visit, checked first.
  const cookies = parseCookies(req);
  if (cookies[SESSION_COOKIE_NAME] && cookies[SESSION_COOKIE_NAME] === sessionToken()) {
    return next();
  }

  const header = req.get('authorization') || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const [u, p] = Buffer.from(encoded, 'base64').toString().split(':');
    if (u === user && p === pass) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="DMA Leads Admin"');
  return res.status(401).send('Authentication required.');
}

router.use(basicAuth);

function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

const STATUS_OPTIONS = ['New', 'Contacted', 'Proposal Sent', 'Negotiating', 'Won', 'Lost', 'NEEDS DETAILS'];

function renderRow(lead) {
  const options = STATUS_OPTIONS.map(
    (s) => `<option value="${esc(s)}" ${s === lead.status ? 'selected' : ''}>${esc(s)}</option>`
  ).join('');
  return `
    <tr>
      <form method="POST" action="/admin/update/${lead.id}">
        <td>${lead.id}</td>
        <td>${esc(lead.date_received)}</td>
        <td>${esc(lead.source)}</td>
        <td>${esc(lead.name)}</td>
        <td>${esc(lead.company)}</td>
        <td>${esc(lead.email)}</td>
        <td>${esc(lead.phone)}</td>
        <td>${esc(lead.location)}</td>
        <td style="max-width:220px">${esc(lead.interest)}</td>
        <td><select name="status">${options}</select></td>
        <td><input type="text" name="owner" value="${esc(lead.owner)}" size="10"></td>
        <td><textarea name="notes" rows="2" cols="24">${esc(lead.notes)}</textarea></td>
        <td><input type="text" name="next_follow_up" value="${esc(lead.next_follow_up)}" size="8"></td>
        <td><button type="submit">Save</button></td>
      </form>
    </tr>`;
}

function renderPage(target, leads) {
  const tabs = ['DMA', 'BARR'].map((t) => {
    const label = t === 'DMA' ? 'DMA Leads' : 'BuyAndRentRobots Leads';
    const active = t === target ? 'style="font-weight:bold;text-decoration:underline"' : '';
    return `<a href="/admin?target=${t}" ${active}>${label}</a>`;
  }).join(' &nbsp;|&nbsp; ');

  const rows = leads.map(renderRow).join('\n');

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>DMA Leads Admin</title>
<style>
  body { font-family: -apple-system, Arial, sans-serif; margin: 20px; background: #f7f7f8; color: #1a1a1a; }
  h1 { font-size: 20px; }
  table { border-collapse: collapse; width: 100%; background: #fff; font-size: 13px; }
  th, td { border: 1px solid #ddd; padding: 6px 8px; text-align: left; vertical-align: top; }
  th { background: #f0f0f2; position: sticky; top: 0; }
  tr:nth-child(even) { background: #fafafa; }
  input, select, textarea { font-size: 12px; width: 100%; box-sizing: border-box; }
  button { cursor: pointer; }
  .nav { margin-bottom: 14px; }
  .addform { background: #fff; border: 1px solid #ddd; padding: 12px; margin-bottom: 20px; }
  .addform label { display: block; font-size: 11px; color: #555; margin-top: 6px; }
  .addform input, .addform select { padding: 4px; }
  .addform-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px 16px; }
</style>
</head>
<body>
  <h1>DMA &amp; BuyAndRentRobots — Leads Admin</h1>
  <div class="nav">${tabs} &nbsp;|&nbsp; <a href="/admin/export.csv?target=${target}">Export CSV</a></div>

  <details class="addform">
    <summary>Add a lead manually (phone-in, walk-up, etc.)</summary>
    <form method="POST" action="/admin/add">
      <input type="hidden" name="target" value="${target}">
      <div class="addform-grid">
        <div><label>Name</label><input name="name"></div>
        <div><label>Company</label><input name="company"></div>
        <div><label>Email</label><input name="email" type="email"></div>
        <div><label>Phone</label><input name="phone"></div>
        <div><label>Location</label><input name="location"></div>
        <div><label>Source</label><input name="source" value="Manual entry"></div>
        <div><label>Interest / Request</label><input name="interest"></div>
        <div><label>Owner</label><input name="owner"></div>
      </div>
      <div style="margin-top:10px"><button type="submit">Add lead</button></div>
    </form>
  </details>

  <table>
    <thead>
      <tr>
        <th>ID</th><th>Date</th><th>Source</th><th>Name</th><th>Company</th>
        <th>Email</th><th>Phone</th><th>Location</th><th>Interest</th>
        <th>Status</th><th>Owner</th><th>Notes</th><th>Next Follow-up</th><th></th>
      </tr>
    </thead>
    <tbody>
      ${rows || '<tr><td colspan="14">No leads yet.</td></tr>'}
    </tbody>
  </table>
</body>
</html>`;
}

router.get('/', (req, res) => {
  const target = req.query.target === 'BARR' ? 'BARR' : 'DMA';
  const leads = listLeads(target);
  res.type('html').send(renderPage(target, leads));
});

router.post('/update/:id', (req, res) => {
  const lead = getLead(req.params.id);
  if (!lead) return res.status(404).send('Lead not found');
  updateLeadFromAdmin(req.params.id, {
    status: req.body.status || lead.status,
    owner: req.body.owner || '',
    notes: req.body.notes || '',
    next_follow_up: req.body.next_follow_up || '',
  });
  res.redirect('/admin?target=' + lead.target);
});

router.post('/add', (req, res) => {
  const target = req.body.target === 'BARR' ? 'BARR' : 'DMA';
  addLeadFromAdmin({ ...req.body, target });
  res.redirect('/admin?target=' + target);
});

router.get('/export.csv', (req, res) => {
  const target = req.query.target === 'BARR' ? 'BARR' : 'DMA';
  const leads = listLeads(target);
  const cols = ['id', 'date_received', 'source', 'name', 'company', 'email', 'phone', 'location', 'interest', 'status', 'owner', 'notes', 'next_follow_up'];
  const csvEscape = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const lines = [cols.join(',')].concat(
    leads.map((l) => cols.map((c) => csvEscape(l[c])).join(','))
  );
  res.set('Content-Type', 'text/csv');
  res.set('Content-Disposition', `attachment; filename="${target}-leads.csv"`);
  res.send(lines.join('\n'));
});

module.exports = router;
