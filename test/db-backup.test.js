process.env.DB_PATH = ':memory:';
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { backupBeforeMigration, existingBackups } = require('../db-backup');

const OLD_SCHEMA = `CREATE TABLE leads (id INTEGER PRIMARY KEY AUTOINCREMENT, date_received TEXT NOT NULL, source TEXT, email TEXT, notes TEXT, ghl_pushed TEXT)`;
let dir; let dbPath; let db;
const log = console.log;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dma-backup-'));
  dbPath = path.join(dir, 'leads.db');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(OLD_SCHEMA);
  const ins = db.prepare(`INSERT INTO leads (date_received, source, email, notes, ghl_pushed) VALUES ('2026-09-01', 'Wix Form - X', ?, 'keep me', 'legacy')`);
  for (let i = 0; i < 25; i++) ins.run(`p${i}@example.com`);
  console.log = () => {};
});
afterEach(() => { console.log = log; try { db.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); });

describe('pre-migration backup', () => {
  test('copies the DB to <dir>/backups/leads-pre-ghl-<timestamp>.db with every row intact', () => {
    const dest = backupBeforeMigration(db, dbPath, { now: new Date('2026-10-04T15:30:12Z') });
    assert.equal(dest, path.join(dir, 'backups', 'leads-pre-ghl-20261004-153012.db'));
    const copy = new Database(dest, { readonly: true });
    assert.equal(copy.prepare('SELECT COUNT(*) n FROM leads').get().n, 25);
    assert.equal(copy.prepare(`SELECT COUNT(*) n FROM leads WHERE ghl_pushed = 'legacy' AND notes = 'keep me'`).get().n, 25);
    assert.ok(!copy.prepare('PRAGMA table_info(leads)').all().some((c) => c.name === 'extra'), 'taken before the migration');
    copy.close();
  });

  test('uncommitted-looking WAL data is included (consistent online backup)', () => {
    db.prepare(`INSERT INTO leads (date_received, email) VALUES ('2026-10-01', 'wal@example.com')`).run(); // lives in the -wal file
    const dest = backupBeforeMigration(db, dbPath);
    const copy = new Database(dest, { readonly: true });
    assert.equal(copy.prepare(`SELECT COUNT(*) n FROM leads WHERE email = 'wal@example.com'`).get().n, 1);
    copy.close();
  });

  test('only if no such backup exists yet: a second call (or a restart) takes none', () => {
    assert.ok(backupBeforeMigration(db, dbPath, { now: new Date('2026-10-04T15:30:12Z') }));
    assert.equal(backupBeforeMigration(db, dbPath, { now: new Date('2026-10-05T01:00:00Z') }), null);
    assert.equal(existingBackups(path.join(dir, 'backups')).length, 1);
  });

  test('skipped for :memory:, for a fresh database, and once the migration has already run', () => {
    assert.equal(backupBeforeMigration(db, ':memory:'), null);
    const fresh = new Database(path.join(dir, 'fresh.db'));
    assert.equal(backupBeforeMigration(fresh, path.join(dir, 'fresh.db')), null);
    fresh.close();
    db.exec(`ALTER TABLE leads ADD COLUMN extra TEXT DEFAULT ''`);
    assert.equal(backupBeforeMigration(db, dbPath), null);
    assert.ok(!fs.existsSync(path.join(dir, 'backups')), 'no directory created when nothing is backed up');
  });

  test('a failed backup throws, so the migration cannot run unprotected', () => {
    fs.writeFileSync(path.join(dir, 'backups'), 'a file, not a directory');
    assert.throws(() => backupBeforeMigration(db, dbPath));
  });

  test('db.js runs the backup before it migrates (order in the source)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'db.js'), 'utf8');
    const backupAt = src.indexOf('backupBeforeMigration(db, DB_PATH)');
    assert.ok(backupAt > 0);
    assert.ok(backupAt < src.indexOf('CREATE TABLE IF NOT EXISTS leads'));
    assert.ok(backupAt < src.indexOf('ALTER TABLE leads ADD COLUMN'));
  });
});
