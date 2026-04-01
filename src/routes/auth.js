/**
 * Auth routes — JWT-based authentication
 */
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { db } = require('../db');

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';
const JWT_EXPIRES = '30d';

function signToken(userId) {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

// POST /api/auth/register — Register with phone, name, password
router.post('/register', async (req, res) => {
  try {
    const { phone, name, password } = req.body;

    if (!phone || !/^\+?\d{8,15}$/.test(phone.replace(/\s/g, ''))) {
      return res.status(400).json({ error: 'Número de teléfono inválido' });
    }

    if (!password || password.length < 6) {
      return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
    }

    const cleanPhone = phone.replace(/\s/g, '');
    const hashedPassword = await bcrypt.hash(password, 10);

    // Check if user exists
    let user = await db.prepare('SELECT * FROM users WHERE phone = $1').get(cleanPhone);

    if (user) {
      // User exists — if they don't have a password, set it; otherwise reject
      if (user.password) {
        return res.status(409).json({ error: 'Este número ya está registrado. Usa /login.' });
      }
      // Set password for existing user
      await db.prepare('UPDATE users SET password = $1, name = COALESCE($2, name), updated_at = NOW() WHERE id = $3').run(hashedPassword, name || null, user.id);
      user.name = name || user.name;
    } else {
      // Create new user
      user = await db.prepare(
        'INSERT INTO users (phone, name, password) VALUES ($1, $2, $3) RETURNING *'
      ).get(cleanPhone, name || null, hashedPassword);
    }

    const token = signToken(user.id);

    res.json({
      user: {
        id: user.id,
        phone: user.phone,
        name: user.name,
        plan: user.plan || 'free',
        wa_connected: !!user.wa_connected,
      },
      token,
    });
  } catch (err) {
    console.error('[Auth] Register error:', err.message);
    res.status(500).json({ error: 'Error al registrar' });
  }
});

// POST /api/auth/login — Login with phone + password
router.post('/login', async (req, res) => {
  try {
    const { phone, password } = req.body;

    if (!phone || !password) {
      return res.status(400).json({ error: 'Teléfono y contraseña son requeridos' });
    }

    const cleanPhone = phone.replace(/\s/g, '');
    const user = await db.prepare('SELECT * FROM users WHERE phone = $1').get(cleanPhone);

    if (!user) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    if (!user.password) {
      return res.status(401).json({ error: 'Necesitas registrarte primero (establecer contraseña)' });
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    const token = signToken(user.id);

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
    console.error('[Auth] Login error:', err.message);
    res.status(500).json({ error: 'Error al iniciar sesión' });
  }
});

// GET /api/auth/me — Get current user info (JWT required)
router.get('/me', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No autenticado' });
    }

    const token = authHeader.split(' ')[1];
    let payload;
    try {
      payload = jwt.verify(token, JWT_SECRET);
    } catch {
      return res.status(401).json({ error: 'Token inválido o expirado' });
    }

    const user = await db.prepare('SELECT * FROM users WHERE id = $1').get(payload.userId);
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

    res.json({
      id: user.id,
      phone: user.phone,
      name: user.name,
      plan: user.plan,
      wa_connected: !!user.wa_connected,
    });
  } catch (err) {
    console.error('[Auth] Me error:', err.message);
    res.status(500).json({ error: 'Error al obtener usuario' });
  }
});

module.exports = router;
