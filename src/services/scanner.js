/**
 * Message Scanner
 * Matches incoming group messages against user's keywords, zones, and price ranges.
 */
const { db } = require('../db');

class Scanner {
  constructor(waManager) {
    this.waManager = waManager;
    waManager.setMessageHandler(this.handleMessage.bind(this));
  }

  async handleMessage(userId, msg) {
    const { groupJid, text, sender, timestamp } = msg;

    try {
      // Check if this group is enabled for monitoring
      const group = await db.prepare(
        'SELECT * FROM user_groups WHERE user_id = $1 AND group_jid = $2 AND enabled = 1'
      ).get(userId, groupJid);

      if (!group) return;

      // Get user's enabled keywords
      const keywords = await db.prepare(
        'SELECT keyword, category FROM user_keywords WHERE user_id = $1 AND enabled = 1'
      ).all(userId);

      if (!keywords.length) return;

      // Match keywords (case-insensitive, multi-word support)
      const textLower = text.toLowerCase();
      const matchedKeywords = [];

      for (const kw of keywords) {
        const kwWords = kw.keyword.toLowerCase().split(/\s+/);
        const allMatch = kwWords.every(word => textLower.includes(word));
        if (allMatch) {
          matchedKeywords.push({ keyword: kw.keyword, category: kw.category });
        }
      }

      if (!matchedKeywords.length) return;

      // Check zone filter (optional)
      const zones = await db.prepare('SELECT zone FROM user_zones WHERE user_id = $1').all(userId);
      let matchedZone = null;
      if (zones.length > 0) {
        for (const z of zones) {
          if (textLower.includes(z.zone.toLowerCase())) {
            matchedZone = z.zone;
            break;
          }
        }
      }

      // Extract price
      const price = this._extractPrice(text);

      // Check price range (optional)
      const priceRange = await db.prepare('SELECT * FROM user_price_range WHERE user_id = $1').get(userId);
      if (priceRange && price) {
        if (price < priceRange.min_price || price > priceRange.max_price) {
          return;
        }
      }

      // 🎯 MATCH!
      const alert = {
        userId,
        groupJid,
        groupName: group.group_name,
        text,
        matchedKeywords: matchedKeywords.map(k => k.keyword),
        matchedZone,
        price,
        sender,
        timestamp,
      };

      await this._sendAlert(alert);
    } catch (err) {
      console.error(`[Scanner] Error processing message for user ${userId}:`, err.message);
    }
  }

  _extractPrice(text) {
    const patterns = [
      /\$\s*([\d,\.]+)/,
      /([\d,\.]+)\s*(?:USD|usd|dólares|dolares|colones|millones)/,
      /([\d]{4,})/
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) {
        const num = parseFloat(match[1].replace(/[,\.]/g, ''));
        if (num > 100) return num;
      }
    }
    return null;
  }

  async _sendAlert(alert) {
    const { userId, groupName, text, matchedKeywords, matchedZone, price } = alert;

    try {
      // Log to database
      await db.prepare(`
        INSERT INTO alerts (user_id, group_jid, group_name, message_text, matched_keywords, matched_zone, matched_price)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `).run(userId, alert.groupJid, groupName, text, matchedKeywords.join(', '), matchedZone, price);

      // Get user's phone
      const user = await db.prepare('SELECT phone FROM users WHERE id = $1').get(userId);
      if (!user) return;

      // Format alert message
      let msg = `🔔 *Nueva alerta — Group Radar*\n\n`;
      msg += `📱 *Grupo:* ${groupName}\n`;
      msg += `🔑 *Keywords:* ${matchedKeywords.join(', ')}\n`;
      if (matchedZone) msg += `📍 *Zona:* ${matchedZone}\n`;
      if (price) msg += `💰 *Precio:* $${price.toLocaleString()}\n`;
      msg += `\n💬 "${text.substring(0, 300)}${text.length > 300 ? '...' : ''}"`;

      // Send via the user's own WhatsApp session
      const session = this.waManager.sessions.get(userId);
      if (session?.socket && session.status === 'connected') {
        await session.socket.sendMessage(`${user.phone}@s.whatsapp.net`, { text: msg });
        console.log(`[Scanner] ✅ Alert sent to user ${userId}: ${matchedKeywords.join(', ')} in ${groupName}`);
      } else {
        console.log(`[Scanner] ⚠️ User ${userId} not connected, alert saved but not sent`);
      }
    } catch (err) {
      console.error(`[Scanner] Alert error for user ${userId}:`, err.message);
    }
  }
}

module.exports = Scanner;
