// One-time safety copy of the leads database, taken BEFORE the lead-shape
// migration alters the table. Uses SQLite's online backup API (better-sqlite3
// `db.backup()`), which yields a consistent copy even in WAL mode.
//
// better-sqlite3's backup is async-only, but db.js must finish the migration
// synchronously at load time (its prepared statements depend on the new columns),
// so the backup runs in a short child process that this function waits for.
//
// Runs only when ALL hold: the DB is a real file (not :memory:), it already has a
// `leads` table, the migration hasn't happened yet (no `extra` column), and no
// `leads-pre-ghl-*.db` exists in the backups directory yet. A failed backup THROWS:
// the migration must not proceed without its safety copy.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const BACKUP_PREFIX = 'leads-pre-ghl-';
const MIGRATION_MARKER_COLUMN = 'extra'; // the last column the shape migration adds

const CHILD_SCRIPT = `
const Database = require(process.argv[1]);
const db = new Database(process.argv[2], { fileMustExist: true });
db.backup(process.argv[3]).then(() => db.close()).catch((e) => { console.error(e.message); process.exit(1); });
`;

function timestamp(now = new Date()) {
  return now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15); // 20261004-153012
}

function existingBackups(dir) {
  try { return fs.readdirSync(dir).filter((f) => f.startsWith(BACKUP_PREFIX) && f.endsWith('.db')); } catch { return []; }
}

// Returns the backup path when one was taken, else null.
function backupBeforeMigration(db, dbPath, { backupDir, now } = {}) {
  if (!dbPath || dbPath === ':memory:') return null;
  const cols = db.prepare(`PRAGMA table_info(leads)`).all().map((c) => c.name);
  if (!cols.length) return null; // fresh database: nothing to protect
  if (cols.includes(MIGRATION_MARKER_COLUMN)) return null; // already migrated: a copy now wouldn't be "pre-ghl"
  const dir = backupDir || path.join(path.dirname(dbPath), 'backups');
  if (existingBackups(dir).length) return null;

  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `${BACKUP_PREFIX}${timestamp(now)}.db`);
  const betterSqlite = require.resolve('better-sqlite3');
  execFileSync(process.execPath, ['-e', CHILD_SCRIPT, betterSqlite, dbPath, dest], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 10 * 60 * 1000 });
  if (!fs.existsSync(dest) || fs.statSync(dest).size === 0) throw new Error(`pre-migration backup was not written: ${dest}`);
  console.log(`pre-migration backup written: ${dest} (${fs.statSync(dest).size} bytes)`);
  return dest;
}

module.exports = { backupBeforeMigration, existingBackups, BACKUP_PREFIX };
