/**
 * Database layer using PostgreSQL (pg)
 * Persistent storage on Railway Postgres add-on.
 * 
 * Exposes a compatibility layer so existing code using
 * db.prepare(sql).run/get/all() keeps working with minimal changes.
 * 
 * Uses $1, $2... placeholders (Postgres style).
 * Migration: all ? placeholders in SQL must be changed to $1, $2, etc.
 */
const { Pool } = require('pg');

// Railway provides DATABASE_URL automatically when you add Postgres
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
});

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        phone TEXT UNIQUE NOT NULL,
        name TEXT,
        plan TEXT DEFAULT 'free',
        wa_connected INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS user_categories (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        category TEXT NOT NULL,
        enabled INTEGER DEFAULT 1,
        UNIQUE(user_id, category)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS user_keywords (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        category TEXT NOT NULL,
        keyword TEXT NOT NULL,
        enabled INTEGER DEFAULT 1,
        UNIQUE(user_id, category, keyword)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS user_zones (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        zone TEXT NOT NULL
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS user_price_range (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) UNIQUE,
        min_price REAL DEFAULT 0,
        max_price REAL DEFAULT 999999,
        currency TEXT DEFAULT 'USD'
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS user_groups (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        group_jid TEXT NOT NULL,
        group_name TEXT,
        enabled INTEGER DEFAULT 1,
        UNIQUE(user_id, group_jid)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS alerts (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        group_jid TEXT,
        group_name TEXT,
        message_text TEXT,
        matched_keywords TEXT,
        matched_zone TEXT,
        matched_price REAL,
        sent_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS wa_sessions (
        user_id INTEGER PRIMARY KEY REFERENCES users(id),
        status TEXT DEFAULT 'disconnected',
        last_connected TIMESTAMPTZ
      )
    `);

    // Baileys auth state persistence
    await client.query(`
      CREATE TABLE IF NOT EXISTS wa_auth_keys (
        user_id INTEGER NOT NULL,
        key_id TEXT NOT NULL,
        key_data JSONB NOT NULL,
        PRIMARY KEY(user_id, key_id)
      )
    `);

    // Migration: add new columns if they don't exist
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS password TEXT`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ls_customer_id TEXT`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ls_subscription_id TEXT`);

    // Drop old Stripe columns if they exist
    await client.query(`ALTER TABLE users DROP COLUMN IF EXISTS stripe_customer_id`);
    await client.query(`ALTER TABLE users DROP COLUMN IF EXISTS stripe_subscription_id`);

    console.log('[DB] PostgreSQL tables ready');
  } finally {
    client.release();
  }
}

/**
 * Compatibility proxy — mimics better-sqlite3 / sql.js API
 * so routes don't need massive rewrites.
 * 
 * IMPORTANT: SQL must use $1, $2... placeholders (not ?).
 */
const db = {
  prepare(sql) {
    return {
      async run(...params) {
        // Only add RETURNING for INSERT statements (not UPDATE/DELETE/ON CONFLICT)
        const trimmed = sql.trim().toUpperCase();
        let query = sql;
        if (trimmed.startsWith('INSERT') && !sql.toUpperCase().includes('RETURNING')) {
          query = sql + ' RETURNING id';
        }
        try {
          const res = await pool.query(query, params);
          return { lastInsertRowid: res.rows?.[0]?.id };
        } catch (err) {
          // If RETURNING fails (e.g., table has no id column), retry without it
          if (err.message?.includes('column "id" does not exist')) {
            const res = await pool.query(sql, params);
            return { lastInsertRowid: null };
          }
          throw err;
        }
      },
      async get(...params) {
        const res = await pool.query(sql, params);
        return res.rows[0] || undefined;
      },
      async all(...params) {
        const res = await pool.query(sql, params);
        return res.rows;
      }
    };
  },
  async exec(sql) {
    await pool.query(sql);
  },
  transaction(fn) {
    return async (...args) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // Provide a scoped db for the transaction
        const txDb = {
          prepare(sql) {
            return {
              async run(...params) {
                const res = await client.query(sql, params);
                return { lastInsertRowid: res.rows[0]?.id };
              },
              async get(...params) {
                const res = await client.query(sql, params);
                return res.rows[0] || undefined;
              },
              async all(...params) {
                const res = await client.query(sql, params);
                return res.rows;
              }
            };
          }
        };
        await fn(txDb, ...args);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    };
  },
  // Direct query access for new code
  query: (sql, params) => pool.query(sql, params),
  close() {
    return pool.end();
  }
};

module.exports = { initDB, db, pool };
