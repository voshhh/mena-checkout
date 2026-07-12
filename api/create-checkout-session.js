// Stripe Checkout endpoint — ZERO dependencies (no npm install needed).
// It calls the Stripe API directly with built-in fetch, so deploy problems with
// the "stripe" package can't break it. You only need STRIPE_SECRET_KEY set.
//
// Health check: open this URL in a browser (a GET) to see whether your key is set.

const CATALOG = {
  "GLP3-R": { "10 mg": 6999, "20 mg": 11999 }, "BPC-157": 3999, "TB-500": 5499, "Tesamorelin": 8499, "GLP2-T": 5999,
  "NAD+": 6999, "Glutathione": 7099, "Cagrilintide": 6999, "L-Carnitine": 4499, "5-Amino-1MQ": 6000,
  "Sermorelin": 3999, "CJC-1295 (No DAC) + Ipamorelin": 6999, "Ipamorelin": 5999, "IGF-1 LR3": 7999,
  "IGF-1": 6999, "KPV": 5499, "MOTS-c": 3999, "DSIP": 5499, "Kisspeptin": 6499, "SS-31": 6499,
  "Wolverine": 10999, "Selank": 4999, "Semax": 4999, "Adamax": 5499, "Melanotan II": 2999,
  "GHK-Cu": 2999, "KLOW": 12499, "GLOW": 11999, "Melanotan I": 2999, "Reconstitution Solution": 1499
};

const ALLOW_ORIGIN = process.env.SITE_ORIGIN || '*';

// Flatten a nested object/array into Stripe's form-encoded param format,
// e.g. line_items[0][price_data][unit_amount]=3999
function encodeForm(obj, prefix, out) {
  out = out || [];
  for (const key in obj) {
    const val = obj[key];
    const k = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(val)) {
      val.forEach((item, i) => {
        const ak = `${k}[${i}]`;
        if (item !== null && typeof item === 'object') encodeForm(item, ak, out);
        else out.push(encodeURIComponent(ak) + '=' + encodeURIComponent(item));
      });
    } else if (val !== null && typeof val === 'object') {
      encodeForm(val, k, out);
    } else {
      out.push(encodeURIComponent(k) + '=' + encodeURIComponent(val));
    }
  }
  return out;
}

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
      message: 'Vera checkout function is live. POST { items: [...] } to start a checkout.',
      stripeKeyPresent: !!process.env.STRIPE_SECRET_KEY
    });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    return res.status(500).json({
      error: 'STRIPE_SECRET_KEY is not set. Vercel: Settings -> Environment Variables -> add STRIPE_SECRET_KEY, then Deployments -> Redeploy.'
    });
  }

  try {
    const body = await readBody(req);
    const items = (body && body.items) || [];
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Cart is empty' });
    }

    // Figure out an absolute base URL to send the shopper back to after payment.
    const cands = [body && body.origin, req.headers.origin, req.headers.referer,
                   (ALLOW_ORIGIN !== '*' ? ALLOW_ORIGIN : null)];
    let base = '';
    for (const c of cands) { if (c && /^https?:\/\//i.test(c)) { base = c.replace(/\/$/, ''); break; } }
    if (!base && req.headers.host) base = 'https://' + req.headers.host;

    const line_items = items.map((it) => {
      const entry = CATALOG[it.id]; const amount = (typeof entry==='object') ? (entry[it.dose]!=null?entry[it.dose]:Object.values(entry)[0]) : entry;
      if (amount == null) throw new Error('Unknown item: ' + it.id);
      const qty = Math.max(1, Math.min(99, parseInt(it.qty, 10) || 1));
      const name = it.dose ? `${it.id} (${it.dose})` : String(it.id);
      return { price_data: { currency: 'usd', product_data: { name }, unit_amount: amount }, quantity: qty };
    });

    // Shipping: flat $9.99, free over $250 (matches the site banner). Adjust as needed.
    const subtotal = line_items.reduce((s, li) => s + li.price_data.unit_amount * li.quantity, 0);
    const freeShip = subtotal >= 25000;
    const SHIP_CENTS = 999;

    const params = {
      mode: 'payment',
      success_url: `${base}/?checkout=success`,
      cancel_url: `${base}/?checkout=cancel`,
      line_items,
      shipping_address_collection: { allowed_countries: ['US'] },
      phone_number_collection: { enabled: true },
      shipping_options: [
        { shipping_rate_data: {
            type: 'fixed_amount',
            fixed_amount: { amount: freeShip ? 0 : SHIP_CENTS, currency: 'usd' },
            display_name: freeShip ? 'Free US Shipping' : 'Standard Shipping (USPS)',
            delivery_estimate: { minimum: { unit: 'business_day', value: 2 }, maximum: { unit: 'business_day', value: 5 } }
        } }
      ]
    };

    const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + key,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: encodeForm(params).join('&')
    });
    const data = await stripeRes.json();

    if (!stripeRes.ok) {
      return res.status(400).json({ error: (data.error && data.error.message) || 'Stripe error' });
    }
    return res.status(200).json({ url: data.url });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
};

