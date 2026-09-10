// NOWPayments checkout endpoint — ZERO dependencies (built-in fetch only).
// Creates a hosted NOWPayments invoice for the cart total and returns its URL.
// Prices are validated SERVER-SIDE from CATALOG so the amount can't be tampered with.
//
// Environment variables (set on the Vercel project):
//   NOWPAYMENTS_API_KEY   -> your NOWPayments API key (Dashboard -> Payments -> API keys)
//   SITE_ORIGIN           -> https://menapeps.com  (no trailing slash)
//   CRYPTO_DISCOUNT_PCT   -> optional, e.g. "10" gives crypto buyers 10% off the product subtotal
//
// Health check: open this URL in a browser (a GET) to confirm the key is set.

const CATALOG = {
  "GLP3-R": { "10 mg": 6999, "20 mg": 11999 }, "BPC-157": { "5 mg": 3999, "10 mg": 5999 }, "TB-500": 5499, "Tesamorelin": { "5 mg": 4499, "10 mg": 6999 }, "GLP2-T": 5999,
  "NAD+": 6999, "Glutathione": 7099, "Cagrilintide": 6999, "L-Carnitine": 4499, "5-Amino-1MQ": 6000,
  "Sermorelin": 3999, "CJC-1295 (No DAC) + Ipamorelin": 6999, "Ipamorelin": 5999, "IGF-1 LR3": 7999,
  "IGF-1": 6999, "KPV": 5499, "MOTS-c": 3999, "DSIP": 5499, "Kisspeptin": 6499, "SS-31": 6499,
  "Wolverine": 10999, "Selank": 4999, "Semax": 4999, "Adamax": 5499, "Melanotan II": 2999,
  "GHK-Cu": 2999, "KLOW": 12499, "GLOW": 11999, "Melanotan I": 2999, "Reconstitution Solution": 1499
};

const ALLOW_ORIGIN = process.env.SITE_ORIGIN || '*';
const SHIP_CENTS = 999;                 // flat $9.99 shipping
const FREE_SHIP_CENTS = 25000;          // free over $250
const DISCOUNT_PCT = parseFloat(process.env.CRYPTO_DISCOUNT_PCT || '0') || 0;

async function readBody(req) {
  if (req.body !== undefined) {
    return typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body;
  }
  return await new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => (d += c));
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch (e) { resolve({}); } });
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', ALLOW_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS, GET');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method === 'GET') {
    return res.status(200).json({
      ok: true,
      message: 'Mena NOWPayments checkout is live. POST { items: [...] } to start a crypto payment.',
      apiKeyPresent: !!process.env.NOWPAYMENTS_API_KEY,
      cryptoDiscountPct: DISCOUNT_PCT
    });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const key = process.env.NOWPAYMENTS_API_KEY;
  if (!key) {
    return res.status(500).json({ error: 'NOWPAYMENTS_API_KEY is not set. Add it in Vercel -> Settings -> Environment Variables, then redeploy.' });
  }

  try {
    const body = await readBody(req);
    const items = (body && body.items) || [];
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Cart is empty' });
    }

    // Absolute site URL for the success/cancel redirects.
    const cands = [body && body.origin, req.headers.origin, req.headers.referer, (ALLOW_ORIGIN !== '*' ? ALLOW_ORIGIN : null)];
    let base = '';
    for (const c of cands) { if (c && /^https?:\/\//i.test(c)) { base = c.replace(/\/$/, ''); break; } }
    if (!base) base = 'https://menapeps.com';

    // Validate + price every line item server-side.
    let productSubtotal = 0;
    const descParts = [];
    for (const it of items) {
      const entry = CATALOG[it.id];
      const amount = (typeof entry === 'object') ? (entry[it.dose] != null ? entry[it.dose] : Object.values(entry)[0]) : entry;
      if (amount == null) throw new Error('Unknown item: ' + it.id);
      const qty = Math.max(1, Math.min(99, parseInt(it.qty, 10) || 1));
      productSubtotal += amount * qty;
      descParts.push((it.dose ? (it.id + ' ' + it.dose) : it.id) + ' x' + qty);
    }

    const discount = DISCOUNT_PCT > 0 ? Math.round(productSubtotal * DISCOUNT_PCT / 100) : 0;
    const shipping = productSubtotal >= FREE_SHIP_CENTS ? 0 : SHIP_CENTS;
    const totalCents = Math.max(0, productSubtotal - discount) + shipping;
    const price_amount = (totalCents / 100).toFixed(2);

    // order_id carries what the webhook needs to award points: ref | buyer | productSubtotalCents
    const ref = (body && body.orderId) ? String(body.orderId) : ('MENA-' + Date.now().toString(36).toUpperCase());
    const buyer = (body && body.userId) ? String(body.userId) : 'guest';
    const order_id = ref + '|' + buyer + '|' + productSubtotal;

    const ipn_callback_url = 'https://' + (req.headers.host || 'checkoutvera.vercel.app') + '/api/nowpayments-ipn';

    const invoiceBody = {
      price_amount: price_amount,
      price_currency: 'usd',
      order_id: order_id,
      order_description: 'Mena Peptides order ' + ref + ' — ' + descParts.join(', '),
      ipn_callback_url: ipn_callback_url,
      success_url: base + '/?checkout=success',
      cancel_url: base + '/?checkout=cancel',
      is_fixed_rate: true,
      is_fee_paid_by_user: false
    };

    const npRes = await fetch('https://api.nowpayments.io/v1/invoice', {
      method: 'POST',
      headers: { 'x-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify(invoiceBody)
    });
    const data = await npRes.json();
    if (!npRes.ok || !data.invoice_url) {
      return res.status(400).json({ error: (data && (data.message || data.error)) || 'NOWPayments error creating invoice' });
    }
    return res.status(200).json({ url: data.invoice_url, ref: ref });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
};
