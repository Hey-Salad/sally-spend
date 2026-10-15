# Sally Spend by HeySalad

**Agents that spend · Briefcase x Stripe hackathon, London, 15 Oct 2026**

**Live audit trail:** https://sally-spend.heysalad-o.workers.dev

## 30-second pitch
Sally is HeySalad's grocery agent. She already fills real Waitrose and Ocado trolleys from your list. **Sally Spend** lets her pay for them herself, on a capped Stripe Issuing card, under a written policy you can read in one minute ([policy.md](policy.md)). Small orders go through on their own, anything over the cap is refused (by Sally *and* by the card), and bigger orders wait for one tap on your phone. Every pound gets an answer to **"Why did you pay this?"**: the exact clause, the basket, the merchant, the MCC and the Stripe authorization.

## What happens in the demo
Input is a real basket from Sally's Waitrose run W18 (15 Oct 2026, 27 items, £71.92).
1. **Approved:** £22.65 breakfast top-up. Under £25 and £40, allowlisted grocer, MCC 5411 → Stripe Issuing test authorization approved and captured.
2. **Declined:** the full £71.92 shop. Breaks SP-5 (£40 cap). Sally refuses, and the Stripe card's own spending limit declines the test authorization too.
3. **Phone approval:** £30.37 dinner basket. Over the £25 threshold (SP-12), so Peter gets an approval link; one tap and it's paid.

## Run it
```bash
cp .env.example .env            # add a Stripe TEST secret key (sk_test_...). Live keys are refused.
node src/run-demo.js --reset    # creates the test cardholder + capped virtual card, runs the 3 scenarios
node src/server.js              # audit page on http://localhost:8787, approval links, webhook
```
Node 20+, no dependencies.

## How it works
- `src/policy.js`: deterministic rules engine (ported from HeySalad's autocheckout engine), every rule tagged with its clause id.
- `src/core.js`: Stripe TEST mode. Creates an Issuing cardholder and a GBP virtual card with £40 per-authorization and monthly limits and grocery-only categories, runs the policy, then creates and captures Issuing test authorizations.
- `src/server.js`: the audit page, phone approval links, and a `POST /webhooks/stripe` handler that answers `issuing_authorization.request` with approve or decline under clauses SP-13 to SP-15.
- `public/decisions.json`: the audit log (no secrets, no card numbers).

License: AGPL-3.0. © 2026 HeySalad Inc.
