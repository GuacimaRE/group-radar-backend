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
