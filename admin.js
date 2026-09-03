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

// Drives both the summary bar's per-status tiles and the status pill's
// color. Statuses not listed here (a stray custom value, or the
// less-common "NEEDS DETAILS") still get a pill via the 'status-other'
// fallback and still count toward an "Other" summary tile, rather than
// being silently dropped.
const STATUS_CLASSES = {
  New: 'status-new',
  Contacted: 'status-warn',
  'Proposal Sent': 'status-warn',
  Negotiating: 'status-warn',
  Won: 'status-won',
  Lost: 'status-lost',
  'NEEDS DETAILS': 'status-alert',
};
const SUMMARY_STATUS_ORDER = ['New', 'Contacted', 'Proposal Sent', 'Negotiating', 'Won', 'Lost'];

// Drives both the summary bar's per-source tiles and the source pill's
// color in the table — same principle as STATUS_CLASSES above, and the
// same object is the single source of truth for both the color and the
// known-sources list, so they can't drift apart.
const SOURCE_CLASSES = {
  CheckCherry: 'source-checkcherry',
  GHL: 'source-ghl',
  'Chat Lead': 'source-chatlead',
  'Meta Ads': 'source-metaads',
  'Google Ads': 'source-googleads',
  'BuyAndRentRobots Website': 'source-barr',
};
const SUMMARY_SOURCE_ORDER = Object.keys(SOURCE_CLASSES);

function statusClass(status) {
  return STATUS_CLASSES[status] || 'status-other';
}

// Manual entries (e.g. "Manual entry", "Manual entry - inbound inquiry")
// get their own color; anything else unrecognized falls back to a neutral
// color rather than being silently uncolored — same "Other" principle
// already used for status and for the summary bar's counts.
function sourceClass(source) {
  if (SOURCE_CLASSES[source]) return SOURCE_CLASSES[source];
  if (/^manual/i.test(source || '')) return 'source-manual';
  return 'source-other';
}

function computeSummary(leads) {
  const statusCounts = {};
  const sourceCounts = {};
  let otherStatusCount = 0;
  let manualSourceCount = 0;
  let otherSourceCount = 0;

  leads.forEach((lead) => {
    const status = lead.status || 'New';
    if (SUMMARY_STATUS_ORDER.includes(status)) {
      statusCounts[status] = (statusCounts[status] || 0) + 1;
    } else {
      otherStatusCount += 1;
    }

    const source = lead.source || '';
    if (SUMMARY_SOURCE_ORDER.includes(source)) {
      sourceCounts[source] = (sourceCounts[source] || 0) + 1;
    } else if (/^manual/i.test(source)) {
      manualSourceCount += 1;
    } else {
      otherSourceCount += 1;
    }
  });

  return { statusCounts, otherStatusCount, sourceCounts, manualSourceCount, otherSourceCount };
}

function statTile(count, label, extraClass) {
  return `<div class="stat-tile ${extraClass || ''}"><div class="stat-value">${count}</div><div class="stat-label">${esc(label)}</div></div>`;
}

function renderSummaryBar(leads) {
  const { statusCounts, otherStatusCount, sourceCounts, manualSourceCount, otherSourceCount } = computeSummary(leads);

  const statusTiles = SUMMARY_STATUS_ORDER
    .map((s) => statTile(statusCounts[s] || 0, s, statusClass(s)))
    .join('');
  const otherStatusTile = otherStatusCount > 0 ? statTile(otherStatusCount, 'Other', 'status-other') : '';

  const sourceTiles = SUMMARY_SOURCE_ORDER
    .map((s) => statTile(sourceCounts[s] || 0, s, sourceClass(s)))
    .join('');
  const manualTile = manualSourceCount > 0 ? statTile(manualSourceCount, 'Manual', 'source-manual') : '';
  const otherSourceTile = otherSourceCount > 0 ? statTile(otherSourceCount, 'Other', 'source-other') : '';

  return `
    <div class="summary-bar">
      ${statTile(leads.length, 'Total Leads', 'stat-total')}
      <div class="stat-divider"></div>
      ${statusTiles}${otherStatusTile}
      <div class="stat-divider"></div>
      ${sourceTiles}${manualTile}${otherSourceTile}
    </div>`;
}

// A long interest/notes value gets a clamped 2-line preview plus a toggle
// (client-side JS shows the toggle only when the text actually overflows)
// instead of ballooning the row to its full height.
function renderClampField(id, text) {
  return `<div class="clamp-text" id="${id}">${esc(text)}</div><button type="button" class="toggle-clamp" data-target="${id}">more</button>`;
}

function renderRow(lead) {
  const options = STATUS_OPTIONS.map(
    (s) => `<option value="${esc(s)}" ${s === lead.status ? 'selected' : ''}>${esc(s)}</option>`
  ).join('');

  const searchKey = esc([lead.name, lead.email, lead.company].filter(Boolean).join(' ').toLowerCase());
  const contactLines = [esc(lead.email), esc(lead.phone), esc(lead.location)].filter(Boolean).join('<br>');
  const leadLines = [esc(lead.name)];
  if (lead.company) leadLines.push(`<span class="subtext">${esc(lead.company)}</span>`);

  const notesPreviewId = `notes-preview-${lead.id}`;
  const notesEditId = `notes-edit-${lead.id}`;
  const interestId = `interest-${lead.id}`;

  return `
    <tr data-search="${searchKey}" data-date="${esc(lead.date_received)}" data-status="${esc(lead.status)}">
      <form method="POST" action="/admin/update/${lead.id}">
        <td>${esc(lead.date_received)}</td>
        <td><span class="source-pill ${sourceClass(lead.source)}">${esc(lead.source)}</span></td>
        <td>${leadLines.join('<br>')}</td>
        <td>${contactLines || '<span class="subtext">&mdash;</span>'}</td>
        <td class="wide-cell">${renderClampField(interestId, lead.interest)}</td>
        <td>
          <select name="status" class="status-select ${statusClass(lead.status)}">${options}</select>
        </td>
        <td><input type="text" name="owner" value="${esc(lead.owner)}"></td>
        <td class="wide-cell">
          <div class="clamp-text notes-preview" id="${notesPreviewId}">${esc(lead.notes)}</div>
          <textarea name="notes" class="notes-edit" id="${notesEditId}" hidden>${esc(lead.notes)}</textarea>
          <button type="button" class="toggle-clamp notes-toggle" data-preview="${notesPreviewId}" data-edit="${notesEditId}">edit</button>
        </td>
        <td><input type="text" name="next_follow_up" value="${esc(lead.next_follow_up)}"></td>
        <td><button type="submit" class="save-btn">Save</button></td>
      </form>
    </tr>`;
}

function renderPage(target, leads) {
  const tabs = ['DMA', 'BARR'].map((t) => {
    const label = t === 'DMA' ? 'DMA Leads' : 'BuyAndRentRobots Leads';
    const active = t === target ? ' active' : '';
    return `<a class="tab${active}" href="/admin?target=${t}">${label}</a>`;
  }).join('');

  const rows = leads.map(renderRow).join('\n');

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>DMA Leads Admin</title>
<style>
  :root {
    --bg: #eef1f8;
    --card: #ffffff;
    --border: #dde3ee;
    --text: #1e2432;
    --text-muted: #667085;
    --accent: #4f46e5;
    --accent-dark: #4338ca;
    --header-bg: #eef0fd;
  }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif; margin: 0; padding: 24px 28px 60px; background: var(--bg); color: var(--text); font-size: 15px; }
  h1 { font-size: 20px; margin: 0 0 16px; }
  a { color: var(--accent); }

  .tabs { margin-bottom: 16px; display: flex; gap: 4px; align-items: center; flex-wrap: wrap; }
  .tab { padding: 7px 14px; border-radius: 8px; text-decoration: none; color: var(--text-muted); font-weight: 600; font-size: 13px; }
  .tab.active { background: var(--accent); color: #fff; }
  .tab:not(.active):hover { background: var(--card); }
  .export-link { margin-left: auto; font-size: 13px; font-weight: 600; }

  .summary-bar { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 18px; align-items: stretch; }
  .stat-tile { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 10px 16px; min-width: 84px; box-shadow: 0 1px 2px rgba(16,24,40,0.04); border-top: 3px solid var(--border); }
  .stat-tile.stat-total { border-top-color: var(--accent); }
  .stat-value { font-size: 20px; font-weight: 700; line-height: 1.1; }
  .stat-label { font-size: 11px; color: var(--text-muted); margin-top: 2px; white-space: nowrap; }
  .stat-divider { width: 1px; background: var(--border); margin: 2px 4px; }

  .toolbar { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; flex-wrap: wrap; }
  .search-box { flex: 0 1 320px; padding: 9px 12px; border: 1px solid var(--border); border-radius: 8px; font-size: 14px; background: var(--card); }
  .search-box:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
  #noResults { display: none; color: var(--text-muted); padding: 16px; text-align: center; }

  .addform { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; margin-bottom: 18px; }
  .addform summary { cursor: pointer; font-weight: 600; font-size: 13px; }
  .addform label { display: block; font-size: 11px; color: var(--text-muted); margin-top: 8px; margin-bottom: 3px; }
  .addform input { padding: 7px 9px; border: 1px solid var(--border); border-radius: 6px; font-size: 13px; width: 100%; box-sizing: border-box; }
  .addform-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px 16px; margin-top: 10px; }
  .addform button { margin-top: 12px; }

  .table-wrap { background: var(--card); border: 1px solid var(--border); border-radius: 10px; overflow: auto; box-shadow: 0 1px 2px rgba(16,24,40,0.04); }
  table { border-collapse: collapse; width: 100%; font-size: 13.5px; }
  th, td { padding: 10px 12px; text-align: left; vertical-align: top; border-bottom: 1px solid var(--border); }
  th { background: var(--header-bg); font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.03em; color: var(--text-muted); font-weight: 700; position: sticky; top: 0; }
  th.sortable { cursor: pointer; user-select: none; }
  th.sortable:hover { color: var(--accent); }
  tr:last-child td { border-bottom: none; }
  tr:hover td { background: #f8f9fd; }
  .wide-cell { max-width: 260px; }
  .subtext { color: var(--text-muted); font-size: 12px; }

  input, select, textarea { font-size: 13px; width: 100%; box-sizing: border-box; padding: 6px 8px; border: 1px solid var(--border); border-radius: 6px; background: #fff; color: var(--text); font-family: inherit; }
  textarea { resize: vertical; }
  button { cursor: pointer; }
  .save-btn { background: var(--accent); color: #fff; border: none; border-radius: 6px; padding: 7px 12px; font-weight: 600; font-size: 12.5px; }
  .save-btn:hover { background: var(--accent-dark); }

  .source-pill { display: inline-block; padding: 3px 9px; border-radius: 999px; font-size: 11.5px; font-weight: 600; white-space: nowrap; }
  .source-checkcherry { background-color: #e0f2fe; color: #075985; border-color: #bae6fd; }
  .source-ghl { background-color: #ccfbf1; color: #115e59; border-color: #99f6e4; }
  .source-chatlead { background-color: #fae8ff; color: #86198f; border-color: #f5d0fe; }
  .source-metaads { background-color: #fce7f3; color: #9d174d; border-color: #fbcfe8; }
  .source-googleads { background-color: #ffedd5; color: #9a3412; border-color: #fed7aa; }
  .source-barr { background-color: #cffafe; color: #155e75; border-color: #a5f3fc; }
  .source-manual { background-color: #f5f5f4; color: #57534e; border-color: #e7e5e4; }
  .source-other { background-color: #e5e7eb; color: #4b5563; border-color: #d1d5db; }

  .status-select { appearance: none; -webkit-appearance: none; border-radius: 999px; font-weight: 700; font-size: 12px; text-align: left; padding: 6px 26px 6px 10px; border-width: 1px; border-style: solid; background-repeat: no-repeat; background-position: right 8px center; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%23667085'/%3E%3C/svg%3E"); min-width: 128px; width: auto; }
  .status-new { background-color: #dbeafe; color: #1e40af; border-color: #bfdbfe; }
  .status-warn { background-color: #fef3c7; color: #92400e; border-color: #fde68a; }
  .status-won { background-color: #dcfce7; color: #166534; border-color: #bbf7d0; }
  .status-lost { background-color: #e5e7eb; color: #4b5563; border-color: #d1d5db; }
  .status-alert { background-color: #fee2e2; color: #991b1b; border-color: #fecaca; }
  .status-other { background-color: #ede9fe; color: #5b21b6; border-color: #ddd6fe; }

  .clamp-text { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; white-space: pre-wrap; line-height: 1.35; }
  .clamp-text.expanded { display: block; -webkit-line-clamp: unset; overflow: visible; }
  .toggle-clamp { display: none; background: none; border: none; padding: 2px 0 0; color: var(--accent); font-size: 11.5px; font-weight: 600; }
  .notes-edit { margin-top: 4px; }
</style>
</head>
<body>
  <h1>DMA &amp; BuyAndRentRobots — Leads Admin</h1>

  <div class="tabs">
    ${tabs}
    <a class="export-link" href="/admin/export.csv?target=${target}">Export CSV</a>
  </div>

  ${renderSummaryBar(leads)}

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
      <button type="submit" class="save-btn">Add lead</button>
    </form>
  </details>

  <div class="toolbar">
    <input type="text" id="searchBox" class="search-box" placeholder="Search name, email, company…">
  </div>

  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th class="sortable" data-sort="date">Date<span class="sort-indicator" data-sort-indicator="date"></span></th>
          <th>Source</th><th>Lead</th><th>Contact</th><th>Interest</th>
          <th class="sortable" data-sort="status">Status<span class="sort-indicator" data-sort-indicator="status"></span></th>
          <th>Owner</th><th>Notes</th><th>Follow-up</th><th></th>
        </tr>
      </thead>
      <tbody>
        ${rows || '<tr><td colspan="10">No leads yet.</td></tr>'}
      </tbody>
    </table>
  </div>
  <div id="noResults">No leads match your search.</div>

<script>
(function () {
  // --- clamp "more"/"edit" toggles: only shown when text actually overflows ---
  document.querySelectorAll('.clamp-text').forEach(function (el) {
    var isNotes = el.classList.contains('notes-preview');
    var btn = isNotes
      ? document.querySelector('.notes-toggle[data-preview="' + el.id + '"]')
      : document.querySelector('.toggle-clamp[data-target="' + el.id + '"]');
    if (!btn) return;
    if (el.scrollHeight > el.clientHeight + 1) {
      btn.style.display = 'inline-block';
    }
  });

  document.querySelectorAll('.toggle-clamp:not(.notes-toggle)').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var target = document.getElementById(btn.dataset.target);
      var expanded = target.classList.toggle('expanded');
      btn.textContent = expanded ? 'less' : 'more';
    });
  });

  document.querySelectorAll('.notes-toggle').forEach(function (btn) {
    var preview = document.getElementById(btn.dataset.preview);
    var editEl = document.getElementById(btn.dataset.edit);
    btn.style.display = 'inline-block'; // notes are always editable, regardless of overflow
    btn.addEventListener('click', function () {
      var editing = !editEl.hidden;
      if (editing) {
        preview.textContent = editEl.value;
        editEl.hidden = true;
        preview.style.display = '-webkit-box';
        btn.textContent = 'edit';
      } else {
        editEl.hidden = false;
        preview.style.display = 'none';
        editEl.focus();
        btn.textContent = 'done';
      }
    });
  });

  // --- status pill recolors immediately on selection, before save ---
  var STATUS_CLASSES = ${JSON.stringify(STATUS_CLASSES)};
  document.querySelectorAll('.status-select').forEach(function (sel) {
    sel.addEventListener('change', function () {
      sel.className = 'status-select ' + (STATUS_CLASSES[sel.value] || 'status-other');
    });
  });

  // --- live search filter (name / email / company) ---
  var rows = Array.prototype.slice.call(document.querySelectorAll('tbody tr[data-search]'));
  var searchBox = document.getElementById('searchBox');
  var noResults = document.getElementById('noResults');
  if (searchBox) {
    searchBox.addEventListener('input', function () {
      var q = searchBox.value.trim().toLowerCase();
      var visibleCount = 0;
      rows.forEach(function (tr) {
        var match = tr.dataset.search.indexOf(q) !== -1;
        tr.style.display = match ? '' : 'none';
        if (match) visibleCount++;
      });
      noResults.style.display = (q && visibleCount === 0) ? 'block' : 'none';
    });
  }

  // --- click Date / Status headers to sort ---
  var sortState = { key: null, dir: 1 };
  function updateIndicators(activeKey, dir) {
    document.querySelectorAll('.sort-indicator').forEach(function (el) {
      el.textContent = el.dataset.sortIndicator === activeKey ? (dir === 1 ? ' \\u25B2' : ' \\u25BC') : '';
    });
  }
  document.querySelectorAll('th.sortable').forEach(function (th) {
    th.addEventListener('click', function () {
      var key = th.dataset.sort;
      var tbody = document.querySelector('table tbody');
      if (sortState.key === key) { sortState.dir *= -1; } else { sortState.key = key; sortState.dir = 1; }
      rows.slice().sort(function (a, b) {
        var va = a.dataset[key] || '';
        var vb = b.dataset[key] || '';
        return va.localeCompare(vb) * sortState.dir;
      }).forEach(function (tr) { tbody.appendChild(tr); });
      updateIndicators(key, sortState.dir);
    });
  });
})();
</script>
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
