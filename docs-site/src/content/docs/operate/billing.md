---
title: Billing and resource limits
description: Inspect effective authority, payment state and project limits before changing them.
---

```bash
run402 status
run402 tier status
run402 wallets balance
```

Read the effective organization tier and resource limits, not just a historical lease timestamp. A project inherits the owning organization's lifecycle and entitlement; some limits are pooled and others apply per resource. Use the [current limits reference](/cli/platform/) rather than assuming a tutorial's numbers apply to your tier.

Check the payer and payment rail before a paid operation. Testnet settlement is not real money; an unknown balance is not a zero balance. Respect configured spending authority and preserve idempotency during retries. See [allowances](/concepts/allowances/) and the [payment commands](/cli/ops/).

If an operation is denied by quota, lifecycle or authority, follow its returned action. HTTP 402 means a payment challenge; ordinary quota/authority denials need their own remedy. Do not repeatedly pay to work around an unrelated validation or authorization error.
