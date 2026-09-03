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
    target TEXT NOT NULL DEFAULT 'DMA',      -- 'DMA' or 'BARR' (BuyAndRentRobots)
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

const findByEmailAndTarget = db.prepare(
  `SELECT * FROM leads WHERE email = ? AND target = ? AND email != '' ORDER BY id DESC LIMIT 1`
);

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

// Same DMA vs. BuyAndRentRobots routing upsertLead() has always used,
// exposed so callers can compute the target a lead would land in before
// they actually upsert it (e.g. to look up its current row first).
function computeTarget(data) {
  return /humanoid|robot rental|buyandrentrobots/i.test(
    (data.source || '') + ' ' + (data.interest || '')
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
  getLead,
  updateLeadFromAdmin,
  addLeadFromAdmin,
  DB_PATH,
};
