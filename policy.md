# Sally Spend: written spending policy

Version `sally-spend-policy v1 (15 Oct 2026)`. Owner and approver: Peter Machona, HeySalad.
Sally may pay for groceries on her own **only** when every clause below holds. Each clause id appears in the code (`src/policy.js`), on every decision in the audit trail, and in every "Why did you pay this?" answer.

Hard clauses block a payment outright. Soft clauses send it to Peter's phone for approval.

| Clause | Rule | Type |
|---|---|---|
| **SP-1** | Autonomous checkout must be switched on for the user. | hard |
| **SP-2** | Freeze switch: if on, nothing is paid and the card is frozen. | hard |
| **SP-3** | Shop allowlist: Ocado, Waitrose, Asda, Tesco only. | hard |
| **SP-4** | The basket total must be a valid positive amount. | hard |
| **SP-5** | Per-order cap: **£40.00** including delivery. | hard |
| **SP-6** | Monthly cap: **$100** on the card (GBP converted at a conservative 1.40). Also set as the card's Stripe spending limit. | hard |
| **SP-7** | No age-restricted items (alcohol, tobacco, knives, medicines). | hard |
| **SP-8** | The checkout total must match the trolley Sally checked item by item (±1%). | soft |
| **SP-9** | Every item must be checked by Sally or accepted by the user. | soft |
| **SP-10** | Delivery fee at most £7.00. | soft |
| **SP-11** | Delivery slot within 7 days, between 08:00 and 22:00 London time. | soft |
| **SP-12** | Phone approval: any order over **£25.00**, and every one of the user's first 10 orders, waits for Peter's OK. | soft |
| **SP-13** | At authorization: merchant category must be MCC 5411 (grocery stores) or 5499 (food stores). | hard |
| **SP-14** | At authorization: merchant name must match an allowlisted shop and the shop of the approved order. | hard |
| **SP-15** | At authorization: amount must not exceed the approved order by more than 1%, nor the £40 cap. | hard |
| **SP-16** | Audit: every decision is logged with its inputs, every clause result, the basket, the merchant, the MCC, the amount and the Stripe object id. | always |

Card-level backstop: the Stripe Issuing card itself carries a £40 per-authorization limit, a monthly limit and grocery-only categories, so even a bug in Sally cannot overspend.

Never: the full card number never passes through Sally's backend or extension. Store passwords are never stored, logged or sent to an LLM.

Demo note: the demo card is treated as past its first 10 orders, so SP-12's first-10 rule does not fire and the £25 threshold is what you see.
