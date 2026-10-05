// Backfill blank GHL fields on existing contacts from the lead rows stored in our
// database. DRY-RUN by default: reads GHL, writes nothing, prints what it would
// fill. Pass --apply to write.
//
// It reads the leads database, which exists only on the Railway volume, so run it
// INSIDE the container with `railway ssh` (NOT `railway run`, which executes on your
// own machine where /data/leads.db does not exist):
//
//   railway ssh -- sh -c 'cd /app && node scripts/backfill-ghl-fields.js'                  # dry run, all sources
//   railway ssh -- sh -c 'cd /app && node scripts/backfill-ghl-fields.js --source wix'     # one source (wix|meta|google|checkcherry)
//   railway ssh -- sh -c 'cd /app && node scripts/backfill-ghl-fields.js --limit 10'       # first 10 contacts per source
//   railway ssh -- sh -c 'cd /app && node scripts/backfill-ghl-fields.js --apply'
//
// Starts from the STORED LEAD ROWS (not GHL tags — this app has never tagged
// contacts with source-* before). For each source: group its rows by email
// (newest first; rows without an email are skipped), look the contact up in GHL by
// email, and apply ONLY plan.fillBlank: a value is written only where the
// contact's field is currently blank. It never creates contacts, never overwrites,
// never touches tags, notes, Lead Source/Status/Score, Last Activity or consent
// (Unknown is never written on an existing contact), and skips advanced /
// dead-deal contacts using the same classification as the live push. BARR, spam
// and test/internal rows are skipped too. Rows stored before the shape columns
// existed are re-derived from their old interest/notes text (rowToLead).
//
// --limit N is applied per source, to contacts (distinct emails), newest first.
// Per source the report shows rows matched, contacts not found in GHL, and how many
// found contacts are STILL missing each field after the fill (in a dry run: after
// the would-be fill).

const { SOURCE_PROFILES, profileForSource, classifyContact, toPlanBody, isBarrLead, isSpamLead } = require('../ghl-push');
const { buildLeadPlan, resolveFillBlank, isBlankOnContact, TRACKED_FIELDS } = require('../ghl-lead-plan');
const { rowToLead, SHAPE_FIELDS } = require('../lead-shape');
const { testLeadReason } = require('../config');

// First letter + stars ("j***@e***.com"): enough to eyeball a log line without exposing a contact.
function maskEmail(email) {
  const [local = '', domain = ''] = String(email).split('@');
  return `${local.slice(0, 1)}***@${domain.slice(0, 1)}***`;
}

const MERGE_KEYS = [...SHAPE_FIELDS, 'company', 'phone', 'name', 'location', 'notes', 'extra', 'utmCampaign'];

// Several stored rows can belong to one contact (e.g. two Wix forms, or a
// re-submission). Newest first; each field takes the first non-blank value.
function mergeRows(rows) {
  const lead = rowToLead(rows[0]);
  rows.slice(1).forEach((row) => {
    const other = rowToLead(row);
    MERGE_KEYS.forEach((k) => { if (!lead[k] && other[k]) lead[k] = other[k]; });
  });
  return lead;
}

// deps: { rowsForSource(profile) -> rows newest first, findContact(email) -> full GHL contact | null,
//         updateContact(id, body) }
async function backfillSource(profile, deps, { apply = false, limit = Infinity, pauseMs = 0, log = () => {} } = {}) {
  const report = {
    source: profile.key, rows: 0, rowsNoEmail: 0, rowsExcluded: 0, contacts: 0, rowsMatched: 0, contactsFound: 0,
    contactsNotFound: 0, skippedGuard: 0, contactsFilled: 0, valuesFilled: 0, errors: 0,
    missing: Object.fromEntries(TRACKED_FIELDS.map((t) => [t.key, 0])),
  };
  const pause = () => (pauseMs ? new Promise((r) => setTimeout(r, pauseMs)) : null);

  // Group this source's eligible rows by email, keeping newest-first order.
  const byEmail = new Map();
  for (const row of deps.rowsForSource(profile)) {
    report.rows++;
    const email = String(row.email || '').trim().toLowerCase();
    if (!email) { report.rowsNoEmail++; continue; }
    const lead = rowToLead(row);
    if (isBarrLead(lead, row) || isSpamLead(lead, row) || testLeadReason(lead)) { report.rowsExcluded++; continue; }
    if (!byEmail.has(email)) byEmail.set(email, []);
    byEmail.get(email).push(row);
  }

  for (const [email, rows] of byEmail) {
    if (report.contacts >= limit) break;
    report.contacts++;
    try {
      await pause();
      const contact = await deps.findContact(email);
      if (!contact) { report.contactsNotFound++; continue; }
      report.contactsFound++;
      report.rowsMatched += rows.length;

      const cls = classifyContact(contact);
      const plan = buildLeadPlan(toPlanBody(mergeRows(rows)), {
        isNewContact: false,
        profile,
        context: {
          advancedReason: cls.bucket === 'advanced' ? cls.reason : null,
          reengageReason: cls.bucket === 'reengage' ? cls.reason : null,
          noImpliedConsent: true, // the backfill writes no tags, so it must not imply consent (no audit tag)
        },
      });

      let fillKeys = [];
      if (cls.bucket !== 'normal') {
        report.skippedGuard++;
      } else {
        const fill = resolveFillBlank(plan, contact, { standalone: true });
        fillKeys = fill.keys;
        if (fill.keys.length) {
          report.contactsFilled++;
          report.valuesFilled += fill.keys.length;
          log(`${apply ? 'FILL' : 'WOULD FILL'} ${contact.id} ${maskEmail(email)}: ${fill.keys.join(', ')}`);
          if (apply) await deps.updateContact(contact.id, { ...fill.contactFields, customFields: fill.customFields });
        }
      }
      TRACKED_FIELDS.forEach((t) => {
        if (isBlankOnContact(contact, t) && !fillKeys.includes(t.key)) report.missing[t.key]++;
      });
    } catch (err) {
      report.errors++;
      log(`ERROR ${maskEmail(email)}: ${err.message}`);
    }
  }
  return report;
}

function formatReport(reports, { apply }) {
  const lines = [`\n=== GHL field backfill — ${apply ? 'APPLIED' : 'DRY RUN (nothing written)'} ===`];
  reports.forEach((r) => {
    lines.push(
      `\n[${r.source}]`,
      `  stored rows:                 ${r.rows}   (no email, skipped: ${r.rowsNoEmail}; BARR/spam/test, skipped: ${r.rowsExcluded})`,
      `  contacts looked up:          ${r.contacts}`,
      `  rows matched to a contact:   ${r.rowsMatched}`,
      `  contacts NOT found in GHL:   ${r.contactsNotFound}`,
      `  skipped (advanced/dead):     ${r.skippedGuard}`,
      `  ${apply ? 'filled' : 'would fill'}:  ${r.contactsFilled} contacts, ${r.valuesFilled} values${r.errors ? `   ERRORS: ${r.errors}` : ''}`,
      `  still missing, of ${r.contactsFound} contacts found:`,
    );
    TRACKED_FIELDS.forEach((t) => {
      const note = (t.kind === 'custom' && !t.id) ? '   (GHL field not configured yet)' : '';
      lines.push(`    ${t.key.padEnd(18)} ${String(r.missing[t.key]).padStart(6)}${note}`);
    });
  });
  return lines.join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const arg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const only = arg('--source');
  const limit = arg('--limit') ? Number(arg('--limit')) : Infinity;
  if (!(limit > 0)) throw new Error('--limit must be a positive number');
  if (apply && /^(1|true|yes|on)$/i.test(String(process.env.GHL_PUSH_DISABLED || '').trim())) {
    throw new Error('GHL_PUSH_DISABLED (kill switch) is on — refusing --apply');
  }

  const ghl = require('../ghl-client');
  const { db } = require('../db');
  const allRows = db.prepare(`SELECT * FROM leads ORDER BY id DESC`);
  const deps = {
    rowsForSource: (profile) => allRows.all().filter((r) => profileForSource(r.source) === profile),
    findContact: async (email) => {
      const found = await ghl.findDuplicateContact({ email, phone: '' });
      return found ? ((await ghl.getContact(found.id)) || found) : null;
    },
    updateContact: (id, body) => ghl.updateContact(id, body),
  };

  const keys = only ? only.split(',') : Object.keys(SOURCE_PROFILES);
  const reports = [];
  for (const key of keys) {
    if (!SOURCE_PROFILES[key]) throw new Error(`unknown source "${key}" (use ${Object.keys(SOURCE_PROFILES).join('|')})`);
    console.log(`\nScanning stored ${key} rows ...`);
    reports.push(await backfillSource(SOURCE_PROFILES[key], deps, { apply, limit, pauseMs: 120, log: console.log }));
  }
  console.log(formatReport(reports, { apply }));
  if (!apply) console.log('\nDry run only. Re-run with --apply to write these fills.');
}

if (require.main === module) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}

module.exports = { backfillSource, formatReport, mergeRows, maskEmail };
