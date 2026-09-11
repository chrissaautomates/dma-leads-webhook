// Local leads database — SQLite file stored on a Railway Volume.
//
// This is the system of record. It replaces the old design where every lead
// had to round-trip through a Google Apps Script Web App bound to a
// spreadsheet — that path turned out to be unreliable (Apps Script would run
// successfully but the HTTP response back to the caller often got mangled,
// and rows didn't reliably land). A local database on a Railway Volume has
// no such moving parts: no external HTTP hop, no Google auth, nothing that
// needs redeploying in a separate UI.

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || '/data/leads.db';
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target TEXT NOT NULL DEFAULT 'DMA',      -- 'DMA', 'BARR' (BuyAndRentRobots), 'CHECKCHERRY', or 'CHATLEAD'
    date_received TEXT NOT NULL,
    source TEXT,
    name TEXT,
    company TEXT,
    email TEXT,
    phone TEXT,
    location TEXT,
    interest TEXT,
    status TEXT DEFAULT 'New',
    owner TEXT,
    notes TEXT,
    next_follow_up TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

db.exec(`CREATE INDEX IF NOT EXISTS idx_leads_email ON leads(email);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_leads_target ON leads(target);`);

// Tombstones for leads a human explicitly deleted from /admin. Every
// polling sync (Wix Forms, CheckCherry, CheckCherry Proposals, GHL) shares
// the same upsertLead() path and the same dedup identity — email + target,
// exactly what findLead() already keys on — so without this, a sync that
// runs every 15 minutes silently re-inserts a deleted lead the next time
// it sees the same source record, since there's nothing left in `leads`
// for findLead() to match against once the row is gone. dedup_key is the
// same normalized (lowercased/trimmed) email upsertLead() already stores,
// not a new identity scheme. `source` is recorded for reference only
// (which integration the deleted row came from) — it is not part of the
// match, since the match needs to block *any* source from recreating the
// same email+target, matching how upsertLead() already treats email+target
// as one identity regardless of which source last wrote to it.
db.exec(`
  CREATE TABLE IF NOT EXISTS deleted_leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dedup_key TEXT NOT NULL,
    target TEXT NOT NULL,
    source TEXT,
    deleted_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_deleted_leads_key ON deleted_leads(dedup_key, target);`);

// Migration: adds CheckCherry's UTM tracking columns to a table that may
// already exist and already hold real rows on the production volume — a
// bare ALTER TABLE ADD COLUMN (checked against PRAGMA table_info first, so
// it's a no-op on a DB that already has them) doesn't touch or rewrite any
// existing row data, unlike a CREATE TABLE-based migration would.
const UTM_COLUMNS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
const existingColumns = db.prepare(`PRAGMA table_info(leads)`).all().map((c) => c.name);
UTM_COLUMNS.forEach((col) => {
  if (!existingColumns.includes(col)) {
    db.exec(`ALTER TABLE leads ADD COLUMN ${col} TEXT DEFAULT ''`);
  }
});

// One-time fixup: rows synced before CheckCherry got its own tab were
// routed to DMA/BARR by content keywords alone (the only rule that existed
// at the time), even though their source is 'CheckCherry'. computeTarget()
// below now routes any CheckCherry-sourced lead to 'CHECKCHERRY' regardless
// of content — reclassify whatever's already in the table so it actually
// shows up on the new tab instead of silently staying put forever. Scoped
// to source = 'CheckCherry' exactly, so GHL's 'Chat Lead' rows are
// untouched. Idempotent (only touches rows not already CHECKCHERRY), so
// this runs harmlessly on every boot rather than needing a separate
// one-off script.
db.exec(`UPDATE leads SET target = 'CHECKCHERRY' WHERE source = 'CheckCherry' AND target != 'CHECKCHERRY'`);

// Same fixup, same reasoning, for GHL's Chat Lead rows: computeTarget()
// below now routes source = 'Chat Lead' to 'CHATLEAD', so reclassify
// anything already sitting on DMA/BARR from before that tab existed.
// Scoped to source = 'Chat Lead' exactly, so CheckCherry/BuyAndRentRobots/
// Meta Ads/Google Ads/Wix rows are untouched. Idempotent, runs harmlessly
// on every boot.
//
// Also scoped to date_received >= 2026-01-01 — matching computeTarget()'s
// own date check below and the CHATLEAD tab's own date-filtered display
// query (listChatLeadLeads() in this file) — on purpose: that tab never
// shows anything older, so a pre-2026 Chat Lead row migrated to CHATLEAD
// would vanish from every /admin tab entirely (not DMA/BARR, since its
// target changed away from them; not CHATLEAD, since the date filter
// excludes it). Leaving older rows on DMA/BARR instead means they keep
// showing up exactly where they always have.
//
// Logs before/after DMA/BARR/CHATLEAD counts so the migration is
// verifiable straight from deploy logs, without needing a separate ad-hoc
// query.
const chatLeadMigrationBefore = {
  DMA: db.prepare(`SELECT COUNT(*) n FROM leads WHERE target = 'DMA'`).get().n,
  BARR: db.prepare(`SELECT COUNT(*) n FROM leads WHERE target = 'BARR'`).get().n,
  CHATLEAD: db.prepare(`SELECT COUNT(*) n FROM leads WHERE target = 'CHATLEAD'`).get().n,
};
db.exec(`
  UPDATE leads SET target = 'CHATLEAD'
  WHERE source = 'Chat Lead' AND date_received >= '2026-01-01' AND target != 'CHATLEAD'
`);
const chatLeadMigrationAfter = {
  DMA: db.prepare(`SELECT COUNT(*) n FROM leads WHERE target = 'DMA'`).get().n,
  BARR: db.prepare(`SELECT COUNT(*) n FROM leads WHERE target = 'BARR'`).get().n,
  CHATLEAD: db.prepare(`SELECT COUNT(*) n FROM leads WHERE target = 'CHATLEAD'`).get().n,
};
console.log(
  'Chat Lead target migration — before:', JSON.stringify(chatLeadMigrationBefore),
  'after:', JSON.stringify(chatLeadMigrationAfter)
);

const findByEmailAndTarget = db.prepare(
  `SELECT * FROM leads WHERE email = ? AND target = ? AND email != '' ORDER BY id DESC LIMIT 1`
);

const findDeletion = db.prepare(
  `SELECT 1 FROM deleted_leads WHERE dedup_key = ? AND target = ? LIMIT 1`
);
const recordDeletionStmt = db.prepare(`
  INSERT INTO deleted_leads (dedup_key, target, source, deleted_at)
  VALUES (@dedup_key, @target, @source, datetime('now'))
  ON CONFLICT(dedup_key, target) DO UPDATE SET source = excluded.source, deleted_at = excluded.deleted_at
`);

// True if a human has already deleted this exact email+target from
// /admin — the same identity findLead() uses, so this only ever blocks a
// sync from recreating the specific row that was removed, never a
// different target bucket or a different email.
function isLeadDeleted(email, target) {
  const normalizedEmail = (email || '').toString().trim().toLowerCase();
  if (!normalizedEmail) return false; // no email -> findLead() could never have matched this anyway
  return !!findDeletion.get(normalizedEmail, target);
}

// Tombstones an email+target so upsertLead() skips it on every future
// sync. Idempotent — deleting the same lead twice (or a lead that somehow
// gets recreated and re-deleted) just refreshes deleted_at rather than
// erroring on the unique index.
function recordDeletion(email, target, source) {
  const normalizedEmail = (email || '').toString().trim().toLowerCase();
  if (!normalizedEmail) return; // nothing for a future sync to match against anyway
  recordDeletionStmt.run({ dedup_key: normalizedEmail, target, source: source || '' });
}

const insertLead = db.prepare(`
  INSERT INTO leads (
    target, date_received, source, name, company, email, phone, location, interest,
    status, owner, notes, next_follow_up, utm_source, utm_medium, utm_campaign, utm_content, utm_term
  )
  VALUES (
    @target, @date_received, @source, @name, @company, @email, @phone, @location, @interest,
    @status, @owner, @notes, @next_follow_up, @utm_source, @utm_medium, @utm_campaign, @utm_content, @utm_term
  )
`);

const updateLeadFields = db.prepare(`
  UPDATE leads SET
    status = COALESCE(NULLIF(@status, ''), status),
    notes = COALESCE(NULLIF(@notes, ''), notes),
    next_follow_up = COALESCE(NULLIF(@next_follow_up, ''), next_follow_up),
    owner = COALESCE(NULLIF(@owner, ''), owner),
    utm_source = COALESCE(NULLIF(@utm_source, ''), utm_source),
    utm_medium = COALESCE(NULLIF(@utm_medium, ''), utm_medium),
    utm_campaign = COALESCE(NULLIF(@utm_campaign, ''), utm_campaign),
    utm_content = COALESCE(NULLIF(@utm_content, ''), utm_content),
    utm_term = COALESCE(NULLIF(@utm_term, ''), utm_term),
    updated_at = datetime('now')
  WHERE id = @id
`);

// Exposed so callers can compute the target a lead would land in before
// they actually upsert it (e.g. to look up its current row first).
//
// CheckCherry and GHL's Chat Lead each get their own tab: a source of
// exactly 'CheckCherry' or 'Chat Lead' routes there regardless of what the
// interest text says, taking priority over the DMA/BARR content-keyword
// check below. These are exact source checks, not a broader pattern match,
// so CheckCherry/BuyAndRentRobots/Meta Ads/Google Ads/Wix routing is
// unaffected and keeps going by content same as before.
//
// The Chat Lead tab only ever displays date_received >= 2026-01-01 (see
// listChatLeadLeads() below), so that check is gated the same way here:
// an older Chat Lead row keeps routing to DMA/BARR by content instead of
// CHATLEAD, where it would otherwise vanish from every /admin tab (not
// DMA/BARR, since it's no longer their target; not CHATLEAD, since its
// date filter would exclude it). In practice every real Chat Lead synced
// so far is well within 2026, so this only matters for a manually-added
// or backdated one.
function computeTarget(data) {
  const source = data.source || '';
  if (source === 'CheckCherry') return 'CHECKCHERRY';
  if (source === 'Chat Lead') {
    const dateReceived = data.dateReceived || new Date().toISOString().slice(0, 10);
    if (dateReceived >= '2026-01-01') return 'CHATLEAD';
  }
  return /humanoid|robot rental|buyandrentrobots/i.test(
    source + ' ' + (data.interest || '')
  ) ? 'BARR' : 'DMA';
}

// Returns the existing lead row for a given email + target, or undefined if
// there's no match — the same lookup upsertLead() does internally, exposed
// so callers can check a lead's current state (e.g. its notes) before
// deciding whether to do expensive work ahead of an upsert.
function findLead(email, target) {
  const normalizedEmail = (email || '').toString().trim().toLowerCase();
  if (!normalizedEmail) return undefined;
  return findByEmailAndTarget.get(normalizedEmail, target);
}

function upsertLead(data) {
  const target = computeTarget(data);
  const email = (data.email || '').toString().trim().toLowerCase();

  // A human deleted this exact email+target from /admin — every sync
  // (Wix Forms, CheckCherry, CheckCherry Proposals, GHL) shares this same
  // upsert path, so checking here once covers all of them rather than
  // needing a per-sync guard. Only ever blocks recreating the specific
  // row that was removed; a genuinely different email sails through
  // untouched.
  if (isLeadDeleted(email, target)) {
    return { action: 'skipped_deleted', target };
  }

  const existing = findLead(email, target);

  if (existing) {
    updateLeadFields.run({
      id: existing.id,
      status: data.status || '',
      notes: data.notes || '',
      next_follow_up: data.nextFollowUp || '',
      owner: data.owner || '',
      // Only overwritten when the new value is non-empty (see
      // updateLeadFields' COALESCE/NULLIF above) — this is what lets a
      // plain re-sync backfill UTM data onto a lead that predates this
      // column existing, without needing a separate one-off script.
      utm_source: data.utmSource || '',
      utm_medium: data.utmMedium || '',
      utm_campaign: data.utmCampaign || '',
      utm_content: data.utmContent || '',
      utm_term: data.utmTerm || '',
    });
    return { action: 'updated', id: existing.id, target };
  }

  const info = insertLead.run({
    target,
    // Callers can pass an explicit dateReceived (e.g. a CSV backfill's real
    // created_time) to preserve the lead's actual received date instead of
    // defaulting to today — used by the Meta Ads sync for historical rows.
    date_received: data.dateReceived || new Date().toISOString().slice(0, 10),
    source: data.source || '',
    name: data.name || '',
    company: data.company || '',
    // Stored lowercased/trimmed to match how findLead() queries — email is
    // compared with a plain SQL "=" (no COLLATE NOCASE), so a mixed-case
    // email that isn't also normalized at write time silently fails to
    // match itself on a later sync, producing a duplicate row instead of
    // an update.
    email,
    phone: data.phone || '',
    location: data.location || '',
    interest: data.interest || '',
    status: data.status || 'New',
    owner: data.owner || '',
    notes: data.notes || '',
    next_follow_up: data.nextFollowUp || 'Yes',
    utm_source: data.utmSource || '',
    utm_medium: data.utmMedium || '',
    utm_campaign: data.utmCampaign || '',
    utm_content: data.utmContent || '',
    utm_term: data.utmTerm || '',
  });
  return { action: 'inserted', id: info.lastInsertRowid, target };
}

function listLeads(target) {
  if (target) {
    return db.prepare(`SELECT * FROM leads WHERE target = ? ORDER BY id DESC`).all(target);
  }
  return db.prepare(`SELECT * FROM leads ORDER BY id DESC`).all();
}

// Powers the /admin GHL tab: unlike DMA/BARR/CheckCherry (which show every
// row for their target regardless of date), this tab is explicitly scoped
// to dateReceived >= 2026-01-01 — anything older is left off. Queries by
// source rather than target so it stays correct even if some historical
// Chat Lead row's target were ever out of sync with its source.
function listChatLeadLeads() {
  return db.prepare(
    `SELECT * FROM leads WHERE source = 'Chat Lead' AND date_received >= '2026-01-01' ORDER BY id DESC`
  ).all();
}

function getLead(id) {
  return db.prepare(`SELECT * FROM leads WHERE id = ?`).get(id);
}

function updateLeadFromAdmin(id, fields) {
  db.prepare(`
    UPDATE leads SET
      status = @status,
      owner = @owner,
      notes = @notes,
      next_follow_up = @next_follow_up,
      updated_at = datetime('now')
    WHERE id = @id
  `).run({ id, ...fields });
}

// Records a tombstone for this row's email+target before removing it, so
// the next sync cycle doesn't silently bring it right back — see
// isLeadDeleted()/recordDeletion() above. Looked up here (rather than
// requiring the caller to pass the row) so every caller gets this for
// free; a row with no email is deleted with no tombstone recorded, since
// findLead() could never have matched it back to a sync record anyway.
function deleteLead(id) {
  const lead = db.prepare(`SELECT email, target, source FROM leads WHERE id = ?`).get(id);
  if (lead) recordDeletion(lead.email, lead.target, lead.source);
  db.prepare(`DELETE FROM leads WHERE id = ?`).run(id);
}

function addLeadFromAdmin(fields) {
  const info = insertLead.run({
    target: fields.target || 'DMA',
    date_received: fields.date_received || new Date().toISOString().slice(0, 10),
    source: fields.source || 'Manual entry',
    name: fields.name || '',
    company: fields.company || '',
    email: (fields.email || '').toString().trim().toLowerCase(),
    phone: fields.phone || '',
    location: fields.location || '',
    interest: fields.interest || '',
    status: fields.status || 'New',
    owner: fields.owner || '',
    notes: fields.notes || '',
    next_follow_up: fields.next_follow_up || 'Yes',
    // Manual entries don't have UTM data of their own, but the column still
    // needs a value for the prepared statement — pass through whatever was
    // given (matching this function's existing snake_case field naming),
    // blank otherwise.
    utm_source: fields.utm_source || '',
    utm_medium: fields.utm_medium || '',
    utm_campaign: fields.utm_campaign || '',
    utm_content: fields.utm_content || '',
    utm_term: fields.utm_term || '',
  });
  return info.lastInsertRowid;
}

module.exports = {
  db,
  upsertLead,
  findLead,
  computeTarget,
  listLeads,
  listChatLeadLeads,
  getLead,
  updateLeadFromAdmin,
  addLeadFromAdmin,
  deleteLead,
  DB_PATH,
};
