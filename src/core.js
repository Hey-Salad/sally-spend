const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const P = require('./policy');
const ROOT = path.join(__dirname, '..');
for (const l of (fs.existsSync(path.join(ROOT, '.env')) ? fs.readFileSync(path.join(ROOT, '.env'), 'utf8') : '').split('\n')) {
  const m = l.match(/^([A-Z_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const KEY = process.env.STRIPE_SECRET_KEY || '';
if (KEY && !KEY.startsWith('sk_test_')) { console.error('Refusing to run: Sally Spend only runs on Stripe TEST keys.'); process.exit(1); }
const LEDGER = path.join(ROOT, 'public', 'decisions.json');
const STATE = path.join(ROOT, 'data', 'state.json');
const load = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const save = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 1)); };

async function stripe(method, p, params) {
  const body = params ? new URLSearchParams(flat(params)).toString() : undefined;
  const r = await fetch(`https://api.stripe.com/v1/${p}`, { method, body, headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' } });
  const j = await r.json(); if (j.error) throw new Error(`Stripe ${p}: ${j.error.message}`); return j;
}
function flat(o, pre = '', out = {}) { for (const [k, v] of Object.entries(o)) { const key = pre ? `${pre}[${k}]` : k; if (v && typeof v === 'object') flat(v, key, out); else out[key] = String(v); } return out; }

async function ensureCard() {
  const st = load(STATE, {});
  if (st.cardId) return st;
  const ch = await stripe('POST', 'issuing/cardholders', { type: 'individual', name: 'Peter Machona', email: 'peter@heysalad.io', phone_number: '+447700900123',
    billing: { address: { line1: '1 Test St', city: 'London', postal_code: 'EC1A 1BB', country: 'GB' } },
    individual: { first_name: 'Peter', last_name: 'Machona', dob: { day: 1, month: 1, year: 1990 }, card_issuing: { user_terms_acceptance: { date: Math.floor(Date.now() / 1000), ip: '8.8.8.8' } } } });
  const card = await stripe('POST', 'issuing/cards', { cardholder: ch.id, currency: 'gbp', type: 'virtual', status: 'active', metadata: { app: 'sally-spend' },
    spending_controls: { spending_limits: [{ amount: 4000, interval: 'per_authorization' }, { amount: 7100, interval: 'monthly' }], allowed_categories: ['grocery_stores_supermarkets', 'miscellaneous_food_stores'] } });
  const s = { cardholderId: ch.id, cardId: card.id, last4: card.last4 }; save(STATE, s); return s;
}
const ledger = () => load(LEDGER, { policyVersion: P.POLICY_VERSION, decisions: [] });
const monthSpentUsd = (L) => L.decisions.filter((d) => d.status === 'paid').reduce((a, d) => a + Math.ceil(d.amountPence * P.DEFAULT_RULES.gbpToUsd), 0);
const dash = (id) => id.startsWith('iauth_') ? `https://dashboard.stripe.com/test/issuing/authorizations/${id}` : id.startsWith('ic_') ? `https://dashboard.stripe.com/test/issuing/cards/${id}` : `https://dashboard.stripe.com/test/search?query=${id}`;

function why(d) {
  const amt = P.gbp(d.amountPence);
  const passed = d.policy.results.filter((r) => r.pass).map((r) => r.clause);
  if (d.status === 'paid') return `Sally paid ${amt} to ${d.merchant.name} (MCC ${d.merchant.mcc}) because the order met every clause of the written policy: ${amt} is under the £40 per-order cap (SP-5), the month stays under the $100 card limit (SP-6), ${d.merchant.name} is an allowlisted grocer with a grocery MCC (SP-3, SP-13, SP-14), and the checkout total matched the ${d.items.length} items Sally checked in the trolley (SP-8, SP-9).` +
    (d.approval ? ` It was over the £25 phone-approval threshold, so it waited until ${d.approval.by} approved it at ${d.approval.at} (SP-12).` : ' It was under the £25 approval threshold, so no phone approval was needed (SP-12).') +
    ` Stripe authorization ${d.stripe.authorizationId} was approved and captured on card ••${d.stripe.last4}.`;
  if (d.status === 'declined') return `Sally did not pay. ${d.policy.reasons.join('; ')}. The card itself also enforces the cap: ` + (d.stripe?.authorizationId ? `Stripe declined test authorization ${d.stripe.authorizationId} (${d.stripe.declineReason}).` : 'no authorization was attempted.');
  if (d.status === 'pending_approval') return `Not paid yet. ${d.policy.reasons.join('; ')}. Waiting for ${P.DEFAULT_RULES.approverName} to approve on his phone.`;
  return `Status ${d.status}. Clauses passed: ${passed.join(', ')}.`;
}

async function decide(order) {
  const L = ledger(); const st = await ensureCard();
  const ctx = { now: new Date(), monthSpentUsdCents: monthSpentUsd(L), completedOrders: order.completedOrders ?? 10 };
  const policy = P.evaluateOrder(order, P.DEFAULT_RULES, ctx);
  const d = { id: 'dec_' + crypto.randomBytes(5).toString('hex'), at: new Date().toISOString(), scenario: order.scenario, source: order.source,
    merchant: { name: order.merchantName, mcc: '5411', category: 'grocery_stores_supermarkets', store: order.store }, amountPence: order.basketPence,
    items: order.items.map((i) => ({ name: i.name, pence: i.pence })), policy, status: '', approvalToken: crypto.randomBytes(12).toString('hex') };
  if (policy.outcome === 'allow') await pay(d, st, L);
  else if (policy.outcome === 'needs_approval') d.status = 'pending_approval';
  else {
    d.status = 'declined';
    // Backstop proof: the Stripe card's own spending controls also refuse it.
    const a = await stripe('POST', 'test_helpers/issuing/authorizations', { card: st.cardId, amount: d.amountPence, currency: 'gbp', merchant_data: { name: d.merchant.name, category: d.merchant.category, city: 'London', country: 'GB' } });
    d.stripe = { authorizationId: a.id, approved: a.approved, declineReason: (a.request_history || []).map((h) => h.reason).join(','), last4: st.last4, cardId: st.cardId, dashboard: dash(a.id) };
  }
  d.why = why(d); L.decisions.push(d); save(LEDGER, L); return d;
}

async function pay(d, st, L) {
  const auth = P.evaluateAuthorization({ amount: d.amountPence, mcc: d.merchant.mcc, category: d.merchant.category, merchantName: d.merchant.name },
    { store: d.merchant.store, status: 'approved', approvedPence: d.amountPence }, P.DEFAULT_RULES, { monthSpentUsdCents: monthSpentUsd(L) });
  d.authorizationCheck = auth;
  if (!auth.approved) { d.status = 'declined'; return; }
  const a = await stripe('POST', 'test_helpers/issuing/authorizations', { card: st.cardId, amount: d.amountPence, currency: 'gbp',
    merchant_data: { name: d.merchant.name, category: d.merchant.category, city: 'London', country: 'GB' } });
  if (!a.approved) { d.status = 'declined'; d.stripe = { authorizationId: a.id, declineReason: (a.request_history || []).map((h) => h.reason).join(','), last4: st.last4, dashboard: dash(a.id) }; return; }
  const cap = await stripe('POST', `test_helpers/issuing/authorizations/${a.id}/capture`, {});
  d.status = 'paid';
  d.stripe = { authorizationId: a.id, approved: true, captured: cap.status, transactionIds: (cap.transactions || []).map((t) => t.id), last4: st.last4, cardId: st.cardId, dashboard: dash(a.id) };
}

async function approve(id, token, by = 'Peter Machona') {
  const L = ledger(); const d = L.decisions.find((x) => x.id === id);
  if (!d || d.approvalToken !== token) throw new Error('bad approval link');
  if (d.status !== 'pending_approval') return d;
  d.approval = { by, at: new Date().toLocaleString('en-GB', { timeZone: 'Europe/London' }) + ' BST', via: 'phone approval link' };
  await pay(d, await ensureCard(), L); d.why = why(d); save(LEDGER, L); return d;
}
module.exports = { decide, approve, ledger, ensureCard, why, LEDGER, ROOT, P, dash };
