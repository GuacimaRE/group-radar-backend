/**
 * Payment routes — LemonSqueezy integration
 * Replaces Stripe (not available in Costa Rica)
 */
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const { db } = require('../db');
const { getUserId } = require('../middleware/auth');

const router = express.Router();

// POST /api/payments/create-checkout — Create LemonSqueezy Checkout
router.post('/create-checkout', getUserId, async (req, res) => {
  try {
    const user = await db.prepare('SELECT * FROM users WHERE id = $1').get(req.userId);

    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const response = await axios.post('https://api.lemonsqueezy.com/v1/checkouts', {
      data: {
        type: 'checkouts',
        attributes: {
          checkout_data: {
            custom: {
              user_id: String(user.id)
            }
          },
          checkout_options: {
            embed: false
          },
          product_options: {
            redirect_url: (process.env.FRONTEND_URL || 'https://groupradar.io') + '/dashboard.html'
          }
        },
        relationships: {
          store: { data: { type: 'stores', id: String(process.env.LEMONSQUEEZY_STORE_ID) } },
          variant: { data: { type: 'variants', id: String(process.env.LEMONSQUEEZY_VARIANT_ID) } }
        }
      }
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.LEMONSQUEEZY_API_KEY}`,
        'Content-Type': 'application/vnd.api+json',
        'Accept': 'application/vnd.api+json'
      }
    });

    const checkoutUrl = response.data.data.attributes.url;
    res.json({ url: checkoutUrl });
  } catch (err) {
    console.error('[Payments] Checkout error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Error al crear sesión de pago' });
  }
});

// GET /api/payments/status — Get user's payment status
router.get('/status', getUserId, async (req, res) => {
  try {
    const user = await db.prepare(
      'SELECT plan, ls_customer_id, ls_subscription_id FROM users WHERE id = $1'
    ).get(req.userId);

    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const result = {
      plan: user.plan || 'free',
      ls_customer_id: user.ls_customer_id || null,
      ls_subscription_id: user.ls_subscription_id || null,
    };

    if (user.ls_subscription_id && process.env.LEMONSQUEEZY_STORE_URL) {
      result.customer_portal_url = process.env.LEMONSQUEEZY_STORE_URL;
    }

    res.json(result);
  } catch (err) {
    console.error('[Payments] Status error:', err.message);
    res.status(500).json({ error: 'Error al obtener estado de pago' });
  }
});

module.exports = router;

/**
 * LemonSqueezy webhook handler — must be registered BEFORE express.json()
 * Use express.raw({ type: 'application/json' }) for HMAC signature verification
 */
module.exports.webhookHandler = async (req, res) => {
  // Always return 200 so LemonSqueezy doesn't retry
  try {
    const rawBody = typeof req.body === 'string' ? req.body : req.body.toString('utf8');
    const signature = req.headers['x-signature'];

    if (!signature || !process.env.LEMONSQUEEZY_WEBHOOK_SECRET) {
      console.error('[LemonSqueezy] Missing signature or webhook secret');
      return res.status(200).json({ received: true });
    }

    // Verify HMAC SHA256 signature
    const hmac = crypto.createHmac('sha256', process.env.LEMONSQUEEZY_WEBHOOK_SECRET);
    hmac.update(rawBody);
    const digest = hmac.digest('hex');

    if (!crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature))) {
      console.error('[LemonSqueezy] Webhook signature verification failed');
      return res.status(200).json({ received: true });
    }

    const payload = JSON.parse(rawBody);
    const eventName = payload.meta?.event_name;
    const userId = payload.meta?.custom_data?.user_id;
    const attributes = payload.data?.attributes || {};
    const customerId = attributes.customer_id ? String(attributes.customer_id) : null;
    const subscriptionId = payload.data?.id ? String(payload.data.id) : null;
    const status = attributes.status;

    console.log(`[LemonSqueezy] Event: ${eventName}, userId: ${userId}, status: ${status}`);

    if (!userId) {
      console.warn('[LemonSqueezy] No user_id in custom_data, skipping');
      return res.status(200).json({ received: true });
    }

    const uid = parseInt(userId);

    switch (eventName) {
      case 'subscription_created': {
        await db.prepare(
          'UPDATE users SET plan = $1, ls_customer_id = $2, ls_subscription_id = $3, updated_at = NOW() WHERE id = $4'
        ).run('pro', customerId, subscriptionId, uid);
        console.log(`[LemonSqueezy] User ${uid} upgraded to pro`);
        break;
      }

      case 'subscription_updated': {
        if (status === 'active') {
          await db.prepare(
            'UPDATE users SET plan = $1, ls_customer_id = $2, ls_subscription_id = $3, updated_at = NOW() WHERE id = $4'
          ).run('pro', customerId, subscriptionId, uid);
          console.log(`[LemonSqueezy] User ${uid} subscription active → pro`);
        } else if (['cancelled', 'expired', 'past_due'].includes(status)) {
          await db.prepare(
            'UPDATE users SET plan = $1, updated_at = NOW() WHERE id = $2'
          ).run('free', uid);
          console.log(`[LemonSqueezy] User ${uid} subscription ${status} → free`);
        }
        break;
      }

      case 'subscription_cancelled':
      case 'subscription_expired': {
        await db.prepare(
          'UPDATE users SET plan = $1, updated_at = NOW() WHERE id = $2'
        ).run('free', uid);
        console.log(`[LemonSqueezy] User ${uid} → free (${eventName})`);
        break;
      }

      default:
        console.log(`[LemonSqueezy] Unhandled event: ${eventName}`);
    }
  } catch (err) {
    console.error('[LemonSqueezy] Webhook processing error:', err.message);
  }

  res.status(200).json({ received: true });
};
