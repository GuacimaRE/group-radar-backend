/**
 * Database layer using sql.js (pure JS SQLite - no native binaries)
 * Works on Railway, Vercel, any platform without compilation.
 * Data persists to disk at data/group-radar.db
 */
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'group-radar.db');
const DATA_DIR = path.join(__dirname, '..', 'data');

let db = null;

// Auto-save interval (every 30 seconds)
let saveInterval = null;

function saveToFile() {
  if (!db) return;
  const data = db.export();
  const buffer = Buffer.from(data);
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DB_PATH, buffer);
}

async function initDB() {
  const SQL = await initSqlJs();
  
  // Load existing DB or create new
  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
  } else {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    db = new SQL.Database();
  }

  // Create tables
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT UNIQUE NOT NULL,
      name TEXT,
      plan TEXT DEFAULT 'free',
      wa_connected INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS user_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      category TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      FOREIGN KEY (user_id) REFERENCES users(id),
      UNIQUE(user_id, category)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS user_keywords (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      category TEXT NOT NULL,
      keyword TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      FOREIGN KEY (user_id) REFERENCES users(id),
      UNIQUE(user_id, category, keyword)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS user_zones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      zone TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS user_price_range (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      min_price REAL DEFAULT 0,
      max_price REAL DEFAULT 999999,
      currency TEXT DEFAULT 'USD',
      FOREIGN KEY (user_id) REFERENCES users(id),
      UNIQUE(user_id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS user_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      group_jid TEXT NOT NULL,
      group_name TEXT,
      enabled INTEGER DEFAULT 1,
      FOREIGN KEY (user_id) REFERENCES users(id),
      UNIQUE(user_id, group_jid)
    )
  `);

  db.run(`
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
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS wa_sessions (
      user_id INTEGER PRIMARY KEY,
      status TEXT DEFAULT 'disconnected',
      last_connected TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  saveToFile();

  // Auto-save every 30 seconds
  saveInterval = setInterval(saveToFile, 30000);

  console.log('[DB] Initialized with sql.js (pure JS)');
  return db;
}

// Wrapper to match better-sqlite3 API style
const dbProxy = {
  prepare(sql) {
    return {
      run(...params) {
        db.run(sql, params);
        saveToFile();
        return { lastInsertRowid: db.exec("SELECT last_insert_rowid()")[0]?.values[0][0] };
      },
      get(...params) {
        const stmt = db.prepare(sql);
        stmt.bind(params);
        if (stmt.step()) {
          const row = stmt.getAsObject();
          stmt.free();
          return row;
        }
        stmt.free();
        return undefined;
      },
      all(...params) {
        const results = [];
        const stmt = db.prepare(sql);
        stmt.bind(params);
        while (stmt.step()) {
          results.push(stmt.getAsObject());
        }
        stmt.free();
        return results;
      }
    };
  },
  exec(sql) {
    db.run(sql);
    saveToFile();
  },
  transaction(fn) {
    return (...args) => {
      db.run('BEGIN TRANSACTION');
      try {
        fn(...args);
        db.run('COMMIT');
        saveToFile();
      } catch (e) {
        db.run('ROLLBACK');
        throw e;
      }
    };
  },
  close() {
    if (saveInterval) clearInterval(saveInterval);
    saveToFile();
    if (db) db.close();
  }
};

module.exports = { initDB, db: dbProxy, saveToFile };
