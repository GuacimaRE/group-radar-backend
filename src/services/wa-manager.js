/**
 * WhatsApp Session Manager
 * Manages one Baileys session per user.
 * Auth state persisted in PostgreSQL (survives Railway restarts).
 */
const { default: makeWASocket, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const QRCode = require('qrcode');
const pino = require('pino');
const { db } = require('../db');
const { usePostgresAuthState } = require('./pg-auth-state');

const logger = pino({ level: 'warn' });

class WAManager {
  constructor() {
    this.sessions = new Map();
    this.qrListeners = new Map();
    this.onMessage = null;
  }

  setMessageHandler(handler) {
    this.onMessage = handler;
  }

  async startSession(userId) {
    if (this.sessions.has(userId)) {
      const existing = this.sessions.get(userId);
      if (existing.status === 'connected') {
        return { status: 'connected' };
      }
      // Clean up stale session
      if (existing.socket) {
        try { existing.socket.end(); } catch {}
      }
      this.sessions.delete(userId);
    }

    // Use PostgreSQL-backed auth state
    const { state, saveCreds } = await usePostgresAuthState(userId);
    const { version } = await fetchLatestBaileysVersion();

    const socket = makeWASocket({
      version,
      auth: state,
      logger,
      printQRInTerminal: false,
      browser: ['Group Radar', 'Chrome', '120.0'],
      getMessage: async () => undefined,
    });

    const sessionData = {
      socket,
      qr: null,
      status: 'connecting',
      userId,
    };

    this.sessions.set(userId, sessionData);

    socket.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        const qrDataUrl = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
        sessionData.qr = qrDataUrl;
        sessionData.status = 'qr';
        this._notifyQRListeners(userId, { type: 'qr', qr: qrDataUrl });
      }

      if (connection === 'close') {
        const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        sessionData.status = 'disconnected';
        try {
          await db.prepare("UPDATE wa_sessions SET status = 'disconnected' WHERE user_id = $1").run(userId);
        } catch {}

        this._notifyQRListeners(userId, { type: 'disconnected' });

        if (shouldReconnect) {
          console.log(`[WA] User ${userId}: reconnecting in 5s...`);
          this.sessions.delete(userId);
          setTimeout(() => this.startSession(userId), 5000);
        } else {
          console.log(`[WA] User ${userId}: logged out, clearing auth keys`);
          this.sessions.delete(userId);
          // Clear stored auth keys so user can re-scan
          try {
            await db.prepare('DELETE FROM wa_auth_keys WHERE user_id = $1').run(userId);
          } catch {}
        }
      }

      if (connection === 'open') {
        console.log(`[WA] User ${userId}: connected!`);
        sessionData.status = 'connected';
        sessionData.qr = null;

        try {
          await db.prepare(`
            INSERT INTO wa_sessions (user_id, status, last_connected)
            VALUES ($1, 'connected', NOW())
            ON CONFLICT(user_id) DO UPDATE SET status = 'connected', last_connected = NOW()
          `).run(userId);
          await db.prepare('UPDATE users SET wa_connected = 1 WHERE id = $1').run(userId);
        } catch (err) {
          console.error(`[WA] DB update error:`, err.message);
        }

        this._notifyQRListeners(userId, { type: 'connected' });
        await this._syncGroups(userId, socket);
      }
    });

    socket.ev.on('creds.update', saveCreds);

    socket.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const msg of messages) {
        if (!msg.key.remoteJid?.endsWith('@g.us')) continue;
        if (msg.key.fromMe) continue;

        const text = msg.message?.conversation
          || msg.message?.extendedTextMessage?.text
          || '';

        if (!text) continue;

        if (this.onMessage) {
          this.onMessage(userId, {
            groupJid: msg.key.remoteJid,
            sender: msg.key.participant,
            text,
            timestamp: msg.messageTimestamp,
          });
        }
      }
    });

    return { status: 'connecting' };
  }

  async _syncGroups(userId, socket) {
    try {
      const groups = await socket.groupFetchAllParticipating();

      for (const [jid, meta] of Object.entries(groups)) {
        await db.prepare(`
          INSERT INTO user_groups (user_id, group_jid, group_name, enabled)
          VALUES ($1, $2, $3, 0)
          ON CONFLICT(user_id, group_jid) DO UPDATE SET group_name = EXCLUDED.group_name
        `).run(userId, jid, meta.subject);
      }

      console.log(`[WA] User ${userId}: synced ${Object.keys(groups).length} groups`);
    } catch (err) {
      console.error(`[WA] User ${userId}: group sync error:`, err.message);
    }
  }

  getStatus(userId) {
    const session = this.sessions.get(userId);
    if (!session) return { status: 'disconnected', qr: null };
    return { status: session.status, qr: session.qr };
  }

  async disconnect(userId) {
    const session = this.sessions.get(userId);
    if (session?.socket) {
      try { await session.socket.logout(); } catch {}
      this.sessions.delete(userId);
    }
    try {
      await db.prepare("UPDATE wa_sessions SET status = 'disconnected' WHERE user_id = $1").run(userId);
      await db.prepare('UPDATE users SET wa_connected = 0 WHERE id = $1').run(userId);
    } catch {}
  }

  addQRListener(userId, ws) {
    if (!this.qrListeners.has(userId)) {
      this.qrListeners.set(userId, new Set());
    }
    this.qrListeners.get(userId).add(ws);

    const session = this.sessions.get(userId);
    if (session?.qr) {
      ws.send(JSON.stringify({ type: 'qr', qr: session.qr }));
    } else if (session?.status === 'connected') {
      ws.send(JSON.stringify({ type: 'connected' }));
    }
  }

  removeQRListener(userId, ws) {
    this.qrListeners.get(userId)?.delete(ws);
  }

  _notifyQRListeners(userId, data) {
    const listeners = this.qrListeners.get(userId);
    if (!listeners) return;
    const json = JSON.stringify(data);
    for (const ws of listeners) {
      try { ws.send(json); } catch {}
    }
  }

  async restoreAll() {
    try {
      const rows = await db.prepare("SELECT user_id FROM wa_sessions WHERE status = 'connected'").all();
      console.log(`[WA] Restoring ${rows.length} sessions...`);
      for (const row of rows) {
        // Check if auth keys exist in DB
        const keys = await db.prepare('SELECT COUNT(*) as count FROM wa_auth_keys WHERE user_id = $1').get(row.user_id);
        if (parseInt(keys.count) > 0) {
          console.log(`[WA] Restoring session for user ${row.user_id}...`);
          await this.startSession(row.user_id);
        } else {
          console.log(`[WA] No auth keys for user ${row.user_id}, skipping`);
          await db.prepare("UPDATE wa_sessions SET status = 'disconnected' WHERE user_id = $1").run(row.user_id);
        }
      }
    } catch (err) {
      console.error('[WA] Restore error:', err.message);
    }
  }
}

module.exports = new WAManager();
