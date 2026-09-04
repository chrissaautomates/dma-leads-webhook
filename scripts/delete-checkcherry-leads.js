// One-time cleanup: remove every lead with source = 'CheckCherry' from the
// leads database. CheckCherry has been removed from the dashboard entirely
// (see runFullSync() in sync.js) — this script drops the leads it already
// synced in so the CheckCherry summary tile on /admin stops showing up
// (admin.js only renders a source tile when leads with that source exist).
//
// Run directly against the real production DB via:
//   railway run node scripts/delete-checkcherry-leads.js
//
// (Not against a scratch/local DB — DB_PATH defaults to /data/leads.db,
// same as the running server, so under `railway run` this hits the actual
// production volume.)
//
// Prints every row it's about to delete (name, email, date) first, so
// there's a record to work from if anything needs to be manually re-entered
// later.

const { db } = require('../db.js');

const rows = db.prepare(
  `SELECT id, name, email, date_received, target FROM leads WHERE source = 'CheckCherry' ORDER BY id`
).all();

if (rows.length === 0) {
  console.log('No CheckCherry leads found. Nothing to delete.');
  process.exit(0);
}

console.log(`Found ${rows.length} CheckCherry lead(s) to delete:\n`);
for (const row of rows) {
  console.log(`  id=${row.id}  target=${row.target}  date=${row.date_received}  name=${row.name || '(no name)'}  email=${row.email || '(no email)'}`);
}

const result = db.prepare(`DELETE FROM leads WHERE source = 'CheckCherry'`).run();

console.log(`\nDeleted ${result.changes} row(s).`);

const remaining = db.prepare(`SELECT COUNT(*) AS n FROM leads WHERE source = 'CheckCherry'`).get();
console.log(`Remaining CheckCherry rows: ${remaining.n}`);
