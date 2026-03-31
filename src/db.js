const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'group-radar.db');
const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Create tables
db.exec(`
  -- Users
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT UNIQUE NOT NULL,
    name TEXT,
    plan TEXT DEFAULT 'free',
    wa_connected INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  -- Categories per user
  CREATE TABLE IF NOT EXISTS user_categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    category TEXT NOT NULL,
    enabled INTEGER DEFAULT 1,
    FOREIGN KEY (user_id) REFERENCES users(id),
    UNIQUE(user_id, category)
  );

  -- Keywords per user per category
  CREATE TABLE IF NOT EXISTS user_keywords (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    category TEXT NOT NULL,
    keyword TEXT NOT NULL,
    enabled INTEGER DEFAULT 1,
    FOREIGN KEY (user_id) REFERENCES users(id),
    UNIQUE(user_id, category, keyword)
  );

  -- Zone/location filters per user
  CREATE TABLE IF NOT EXISTS user_zones (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    zone TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  -- Price range per user
  CREATE TABLE IF NOT EXISTS user_price_range (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    min_price REAL DEFAULT 0,
    max_price REAL DEFAULT 999999,
    currency TEXT DEFAULT 'USD',
    FOREIGN KEY (user_id) REFERENCES users(id),
    UNIQUE(user_id)
  );

  -- Groups monitored per user
  CREATE TABLE IF NOT EXISTS user_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    group_jid TEXT NOT NULL,
    group_name TEXT,
    enabled INTEGER DEFAULT 1,
    FOREIGN KEY (user_id) REFERENCES users(id),
    UNIQUE(user_id, group_jid)
  );

  -- Alerts sent
  CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    group_jid TEXT,
    group_name TEXT,
    message_text TEXT,
    matched_keywords TEXT,
    matched_zone TEXT,
    matched_price REAL,
    sent_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  -- WhatsApp sessions (auth state stored on disk, this tracks status)
  CREATE TABLE IF NOT EXISTS wa_sessions (
    user_id INTEGER PRIMARY KEY,
    status TEXT DEFAULT 'disconnected',
    last_connected TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);

module.exports = db;
