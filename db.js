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

const findByEmailAndTarget = db.prepare(
  `SELECT * FROM leads WHERE email = ? AND target = ? AND email != '' ORDER BY id DESC LIMIT 1`
);

const insertLead = db.prepare(`
  INSERT INTO leads (target, date_received, source, name, company, email, phone, location, interest, status, owner, notes, next_follow_up)
  VALUES (@target, @date_received, @source, @name, @company, @email, @phone, @location, @interest, @status, @owner, @notes, @next_follow_up)
`);

const updateLeadFields = db.prepare(`
  UPDATE leads SET
    status = COALESCE(NULLIF(@status, ''), status),
    notes = COALESCE(NULLIF(@notes, ''), notes),
    next_follow_up = COALESCE(NULLIF(@next_follow_up, ''), next_follow_up),
    owner = COALESCE(NULLIF(@owner, ''), owner),
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
    });
    return { action: 'updated', id: existing.id, target };
  }

  const info = insertLead.run({
    target,
    date_received: new Date().toISOString().slice(0, 10),
    source: data.source || '',
    name: data.name || '',
    company: data.company || '',
    email: data.email || '',
    phone: data.phone || '',
    location: data.location || '',
    interest: data.interest || '',
    status: data.status || 'New',
    owner: data.owner || '',
    notes: data.notes || '',
    next_follow_up: data.nextFollowUp || 'Yes',
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
    email: fields.email || '',
    phone: fields.phone || '',
    location: fields.location || '',
    interest: fields.interest || '',
    status: fields.status || 'New',
    owner: fields.owner || '',
    notes: fields.notes || '',
    next_follow_up: fields.next_follow_up || 'Yes',
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
