// Stripe webhook — ZERO dependencies.
// Verifies Stripe's signature with Node's built-in crypto, then updates Supabase
// (points + referral commission) via the Supabase REST RPC endpoints.
//
// Required environment variables (set these on the checkoutvera project):
//   STRIPE_WEBHOOK_SECRET      -> the "Signing secret" from your Stripe webhook (whsec_...)
//   SUPABASE_URL               -> your Supabase Project URL (https://xxxx.supabase.co)
//   SUPABASE_SERVICE_ROLE_KEY  -> Supabase service_role key (BACKEND ONLY - never in the site)
//
// It handles:
//   checkout.session.completed -> award points to buyer + commission to referrer
//   charge.refunded            -> reverse the points + commission for that order

const crypto = require('crypto');

// Stripe signs the RAW body, so we must NOT let the platform parse it first.
module.exports.config = { api: { bodyParser: false } };

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Verify the Stripe-Signature header against the raw body (HMAC-SHA256).
function verifyStripe(raw, header, secret) {
  if (!header || !secret) return false;
  const parts = {};
  header.split(',').forEach((kv) => {
    const i = kv.indexOf('=');
    if (i > -1) parts[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
  });
  const t = parts.t, v1 = parts.v1;
  if (!t || !v1) return false;
  // reject events older than 5 minutes (replay protection)
  if (Math.abs(Math.floor(Date.now() / 1000) - parseInt(t, 10)) > 300) return false;
  const signed = t + '.' + raw.toString('utf8');
  const expected = crypto.createHmac('sha256', secret).update(signed).digest('hex');
  const a = Buffer.from(expected), b = Buffer.from(v1);
  if (a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(a, b); } catch (e) { return false; }
}

async function sbRpc(fn, args) {
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) throw new Error('Supabase env vars missing');
  const res = await fetch(base.replace(/\/$/, '') + '/rest/v1/rpc/' + fn, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': key,
      'Authorization': 'Bearer ' + key
    },
    body: JSON.stringify(args)
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error('Supabase RPC ' + fn + ' failed: ' + res.status + ' ' + txt);
  }
  return res;
}

module.exports = async (req, res) => {
  if (req.method === 'GET') {
    return res.status(200).json({
      ok: true,
      message: 'Mena webhook is live. Stripe POSTs events here.',
      webhookSecretPresent: !!process.env.STRIPE_WEBHOOK_SECRET,
      supabaseConfigured: !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
    });
  }
  if (req.method !== 'POST') return res.status(405).send('POST only');

  let raw;
  try { raw = await readRaw(req); } catch (e) { return res.status(400).send('cannot read body'); }

  const sig = req.headers['stripe-signature'];
  if (!verifyStripe(raw, sig, process.env.STRIPE_WEBHOOK_SECRET)) {
    return res.status(400).send('signature verification failed');
  }

  let event;
  try { event = JSON.parse(raw.toString('utf8')); } catch (e) { return res.status(400).send('bad json'); }

  try {
    if (event.type === 'checkout.session.completed') {
      const s = event.data.object;
      const buyer = s.client_reference_id;           // Supabase user id (null for guest checkout)
      const orderId = s.payment_intent || s.id;      // stable key for refunds
      const subtotal = s.amount_subtotal || 0;       // product subtotal in cents (excludes shipping)
      if (buyer && subtotal > 0) {
        await sbRpc('process_order', { p_order: String(orderId), p_buyer: buyer, p_subtotal: subtotal });
      }
    } else if (event.type === 'charge.refunded' || event.type === 'charge.refund.updated') {
      const c = event.data.object;
      const orderId = c.payment_intent;
      if (orderId) {
        await sbRpc('reverse_order', { p_order: String(orderId) });
      }
    }
    return res.status(200).json({ received: true });
  } catch (e) {
    console.error('webhook handler error:', e && e.message);
    // 500 tells Stripe to retry later (good for transient Supabase hiccups)
    return res.status(500).send('handler error');
  }
};
