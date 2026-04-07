/**
 * Group Radar — Backend Server
 * WhatsApp group monitoring SaaS
 */
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const http = require('http');
const { WebSocketServer } = require('ws');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');

const { initDB, db } = require('./db');
const waManager = require('./services/wa-manager');
const Scanner = require('./services/scanner');

// Routes
const authRoutes = require('./routes/auth');
const settingsRoutes = require('./routes/settings');
const whatsappRoutes = require('./routes/whatsapp');
const alertsRoutes = require('./routes/alerts');
const paymentRoutes = require('./routes/payments');
const { webhookHandler } = require('./routes/payments');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';

const app = express();
app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true,
}));

// LemonSqueezy webhook needs raw body for HMAC verification — MUST be before express.json()
app.post('/api/payments/webhook', express.raw({ type: 'application/json' }), webhookHandler);

// JSON body parser for all other routes
app.use(express.json());

// Rate limiters
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes. Intenta de nuevo en unos minutos.' },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos de autenticación. Intenta de nuevo en 15 minutos.' },
});

app.use('/api/', generalLimiter);
app.use('/api/auth/', authLimiter);

// Temp: clear WA auth for user
app.post('/api/auth/clear-wa', async (req, res) => {
  const { phone, secret } = req.body;
  if (secret !== 'wercr2026') return res.status(403).json({ error: 'forbidden' });
  const { db } = require('./db');
  const user = await db.prepare('SELECT id FROM users WHERE phone = $1').get(phone);
  if (!user) return res.status(404).json({ error: 'user not found' });
  await db.prepare('DELETE FROM wa_auth_keys WHERE user_id = $1').run(user.id);
  res.json({ ok: true, userId: user.id });
});

// Temp: set password for existing user
app.post('/api/auth/set-password', async (req, res) => {
  const { phone, password, secret } = req.body;
  if (secret !== 'wercr2026') return res.status(403).json({ error: 'forbidden' });
  const bcrypt = require('bcryptjs');
  const { db } = require('./db');
  const hashed = await bcrypt.hash(password, 10);
  try {
    await db.prepare('ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT').run();
  } catch(_) {}
  await db.prepare('UPDATE users SET password = $1 WHERE phone = $2').run(hashed, phone);
  res.json({ ok: true });
});

// Health check
app.get('/api/health', (req, res) => {
  const sessions = waManager.sessions.size;
  const connected = [...waManager.sessions.values()].filter(s => s.status === 'connected').length;
  res.json({ status: 'ok', db: 'postgres', sessions, connected, uptime: process.uptime() });
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/whatsapp', whatsappRoutes);
app.use('/api/alerts', alertsRoutes);
app.use('/api/payments', paymentRoutes);

const server = http.createServer(app);

// WebSocket server for real-time QR updates
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', async (ws, req) => {
  const params = new URL(req.url, `http://localhost:${PORT}`).searchParams;

  // Support JWT token auth (preferred) or legacy phone param
  const token = params.get('token');
  const phone = params.get('phone');

  let userId = null;

  if (token) {
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      const user = await db.prepare('SELECT id FROM users WHERE id = $1').get(payload.userId);
      if (user) userId = user.id;
    } catch (err) {
      ws.close(4001, 'Invalid token');
      return;
    }
  } else if (phone) {
    // Legacy: phone-based lookup
    try {
      const user = await db.prepare('SELECT id FROM users WHERE phone = $1').get(phone);
      if (user) userId = user.id;
    } catch {}
  }

  if (!userId) {
    ws.close(4001, 'Authentication required');
    return;
  }

  console.log(`[WS] User ${userId} connected for QR updates`);
  waManager.addQRListener(userId, ws);

  ws.on('close', () => {
    waManager.removeQRListener(userId, ws);
  });
});

// Initialize scanner
const scanner = new Scanner(waManager);

// Start server
async function start() {
  await initDB();
  console.log('[DB] PostgreSQL ready');

  server.listen(PORT, async () => {
    console.log(`
  ╔══════════════════════════════════════╗
  ║   📡 Group Radar Backend v2.1       ║
  ║   Port: ${PORT}                         ║
  ║   DB: PostgreSQL                    ║
  ║   Auth: JWT                         ║
  ║   ENV: ${(process.env.NODE_ENV || 'development').padEnd(24)}║
  ╚══════════════════════════════════════╝
    `);

    // Restore previously connected WhatsApp sessions
    await waManager.restoreAll();
  });
}

start().catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('[Server] Shutting down...');
  server.close();
  await db.close();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('[Server] Interrupted, shutting down...');
  server.close();
  await db.close();
  process.exit(0);
});
