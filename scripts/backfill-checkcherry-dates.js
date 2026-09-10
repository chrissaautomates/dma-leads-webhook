// One-time backfill: mapCheckCherryLead() (sync.js) never set dateReceived
// until this fix, so upsertLead()'s insert fallback stamped every
// CheckCherry lead synced via syncCheckCherry() (the regular /leads sync,
// not syncCheckCherryProposals()) with whatever day the sync first saw
// it — not the lead's real CheckCherry creation date. Since date_received
// is only ever set on insert, never touched by a later update, every
// already-synced row from that path has the wrong date until corrected
// here.
//
// Re-fetches every real lead from CheckCherry's /leads endpoint, matches
// each one back to our leads table by email, and corrects date_received
// to that lead's real created_at (the same field mapCheckCherryLead() now
// uses going forward, and the same one mapCheckCherryProposalEvent()
// already used correctly from the start). Nothing else on the row is
// touched — not status, not notes, not any other field a human may have
// since edited by hand in /admin.
//
// A row whose email doesn't match any real, currently-existing /leads
// record is left alone — that covers rows that only ever came from
// syncCheckCherryProposals() (/events), which already stamps the right
// date, so there's nothing to correct there.
//
// Run directly against the real production DB via:
//   railway run node scripts/backfill-checkcherry-dates.js
//
// (Needs a working DB_PATH + CHECKCHERRY_API_KEY in the environment, same
// as the live server — see delete-checkcherry-leads.js for why this must
// run somewhere with real access to both, not a scratch/local setup.)
//
// Prints every correction (email, old date -> new date) before making it,
// and reports how many rows were left unchanged.

const { db } = require('../db.js');

async function fetchAllLeads(apiKey) {
  const leads = [];
  let page = 1;
  for (;;) {
    const res = await fetch(`https://api.checkcherry.com/api/v1/leads?page=${page}&per=100`, {
      headers: { 'Api-Key': apiKey },
    });
    if (!res.ok) throw new Error(`CheckCherry HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const body = await res.json();
    const records = body.data || [];
    leads.push(...records);
    if (records.length < 100) break;
    page++;
    if (page > 50) break; // safety cap, matching the pattern used elsewhere in sync.js
  }
  return leads;
}

async function main() {
  const apiKey = process.env.CHECKCHERRY_API_KEY;
  if (!apiKey) {
    console.error('CHECKCHERRY_API_KEY is not set in this environment.');
    process.exit(1);
  }

  console.log('Fetching real leads from CheckCherry...');
  const records = await fetchAllLeads(apiKey);
  console.log(`Fetched ${records.length} real lead(s) from CheckCherry.\n`);

  // email (lowercased/trimmed, matching how upsertLead() stores it) -> real
  // creation date (YYYY-MM-DD, matching date_received's format).
  const realDateByEmail = new Map();
  for (const record of records) {
    const attrs = record.attributes || {};
    const email = (attrs.email || '').toString().trim().toLowerCase();
    if (!email || !attrs.created_at) continue;
    realDateByEmail.set(email, attrs.created_at.slice(0, 10));
  }

  const rows = db.prepare(
    `SELECT id, email, name, date_received FROM leads WHERE source = 'CheckCherry' ORDER BY id`
  ).all();

  let corrected = 0;
  let noMatch = 0;
  let alreadyCorrect = 0;
  for (const row of rows) {
    const email = (row.email || '').toString().trim().toLowerCase();
    const realDate = realDateByEmail.get(email);
    if (!realDate) { noMatch++; continue; }
    if (realDate === row.date_received) { alreadyCorrect++; continue; }

    console.log(`  id=${row.id}  email=${row.email}  name=${row.name || '(no name)'}  ${row.date_received} -> ${realDate}`);
    db.prepare(`UPDATE leads SET date_received = ? WHERE id = ?`).run(realDate, row.id);
    corrected++;
  }

  console.log(`\nCorrected ${corrected} row(s).`);
  console.log(`${alreadyCorrect} row(s) already had the right date.`);
  console.log(`${noMatch} row(s) had no matching real /leads record for their email (left untouched — likely proposal-only rows, which already have the right date from syncCheckCherryProposals()).`);
}

main().catch((err) => {
  console.error('Backfill failed:', err.message);
  process.exit(1);
});
