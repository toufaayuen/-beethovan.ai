/**
 * SQLite database for users and saved songs.
 * Migrates from store.json on first run if it exists.
 */
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'beethovan.db');
const STORE_FILE = path.join(DATA_DIR, 'store.json');

let db = null;

function getDb() {
  if (db) return db;
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  db = new Database(DB_FILE);

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      tier TEXT DEFAULT 'free',
      subscription_id TEXT,
      subscription_period_end TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS saved_songs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      artist TEXT DEFAULT '',
      data TEXT NOT NULL,
      saved_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_saved_songs_user ON saved_songs(user_id);
  `);

  migrateFromStore();
  return db;
}

function migrateFromStore() {
  try {
    const data = fs.readFileSync(STORE_FILE, 'utf8');
    const store = JSON.parse(data);
    const users = store.users || [];
    if (users.length === 0) return;

    const d = getDb();
    const existing = d.prepare('SELECT COUNT(*) as n FROM users').get();
    if (existing.n > 0) return;

    const insertUser = d.prepare(`
      INSERT INTO users (id, email, password_hash, tier, subscription_id, subscription_period_end, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const insertSong = d.prepare(`
      INSERT INTO saved_songs (user_id, title, artist, data, saved_at)
      VALUES (?, ?, ?, ?, ?)
    `);

    const run = d.transaction(() => {
      for (const u of users) {
        insertUser.run(
          u.id,
          u.email,
          u.passwordHash || '',
          u.tier || 'free',
          u.subscriptionId || null,
          u.subscriptionPeriodEnd || null,
          u.createdAt || new Date().toISOString()
        );
        for (const s of (u.savedSongs || [])) {
          insertSong.run(
            u.id,
            s.title || '',
            s.artist || '',
            JSON.stringify(s),
            s.savedAt || new Date().toISOString()
          );
        }
      }
    });
    run();
    console.log('Migrated', users.length, 'users from store.json to SQLite');
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn('Migration from store.json:', e.message);
  }
}

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function getUserById(id) {
  const row = getDb().prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.password_hash,
    tier: row.tier,
    subscriptionId: row.subscription_id,
    subscriptionPeriodEnd: row.subscription_period_end,
    createdAt: row.created_at,
  };
}

function getUserByEmail(email) {
  const row = getDb().prepare('SELECT * FROM users WHERE LOWER(email) = LOWER(?)').get(email);
  if (!row) return null;
  return getUserById(row.id);
}

function createUser(email, passwordHash) {
  const id = genId();
  const createdAt = new Date().toISOString();
  getDb().prepare(`
    INSERT INTO users (id, email, password_hash, tier, created_at)
    VALUES (?, ?, ?, 'free', ?)
  `).run(id, email.toLowerCase(), passwordHash, createdAt);
  return { id, email: email.toLowerCase(), tier: 'free', savedSongs: [], createdAt };
}

function updateUser(userId, updates) {
  const u = getUserById(userId);
  if (!u) return null;
  const tier = updates.tier !== undefined ? updates.tier : u.tier;
  const subId = updates.hasOwnProperty('subscriptionId') ? updates.subscriptionId : u.subscriptionId;
  const subEnd = updates.hasOwnProperty('subscriptionPeriodEnd') ? updates.subscriptionPeriodEnd : u.subscriptionPeriodEnd;
  getDb().prepare(`
    UPDATE users SET tier = ?, subscription_id = ?, subscription_period_end = ?
    WHERE id = ?
  `).run(tier, subId, subEnd, userId);
  return getUserById(userId);
}

function getSavedSongs(userId) {
  const rows = getDb().prepare(`
    SELECT data FROM saved_songs WHERE user_id = ? ORDER BY saved_at ASC
  `).all(userId);
  return rows.map(r => {
    try {
      return JSON.parse(r.data);
    } catch (e) {
      return {};
    }
  });
}

function addSavedSong(userId, song) {
  const songs = getSavedSongs(userId);
  const exists = songs.some(s => s.title === song.title && (s.artist || '') === (song.artist || ''));
  if (exists) return { exists: true };
  const data = JSON.stringify({ ...song, savedAt: new Date().toISOString() });
  getDb().prepare(`
    INSERT INTO saved_songs (user_id, title, artist, data, saved_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(userId, song.title || '', song.artist || '', data, new Date().toISOString());
  return { exists: false, count: songs.length + 1 };
}

function removeSavedSongByIndex(userId, index) {
  const rows = getDb().prepare(`
    SELECT id FROM saved_songs WHERE user_id = ? ORDER BY saved_at ASC
  `).all(userId);
  if (index < 0 || index >= rows.length) return false;
  const id = rows[index].id;
  getDb().prepare('DELETE FROM saved_songs WHERE id = ?').run(id);
  return true;
}

function syncEmailList() {
  const users = getDb().prepare('SELECT * FROM users ORDER BY created_at').all();
  const EMAIL_LIST_FILE = path.join(DATA_DIR, 'email-list.txt');
  const lines = [
    `# Registered users (${users.length} total)`,
    `# Last updated: ${new Date().toISOString()}`,
    ''
  ];
  for (const u of users) {
    const savedCount = getSavedSongs(u.id).length;
    const joined = u.created_at ? u.created_at.slice(0, 10) : '-';
    const subEnd = u.subscription_period_end ? u.subscription_period_end.slice(0, 10) : '-';
    lines.push(u.email);
    lines.push(`  tier: ${u.tier || 'free'}`);
    lines.push(`  saved songs: ${savedCount}`);
    lines.push(`  joined: ${joined}`);
    if (u.tier === 'unlimited' && subEnd !== '-') lines.push(`  subscription ends: ${subEnd}`);
    lines.push('');
  }
  fs.writeFileSync(EMAIL_LIST_FILE, lines.join('\n'), 'utf8');
}

module.exports = {
  getDb,
  genId,
  getUserById,
  getUserByEmail,
  createUser,
  updateUser,
  getSavedSongs,
  addSavedSong,
  removeSavedSongByIndex,
  syncEmailList,
};
