// NOWPayments IPN (webhook) — ZERO dependencies (Node built-in crypto only).
// Verifies NOWPayments' HMAC-SHA512 signature, then on a finished payment awards
// Supabase points + referral commission (and reverses them on a refund).
//
// Environment variables (set on the Vercel project):
//   NOWPAYMENTS_IPN_SECRET     -> the IPN Secret Key from NOWPayments (Dashboard -> Store settings -> IPN)
//   SUPABASE_URL               -> https://xxxx.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY  -> Supabase service_role key (BACKEND ONLY)
//
// Set this file's URL as the IPN callback in NOWPayments:  https://<your-project>.vercel.app/api/nowpayments-ipn

const crypto = require('crypto');

// NOWPayments signs the RAW body, so do not let the platform parse it first.
module.exports.config = { api: { bodyParser: false } };

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Recursively sort object keys alphabetically (NOWPayments hashes the sorted payload).
function sortDeep(obj) {
  if (Array.isArray(obj)) return obj.map(sortDeep);
  if (obj && typeof obj === 'object') {
    const out = {};
    Object.keys(obj).sort().forEach((k) => { out[k] = sortDeep(obj[k]); });
    return out;
  }
  return obj;
}

function verifySig(parsed, header, secret) {
  if (!header || !secret) return false;
  const sorted = JSON.stringify(sortDeep(parsed));
  const expected = crypto.createHmac('sha512', secret).update(sorted).digest('hex');
  try {
    const a = Buffer.from(expected);
    const b = Buffer.from(String(header));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (e) { return false; }
}

async function sbRpc(fn, args) {
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) throw new Error('Supabase env vars missing');
  const res = await fetch(base.replace(/\/$/, '') + '/rest/v1/rpc/' + fn, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': key, 'Authorization': 'Bearer ' + key },
    body: JSON.stringify(args)
  });
  if (!res.ok) { const t = await res.text(); throw new Error('Supabase RPC ' + fn + ' failed: ' + res.status + ' ' + t); }
  return res;
}

module.exports = async (req, res) => {
  if (req.method === 'GET') {
    return res.status(200).json({
      ok: true,
      message: 'Mena NOWPayments IPN is live.',
      ipnSecretPresent: !!process.env.NOWPAYMENTS_IPN_SECRET,
      supabaseConfigured: !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
    });
  }
  if (req.method !== 'POST') return res.status(405).send('POST only');

  let raw;
  try { raw = await readRaw(req); } catch (e) { return res.status(400).send('cannot read body'); }

  let event;
  try { event = JSON.parse(raw.toString('utf8') || '{}'); } catch (e) { return res.status(400).send('bad json'); }

  if (!verifySig(event, req.headers['x-nowpayments-sig'], process.env.NOWPAYMENTS_IPN_SECRET)) {
    return res.status(400).send('signature verification failed');
  }

  try {
    const status = event.payment_status;
    // order_id we set as: ref | buyerId | productSubtotalCents
    const parts = String(event.order_id || '').split('|');
    const ref = parts[0] || (event.payment_id != null ? String(event.payment_id) : '');
    const buyer = parts[1] || 'guest';
    const subtotal = parseInt(parts[2], 10) || 0;

    if (status === 'finished' || status === 'confirmed') {
      if (buyer && buyer !== 'guest' && subtotal > 0) {
        await sbRpc('process_order', { p_order: ref, p_buyer: buyer, p_subtotal: subtotal });
      }
    } else if (status === 'refunded' || status === 'expired' || status === 'failed') {
      // Reverse points/commission only for a real reversal (refund); expired/failed never awarded, so skip.
      if (status === 'refunded' && ref) {
        await sbRpc('reverse_order', { p_order: ref });
      }
    }
    return res.status(200).json({ received: true });
  } catch (e) {
    console.error('nowpayments ipn error:', e && e.message);
    return res.status(500).send('handler error');
  }
};
