// Backfill blank GHL fields on existing source-tagged contacts from the lead
// rows stored in our database. DRY-RUN by default: reads GHL, writes nothing,
// and prints what it would fill. Pass --apply to write.
//
//   railway run node scripts/backfill-ghl-fields.js                  # dry run, all sources
//   railway run node scripts/backfill-ghl-fields.js --source wix     # one source (wix|meta|google|checkcherry)
//   railway run node scripts/backfill-ghl-fields.js --limit 25       # first 25 contacts per source
//   railway run node scripts/backfill-ghl-fields.js --apply
//
// For each contact tagged source-wix / source-meta / source-google-ads /
// source-checkcherry it finds that contact's stored lead row(s) by email,
// builds the same plan a live push would, and applies ONLY plan.fillBlank:
// a value is written only where the contact's field is currently blank. It
// never overwrites, never touches tags, notes, Lead Source/Status/Score or
// Last Activity, and skips advanced / dead-deal contacts entirely (same guard
// as the live push). Rows stored before the shape columns existed are
// re-derived from their old interest/notes text (lead-shape.js rowToLead).
//
// The report ends with, per source, how many contacts are STILL missing each
// field after the fill (in a dry run: after the would-be fill).

const { SOURCE_PROFILES, profileForSource, classifyContact, toPlanBody } = require('../ghl-push');
const { buildLeadPlan, resolveFillBlank, isBlankOnContact, TRACKED_FIELDS } = require('../ghl-lead-plan');
const { rowToLead, SHAPE_FIELDS } = require('../lead-shape');

const KEEP_BLANK_MERGE = [...SHAPE_FIELDS, 'company', 'phone', 'name', 'location', 'notes', 'extra', 'utmCampaign'];

// Several stored rows can belong to one contact (e.g. two Wix forms, or a
// re-submission). Newest first; each field takes the first non-blank value.
function mergeRows(rows) {
  const lead = rowToLead(rows[0]);
  rows.slice(1).forEach((row) => {
    const other = rowToLead(row);
    KEEP_BLANK_MERGE.forEach((k) => { if (!lead[k] && other[k]) lead[k] = other[k]; });
  });
  return lead;
}

// deps: { iterateContacts(tag), getContact(id), updateContact(id, body), findRows(email) }
async function backfillSource(profile, deps, { apply = false, limit = Infinity, pauseMs = 0, log = () => {} } = {}) {
  const report = {
    source: profile.key, tag: profile.sourceTag, scanned: 0, withRow: 0, noRow: 0, skippedGuard: 0,
    contactsFilled: 0, valuesFilled: 0, missing: Object.fromEntries(TRACKED_FIELDS.map((t) => [t.key, 0])), errors: 0,
  };
  const sleep = () => (pauseMs ? new Promise((r) => setTimeout(r, pauseMs)) : null);

  for await (const summary of deps.iterateContacts(profile.sourceTag)) {
    if (report.scanned >= limit) break;
    report.scanned++;
    try {
      await sleep();
      const contact = (await deps.getContact(summary.id)) || summary;
      const email = String(contact.email || summary.email || '').trim().toLowerCase();
      const rows = email ? deps.findRows(email).filter((r) => profileForSource(r.source) === profile) : [];

      let fillKeys = [];
      if (!rows.length) {
        report.noRow++;
      } else {
        report.withRow++;
        const cls = classifyContact(contact);
        const plan = buildLeadPlan(toPlanBody(mergeRows(rows)), {
          isNewContact: false,
          profile,
          context: {
            advancedReason: cls.bucket === 'advanced' ? cls.reason : null,
            reengageReason: cls.bucket === 'reengage' ? cls.reason : null,
          },
        });
        if (cls.bucket !== 'normal') {
          report.skippedGuard++;
        } else {
          const fill = resolveFillBlank(plan, contact, { standalone: true });
          fillKeys = fill.keys;
          if (fill.keys.length) {
            report.contactsFilled++;
            report.valuesFilled += fill.keys.length;
            log(`${apply ? 'FILL' : 'WOULD FILL'} ${contact.id} ${email}: ${fill.keys.join(', ')}`);
            if (apply) await deps.updateContact(contact.id, { ...fill.contactFields, customFields: fill.customFields });
          }
        }
      }
      TRACKED_FIELDS.forEach((t) => {
        if (isBlankOnContact(contact, t) && !fillKeys.includes(t.key)) report.missing[t.key]++;
      });
    } catch (err) {
      report.errors++;
      log(`ERROR ${summary.id}: ${err.message}`);
    }
  }
  return report;
}

function formatReport(reports, { apply }) {
  const lines = [`\n=== GHL field backfill — ${apply ? 'APPLIED' : 'DRY RUN (nothing written)'} ===`];
  reports.forEach((r) => {
    lines.push(
      `\n[${r.source}] tag ${r.tag}`,
      `  contacts scanned:        ${r.scanned}`,
      `  with a stored lead row:  ${r.withRow}   (no row: ${r.noRow})`,
      `  skipped (advanced/dead): ${r.skippedGuard}`,
      `  ${apply ? 'filled' : 'would fill'}:  ${r.contactsFilled} contacts, ${r.valuesFilled} values${r.errors ? `   ERRORS: ${r.errors}` : ''}`,
      `  still missing, of ${r.scanned} contacts:`,
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

  if (apply && /^(1|true|yes|on)$/i.test(String(process.env.GHL_PUSH_DISABLED || '').trim())) {
    throw new Error('GHL_PUSH_DISABLED (kill switch) is on — refusing --apply');
  }
  const ghl = require('../ghl-client');
  const { db } = require('../db');
  const findRowsStmt = db.prepare('SELECT * FROM leads WHERE email = ? ORDER BY id DESC');
  const deps = {
    iterateContacts: (tag) => ghl.iterateContactsByTag(tag),
    getContact: (id) => ghl.getContact(id),
    updateContact: (id, body) => ghl.updateContact(id, body),
    findRows: (email) => findRowsStmt.all(email),
  };

  const keys = only ? only.split(',') : Object.keys(SOURCE_PROFILES);
  const reports = [];
  for (const key of keys) {
    if (!SOURCE_PROFILES[key]) throw new Error(`unknown source "${key}" (use ${Object.keys(SOURCE_PROFILES).join('|')})`);
    console.log(`\nScanning ${SOURCE_PROFILES[key].sourceTag} ...`);
    reports.push(await backfillSource(SOURCE_PROFILES[key], deps, { apply, limit, pauseMs: 120, log: console.log }));
  }
  console.log(formatReport(reports, { apply }));
  if (!apply) console.log('\nDry run only. Re-run with --apply to write these fills.');
}

if (require.main === module) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}

module.exports = { backfillSource, formatReport, mergeRows };
