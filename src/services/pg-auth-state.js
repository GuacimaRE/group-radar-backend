/**
 * PostgreSQL-backed auth state for Baileys.
 * Replaces useMultiFileAuthState — stores creds in DB instead of filesystem.
 * Survives Railway restarts, container redeployments, etc.
 */
const { proto, initAuthCreds: baileyInitAuthCreds } = require('@whiskeysockets/baileys');
const { db } = require('../db');

const KEY_PREFIX = 'auth:';
const CREDS_KEY = 'creds';

/**
 * Initialize auth state from PostgreSQL for a given userId.
 */
async function usePostgresAuthState(userId) {
  // Load creds from DB
  const credsRow = await db.prepare(
    'SELECT key_data FROM wa_auth_keys WHERE user_id = $1 AND key_id = $2'
  ).get(userId, CREDS_KEY);

  let creds = credsRow ? JSON.parse(credsRow.key_data) : undefined;

  // If creds exist, deserialize signedPreKey and other Buffer fields
  if (creds) {
    creds = deserializeCreds(creds);
  }

  const state = {
    creds: creds || initAuthCreds(),
    keys: {
      get: async (type, ids) => {
        const result = {};
        for (const id of ids) {
          const keyId = `${KEY_PREFIX}${type}:${id}`;
          const row = await db.prepare(
            'SELECT key_data FROM wa_auth_keys WHERE user_id = $1 AND key_id = $2'
          ).get(userId, keyId);
          if (row) {
            let data = JSON.parse(row.key_data);
            if (type === 'app-state-sync-key') {
              data = proto.Message.AppStateSyncKeyData.fromObject(data);
            }
            result[id] = data;
          }
        }
        return result;
      },
      set: async (data) => {
        for (const [type, entries] of Object.entries(data)) {
          for (const [id, value] of Object.entries(entries)) {
            const keyId = `${KEY_PREFIX}${type}:${id}`;
            if (value) {
              const json = JSON.stringify(value);
              await db.prepare(`
                INSERT INTO wa_auth_keys (user_id, key_id, key_data)
                VALUES ($1, $2, $3::jsonb)
                ON CONFLICT(user_id, key_id) DO UPDATE SET key_data = EXCLUDED.key_data
              `).run(userId, keyId, json);
            } else {
              await db.prepare(
                'DELETE FROM wa_auth_keys WHERE user_id = $1 AND key_id = $2'
              ).run(userId, keyId);
            }
          }
        }
      }
    }
  };

  const saveCreds = async () => {
    const json = JSON.stringify(state.creds);
    await db.prepare(`
      INSERT INTO wa_auth_keys (user_id, key_id, key_data)
      VALUES ($1, $2, $3::jsonb)
      ON CONFLICT(user_id, key_id) DO UPDATE SET key_data = EXCLUDED.key_data
    `).run(userId, CREDS_KEY, json);
  };

  return { state, saveCreds };
}

/**
 * Create initial empty auth creds (Baileys will fill them in).
 */
function initAuthCreds() {
  // Use Baileys' built-in initAuthCreds if available, otherwise return undefined
  if (typeof baileyInitAuthCreds === 'function') {
    return baileyInitAuthCreds();
  }
  return undefined;
}

/**
 * Deserialize creds from JSON — handle Buffer fields stored as { type: 'Buffer', data: [...] }
 */
function deserializeCreds(creds) {
  if (!creds) return creds;

  const walk = (obj) => {
    if (!obj || typeof obj !== 'object') return obj;
    if (obj.type === 'Buffer' && Array.isArray(obj.data)) {
      return Buffer.from(obj.data);
    }
    if (Array.isArray(obj)) return obj.map(walk);
    const result = {};
    for (const [k, v] of Object.entries(obj)) {
      result[k] = walk(v);
    }
    return result;
  };

  return walk(creds);
}

module.exports = { usePostgresAuthState };
