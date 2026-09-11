// Simple server-rendered admin page for viewing/editing leads directly —
// no Google Sheets, no Apps Script. Protected with HTTP Basic Auth using
// ADMIN_USER / ADMIN_PASSWORD env vars, plus a magic-link cookie login:
// visit /admin/login?key=<ADMIN_PASSWORD> once and a long-lived cookie logs
// you in on every visit after that, without the browser's Basic Auth popup.

const crypto = require('crypto');
const express = require('express');
const { listLeads, listChatLeadLeads, getLead, updateLeadFromAdmin, addLeadFromAdmin, deleteLead } = require('./db');

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
  'Wix Form - Digital Mirror Homepage': 'source-wix',
};
// DMA/BARR tabs only: CheckCherry and Chat Lead now always route to their
// own tabs (see computeTarget()'s source-based overrides in db.js), so
// neither can show up on DMA/BARR anymore — omit both here instead of the
// tiles always showing a permanent "CheckCherry: 0" / "Chat Lead: 0".
const SUMMARY_SOURCE_ORDER = Object.keys(SOURCE_CLASSES).filter((s) => s !== 'CheckCherry' && s !== 'Chat Lead');

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

function computeSummary(leads, sourceOrder) {
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
    if (sourceOrder.includes(source)) {
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

// sourceOrder is one of three things: undefined (use the default
// DMA/BARR source list), an array (restrict the per-source tiles to just
// those sources), or null (skip the source-tiles section entirely — used
// by the CheckCherry tab, where every lead is already the same source, so
// a source breakdown would be redundant with the total).
function renderSummaryBar(leads, sourceOrder) {
  if (sourceOrder === undefined) sourceOrder = SUMMARY_SOURCE_ORDER;
  const { statusCounts, otherStatusCount, sourceCounts, manualSourceCount, otherSourceCount } =
    computeSummary(leads, sourceOrder || []);

  const statusTiles = SUMMARY_STATUS_ORDER
    .map((s) => statTile(statusCounts[s] || 0, s, statusClass(s)))
    .join('');
  const otherStatusTile = otherStatusCount > 0 ? statTile(otherStatusCount, 'Other', 'status-other') : '';

  let sourceSection = '';
  if (sourceOrder) {
    const sourceTiles = sourceOrder
      .map((s) => statTile(sourceCounts[s] || 0, s, sourceClass(s)))
      .join('');
    const manualTile = manualSourceCount > 0 ? statTile(manualSourceCount, 'Manual', 'source-manual') : '';
    const otherSourceTile = otherSourceCount > 0 ? statTile(otherSourceCount, 'Other', 'source-other') : '';
    sourceSection = `<div class="stat-divider"></div>${sourceTiles}${manualTile}${otherSourceTile}`;
  }

  return `
    <div class="summary-bar">
      ${statTile(leads.length, 'Total Leads', 'stat-total')}
      <div class="stat-divider"></div>
      ${statusTiles}${otherStatusTile}
      ${sourceSection}
    </div>`;
}

// A long interest/notes value gets a clamped 2-line preview plus a toggle
// (client-side JS shows the toggle only when the text actually overflows)
// instead of ballooning the row to its full height.
function renderClampField(id, text) {
  return `<div class="clamp-text" id="${id}">${esc(text)}</div><button type="button" class="toggle-clamp" data-target="${id}">more</button>`;
}

function capitalizeFirst(v) {
  return v ? v.charAt(0).toUpperCase() + v.slice(1) : '';
}

// CheckCherry's UTM tracking, shown as "Source / Medium" (e.g.
// "Google / Organic"); campaign/content/term — often the longer, more
// specific part — get the same clamp-and-toggle overflow handling as
// Interest/Notes rather than a fixed-width truncation. Leads from
// integrations that don't carry this data (GHL, Meta Ads, manual entries,
// ...) render a plain em dash rather than something implying it's missing.
function renderLeadOrigin(lead) {
  const sourceMedium = [capitalizeFirst(lead.utm_source), capitalizeFirst(lead.utm_medium)]
    .filter(Boolean).join(' / ');
  const extra = [lead.utm_campaign, lead.utm_content, lead.utm_term].filter(Boolean).join(' | ');

  if (!sourceMedium && !extra) return '<span class="subtext">&mdash;</span>';

  const parts = [];
  if (sourceMedium) parts.push(`<div>${esc(sourceMedium)}</div>`);
  if (extra) parts.push(renderClampField(`origin-${lead.id}`, extra));
  return parts.join('');
}

function renderRow(lead, rowNumber, returnView) {
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
        <input type="hidden" name="return_view" value="${esc(returnView)}">
        <td class="row-num">${rowNumber}</td>
        <td>${esc(lead.date_received)}</td>
        <td><span class="source-pill ${sourceClass(lead.source)}">${esc(lead.source)}</span></td>
        <td class="origin-cell">${renderLeadOrigin(lead)}</td>
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
          <div class="notes-controls">
            <button type="button" class="toggle-clamp" data-target="${notesPreviewId}">more</button>
            <button type="button" class="notes-edit-toggle" data-preview="${notesPreviewId}" data-edit="${notesEditId}">Edit</button>
          </div>
        </td>
        <td><input type="text" name="next_follow_up" value="${esc(lead.next_follow_up)}"></td>
        <td class="actions-cell">
          <button type="submit" class="save-btn">Save</button>
          <button type="submit" class="delete-btn" formaction="/admin/delete/${lead.id}" formnovalidate
            data-confirm="Delete this lead${lead.name ? ' (' + esc(lead.name) + ')' : ''}? This cannot be undone.">Delete</button>
        </td>
      </form>
    </tr>`;
}

// Tabs shown in the /admin nav, in order. DMA/BARR/CHECKCHERRY/CHATLEAD are
// real `target` values leads are stored under (see computeTarget() in
// db.js); ANALYTICS is a pseudo-tab — renderAnalyticsPage() below has no
// corresponding leads at all, just aggregate counts.
const TAB_LABELS = { DMA: 'DMA Leads', BARR: 'BuyAndRentRobots Leads', CHECKCHERRY: 'CheckCherry', CHATLEAD: 'Chat Lead', ANALYTICS: 'Analytics' };

// Shared by renderPage() and renderAnalyticsPage() so every tab gets the
// same nav bar. The CSV export only makes sense for an actual leads list,
// so it's omitted on the Analytics tab.
function renderTabsNav(target) {
  const tabs = Object.keys(TAB_LABELS).map((t) => {
    const active = t === target ? ' active' : '';
    return `<a class="tab${active}" href="/admin?target=${t}">${TAB_LABELS[t]}</a>`;
  }).join('');
  const exportLink = target === 'ANALYTICS'
    ? ''
    : `<a class="export-link" href="/admin/export.csv?target=${target}">Export CSV</a>`;
  return `<div class="tabs">${tabs}${exportLink}</div>`;
}

// Shared <style> body — both renderPage() (DMA/BARR/CheckCherry) and
// renderAnalyticsPage() wrap this in their own <style> tag, so page layout,
// tabs, table, and pill/badge colors stay visually identical across every
// tab without duplicating the CSS.
const PAGE_STYLES = `
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
  .origin-cell { max-width: 150px; }
  .row-num { color: var(--text-muted); text-align: right; }
  .subtext { color: var(--text-muted); font-size: 12px; }

  input, select, textarea { font-size: 13px; width: 100%; box-sizing: border-box; padding: 6px 8px; border: 1px solid var(--border); border-radius: 6px; background: #fff; color: var(--text); font-family: inherit; }
  textarea { resize: vertical; }
  button { cursor: pointer; }
  .save-btn { background: var(--accent); color: #fff; border: none; border-radius: 6px; padding: 7px 12px; font-weight: 600; font-size: 12.5px; }
  .save-btn:hover { background: var(--accent-dark); }
  .actions-cell { display: flex; flex-direction: column; gap: 6px; align-items: flex-start; }
  .delete-btn { background: #fff; color: #b91c1c; border: 1px solid #fecaca; border-radius: 6px; padding: 7px 12px; font-weight: 600; font-size: 12.5px; }
  .delete-btn:hover { background: #fef2f2; border-color: #fca5a5; }

  .source-pill { display: inline-block; padding: 3px 9px; border-radius: 999px; font-size: 11.5px; font-weight: 600; white-space: nowrap; }
  .source-checkcherry { background-color: #e0f2fe; color: #075985; border-color: #bae6fd; }
  .source-ghl { background-color: #ccfbf1; color: #115e59; border-color: #99f6e4; }
  .source-chatlead { background-color: #fae8ff; color: #86198f; border-color: #f5d0fe; }
  .source-metaads { background-color: #fce7f3; color: #9d174d; border-color: #fbcfe8; }
  .source-googleads { background-color: #ffedd5; color: #9a3412; border-color: #fed7aa; }
  .source-barr { background-color: #cffafe; color: #155e75; border-color: #a5f3fc; }
  .source-wix { background-color: #e0e7ff; color: #3730a3; border-color: #c7d2fe; }
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
  .notes-controls { display: flex; align-items: center; gap: 10px; margin-top: 2px; }
  .notes-controls .toggle-clamp { padding: 0; }
  .notes-edit-toggle { background: none; border: none; padding: 0; color: var(--accent); font-size: 11.5px; font-weight: 600; }

  .analytics-section { margin-bottom: 24px; }
  .analytics-section h2 { font-size: 15px; margin: 0 0 4px; }
  .analytics-section .subtext { display: block; margin-bottom: 10px; }
  .pct-badge { display: inline-flex; align-items: center; gap: 3px; padding: 3px 9px; border-radius: 999px; font-size: 12.5px; font-weight: 700; white-space: nowrap; }
  .pct-up { background-color: #dcfce7; color: #166534; }
  .pct-down { background-color: #fee2e2; color: #991b1b; }
  .pct-flat { background-color: #e5e7eb; color: #4b5563; }
`;

// Tabs that are single-source by construction (see computeTarget()'s
// source-based overrides in db.js) — every row on them is already synced
// from that one integration, so the manual-add form and the per-source
// summary tiles (which would just show one redundant tile matching the
// total) are both skipped, same as CheckCherry started doing.
const SINGLE_SOURCE_TABS = ['CHECKCHERRY', 'CHATLEAD'];

function renderPage(target, leads) {
  const rows = leads.map((lead, i) => renderRow(lead, i + 1, target)).join('\n');
  const showAddForm = !SINGLE_SOURCE_TABS.includes(target);
  const summarySourceOrder = SINGLE_SOURCE_TABS.includes(target) ? null : SUMMARY_SOURCE_ORDER;

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>DMA Leads Admin</title>
<style>${PAGE_STYLES}</style>
</head>
<body>
  <h1>DMA &amp; BuyAndRentRobots — Leads Admin</h1>

  ${renderTabsNav(target)}

  ${renderSummaryBar(leads, summarySourceOrder)}

  ${showAddForm ? `
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
  </details>` : ''}

  <div class="toolbar">
    <input type="text" id="searchBox" class="search-box" placeholder="Search name, email, company…">
  </div>

  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>#</th>
          <th class="sortable" data-sort="date">Date<span class="sort-indicator" data-sort-indicator="date"></span></th>
          <th>Source</th><th>Lead Origin</th><th>Lead</th><th>Contact</th><th>Interest</th>
          <th class="sortable" data-sort="status">Status<span class="sort-indicator" data-sort-indicator="status"></span></th>
          <th>Owner</th><th>Notes</th><th>Follow-up</th><th></th>
        </tr>
      </thead>
      <tbody>
        ${rows || '<tr><td colspan="12">No leads yet.</td></tr>'}
      </tbody>
    </table>
  </div>
  <div id="noResults">No leads match your search.</div>

<script>
(function () {
  // --- clamp "more"/"less" toggles (Interest, and Notes' read-only preview):
  // only shown when the text actually overflows its 2-line clamp. Shared by
  // both columns — Notes' preview <div> is marked up exactly like Interest's,
  // so one loop handles both.
  document.querySelectorAll('.toggle-clamp').forEach(function (btn) {
    var target = document.getElementById(btn.dataset.target);
    if (!target) return;
    if (target.scrollHeight > target.clientHeight + 1) {
      btn.style.display = 'inline-block';
    }
    btn.addEventListener('click', function () {
      var expanded = target.classList.toggle('expanded');
      btn.textContent = expanded ? 'less' : 'more';
    });
  });

  // --- Notes "Edit"/"Done": swaps the read-only preview for a textarea.
  // Separate control from the more/less toggle above and independent of it —
  // expanding via "more" never enters edit mode. Entering/leaving edit mode
  // hides the preview + its more/less button via inline style.display, but
  // saves each one's existing style.display first and restores exactly that
  // (not a hardcoded value) on "Done" — the preview's clamp/expanded class
  // rule sets its own explicit display, and the hidden attribute does not
  // reliably win over that (verified in-browser), so a plain hidden=true/
  // false toggle silently left the preview visible during edit.
  document.querySelectorAll('.notes-edit-toggle').forEach(function (btn) {
    var preview = document.getElementById(btn.dataset.preview);
    var editEl = document.getElementById(btn.dataset.edit);
    var moreBtn = document.querySelector('.toggle-clamp[data-target="' + preview.id + '"]');
    btn.addEventListener('click', function () {
      var editing = !editEl.hidden;
      if (editing) {
        // "Done"
        preview.textContent = editEl.value;
        editEl.hidden = true;
        preview.style.display = preview.dataset.savedDisplay || '';
        if (moreBtn) moreBtn.style.display = moreBtn.dataset.savedDisplay || '';
        btn.textContent = 'Edit';
      } else {
        // "Edit"
        preview.dataset.savedDisplay = preview.style.display;
        preview.style.display = 'none';
        if (moreBtn) {
          moreBtn.dataset.savedDisplay = moreBtn.style.display;
          moreBtn.style.display = 'none';
        }
        editEl.hidden = false;
        editEl.focus();
        btn.textContent = 'Done';
      }
    });
  });

  // --- delete button: confirm before submitting (formaction points the
  // shared row <form> at /admin/delete/:id instead of /admin/update/:id) ---
  document.querySelectorAll('.delete-btn').forEach(function (btn) {
    btn.addEventListener('click', function (e) {
      if (!confirm(btn.dataset.confirm || 'Delete this lead? This cannot be undone.')) {
        e.preventDefault();
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

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

// "Active" = not yet dispositioned one way or the other. Matches the
// Analytics tab's brief exactly: everything except these three counts as
// active (New, Contacted, Negotiating, NEEDS DETAILS, and any stray custom
// status).
const ACTIVE_EXCLUDED_STATUSES = ['Proposal Sent', 'Won', 'Lost'];

// Buckets every lead by the 'YYYY-MM' of its date_received, across all
// targets/sources — the Analytics tab's brief is explicitly "all leads in
// the database (all sources combined)". Returns two parallel maps so a
// single pass over the leads list produces both the Lead Volume and Active
// Leads tables.
function computeMonthlyCounts(leads) {
  const totals = {};
  const active = {};
  leads.forEach((lead) => {
    const month = (lead.date_received || '').slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) return; // malformed/blank date — don't let it skew a bucket
    totals[month] = (totals[month] || 0) + 1;
    if (!ACTIVE_EXCLUDED_STATUSES.includes(lead.status)) {
      active[month] = (active[month] || 0) + 1;
    }
  });
  return { totals, active };
}

// current vs. previous is 2026 vs. 2025 for a given month. previous = 0 has
// no meaningful percent change (division by zero) — shown as "New" if 2026
// actually has leads, or a flat dash if both years are empty, rather than
// a misleading 0%/Infinity%.
function renderPctBadge(current, previous) {
  if (!previous) {
    return current > 0
      ? '<span class="pct-badge pct-up">New</span>'
      : '<span class="pct-badge pct-flat">&mdash;</span>';
  }
  const pct = Math.round(((current - previous) / previous) * 1000) / 10; // one decimal place
  if (pct === 0) return '<span class="pct-badge pct-flat">0%</span>';
  const cls = pct > 0 ? 'pct-up' : 'pct-down';
  const arrow = pct > 0 ? '▲' : '▼';
  return `<span class="pct-badge ${cls}">${arrow} ${Math.abs(pct)}%</span>`;
}

function renderAnalyticsTable(title, rowsData, previousYear, currentYear, subtitle) {
  const rows = rowsData.map((r) => `
        <tr>
          <td>${esc(r.month)}</td>
          <td>${r.yPrev}</td>
          <td>${r.yCurrent}</td>
          <td>${renderPctBadge(r.yCurrent, r.yPrev)}</td>
        </tr>`).join('');

  return `
  <div class="analytics-section">
    <h2>${esc(title)}</h2>
    ${subtitle ? `<span class="subtext">${esc(subtitle)}</span>` : ''}
    <div class="table-wrap">
      <table>
        <thead>
          <tr><th>Month</th><th>${previousYear}</th><th>${currentYear}</th><th>Change</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </div>`;
}

// The Lead Volume/Active Leads tables only ever show Jan-through-current-
// month for previousYear/currentYear — a real chunk of CheckCherry's
// historical data (proposals with a genuine creation date well before
// 2025, or falling in previousYear after the cutoff month) never lands in
// either window and would otherwise vanish from this tab silently. Counts
// every target=CHECKCHERRY row NOT captured by that window — as the
// complement of what's displayed, not a second hardcoded date range, so
// this can't drift out of sync with the table above it (including the
// edge case of a malformed/blank date_received, which computeMonthlyCounts()
// already excludes from every bucket — that row wouldn't match either
// window here either, so it still gets counted as "not shown above").
// Verified against production on 2026-09-10: 75.
function countCheckCherryOutsideWindow(leads, previousYear, currentYear, currentMonthIndex) {
  const endMonth = String(currentMonthIndex + 1).padStart(2, '0');
  const ccLeads = leads.filter((lead) => lead.target === 'CHECKCHERRY');
  const inWindow = ccLeads.filter((lead) => {
    const month = (lead.date_received || '').slice(0, 7);
    return (month >= `${previousYear}-01` && month <= `${previousYear}-${endMonth}`)
        || (month >= `${currentYear}-01` && month <= `${currentYear}-${endMonth}`);
  }).length;
  return ccLeads.length - inWindow;
}

// No lead list here, just aggregate counts — January through the current
// month, this year vs. the same month last year (computed from the current
// date, not hardcoded, so this doesn't need a manual edit every January).
// Scoped to every lead in the database (all sources/tabs combined), per
// the brief; see the commit message / report for the flagged ambiguity on
// whether this should instead be CheckCherry-only.
function renderAnalyticsPage() {
  const leads = listLeads(); // no target arg -> every lead, every source
  const { totals, active } = computeMonthlyCounts(leads);

  const now = new Date();
  const currentYear = now.getUTCFullYear();
  const previousYear = currentYear - 1;
  const currentMonthIndex = now.getUTCMonth(); // 0 = January
  const volumeRows = [];
  const activeRows = [];
  for (let m = 0; m <= currentMonthIndex; m++) {
    const mm = String(m + 1).padStart(2, '0');
    const keyPrev = `${previousYear}-${mm}`;
    const keyCurrent = `${currentYear}-${mm}`;
    const month = MONTH_NAMES[m] + (m === currentMonthIndex ? ' (partial)' : '');
    volumeRows.push({ month, yPrev: totals[keyPrev] || 0, yCurrent: totals[keyCurrent] || 0 });
    activeRows.push({ month, yPrev: active[keyPrev] || 0, yCurrent: active[keyCurrent] || 0 });
  }
  const outsideWindowCount = countCheckCherryOutsideWindow(leads, previousYear, currentYear, currentMonthIndex);

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>DMA Leads Admin</title>
<style>${PAGE_STYLES}</style>
</head>
<body>
  <h1>DMA &amp; BuyAndRentRobots — Leads Admin</h1>

  ${renderTabsNav('ANALYTICS')}

  <p class="subtext">All leads across every tab (DMA, BuyAndRentRobots, CheckCherry, and Chat Lead combined), grouped by the month each lead was received. The current month is still in progress.</p>

  ${renderAnalyticsTable('Lead Volume by Month', volumeRows, previousYear, currentYear)}
  <p class="subtext" style="margin: -10px 0 20px;">Plus ${outsideWindowCount} additional CheckCherry lead${outsideWindowCount === 1 ? '' : 's'} from outside the window shown above (before ${previousYear}, or after ${MONTH_NAMES[currentMonthIndex]} in either year), not included in the monthly breakdown.</p>

  ${renderAnalyticsTable('Active Leads by Month', activeRows, previousYear, currentYear, 'Leads not yet marked Proposal Sent, Won, or Lost.')}
</body>
</html>`;
}

// Resolves the `target` query/body param to one of the tabs this admin
// page knows about — anything else (missing, stray value) falls back to
// DMA.
function resolveView(value) {
  return Object.keys(TAB_LABELS).includes(value) ? value : 'DMA';
}

// The Chat Lead tab is the one lead-list tab with its own query (date-
// filtered — see listChatLeadLeads() in db.js) rather than a plain
// listLeads(target); centralized here so the page route and CSV export
// route can't drift apart on which tab uses which.
function leadsForTab(target) {
  return target === 'CHATLEAD' ? listChatLeadLeads() : listLeads(target);
}

router.get('/', (req, res) => {
  const target = resolveView(req.query.target);
  if (target === 'ANALYTICS') {
    return res.type('html').send(renderAnalyticsPage());
  }
  res.type('html').send(renderPage(target, leadsForTab(target)));
});

// Both routes redirect back to whichever tab the edit was made from
// (return_view, a hidden field on each row's form) rather than always the
// lead's own target. Every lead-list tab's target now equals a real,
// resolveView()-valid tab (DMA/BARR/CHECKCHERRY/CHATLEAD), so in practice
// this already agrees with lead.target — computeTarget() only ever assigns
// CHATLEAD to a row that also passes listChatLeadLeads()'s own date filter
// (see db.js), so that agreement holds for CHATLEAD too. return_view is
// what future-proofs this generally (e.g. a tab that, like the old Email
// List one, shows leads that don't all share one real target).
router.post('/update/:id', (req, res) => {
  const lead = getLead(req.params.id);
  if (!lead) return res.status(404).send('Lead not found');
  updateLeadFromAdmin(req.params.id, {
    status: req.body.status || lead.status,
    owner: req.body.owner || '',
    notes: req.body.notes || '',
    next_follow_up: req.body.next_follow_up || '',
  });
  res.redirect('/admin?target=' + resolveView(req.body.return_view || lead.target));
});

router.post('/delete/:id', (req, res) => {
  const lead = getLead(req.params.id);
  if (!lead) return res.status(404).send('Lead not found');
  deleteLead(req.params.id);
  res.redirect('/admin?target=' + resolveView(req.body.return_view || lead.target));
});

router.post('/add', (req, res) => {
  const target = req.body.target === 'BARR' ? 'BARR' : 'DMA';
  addLeadFromAdmin({ ...req.body, target });
  res.redirect('/admin?target=' + target);
});

router.get('/export.csv', (req, res) => {
  const target = resolveView(req.query.target);
  const leads = target === 'ANALYTICS' ? [] : leadsForTab(target);
  const cols = ['id', 'date_received', 'source', 'name', 'company', 'email', 'phone', 'location', 'interest', 'status', 'owner', 'notes', 'next_follow_up', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
  const csvEscape = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const lines = [cols.join(',')].concat(
    leads.map((l) => cols.map((c) => csvEscape(l[c])).join(','))
  );
  res.set('Content-Type', 'text/csv');
  res.set('Content-Disposition', `attachment; filename="${target}-leads.csv"`);
  res.send(lines.join('\n'));
});

module.exports = router;
