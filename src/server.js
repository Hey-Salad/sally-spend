const http = require('http'); const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const core = require('./core'); const P = core.P;
const PORT = process.env.PORT || 8787; const PUB = path.join(core.ROOT, 'public');
const types = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.css': 'text/css' };
const page = (title, body) => `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><link rel=stylesheet href="/style.css"><title>${title}</title><main class=card><img src="/heysalad-logo-black.png" class=logo alt=HeySalad>${body}</main>`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Real-time issuing_authorization.request handler (Stripe webhook). Verifies the signature when STRIPE_WEBHOOK_SECRET is set.
function verify(raw, sig, secret) {
  const parts = Object.fromEntries(String(sig || '').split(',').map((kv) => kv.split('=')));
  const mac = crypto.createHmac('sha256', secret).update(`${parts.t}.${raw}`).digest('hex');
  return parts.v1 && crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(parts.v1));
}
function onAuthorizationRequest(auth) {
  const L = core.ledger(); const intent = L.decisions.filter((d) => d.status === 'pending_capture' || d.status === 'approved_intent').pop();
  const md = auth.merchant_data || {};
  return P.evaluateAuthorization({ amount: auth.pending_request?.amount ?? auth.amount, mcc: md.category_code, category: md.category, merchantName: md.name },
    intent ? { store: intent.merchant.store, status: 'approved', approvedPence: intent.amountPence } : null, P.DEFAULT_RULES, { monthSpentUsdCents: 0 });
}

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  try {
    if (u.pathname === '/webhooks/stripe' && req.method === 'POST') {
      let raw = ''; for await (const c of req) raw += c;
      if (process.env.STRIPE_WEBHOOK_SECRET && !verify(raw, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET)) { res.writeHead(400); return res.end('bad signature'); }
      const ev = JSON.parse(raw);
      if (ev.type === 'issuing_authorization.request') { const r = onAuthorizationRequest(ev.data.object);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Stripe-Version': '2024-06-20' }); return res.end(JSON.stringify({ approved: r.approved })); }
      res.writeHead(200); return res.end('ok');
    }
    const m = u.pathname.match(/^\/approve\/(dec_[a-f0-9]+)$/);
    if (m) {
      const d = core.ledger().decisions.find((x) => x.id === m[1]);
      if (!d || d.approvalToken !== u.searchParams.get('t')) { res.writeHead(403); return res.end('Invalid approval link'); }
      if (req.method === 'POST') { const nd = await core.approve(d.id, u.searchParams.get('t')); res.writeHead(303, { Location: `/#${nd.id}` }); return res.end(); }
      res.writeHead(200, { 'Content-Type': types['.html'] });
      return res.end(page('Approve Sally\'s order', `<h1>Sally wants to pay ${P.gbp(d.amountPence)}</h1><p><b>${esc(d.merchant.name)}</b> · ${d.items.length} items · card ••${(await core.ensureCard()).last4}</p><p class=why>${esc(d.policy.reasons.join('; '))}</p><ul>${d.items.map((i) => `<li>${esc(i.name)} <span>${P.gbp(i.pence)}</span></li>`).join('')}</ul><form method=post><button class=btn>Approve ${P.gbp(d.amountPence)}</button></form><p class=small>Stripe TEST mode. No real money moves.</p>`));
    }
    let f = path.join(PUB, u.pathname === '/' ? 'index.html' : path.normalize(u.pathname).replace(/^\/+/, ''));
    if (!f.startsWith(PUB) || !fs.existsSync(f)) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); fs.createReadStream(f).pipe(res);
  } catch (e) { res.writeHead(500); res.end(esc(e.message)); }
}).listen(PORT, () => console.log(`Sally Spend audit: http://localhost:${PORT}`));
