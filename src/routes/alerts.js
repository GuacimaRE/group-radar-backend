/**
 * Alerts routes — fetch alert history
 */
const express = require('express');
const { getUserId } = require('../middleware/auth');
const { db } = require('../db');

const router = express.Router();
router.use(getUserId);

// GET /api/alerts — Get user's alert history
router.get('/', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = parseInt(req.query.offset) || 0;

  const alerts = db.prepare(`
    SELECT * FROM alerts WHERE user_id = ? ORDER BY sent_at DESC LIMIT ? OFFSET ?
  `).all(req.userId, limit, offset);

  const total = db.prepare('SELECT COUNT(*) as count FROM alerts WHERE user_id = ?').get(req.userId);

  res.json({ alerts, total: total.count });
});

// GET /api/alerts/stats — Basic stats
router.get('/stats', (req, res) => {
  const userId = req.userId;
  
  const today = db.prepare(`
    SELECT COUNT(*) as count FROM alerts WHERE user_id = ? AND date(sent_at) = date('now')
  `).get(userId);

  const total = db.prepare('SELECT COUNT(*) as count FROM alerts WHERE user_id = ?').get(userId);

  const topKeywords = db.prepare(`
    SELECT matched_keywords, COUNT(*) as count FROM alerts
    WHERE user_id = ? GROUP BY matched_keywords ORDER BY count DESC LIMIT 5
  `).all(userId);

  res.json({
    today: today.count,
    total: total.count,
    topKeywords,
  });
});

module.exports = router;
