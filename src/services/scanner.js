/**
 * Message Scanner
 * Matches incoming group messages against user's keywords, zones, and price ranges.
 */
const db = require('../db');

class Scanner {
  constructor(waManager) {
    this.waManager = waManager;
    
    // Register as message handler
    waManager.setMessageHandler(this.handleMessage.bind(this));
  }

  /**
   * Handle an incoming group message for a specific user
   */
  handleMessage(userId, msg) {
    const { groupJid, text, sender, timestamp } = msg;

    // Check if this group is enabled for monitoring
    const group = db.prepare(
      'SELECT * FROM user_groups WHERE user_id = ? AND group_jid = ? AND enabled = 1'
    ).get(userId, groupJid);

    if (!group) return; // Group not monitored

    // Get user's enabled keywords
    const keywords = db.prepare(
      'SELECT keyword, category FROM user_keywords WHERE user_id = ? AND enabled = 1'
    ).all(userId);

    if (!keywords.length) return;

    // Match keywords (case-insensitive, multi-word support)
    const textLower = text.toLowerCase();
    const matchedKeywords = [];

    for (const kw of keywords) {
      const kwWords = kw.keyword.toLowerCase().split(/\s+/);
      // All words must appear in the text (not necessarily adjacent)
      const allMatch = kwWords.every(word => textLower.includes(word));
      if (allMatch) {
        matchedKeywords.push({ keyword: kw.keyword, category: kw.category });
      }
    }

    if (!matchedKeywords.length) return;

    // Check zone filter (optional)
    const zones = db.prepare('SELECT zone FROM user_zones WHERE user_id = ?').all(userId);
    let matchedZone = null;
    if (zones.length > 0) {
      for (const z of zones) {
        if (textLower.includes(z.zone.toLowerCase())) {
          matchedZone = z.zone;
          break;
        }
      }
      // If zones are configured but none matched, skip (unless no zones = match all)
      // Actually, zones are optional — only filter if configured
    }

    // Extract price from message
    const price = this._extractPrice(text);

    // Check price range (optional)
    const priceRange = db.prepare('SELECT * FROM user_price_range WHERE user_id = ?').get(userId);
    if (priceRange && price) {
      if (price < priceRange.min_price || price > priceRange.max_price) {
        return; // Price out of range
      }
    }

    // 🎯 MATCH! Send alert
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

    this._sendAlert(alert);
  }

  /**
   * Extract price from message text
   */
  _extractPrice(text) {
    // Match common price patterns: $100,000 / 100000 / $100.000 / 100,000 USD
    const patterns = [
      /\$\s*([\d,\.]+)/,
      /([\d,\.]+)\s*(?:USD|usd|dólares|dolares|colones)/,
      /([\d]{4,})/  // Any number 4+ digits
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) {
        const num = parseFloat(match[1].replace(/[,\.]/g, ''));
        if (num > 100) return num; // Ignore tiny numbers
      }
    }
    return null;
  }

  /**
   * Send alert to user via WhatsApp
   */
  _sendAlert(alert) {
    const { userId, groupName, text, matchedKeywords, matchedZone, price } = alert;

    // Log to database
    db.prepare(`
      INSERT INTO alerts (user_id, group_jid, group_name, message_text, matched_keywords, matched_zone, matched_price)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(userId, alert.groupJid, groupName, text, matchedKeywords.join(', '), matchedZone, price);

    // Get user's phone
    const user = db.prepare('SELECT phone FROM users WHERE id = ?').get(userId);
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
      session.socket.sendMessage(`${user.phone}@s.whatsapp.net`, { text: msg })
        .catch(err => console.error(`[Scanner] Alert send error for user ${userId}:`, err.message));
    }

    console.log(`[Scanner] Alert for user ${userId}: ${matchedKeywords.join(', ')} in ${groupName}`);
  }
}

module.exports = Scanner;
