// One-time cleanup: remove every Wix Form lead (source starting with "Wix
// Form") whose date_received is before 2026-09-01. Requested explicitly:
// only leads actually submitted in September 2026 or later should remain
// from these forms — the older, mostly historical data pulled in by the
// dynamic-discovery sync (syncWixForms() in sync.js, which now walks every
// form on the site back through its full submission history) should be
// gone, permanently, not just hidden.
//
// Every source/target other than Wix Form leads is left completely
// untouched — CheckCherry, GHL, Meta Ads, Google Ads, and manual entries
// are all out of scope for this cleanup.
//
// Uses deleteLead() (db.js) rather than a raw SQL DELETE — that's what
// records a deleted_leads tombstone for each row's email+target, which is
// exactly the point here: syncWixForms() re-queries each form's full
// submission history every 15 minutes with no date filter, so without a
// tombstone this same historical data would simply come right back on the
// next sync cycle.
//
// Run directly against the real production DB via:
//   railway run node scripts/prune-old-wix-leads.js
//
// (Not against a scratch/local DB — DB_PATH defaults to /data/leads.db,
// same as the running server, so under `railway run` this hits the actual
// production volume.)
//
// Prints every row it's about to remove (source, name, email, date) first,
// so there's a record to work from if anything needs to be manually
// re-entered later — deleteLead()'s tombstone means the normal sync path
// can't bring any of these back on its own.

const { db, deleteLead } = require('../db.js');

const CUTOFF = '2026-09-01';

const rows = db.prepare(
  `SELECT id, source, name, email, date_received FROM leads
   WHERE source LIKE 'Wix Form%' AND date_received < ?
   ORDER BY source, date_received`
).all(CUTOFF);

if (rows.length === 0) {
  console.log(`No Wix Form leads found with date_received before ${CUTOFF}. Nothing to delete.`);
  process.exit(0);
}

console.log(`Found ${rows.length} Wix Form lead(s) with date_received before ${CUTOFF} to remove:\n`);
for (const row of rows) {
  console.log(`  id=${row.id}  source="${row.source}"  date=${row.date_received}  name=${row.name || '(no name)'}  email=${row.email || '(no email)'}`);
}

let deleted = 0;
for (const row of rows) {
  deleteLead(row.id);
  deleted++;
}

console.log(`\nDeleted ${deleted} row(s) (each tombstoned in deleted_leads too).`);

const remaining = db.prepare(`SELECT COUNT(*) AS n FROM leads WHERE source LIKE 'Wix Form%'`).get();
console.log(`Remaining Wix Form rows (any date): ${remaining.n}`);
const remainingBefore = db.prepare(`SELECT COUNT(*) AS n FROM leads WHERE source LIKE 'Wix Form%' AND date_received < ?`).get(CUTOFF);
console.log(`Remaining Wix Form rows still before ${CUTOFF} (should be 0): ${remainingBefore.n}`);
