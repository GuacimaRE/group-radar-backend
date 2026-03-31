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

const { initDB, db } = require('./db');
const waManager = require('./services/wa-manager');
const Scanner = require('./services/scanner');

// Routes
const authRoutes = require('./routes/auth');
const settingsRoutes = require('./routes/settings');
const whatsappRoutes = require('./routes/whatsapp');
const alertsRoutes = require('./routes/alerts');

const PORT = process.env.PORT || 3000;

const app = express();
app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true,
}));
app.use(express.json());

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

const server = http.createServer(app);

// WebSocket server for real-time QR updates
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', async (ws, req) => {
  const params = new URL(req.url, `http://localhost:${PORT}`).searchParams;
  const phone = params.get('phone');

  if (!phone) {
    ws.close(4001, 'Missing phone parameter');
    return;
  }

  try {
    const user = await db.prepare('SELECT id FROM users WHERE phone = $1').get(phone);
    if (!user) {
      ws.close(4004, 'User not found');
      return;
    }

    console.log(`[WS] User ${user.id} connected for QR updates`);
    waManager.addQRListener(user.id, ws);

    ws.on('close', () => {
      waManager.removeQRListener(user.id, ws);
    });
  } catch (err) {
    console.error('[WS] Connection error:', err.message);
    ws.close(4500, 'Server error');
  }
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
  ║   📡 Group Radar Backend v2.0       ║
  ║   Port: ${PORT}                         ║
  ║   DB: PostgreSQL                    ║
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
