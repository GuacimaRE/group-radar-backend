/**
 * WhatsApp connection routes — QR code, status, disconnect
 */
const express = require('express');
const { getUserId } = require('../middleware/auth');
const waManager = require('../services/wa-manager');

const router = express.Router();
router.use(getUserId);

// POST /api/whatsapp/connect — Start WhatsApp connection (generates QR)
router.post('/connect', async (req, res) => {
  try {
    const result = await waManager.startSession(req.userId);
    res.json(result);
  } catch (err) {
    console.error('[WA Route] Connect error:', err.message, err.stack);
    res.status(500).json({ error: 'Failed to start WhatsApp session', detail: err.message });
  }
});

// GET /api/whatsapp/status — Check connection status + get QR if available
router.get('/status', (req, res) => {
  const status = waManager.getStatus(req.userId);
  res.json(status);
});

// POST /api/whatsapp/pairing-code — Request pairing code (alternative to QR)
router.post('/pairing-code', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'phone required' });
    // Clean phone number (digits only)
    const cleanPhone = phone.replace(/[^0-9]/g, '');
    // Start session first if not active
    await waManager.startSession(req.userId);
    // Wait 3 seconds for session to initialize
    await new Promise(r => setTimeout(r, 3000));
    const code = await waManager.requestPairingCode(req.userId, cleanPhone);
    res.json({ code });
  } catch (err) {
    console.error('[WA] Pairing code error:', err.message);
    res.status(500).json({ error: 'Failed to get pairing code', detail: err.message });
  }
});

// POST /api/whatsapp/disconnect — Disconnect WhatsApp
router.post('/disconnect', async (req, res) => {
  try {
    await waManager.disconnect(req.userId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to disconnect' });
  }
});

module.exports = router;
