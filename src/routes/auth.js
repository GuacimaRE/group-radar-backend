/**
 * Auth routes — simple phone-based auth
 */
const express = require('express');
const crypto = require('crypto');
const { db } = require('../db');

const router = express.Router();

// POST /api/auth/register — Register or login with phone number
router.post('/register', async (req, res) => {
  try {
    const { phone, name } = req.body;

    if (!phone || !/^\+?\d{8,15}$/.test(phone.replace(/\s/g, ''))) {
      return res.status(400).json({ error: 'Invalid phone number' });
    }

    const cleanPhone = phone.replace(/\s/g, '');

    // Check if user exists
    let user = await db.prepare('SELECT * FROM users WHERE phone = $1').get(cleanPhone);

    if (!user) {
      // Create new user
      const result = await db.prepare('INSERT INTO users (phone, name) VALUES ($1, $2) RETURNING *').get(cleanPhone, name || null);
      user = result;
    }

    // Generate simple session token (in production, use JWT)
    const token = crypto.randomBytes(32).toString('hex');

    res.json({
      user: {
        id: user.id,
        phone: user.phone,
        name: user.name,
        plan: user.plan,
        wa_connected: !!user.wa_connected,
      },
      token,
    });
  } catch (err) {
    console.error('[Auth] Register error:', err.message);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// GET /api/auth/me — Get current user info
router.get('/me', async (req, res) => {
  const phone = req.headers['x-user-phone'];
  if (!phone) return res.status(401).json({ error: 'Not authenticated' });

  try {
    const user = await db.prepare('SELECT * FROM users WHERE phone = $1').get(phone);
    if (!user) return res.status(404).json({ error: 'User not found' });

    res.json({
      id: user.id,
      phone: user.phone,
      name: user.name,
      plan: user.plan,
      wa_connected: !!user.wa_connected,
    });
  } catch (err) {
    console.error('[Auth] Me error:', err.message);
    res.status(500).json({ error: 'Failed to get user' });
  }
});

module.exports = router;
