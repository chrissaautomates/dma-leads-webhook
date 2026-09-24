// The ghl_pushed migration: proves the back catalog is locked out. Builds a
// database file in the OLD schema (no ghl_pushed column) holding historical
// rows, boots db.js against it, and checks every existing row is 'legacy' —
// then that rows added afterwards are pending (NULL) and are NOT re-stamped on
// a later boot.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

function freshDb() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ghl-migration-')), 'leads.db');
  const old = new Database(file);
  // The production schema BEFORE this change (no ghl_pushed).
  old.exec(`
    CREATE TABLE leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT, target TEXT NOT NULL DEFAULT 'DMA', date_received TEXT NOT NULL,
      source TEXT, name TEXT, company TEXT, email TEXT, phone TEXT, location TEXT, interest TEXT,
      status TEXT DEFAULT 'New', owner TEXT, notes TEXT, next_follow_up TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      utm_source TEXT DEFAULT '', utm_medium TEXT DEFAULT '', utm_campaign TEXT DEFAULT '', utm_content TEXT DEFAULT '', utm_term TEXT DEFAULT ''
    );`);
  const ins = old.prepare(`INSERT INTO leads (target, date_received, source, name, email, status) VALUES (?, ?, ?, ?, ?, ?)`);
  for (let i = 0; i < 320; i++) ins.run('DMA', '2026-09-05', 'Wix Form - Digital Mirror Homepage', `Wix ${i}`, `wix${i}@example.com`, 'New');
  for (let i = 0; i < 225; i++) ins.run('CHECKCHERRY', '2026-08-01', 'CheckCherry', `Prop ${i}`, `prop${i}@example.com`, 'Proposal Sent');
  ins.run('DMA', '2026-09-20', 'Meta Ads', 'Meta One', 'meta1@example.com', 'New');
  old.close();
  return file;
}

function bootDb(file) {
  process.env.DB_PATH = file;
  delete require.cache[require.resolve('../db')];
  return require('../db');
}

test('migration adds ghl_pushed and stamps EVERY existing row legacy (320 Wix + 225 CheckCherry + 1 Meta)', () => {
  const file = freshDb();
  const { db } = bootDb(file);
  const cols = db.prepare('PRAGMA table_info(leads)').all().map((c) => c.name);
  assert.ok(cols.includes('ghl_pushed'));
  const counts = Object.fromEntries(db.prepare(`SELECT COALESCE(ghl_pushed, 'NULL') k, COUNT(*) n FROM leads GROUP BY k`).all().map((r) => [r.k, r.n]));
  assert.deepEqual(counts, { legacy: 546 }, 'no row may be left pending');
  db.close();
});

test('rows inserted after the migration are pending (NULL), and a second boot does NOT re-stamp them', () => {
  const file = freshDb();
  let m = bootDb(file);
  const res = m.upsertLead({ source: 'Meta Ads', name: 'New Person', email: 'newperson@example.com', dateReceived: '2026-10-05' });
  assert.equal(res.action, 'inserted');
  assert.equal(m.getGhlState(res.id).ghl_pushed, null);
  m.db.close();

  m = bootDb(file); // second boot: column already exists -> migration must not run again
  assert.equal(m.getGhlState(res.id).ghl_pushed, null, 'a post-migration row must stay pending');
  const legacy = m.db.prepare(`SELECT COUNT(*) n FROM leads WHERE ghl_pushed = 'legacy'`).get().n;
  assert.equal(legacy, 546);
  m.db.close();
});

test('markGhlPushed can never overwrite a terminal state (a legacy row cannot be re-armed or re-marked)', () => {
  const file = freshDb();
  const m = bootDb(file);
  const legacyId = m.db.prepare('SELECT id FROM leads LIMIT 1').get().id;
  assert.equal(m.markGhlPushed(legacyId, 'pushed'), 0);
  assert.equal(m.getGhlState(legacyId).ghl_pushed, 'legacy');
  m.db.close();
});

test('a caller-supplied terminal value is honored at insert; manual /admin entries are excluded', () => {
  const m = bootDb(freshDb());
  const r = m.upsertLead({ source: 'CheckCherry', name: 'Prop', email: 'evt@example.com', ghlPushed: 'excluded_proposal' });
  assert.equal(m.getGhlState(r.id).ghl_pushed, 'excluded_proposal');
  const manualId = m.addLeadFromAdmin({ name: 'Walk-up', email: 'walkup@example.com' });
  assert.equal(m.getGhlState(manualId).ghl_pushed, 'excluded_source');
  m.db.close();
});
