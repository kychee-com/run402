---
title: "Public Buzz/Nostr identity links"
description: "Native SDK reference — identity."
order: 20
---

## Public Buzz/Nostr identity links (`r.identityLinks`)

`identityLinks` represents public Nostr attribution for human and agent principals through one common shape discriminated by `proof_protocol`. One principal may have multiple active subjects, while an active subject is linked to only one principal. It never accepts a Nostr secret and never affects authentication, authorization, organization ownership, grants, grant keys, payment, or transfers.

```ts
import { readFile } from "node:fs/promises";

const challenge = await r.identityLinks.nostr.begin({
  nostrPubkey: "npub1...",       // canonical npub or 64-char lowercase hex
  visibility: "public",          // deliberately explicit
  idempotencyKey: crypto.randomUUID(),
});

// Give challenge.proof_content to Buzz as one standalone kind-1 message.
// Buzz owns Nostr signing; the SDK never sees its private key.
const rawEvent = await readFile("buzz-event.json", "utf8");
const proof = await r.identityLinks.nostr.complete({ rawEvent });

const links = await r.identityLinks.list();
const publicProof = await r.identityLinks.getProof(proof.identity_link_id);
await r.identityLinks.revoke(proof.identity_link_id);
```

`begin`/`complete` is the agent protocol. It requires a credential provider with `signPersonalMessage(message)`, checks that the returned EOA matches the gateway payload, verifies the exact kind-1 Nostr event locally, and never sees a Nostr secret. Human creation is browser-canonical at <https://console.run402.com/identity-links/connect>: direct human session, fresh passkey, explicit public-correlation disclosure, and released Buzz approval, with no terminal/raw-event/resource-id/passkey choreography. `list()` preserves every active and revoked record and its proof protocol. Public proof reads expose common subject/principal/lifecycle fields, the immutable Nostr event, and either agent EOA evidence or the Run402-attested human-session verification statement. Human link and organization membership revocation are independent.

Current `whoami`, project, deploy-operation/release, and transfer response types include linked-identity and immutable action-time actor snapshots. Render unknown future principal/authenticator/authority kinds as data. A snapshot is historical attribution, not a live authorization decision.

## The Lightning allowance (`r.agent.lightningWallet`)

`await r.agent.lightningWallet.mint()` asks Run402 for the calling agent's Lightning wallet — one budgeted, isolated sub-wallet on Run402's own Hub (`custody: "run402_hub"`: the sats sit on the platform Hub, the agent holds a budgeted connection) — and, by default, polls until the platform-side broker activates it (`timeoutMs`, `intervalMs`; `wait: false` returns the `minting` record). Minting is idempotent per principal. The response that first observes the wallet active carries `pairing` (the NWC pairing URI) exactly once; the Node CLI stores it in the profile's `allowance.json` beside the Base key and sets `rail: "lightning"`, after which the Node paid fetch selects Run402's Lightning safety profile on every request, pays the one fixed BOLT11 challenge a 402 carries from the wallet over NWC (checking the remaining budget first), presents the preimage as the MPP credential on a byte-identical retry, and falls back to the x402 buyer when the seller offers no Lightning challenge. Once the invoice is paid, the gateway's "still fulfilling" answers on that retry (`PAYMENT_RECOVERY_PENDING`, `PAYMENT_INTENT_PENDING`, `PAYMENT_STATE_UNAVAILABLE`, `PAYMENT_EVIDENCE_UNAVAILABLE`, each with `Retry-After`) are honoured by repeating the identical paid request a bounded number of times: the same intent, the same credential, never a second payment; a terminal answer such as `PAYMENT_CREDITED` is returned as-is. `get()` reads the wallet (`has_pairing` only; the pairing is never returned twice), `waitForActive()` polls, `revoke()` deletes the sub-wallet on the Hub and returns its balance to the platform. `/sdk/node` exports `NwcWallet` (`getBalanceSats`, `getBudgetSats`, `payInvoice`, `lookupInvoice`), `createLightningFetch`, and `LightningPaymentError` (`LIGHTNING_BUDGET_EXHAUSTED`, `LIGHTNING_DEBIT_ABOVE_CAP`, `LIGHTNING_PAYMENT_OUTCOME_UNKNOWN`, `LIGHTNING_PREIMAGE_MISMATCH`). Errors never carry the pairing, an invoice, or a preimage.

## Buzz community control plane (`r.buzz`)

`await r.buzz.status()` capability-detects `run402.buzz-control-plane.v1` plus `capabilities.human_adoption_offers` and returns independent skill/offer/adoption/community/enrollment state without manufacturing state on an older gateway. The canonical ownership alias is `r.buzz.offerAdoption`; typed `humanAdoptionOffers.create/get/cancel/createAttempt` separates durable inert offers from short human/session-bound attempts. A completed poll exposes the terminal consent receipt, public human identity link, and ordinary owner membership as distinct typed effects. The membership is the only organization-authority source; identity-link and membership revocation are independent and neither rewrites the completed receipt. `r.buzz.adopt` and `humanAdoptions` remain direct advanced compatibility. Other goal aliases are `r.buzz.install` and `r.buzz.enroll`.

The SDK generates mutation idempotency keys when omitted and rejects nested secret-shaped fields before network access. It never signs a Buzz event. Human adoption requires a directly authenticated human completion; community activation accepts an ordinary Buzz kind-1 owner/admin approval and lets Run402 verify released NIP-11/NIP-43 relay evidence. Run402 owns descriptor discovery, policy/default revisions, and revocation, so Buzz itself remains unchanged. Agent enrollment can create only finite grants on named existing projects. It never creates agent org membership, future-project, owner, grant key, or payment authority. Installation revocation leaves existing grants unchanged; enrollment revocation affects only its linked grants; drift is advisory. Buzz failures preserve the gateway's stable code, exact repair `field`, complete `nextActions`, and `safeToRetry`; there is no client-synthesized generic edit fallback, and an unchanged call is retried only when the gateway marks it safe.

Before creating an x402 payment payload, the Node entry confirms USDC with
bounded retry/backoff and independent RPC failover on Base and Base Sepolia.
RPC exhaustion is never treated as a zero balance. Branch on the exported
`X402BalanceError.code`: `X402_RPC_TIMEOUT`, `X402_RPC_RATE_LIMITED`, and
`X402_RPC_UNAVAILABLE` are pre-payment failures with `safeToRetry === true`
and `mutationState === "not_started"`; `X402_INSUFFICIENT_FUNDS` means the
relevant balance reads succeeded and the confirmed funds do not cover any
accepted requirement. After a retryable preflight failure, the next request
refreshes only mutable RPC balance state while retaining the originally
selected signer and payer provenance. Error details contain provider indexes
and failure classes, never RPC credentials, wallet keys, or signed proofs.

### Payment signer selection (Node)

Authentication and payment are separate authorities. A custom `credentials`
provider controls API authentication; the x402 payer is resolved exactly once
in this order:

1. `paymentSigner` — an explicit async EVM signer provider (KMS/HSM friendly).
2. `allowancePath` — an explicit local allowance file.
3. `credentials.readAllowance()` — when a supplied provider implements it.
4. The Node default provider's active-profile allowance — only when the caller
   did not supply a custom credentials provider.

Once a source is selected, the SDK never falls back to the ambient/global
wallet. `paymentSigner` and `allowancePath` together throw
`PAYMENT_SOURCE_CONFLICT`. Passing both `credentials` and `allowancePath` is
valid: auth uses `credentials`, while payment intentionally uses that file.
`fetch` still takes precedence over built-in paid fetch, and
`disablePaidFetch: true` disables automatic payment entirely.

An opaque signer returns only its public payer address and signing operation;
raw keys and replayable payment authorizations do not cross the provider
boundary:

```ts
import {
  run402,
  type CredentialsProvider,
  type EvmPaymentSigner,
  type EvmPaymentSignerProvider,
  type PaymentPublicClient,
  type X402PaymentNetwork,
} from "@run402/sdk/node";

declare const sessionCredentials: CredentialsProvider;
declare function kmsSignerFor(
  network: X402PaymentNetwork,
  publicClient: PaymentPublicClient,
): Promise<EvmPaymentSigner>;

const paymentSigner: EvmPaymentSignerProvider = {
  async getSigner({ network, publicClient }) {
    return kmsSignerFor(network, publicClient); // address + signTypedData
  },
};

const r = run402({ credentials: sessionCredentials, paymentSigner });
const payer = await r.paymentPayer();
// { source: "payment_signer", rail: "x402", payers: [{ address, network }, ...] }
```

The provider may return `null` for an unsupported Base network. Paid-fetch
initialization is lazy and retries after missing/recoverable local state, so a
long-lived client can start paying after its selected allowance/provider
becomes available without being reconstructed. `r.paymentPayer()` initializes
the selected source if necessary and returns only its source, rail, public
address(es), and network(s); it never returns a key, signed authorization, or
replayable proof. It returns `null` when automatic paid fetch is disabled, a
custom `fetch` owns payment, or the selected source is not currently available.

### Buy arbitrary x402 URLs (Node)

`r.pay.fetch(url, init?, options?)` is the canonical buyer surface for an
arbitrary x402-priced HTTP endpoint. It passes unpriced endpoints through,
defaults `maxUsdMicros` to `100_000` ($0.10), forwards an optional
`Idempotency-Key`, and returns the response together with a faithful receipt:

```ts
import { run402 } from "@run402/sdk/node";

const r = run402();
const result = await r.pay.fetch(
  "https://seller.example/translate",
  { method: "POST", body: JSON.stringify({ text: "hello" }) },
  {
    maxUsdMicros: 50_000,
    idempotencyKey: "translation:1",
    requireReceipt: true,
  },
);

console.log(result.outcome, result.payment, await result.response.json());
```

`payment` is `null` when no payment was required or when an already-used proof
confirms that a prior ambiguous request settled but the target cannot return a
transaction reference. Otherwise it includes settlement, movement/replay,
delivery, offer, merchant-receipt, signer-relationship, policy, and
raw-evidence fields. Set `requireReceipt: true` to require a verified
wallet-rooted offer before payment and a matching receipt afterward. The buyer
verifies the exact URL, scheme, network, asset, atomic amount, recipient,
validity, settlement, payer, transaction, and signer relationship. Branch on
`PaymentBuyerError.code`: `PAYMENT_EXCEEDS_MAX`, `PAYMENT_WALLET_UNFUNDED`,
`PAYMENT_NETWORK_UNSUPPORTED`, exact Run402 pending/drain/destination/fence/
lifetime/key-reuse codes, or `PAYMENT_SETTLEMENT_FAILED`. The error preserves
`fundsMoved`, `paymentId`, intent/delivery events, and canonical `nextActions`.
Successful results preserve `paymentId`, `deduplicated`, `fundsMoved`,
`delivery`, `settledAt`, and `intentState` when supplied.

Required policy fails before signing with `MERCHANT_RECEIPT_REQUIRED` when no
eligible offer remains. A post-settlement evidence failure throws
`PaymentPolicyError` with `MERCHANT_RECEIPT_UNAVAILABLE`, the upstream
`Response`, complete commerce result, true funds-moved/mutation state, and one
canonical `retry` or `reconcile_payment` action. Never authorize a second
payment to recover a receipt. `payFetchResultToJson` renders the complete
snake_case `x402-commerce-result.v1` envelope.

For an ambiguous transport failure, retry the identical request on the same SDK
instance with the same idempotency key. This buyer keeps the signed proof only
in memory and re-presents that exact proof; it never mints a second authorization.
An upstream used-proof response becomes `outcome: "already_settled"` and
`replay: true`. Across a fresh process, a Run402 managed/host can
recover a caller-keyed intent by repeating the same request with the same payer
and key. Trusted pending requires status 409, the exact code and reserved
header, the same payment-bearing origin, redirects disabled, HTTPS, and an
exact Run402 DNS-label match. Custom, arbitrary, lookalike, and redirected
hosts remain ambiguous.

`PAYMENT_CALLER_IDENTITY_NOT_ACTIVE` is a rollout fail-closed response. Keep
the same key and retry after caller identity is activated; removing the key to
force a proof-only attempt changes the contract and is never a recovery step.

Raw HTTP interoperability follows the same protocol:

1. Send the intended request with a stable `Idempotency-Key`.
2. On 402, base64url-decode `PAYMENT-REQUIRED`, verify its exact scheme,
   network, asset, atomic amount, recipient, and your local spend ceiling.
3. Sign one x402 payload and retry the same request with that base64url JSON in
   `PAYMENT-SIGNATURE` (`X-PAYMENT` for v1). Do not follow redirects with a
   payment proof.
4. On success, base64url-decode `PAYMENT-RESPONSE` and require
   `success: true`, a non-empty `transaction`, and the expected network before
   reporting funds moved.
5. If the signed request loses its response, retain and re-present the same
   proof for the same intent. Never create a fresh proof until the first
   settlement is reconciled. A used-proof 402 can establish
   `already_settled`, but without a settlement header it is not a transaction
   receipt.

### Automatic x402 attempt recovery (Node)

The Node entry tracks each automatic x402 payment across the provider-dispatch boundary. If setup, challenge handling, or signing fails before a payment-bearing request is sent, it throws `PaymentAttemptError` with `mutationState: "not_started"` and `safeToRetry: true`. Check `retryable` separately: persistent local-journal corruption is safe from duplicate payment but requires repair instead of an automatic retry. If the signed request may have reached the target but no reliable result returns, it reports `mutationState: "ambiguous"`, `safeToRetry: false`, and `reconcile_payment` / `poll` next actions. Generic automatic requests must not be blindly retried; `r.pay.fetch` is the deliberate exception because the same live SDK instance retains and re-presents the original proof.

Every challenged payment gets a stable `paymentAttemptId`. A redacted intent is written atomically under the active profile's mode-0700 `payment-attempts/` directory before provider dispatch; individual records are mode 0600. Inspect them with `readPaymentAttempt(id)` or `listPaymentAttempts({ limit })`. Trusted pending records use `state: "intent_pending"` and may include `payment_id`, retry timing, and a SHA-256 caller-key digest. Records never contain a raw caller key, URL path/query, request body, header, wallet key, signature, signed authorization, provider proof, or raw cause.

The SDK sends `X-Run402-Payment-Attempt-Id` only on the payment-bearing request so a compatible target can correlate its logs. Redirects are disabled for that signed request, preventing both the correlation id and signed payment authorization from reaching a redirect target. A caller may supply a canonical `pat_` id only when it is new; the SDK reserves it atomically across processes, and an id already present in the journal fails closed with `X402_ATTEMPT_ID_ALREADY_EXISTS` before any network request. Generic automatic payment retries require reconciliation and a fresh authorized attempt; only `r.pay.fetch` may re-present its in-memory proof for an identical request. Malformed reserved-header values fail locally with `INVALID_PAYMENT_ATTEMPT_ID`; they are never replaced with an id that could authorize a new payment.

Repo-level deploy through the same SDK action runner used by `run402 up`:

```ts
import { Run402Action, run402 } from "@run402/sdk/node";

const r = run402();

await r.up({ name: "my-app" }, { approval: "yes" });
// result.identity separates principal { id, type, display_name } from client { detected, declared_name }. Human/unknown identity is preserved; RUN402_AGENT_NAME can name agent principals only.
// result.deploy.rehearsal: { status: "passed" | "skipped", … } — automatic for a live-release project with migrations
// input.noRehearse / input.identityName override both.

const provision = await r.actions.run({
  type: Run402Action.ProjectsProvision,
  name: "my-app",
});
```

Typed deploy config loop:

```ts
await r.up({ manifest: "run402.deploy.ts" }, { mode: "check" });
const reviewed = await r.up({ manifest: "run402.deploy.ts" }, { mode: "plan" });
await r.up(
  { manifest: "run402.deploy.ts" },
  {
    mode: {
      kind: "applyReviewed",
      planId: reviewed.result?.plan?.plan_id ?? "",
      planFingerprint: reviewed.result?.plan?.plan_fingerprint ?? undefined,
    },
  },
);
```

For a self-hosted Run402 Core Gateway, run `run402 init --api-base=http://my-core:4020` once. The Node SDK then targets that API base by default; explicit `run402({ apiBase })` still wins.

App build scripts should use `resolveRun402TargetProfile()` instead of parsing `target.json` or local project-key cache files:

```ts
import { resolveRun402TargetProfile } from "@run402/sdk/node";

const target = resolveRun402TargetProfile({
  requiredTarget: "core",
  requireProject: true,
  requireAnonKey: true,
});

console.log(target.apiBase, target.projectId, target.anonKey);
```

For app-specific legacy env names, pass aliases:

```ts
import { resolveRun402TargetProfile } from "@run402/sdk/node";

resolveRun402TargetProfile({
  envAliases: {
    projectId: ["MY_APP_PROJECT_ID"],
    anonKey: ["MY_APP_ANON_KEY"],
  },
});
```
