/**
 * User settings routes — categories, keywords, zones, prices, groups
 */
const express = require('express');
const { db } = require('../db');
const { getUserId } = require('../middleware/auth');

const router = express.Router();
router.use(getUserId);

// GET /api/settings — Get all user settings
router.get('/', async (req, res) => {
  try {
    const userId = req.userId;
    const categories = await db.prepare('SELECT * FROM user_categories WHERE user_id = $1').all(userId);
    const keywords = await db.prepare('SELECT * FROM user_keywords WHERE user_id = $1').all(userId);
    const zones = await db.prepare('SELECT * FROM user_zones WHERE user_id = $1').all(userId);
    const priceRange = await db.prepare('SELECT * FROM user_price_range WHERE user_id = $1').get(userId);
    const groups = await db.prepare('SELECT * FROM user_groups WHERE user_id = $1').all(userId);

    res.json({ categories, keywords, zones, priceRange, groups });
  } catch (err) {
    console.error('[Settings] Get error:', err.message);
    res.status(500).json({ error: 'Failed to get settings' });
  }
});

// PUT /api/settings/categories — Update categories
router.put('/categories', async (req, res) => {
  try {
    const userId = req.userId;
    const { categories } = req.body;

    for (const cat of categories) {
      await db.prepare(`
        INSERT INTO user_categories (user_id, category, enabled)
        VALUES ($1, $2, $3)
        ON CONFLICT(user_id, category) DO UPDATE SET enabled = EXCLUDED.enabled
      `).run(userId, cat.category, cat.enabled ? 1 : 0);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('[Settings] Categories error:', err.message);
    res.status(500).json({ error: 'Failed to update categories' });
  }
});

// PUT /api/settings/keywords — Update keywords
router.put('/keywords', async (req, res) => {
  try {
    const userId = req.userId;
    const { keywords } = req.body;

    for (const kw of keywords) {
      await db.prepare(`
        INSERT INTO user_keywords (user_id, category, keyword, enabled)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT(user_id, category, keyword) DO UPDATE SET enabled = EXCLUDED.enabled
      `).run(userId, kw.category, kw.keyword, kw.enabled ? 1 : 0);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('[Settings] Keywords error:', err.message);
    res.status(500).json({ error: 'Failed to update keywords' });
  }
});

// PUT /api/settings/zones — Update zones
router.put('/zones', async (req, res) => {
  try {
    const userId = req.userId;
    await db.prepare('DELETE FROM user_zones WHERE user_id = $1').run(userId);

    for (const zone of (req.body.zones || [])) {
      await db.prepare('INSERT INTO user_zones (user_id, zone) VALUES ($1, $2)').run(userId, zone);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('[Settings] Zones error:', err.message);
    res.status(500).json({ error: 'Failed to update zones' });
  }
});

// PUT /api/settings/price-range — Update price range
router.put('/price-range', async (req, res) => {
  try {
    const userId = req.userId;
    const { minPrice, maxPrice, currency } = req.body;

    await db.prepare(`
      INSERT INTO user_price_range (user_id, min_price, max_price, currency)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT(user_id) DO UPDATE SET min_price = EXCLUDED.min_price, max_price = EXCLUDED.max_price, currency = EXCLUDED.currency
    `).run(userId, minPrice || 0, maxPrice || 999999, currency || 'USD');

    res.json({ ok: true });
  } catch (err) {
    console.error('[Settings] Price range error:', err.message);
    res.status(500).json({ error: 'Failed to update price range' });
  }
});

// PUT /api/settings/groups — Toggle groups on/off
router.put('/groups', async (req, res) => {
  try {
    const userId = req.userId;
    const { groups } = req.body;

    for (const g of groups) {
      await db.prepare('UPDATE user_groups SET enabled = $1 WHERE user_id = $2 AND group_jid = $3')
        .run(g.enabled ? 1 : 0, userId, g.groupJid);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('[Settings] Groups error:', err.message);
    res.status(500).json({ error: 'Failed to update groups' });
  }
});

module.exports = router;
