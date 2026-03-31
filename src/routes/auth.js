/**
 * Auth routes — simple phone-based auth
 */
const express = require('express');
const crypto = require('crypto');
const { db } = require('../db');

const router = express.Router();

// POST /api/auth/register — Register or login with phone number
router.post('/register', (req, res) => {
  const { phone, name } = req.body;

  if (!phone || !/^\+?\d{8,15}$/.test(phone.replace(/\s/g, ''))) {
    return res.status(400).json({ error: 'Invalid phone number' });
  }

  const cleanPhone = phone.replace(/\s/g, '');

  // Check if user exists
  let user = db.prepare('SELECT * FROM users WHERE phone = ?').get(cleanPhone);

  if (!user) {
    // Create new user
    const result = db.prepare('INSERT INTO users (phone, name) VALUES (?, ?)').run(cleanPhone, name || null);
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
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
});

// GET /api/auth/me — Get current user info
router.get('/me', (req, res) => {
  // Simple auth: phone in header (in production, use JWT middleware)
  const phone = req.headers['x-user-phone'];
  if (!phone) return res.status(401).json({ error: 'Not authenticated' });

  const user = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
  if (!user) return res.status(404).json({ error: 'User not found' });

  res.json({
    id: user.id,
    phone: user.phone,
    name: user.name,
    plan: user.plan,
    wa_connected: !!user.wa_connected,
  });
});

module.exports = router;
