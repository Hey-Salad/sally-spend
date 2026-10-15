// Sally Spend policy engine. Ported from HeySalad autocheckout rules (heysalad-payme PR #35).
// Pure functions: same inputs -> same decision. Every rule maps to a clause id in policy.md.
const POLICY_VERSION = 'sally-spend-policy v1 (15 Oct 2026)';
const DEFAULT_RULES = Object.freeze({
  enabled: true, killSwitch: false, approverName: 'Peter Machona',
  perOrderCapPence: 4000, monthlyCapUsdCents: 10000, gbpToUsd: 1.4,
  approvalThresholdPence: 2500, alwaysApproveFirstN: 10,
  storeAllowlist: ['ocado', 'waitrose', 'asda', 'tesco'],
  trolleyTolerance: 0.01, maxDeliveryFeePence: 700,
  slotEarliestHour: 8, slotLatestHour: 22, slotMaxDaysAhead: 7,
});
const CLAUSES = {
  feature_enabled: 'SP-1', kill_switch: 'SP-2', store_allowlist: 'SP-3', basket_valid: 'SP-4',
  per_order_cap: 'SP-5', monthly_cap: 'SP-6', no_age_restricted: 'SP-7', trolley_match: 'SP-8',
  items_checked: 'SP-9', delivery_fee: 'SP-10', slot_window: 'SP-11', approval_required: 'SP-12',
  auth_mcc: 'SP-13', auth_merchant: 'SP-14', auth_amount: 'SP-15', audit: 'SP-16',
};
const MERCHANT_NAME_PATTERNS = { ocado: /\bocado\b/i, waitrose: /\bwaitrose\b/i, asda: /\basda\b/i, tesco: /\btesco\b/i };
const ALLOWED_MCCS = ['5411', '5499'];
const ALLOWED_STRIPE_CATEGORIES = ['grocery_stores_supermarkets', 'miscellaneous_food_stores'];
const gbp = (p) => `£${(p / 100).toFixed(2)}`;
const londonHour = (d) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', hourCycle: 'h23' }).format(d));

function evaluateOrder(input, cfg, ctx) {
  const r = [];
  const add = (rule, pass, severity, detail) => r.push({ rule, clause: CLAUSES[rule], pass, severity, detail });
  add('feature_enabled', cfg.enabled, 'hard', cfg.enabled ? 'autonomous checkout on' : 'autonomous checkout off');
  add('kill_switch', !cfg.killSwitch, 'hard', cfg.killSwitch ? 'freeze switch ON (card frozen)' : 'freeze switch off');
  const store = String(input.store || '').toLowerCase();
  add('store_allowlist', cfg.storeAllowlist.includes(store), 'hard', `store=${store}`);
  const basket = Math.round(Number(input.basketPence));
  const ok = Number.isFinite(basket) && basket > 0;
  add('basket_valid', ok, 'hard', ok ? gbp(basket) : 'invalid total');
  add('per_order_cap', ok && basket <= cfg.perOrderCapPence, 'hard', `${gbp(basket)} vs cap ${gbp(cfg.perOrderCapPence)}`);
  const usd = Math.ceil(basket * cfg.gbpToUsd); const proj = ctx.monthSpentUsdCents + usd;
  add('monthly_cap', proj <= cfg.monthlyCapUsdCents, 'hard', `month $${(ctx.monthSpentUsdCents / 100).toFixed(2)} + ~$${(usd / 100).toFixed(2)} vs $${(cfg.monthlyCapUsdCents / 100).toFixed(2)}`);
  const age = input.items.filter((i) => i.ageRestricted);
  add('no_age_restricted', !age.length, 'hard', age.length ? age.map((i) => i.name).join(', ') : 'none');
  const c = input.trolleyCheckedPence;
  add('trolley_match', c > 0 && Math.abs(basket - c) <= Math.max(1, Math.round(c * cfg.trolleyTolerance)), 'soft', `checkout ${gbp(basket)} vs Sally's checked trolley ${gbp(c || 0)}`);
  const un = input.items.filter((i) => !i.trolleyChecked);
  add('items_checked', input.items.length > 0 && !un.length, 'soft', un.length ? `unchecked: ${un.map((i) => i.name).join(', ')}` : `${input.items.length} items checked`);
  add('delivery_fee', input.deliveryFeePence <= cfg.maxDeliveryFeePence, 'soft', `${gbp(input.deliveryFeePence)} vs max ${gbp(cfg.maxDeliveryFeePence)}`);
  let slotOk = false;
  if (input.slot) { const s = new Date(input.slot.start), e = new Date(input.slot.end); const days = (s - ctx.now) / 864e5;
    slotOk = s > ctx.now && e > s && days <= cfg.slotMaxDaysAhead && londonHour(s) >= cfg.slotEarliestHour && (londonHour(e) || 24) <= cfg.slotLatestHour; }
  add('slot_window', slotOk, 'soft', input.slot ? `${input.slot.start} – ${input.slot.end}` : 'no slot');
  const hard = r.filter((x) => !x.pass && x.severity === 'hard');
  if (hard.length) return { outcome: 'deny', results: r, reasons: hard.map((x) => `${x.clause} ${x.rule}: ${x.detail}`) };
  const reasons = r.filter((x) => !x.pass).map((x) => `${x.clause} ${x.rule}: ${x.detail}`);
  if (ctx.completedOrders < cfg.alwaysApproveFirstN) reasons.push(`SP-12 first ${cfg.alwaysApproveFirstN} orders need ${cfg.approverName}'s OK (this is order ${ctx.completedOrders + 1})`);
  if (basket > cfg.approvalThresholdPence) reasons.push(`SP-12 ${gbp(basket)} is above the phone-approval threshold ${gbp(cfg.approvalThresholdPence)}`);
  add('approval_required', !reasons.length, 'soft', reasons.length ? reasons.join('; ') : 'no approval needed');
  return reasons.length ? { outcome: 'needs_approval', results: r, reasons } : { outcome: 'allow', results: r, reasons: [] };
}

// Authorization-time check: the same logic a Stripe issuing_authorization.request webhook runs.
function evaluateAuthorization(a, intent, cfg, ctx) {
  const reasons = [], checks = [];
  const chk = (rule, clause, pass, detail) => { checks.push({ rule, clause, pass, detail }); if (!pass) reasons.push(`${clause} ${detail}`); };
  chk('kill_switch', 'SP-2', !cfg.killSwitch, cfg.killSwitch ? 'freeze switch on' : 'freeze switch off');
  chk('auth_mcc', 'SP-13', ALLOWED_MCCS.includes(String(a.mcc)) || ALLOWED_STRIPE_CATEGORIES.includes(a.category), `MCC ${a.mcc} (${a.category})`);
  const nameStore = Object.keys(MERCHANT_NAME_PATTERNS).find((s) => MERCHANT_NAME_PATTERNS[s].test(a.merchantName || ''));
  chk('auth_merchant', 'SP-14', !!nameStore && cfg.storeAllowlist.includes(nameStore) && (!intent || intent.store === nameStore), `merchant "${a.merchantName}"`);
  const limit = intent ? Math.round(intent.approvedPence * (1 + cfg.trolleyTolerance)) : 0;
  chk('auth_amount', 'SP-15', !!intent && intent.status === 'approved' && a.amount <= limit && a.amount <= cfg.perOrderCapPence,
    intent ? `${gbp(a.amount)} vs approved order ${gbp(intent.approvedPence)} (+1%) and cap ${gbp(cfg.perOrderCapPence)}; order status ${intent.status}` : 'no approved order');
  chk('monthly_cap', 'SP-6', ctx.monthSpentUsdCents + Math.ceil(a.amount * cfg.gbpToUsd) <= cfg.monthlyCapUsdCents, 'monthly $100 cap');
  return { approved: !reasons.length, reasons, checks };
}
module.exports = { POLICY_VERSION, DEFAULT_RULES, CLAUSES, evaluateOrder, evaluateAuthorization, gbp };
