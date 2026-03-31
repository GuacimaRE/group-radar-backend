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
const url = require('url');

const { initDB, db } = require('./db');
const waManager = require('./services/wa-manager');
const Scanner = require('./services/scanner');

// Routes
const authRoutes = require('./routes/auth');
const settingsRoutes = require('./routes/settings');
const whatsappRoutes = require('./routes/whatsapp');
const alertsRoutes = require('./routes/alerts');

const PORT = process.env.PORT || 3000;

// Express app
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
  res.json({ status: 'ok', sessions, connected, uptime: process.uptime() });
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/whatsapp', whatsappRoutes);
app.use('/api/alerts', alertsRoutes);

// Create HTTP server
const server = http.createServer(app);

// WebSocket server for real-time QR updates
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  const params = new URL(req.url, `http://localhost:${PORT}`).searchParams;
  const phone = params.get('phone');

  if (!phone) {
    ws.close(4001, 'Missing phone parameter');
    return;
  }

  const user = db.prepare('SELECT id FROM users WHERE phone = ?').get(phone);
  if (!user) {
    ws.close(4004, 'User not found');
    return;
  }

  console.log(`[WS] User ${user.id} connected for QR updates`);
  waManager.addQRListener(user.id, ws);

  ws.on('close', () => {
    waManager.removeQRListener(user.id, ws);
  });
});

// Initialize scanner
const scanner = new Scanner(waManager);

// Start server (async init)
async function start() {
  await initDB();
  console.log('[DB] Ready');
}

start().then(() => {
server.listen(PORT, async () => {
  console.log(`
  ╔══════════════════════════════════════╗
  ║   📡 Group Radar Backend v1.0       ║
  ║   Port: ${PORT}                         ║
  ║   ENV: ${process.env.NODE_ENV || 'development'}               ║
  ╚══════════════════════════════════════╝
  `);

  // Restore previously connected sessions
  await waManager.restoreAll();
});
}).catch(err => { console.error('Failed to start:', err); process.exit(1); });

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[Server] Shutting down...');
  server.close();
  db.close();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('[Server] Interrupted, shutting down...');
  server.close();
  db.close();
  process.exit(0);
});
