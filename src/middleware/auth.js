/**
 * Auth middleware — JWT-based
 * Verifies Bearer token and attaches req.userId
 */
const jwt = require('jsonwebtoken');
const { db } = require('../db');

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';

async function getUserId(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No autenticado. Envía Authorization: Bearer <token>.' });
  }

  const token = authHeader.split(' ')[1];

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = await db.prepare('SELECT id FROM users WHERE id = $1').get(payload.userId);
    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado.' });
    }
    req.userId = user.id;
    next();
  } catch (err) {
    if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token inválido o expirado.' });
    }
    console.error('[Auth] Error:', err.message);
    res.status(500).json({ error: 'Error de autenticación' });
  }
}

module.exports = { getUserId };
