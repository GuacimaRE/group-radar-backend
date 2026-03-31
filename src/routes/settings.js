/**
 * User settings routes — categories, keywords, zones, prices, groups
 */
const express = require('express');
const { db } = require('../db');
const { getUserId } = require('../middleware/auth');

const router = express.Router();
router.use(getUserId);

// GET /api/settings — Get all user settings
router.get('/', (req, res) => {
  const userId = req.userId;

  const categories = db.prepare('SELECT * FROM user_categories WHERE user_id = ?').all(userId);
  const keywords = db.prepare('SELECT * FROM user_keywords WHERE user_id = ?').all(userId);
  const zones = db.prepare('SELECT * FROM user_zones WHERE user_id = ?').all(userId);
  const priceRange = db.prepare('SELECT * FROM user_price_range WHERE user_id = ?').get(userId);
  const groups = db.prepare('SELECT * FROM user_groups WHERE user_id = ?').all(userId);

  res.json({ categories, keywords, zones, priceRange, groups });
});

// PUT /api/settings/categories — Update categories
router.put('/categories', (req, res) => {
  const userId = req.userId;
  const { categories } = req.body; // [{ category: 'bienes-raices', enabled: true }]

  const upsert = db.prepare(`
    INSERT INTO user_categories (user_id, category, enabled)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id, category) DO UPDATE SET enabled = excluded.enabled
  `);

  const tx = db.transaction(() => {
    for (const cat of categories) {
      upsert.run(userId, cat.category, cat.enabled ? 1 : 0);
    }
  });
  tx();

  res.json({ ok: true });
});

// PUT /api/settings/keywords — Update keywords
router.put('/keywords', (req, res) => {
  const userId = req.userId;
  const { keywords } = req.body; // [{ category, keyword, enabled }]

  const upsert = db.prepare(`
    INSERT INTO user_keywords (user_id, category, keyword, enabled)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, category, keyword) DO UPDATE SET enabled = excluded.enabled
  `);

  const tx = db.transaction(() => {
    for (const kw of keywords) {
      upsert.run(userId, kw.category, kw.keyword, kw.enabled ? 1 : 0);
    }
  });
  tx();

  res.json({ ok: true });
});

// PUT /api/settings/zones — Update zones
router.put('/zones', (req, res) => {
  const userId = req.userId;
  const { zones } = req.body; // ['Escazú', 'La Guácima']

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM user_zones WHERE user_id = ?').run(userId);
    const insert = db.prepare('INSERT INTO user_zones (user_id, zone) VALUES (?, ?)');
    for (const zone of zones) {
      insert.run(userId, zone);
    }
  });
  tx();

  res.json({ ok: true });
});

// PUT /api/settings/price-range — Update price range
router.put('/price-range', (req, res) => {
  const userId = req.userId;
  const { minPrice, maxPrice, currency } = req.body;

  db.prepare(`
    INSERT INTO user_price_range (user_id, min_price, max_price, currency)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET min_price = excluded.min_price, max_price = excluded.max_price, currency = excluded.currency
  `).run(userId, minPrice || 0, maxPrice || 999999, currency || 'USD');

  res.json({ ok: true });
});

// PUT /api/settings/groups — Toggle groups on/off
router.put('/groups', (req, res) => {
  const userId = req.userId;
  const { groups } = req.body; // [{ groupJid, enabled }]

  const update = db.prepare('UPDATE user_groups SET enabled = ? WHERE user_id = ? AND group_jid = ?');

  const tx = db.transaction(() => {
    for (const g of groups) {
      update.run(g.enabled ? 1 : 0, userId, g.groupJid);
    }
  });
  tx();

  res.json({ ok: true });
});

module.exports = router;
