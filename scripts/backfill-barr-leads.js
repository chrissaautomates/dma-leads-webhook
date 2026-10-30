// Backfill BuyAndRentRobots leads into GHL from a CSV export (default barr_leads_review.csv).
// DRY-RUN by default: reads GHL (lookups only), prints what it would create and update, and
// writes nothing. Pass --commit to write.
//
//   node scripts/backfill-barr-leads.js                         # dry run, ./barr_leads_review.csv
//   node scripts/backfill-barr-leads.js --file path/to.csv      # another file
//   node scripts/backfill-barr-leads.js --limit 20              # first 20 rows (after date sort)
//   node scripts/backfill-barr-leads.js --commit                # write
//
// Needs GHL_API_KEY and GHL_LOCATION_ID (a dry run does read-only lookups to tell creates
// from updates). Rows are processed in date order, OLDEST FIRST; rows with no readable date
// go last, flagged. Each row goes through the same upsert as POST /webhook/barr-lead
// (barr-intake.js): match on lowercase email, else company name; Lead Source BuyAndRentRobots;
// only the barr-<type> tag. A later row for a contact already seen in this run updates it.
// A row with no recognizable type, or neither email nor company, is skipped and listed, never
// guessed at. Never touches the leads database.

process.env.DB_PATH = process.env.DB_PATH || ':memory:'; // ghl-push.js imports the db module; keep it off the real file

const fs = require('fs');
const path = require('path');
const { normalizeLead, upsertBarrLead } = require('../barr-intake');
const { testLeadReason } = require('../config');

// Header (lowercased, letters and digits only) -> payload key normalizeLead understands.
const COLUMN_ALIASES = {
  type: ['type', 'leadtype', 'barrtype', 'role', 'kind', 'category', 'usertype', 'inquirytype'],
  email: ['email', 'emailaddress', 'useremail', 'workemail'],
  name: ['name', 'fullname', 'contactname', 'contact'],
  firstName: ['firstname'],
  lastName: ['lastname'],
  phone: ['phone', 'phonenumber', 'mobile', 'telephone'],
  company: ['company', 'companyname', 'organization', 'organisation', 'business', 'businessname'],
  city: ['city', 'location'],
  interest: ['interest', 'interestedin', 'product', 'robot'],
  eventType: ['eventtype'],
  eventDate: ['eventdate'],
  guestCount: ['guestcount', 'guests'],
  budgetRange: ['budget', 'budgetrange'],
  message: ['message', 'notes', 'comments', 'details', 'inquiry'],
  campaign: ['campaign', 'utmcampaign'],
  pageUrl: ['pageurl', 'url', 'page'],
  website: ['website', 'companywebsite'],
};
const DATE_ALIASES = ['date', 'createdat', 'created', 'submittedat', 'submitted', 'datereceived', 'receivedat', 'timestamp', 'signupdate', 'inquirydate'];

const headerKey = (h) => String(h || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// RFC 4180: quoted fields, "" escapes, commas/newlines inside quotes, CRLF, BOM.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const src = String(text).replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { field += '"'; i++; } else if (c === '"') quoted = false; else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);
  return rows;
}

// -> [{ line, date: ms|null, dateText, body }] ; `line` is the 1-based line of the row in the file's row order.
function readRows(text) {
  const [header, ...data] = parseCsv(text);
  if (!header) return { rows: [], unmapped: [] };
  const byAlias = new Map();
  Object.entries(COLUMN_ALIASES).forEach(([key, aliases]) => aliases.forEach((a) => { if (!byAlias.has(a)) byAlias.set(a, key); }));
  const cols = header.map((h) => ({ key: byAlias.get(headerKey(h)) || null, isDate: DATE_ALIASES.includes(headerKey(h)), name: h }));
  const unmapped = cols.filter((c) => !c.key && !c.isDate).map((c) => c.name);

  const rows = data.map((cells, i) => {
    const body = {};
    let dateText = '';
    cols.forEach((c, idx) => {
      const v = String(cells[idx] == null ? '' : cells[idx]).trim();
      if (!v) return;
      if (c.isDate && !dateText) dateText = v;
      else if (c.key && !body[c.key]) body[c.key] = v;
    });
    const ms = dateText ? Date.parse(dateText) : NaN;
    return { line: i + 2, date: Number.isNaN(ms) ? null : ms, dateText, body };
  });
  return { rows, unmapped };
}

// Oldest first; undated rows last; ties keep file order.
function sortOldestFirst(rows) {
  return rows.map((r, i) => ({ r, i })).sort((a, b) => {
    const ad = a.r.date; const bd = b.r.date;
    if (ad === null && bd === null) return a.i - b.i;
    if (ad === null) return 1;
    if (bd === null) return -1;
    return ad - bd || a.i - b.i;
  }).map((x) => x.r);
}

// deps: { upsert(type, lead, { dryRun, seen }) } — injectable for tests.
async function runBackfill(rows, { commit = false, upsert = upsertBarrLead, log = console.log, pauseMs = 0 } = {}) {
  const ordered = sortOldestFirst(rows);
  const seen = new Map();
  const summary = { rows: ordered.length, create: 0, update: 0, skipped: 0, errors: 0, undated: 0 };
  for (const r of ordered) {
    const when = r.date === null ? '(no date)' : new Date(r.date).toISOString().slice(0, 10);
    if (r.date === null) summary.undated++;
    const prefix = `line ${String(r.line).padStart(4)} ${when}`;
    const { type, lead, error } = normalizeLead(r.body);
    if (error) { summary.skipped++; log(`${prefix}  SKIP   ${error}`); continue; }
    const testReason = testLeadReason(lead);
    if (testReason) { summary.skipped++; log(`${prefix}  SKIP   ${testReason}`); continue; }
    try {
      if (pauseMs) await new Promise((res) => setTimeout(res, pauseMs));
      const out = await upsert(type, lead, { dryRun: !commit, seen });
      const verb = out.action === 'create' ? 'CREATE' : 'UPDATE';
      if (out.action === 'create') summary.create++; else summary.update++;
      log(`${prefix}  ${commit ? verb : `WOULD ${verb}`}  ${type.padEnd(8)} ${out.line}`);
      out.warnings.forEach((w) => log(`${' '.repeat(prefix.length)}         ! ${w}`));
    } catch (err) {
      summary.errors++;
      log(`${prefix}  ERROR  ${err.message}`);
    }
  }
  return summary;
}

async function main() {
  const args = process.argv.slice(2);
  const commit = args.includes('--commit');
  const arg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const file = path.resolve(arg('--file') || 'barr_leads_review.csv');
  const limit = arg('--limit') ? Number(arg('--limit')) : Infinity;
  if (!(limit > 0)) throw new Error('--limit must be a positive number');
  if (!fs.existsSync(file)) throw new Error(`CSV not found: ${file} (pass --file)`);
  if (commit && /^(1|true|yes|on)$/i.test(String(process.env.GHL_PUSH_DISABLED || '').trim())) {
    throw new Error('GHL_PUSH_DISABLED (kill switch) is on — refusing --commit');
  }

  const { rows, unmapped } = readRows(fs.readFileSync(file, 'utf8'));
  console.log(`${commit ? 'COMMIT' : 'DRY RUN (nothing will be written)'} — ${rows.length} rows from ${file}, oldest first`);
  if (unmapped.length) console.log(`Columns not used: ${unmapped.join(', ')}`);
  const picked = Number.isFinite(limit) ? sortOldestFirst(rows).slice(0, limit) : rows;

  const s = await runBackfill(picked, { commit, pauseMs: 150 });
  console.log(`\n${commit ? 'Done' : 'Would do'}: ${s.create} created, ${s.update} updated, ${s.skipped} skipped${s.undated ? `, ${s.undated} undated (processed last)` : ''}${s.errors ? `, ${s.errors} ERRORS` : ''}`);
  if (!commit) console.log('Dry run only. Re-run with --commit to write.');
  if (s.errors) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}

module.exports = { parseCsv, readRows, sortOldestFirst, runBackfill, COLUMN_ALIASES };
