/**
 * WhatsApp Session Manager
 * Manages one Baileys session per user.
 */
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const pino = require('pino');
const { db } = require('../db');

const SESSIONS_DIR = path.join(__dirname, '..', '..', 'data', 'sessions');
const logger = pino({ level: 'warn' });

class WAManager {
  constructor() {
    // Map<userId, { socket, qr, status }>
    this.sessions = new Map();
    // Listeners waiting for QR updates (WebSocket connections)
    this.qrListeners = new Map(); // Map<userId, Set<ws>>
    // Message handler callback
    this.onMessage = null;
  }

  /**
   * Set the message handler for incoming group messages
   */
  setMessageHandler(handler) {
    this.onMessage = handler;
  }

  /**
   * Start a WhatsApp session for a user.
   * Returns the QR code as a data URL if not yet authenticated.
   */
  async startSession(userId) {
    // If session already exists and connected, skip
    if (this.sessions.has(userId)) {
      const existing = this.sessions.get(userId);
      if (existing.status === 'connected') {
        return { status: 'connected' };
      }
    }

    const sessionDir = path.join(SESSIONS_DIR, `user_${userId}`);
    if (!fs.existsSync(sessionDir)) {
      fs.mkdirSync(sessionDir, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    const socket = makeWASocket({
      version,
      auth: state,
      logger,
      printQRInTerminal: false,
      browser: ['Group Radar', 'Chrome', '120.0'],
      // Reduce memory usage
      getMessage: async () => undefined,
    });

    const sessionData = {
      socket,
      qr: null,
      status: 'connecting',
      userId,
    };

    this.sessions.set(userId, sessionData);

    // Handle connection updates
    socket.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        // Generate QR as data URL
        const qrDataUrl = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
        sessionData.qr = qrDataUrl;
        sessionData.status = 'qr';

        // Notify WebSocket listeners
        this._notifyQRListeners(userId, { type: 'qr', qr: qrDataUrl });
      }

      if (connection === 'close') {
        const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        sessionData.status = 'disconnected';
        db.prepare('UPDATE wa_sessions SET status = ? WHERE user_id = ?')
          .run('disconnected', userId);

        this._notifyQRListeners(userId, { type: 'disconnected' });

        if (shouldReconnect) {
          console.log(`[WA] User ${userId}: reconnecting...`);
          setTimeout(() => this.startSession(userId), 3000);
        } else {
          console.log(`[WA] User ${userId}: logged out, cleaning session`);
          this.sessions.delete(userId);
          // Remove auth files so user can re-scan
          fs.rmSync(sessionDir, { recursive: true, force: true });
        }
      }

      if (connection === 'open') {
        console.log(`[WA] User ${userId}: connected!`);
        sessionData.status = 'connected';
        sessionData.qr = null;

        db.prepare(`
          INSERT INTO wa_sessions (user_id, status, last_connected)
          VALUES (?, 'connected', datetime('now'))
          ON CONFLICT(user_id) DO UPDATE SET status = 'connected', last_connected = datetime('now')
        `).run(userId);

        db.prepare('UPDATE users SET wa_connected = 1 WHERE id = ?').run(userId);

        this._notifyQRListeners(userId, { type: 'connected' });

        // Fetch user's groups and store them
        await this._syncGroups(userId, socket);
      }
    });

    // Save credentials on update
    socket.ev.on('creds.update', saveCreds);

    // Handle incoming messages (group messages)
    socket.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const msg of messages) {
        // Only process group messages
        if (!msg.key.remoteJid?.endsWith('@g.us')) continue;
        // Skip own messages
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

  /**
   * Sync user's WhatsApp groups to database
   */
  async _syncGroups(userId, socket) {
    try {
      const groups = await socket.groupFetchAllParticipating();
      const insertGroup = db.prepare(`
        INSERT INTO user_groups (user_id, group_jid, group_name, enabled)
        VALUES (?, ?, ?, 0)
        ON CONFLICT(user_id, group_jid) DO UPDATE SET group_name = excluded.group_name
      `);

      const transaction = db.transaction((groups) => {
        for (const [jid, meta] of Object.entries(groups)) {
          insertGroup.run(userId, jid, meta.subject);
        }
      });

      transaction(groups);
      console.log(`[WA] User ${userId}: synced ${Object.keys(groups).length} groups`);
    } catch (err) {
      console.error(`[WA] User ${userId}: group sync error:`, err.message);
    }
  }

  /**
   * Get session status for a user
   */
  getStatus(userId) {
    const session = this.sessions.get(userId);
    if (!session) return { status: 'disconnected', qr: null };
    return { status: session.status, qr: session.qr };
  }

  /**
   * Disconnect a user's WhatsApp session
   */
  async disconnect(userId) {
    const session = this.sessions.get(userId);
    if (session?.socket) {
      await session.socket.logout();
      this.sessions.delete(userId);
    }
    db.prepare('UPDATE wa_sessions SET status = ? WHERE user_id = ?')
      .run('disconnected', userId);
    db.prepare('UPDATE users SET wa_connected = 0 WHERE id = ?').run(userId);
  }

  /**
   * Register a WebSocket listener for QR updates
   */
  addQRListener(userId, ws) {
    if (!this.qrListeners.has(userId)) {
      this.qrListeners.set(userId, new Set());
    }
    this.qrListeners.get(userId).add(ws);

    // Send current QR if available
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

  /**
   * Restore sessions for users that were previously connected
   */
  async restoreAll() {
    const rows = db.prepare("SELECT user_id FROM wa_sessions WHERE status = 'connected'").all();
    console.log(`[WA] Restoring ${rows.length} sessions...`);
    for (const row of rows) {
      const sessionDir = path.join(SESSIONS_DIR, `user_${row.user_id}`);
      if (fs.existsSync(sessionDir)) {
        await this.startSession(row.user_id);
      }
    }
  }
}

module.exports = new WAManager();
