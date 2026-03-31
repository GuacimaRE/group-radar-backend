/**
 * Alerts routes — fetch alert history
 */
const express = require('express');
const { getUserId } = require('../middleware/auth');
const { db } = require('../db');

const router = express.Router();
router.use(getUserId);

// GET /api/alerts — Get user's alert history
router.get('/', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;

    const alerts = await db.prepare(
      'SELECT * FROM alerts WHERE user_id = $1 ORDER BY sent_at DESC LIMIT $2 OFFSET $3'
    ).all(req.userId, limit, offset);

    const total = await db.prepare('SELECT COUNT(*) as count FROM alerts WHERE user_id = $1').get(req.userId);

    res.json({ alerts, total: parseInt(total.count) });
  } catch (err) {
    console.error('[Alerts] Get error:', err.message);
    res.status(500).json({ error: 'Failed to get alerts' });
  }
});

// GET /api/alerts/stats — Basic stats
router.get('/stats', async (req, res) => {
  try {
    const userId = req.userId;

    const today = await db.prepare(
      "SELECT COUNT(*) as count FROM alerts WHERE user_id = $1 AND sent_at::date = CURRENT_DATE"
    ).get(userId);

    const total = await db.prepare('SELECT COUNT(*) as count FROM alerts WHERE user_id = $1').get(userId);

    const topKeywords = await db.prepare(
      'SELECT matched_keywords, COUNT(*) as count FROM alerts WHERE user_id = $1 GROUP BY matched_keywords ORDER BY count DESC LIMIT 5'
    ).all(userId);

    res.json({
      today: parseInt(today.count),
      total: parseInt(total.count),
      topKeywords,
    });
  } catch (err) {
    console.error('[Alerts] Stats error:', err.message);
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

module.exports = router;
