---
title: Allowances and spending
description: Distinguish the organization's allowance, the wallet, tiers and application-side costs.
---

The allowance is the organization's Run402-held prepaid balance: funded by card (Stripe), Lightning, or a voucher, spent by any agent acting for the organization, settled before any 402, and the cap on that spending; a grant key's spend cap bounds one agent's share. A wallet is a key that signs and holds on-chain money — the self-custody path; faucet money lands in the wallet, not the allowance. A balance is an observation of funds, not a grant of permission. A tier determines service entitlement and resource limits; it is neither the allowance nor the wallet balance. Existing profiles retain their payer and policy rather than being reset by a tutorial.

```bash
run402 wallets balance
run402 tier status
run402 status
```

A fresh supported Cloud setup can use the free prototype tier on testnet. Testnet settlement is not a real-money payment. Before production operations, inspect the selected payer, network, the organization's allowance and tier; follow the [billing reference](/cli/ops/) for the chosen payment rail. An unavailable balance read means unknown, not zero or “funded”.

The allowance and configured spending limits constrain the operations governed by that payment path. Do not assume one allowance caps external APIs called by application code, every provider-side charge, or all application billing. Replenishment, holds, settlement, refunds and revocation depend on the selected payment flow. Inspect its returned state; a timeout or pending receipt does not prove payment failed.

For a paid retry, preserve the operation's idempotency key and heed `safe_to_retry`, mutation state and timing. Do not issue a new payment merely because the response was lost. Revoking future authority does not reverse a settled payment. Use the [error and retry contract](/cli/reference/) to distinguish those outcomes.
