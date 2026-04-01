/**
 * Payment routes — Stripe integration
 * $4.99/month subscription
 */
const express = require('express');
const { db } = require('../db');
const { getUserId } = require('../middleware/auth');

const router = express.Router();

function getStripe() {
  return require('stripe')(process.env.STRIPE_SECRET_KEY);
}

// POST /api/payments/create-checkout — Create Stripe Checkout session
router.post('/create-checkout', getUserId, async (req, res) => {
  try {
    const stripe = getStripe();
    const user = await db.prepare('SELECT * FROM users WHERE id = $1').get(req.userId);

    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    // Reuse or create Stripe customer
    let customerId = user.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        metadata: { userId: String(user.id) },
        phone: user.phone,
        name: user.name || undefined,
      });
      customerId = customer.id;
      await db.prepare('UPDATE users SET stripe_customer_id = $1 WHERE id = $2').run(customerId, user.id);
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{
        price: process.env.STRIPE_PRICE_ID,
        quantity: 1,
      }],
      success_url: `${process.env.FRONTEND_URL || 'https://groupradar.io'}/dashboard?payment=success`,
      cancel_url: `${process.env.FRONTEND_URL || 'https://groupradar.io'}/dashboard?payment=cancelled`,
      metadata: { userId: String(user.id) },
    });

    res.json({ url: session.url, sessionId: session.id });
  } catch (err) {
    console.error('[Payments] Checkout error:', err.message);
    res.status(500).json({ error: 'Error al crear sesión de pago' });
  }
});

// GET /api/payments/status — Get user's payment status
router.get('/status', getUserId, async (req, res) => {
  try {
    const user = await db.prepare('SELECT plan, stripe_customer_id, stripe_subscription_id FROM users WHERE id = $1').get(req.userId);

    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    let subscription = null;
    if (user.stripe_subscription_id) {
      try {
        const stripe = getStripe();
        const sub = await stripe.subscriptions.retrieve(user.stripe_subscription_id);
        subscription = {
          status: sub.status,
          currentPeriodEnd: sub.current_period_end,
          cancelAtPeriodEnd: sub.cancel_at_period_end,
        };
      } catch {}
    }

    res.json({
      plan: user.plan || 'free',
      subscription,
    });
  } catch (err) {
    console.error('[Payments] Status error:', err.message);
    res.status(500).json({ error: 'Error al obtener estado de pago' });
  }
});

module.exports = router;

/**
 * Stripe webhook handler — must be registered BEFORE express.json()
 * Use express.raw({ type: 'application/json' }) for signature verification
 */
module.exports.webhookHandler = async (req, res) => {
  const stripe = getStripe();
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[Stripe] Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const userId = session.metadata?.userId;
        if (userId) {
          await db.prepare(
            'UPDATE users SET plan = $1, stripe_subscription_id = $2, updated_at = NOW() WHERE id = $3'
          ).run('pro', session.subscription, parseInt(userId));
          console.log(`[Stripe] User ${userId} upgraded to pro`);
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        const customerId = subscription.customer;
        // Find user by stripe_customer_id
        const user = await db.prepare('SELECT id FROM users WHERE stripe_customer_id = $1').get(customerId);
        if (user) {
          await db.prepare(
            'UPDATE users SET plan = $1, stripe_subscription_id = NULL, updated_at = NOW() WHERE id = $2'
          ).run('free', user.id);
          console.log(`[Stripe] User ${user.id} downgraded to free`);
        }
        break;
      }

      default:
        console.log(`[Stripe] Unhandled event: ${event.type}`);
    }
  } catch (err) {
    console.error('[Stripe] Webhook processing error:', err.message);
  }

  res.json({ received: true });
};
