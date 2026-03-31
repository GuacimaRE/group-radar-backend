/**
 * Simple auth middleware
 * For MVP: phone number in header. Production: JWT.
 */
const { db } = require('../db');

async function getUserId(req, res, next) {
  const phone = req.headers['x-user-phone'];
  if (!phone) {
    return res.status(401).json({ error: 'Not authenticated. Send x-user-phone header.' });
  }

  try {
    const user = await db.prepare('SELECT id FROM users WHERE phone = $1').get(phone);
    if (!user) {
      return res.status(404).json({ error: 'User not found. Register first.' });
    }
    req.userId = user.id;
    next();
  } catch (err) {
    console.error('[Auth] Error:', err.message);
    res.status(500).json({ error: 'Auth error' });
  }
}

module.exports = { getUserId };
