// Three scripted scenarios on a real Sally Waitrose basket (run W18, 15 Oct 2026).
const fs = require('fs'); const path = require('path'); const core = require('./core');
const run = JSON.parse(fs.readFileSync(path.join(core.ROOT, 'data', 'w18-basket.json'), 'utf8'));
const pick = (names) => run.items.filter((i) => names.some((n) => i.product.includes(n))).map((i) => ({ name: i.product, pence: i.pence, trolleyChecked: true }));
const tomorrow = (h) => { const d = new Date(Date.now() + 864e5); d.setUTCHours(h - 1, 0, 0, 0); return d.toISOString(); };
const order = (scenario, items) => { const t = items.reduce((a, i) => a + i.pence, 0);
  return { scenario, source: run.source, store: 'waitrose', merchantName: 'Waitrose', items, basketPence: t, trolleyCheckedPence: t, deliveryFeePence: 0, slot: { start: tomorrow(10), end: tomorrow(11) } }; };
(async () => {
  if (process.argv.includes('--reset')) fs.rmSync(core.LEDGER, { force: true });
  const s = await core.ensureCard(); console.log(`Card ••${s.last4} (${s.cardId}) ready, Stripe TEST mode`);
  const A = order('1 · Approved: breakfast top-up', pick(['Milk', 'Eggs', 'Sourdough', 'Butter', 'Yogurts', 'Strawberries']));
  const B = order('2 · Declined: full weekly shop over the £40 cap', run.items.map((i) => ({ name: i.product, pence: i.pence, trolleyChecked: true })));
  const C = order('3 · Needs phone approval: dinner basket over £25', pick(['Chicken', 'Sausages', 'Sweet Potatoes', 'Courgettes', 'Mushrooms', 'Avocado', 'Limes', 'Rice', 'Coconut', 'Coffee']));
  for (const o of [A, B, C]) { const d = await core.decide(o); console.log(`${d.scenario}: £${(d.amountPence / 100).toFixed(2)} -> ${d.status}${d.stripe ? ' ' + d.stripe.authorizationId : ''}`);
    if (d.status === 'pending_approval') console.log(`   approve: ${process.env.PUBLIC_URL || 'http://localhost:8787'}/approve/${d.id}?t=${d.approvalToken}`); }
})().catch((e) => { console.error(e.message); process.exit(1); });
