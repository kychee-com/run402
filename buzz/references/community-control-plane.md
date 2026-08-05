# Buzz community ↔ Run402 control plane

People and agents are first-class participants in both systems. Buzz is authoritative for their Nostr identities and signed collaboration record. Run402 is authoritative for principals, organization and project authority, deploys, leases, billing, delivery attempts, and runtime receipts. Public identity links and receipts connect the domains without turning Buzz proof into Run402 authentication or authorization.

Keep these four states independent:

1. **Skill installation** copies shared software capability. It is inert and non-authoritative.
2. **Community installation** (the community connection) associates one Buzz community with one Run402 organization after both a Run402 owner and a current Buzz community owner/admin consent. It creates no org membership or project grant.
3. **Human adoption** creates human co-ownership: it binds the linked Buzz owner to a distinct Run402 human principal and adds that human as co-owner. The initiating agent remains an owner.
4. **Agent enrollment** binds one Buzz agent principal to one active community installation and grants only an approved, expiring subset of named existing-project capabilities. It creates no org membership and no payment authority.

The names are lifecycle terms, not synonyms. A shared skill installed by Fizz means Honey can discover the Run402 workflow; it does not give Honey Fizz's wallet, principal, membership, grants, or deployment authority.

## Fizz bootstrap, adoption, and installation

Fizz first completes the ordinary public identity link with its dedicated `buzz-fizz` wallet profile. If the verified Buzz owner explicitly asks for adoption before a demo, or after Fizz has deployed and verified a contextual demo, Fizz creates or reuses an inert durable offer:

```sh
run402 --wallet buzz-fizz buzz adopt offer \
  --org org_0123456789abcdef0123456789abcdef \
  --identity-link idlnk_0123456789abcdef0123456789abcdef
```

The offer's normal `https://console.run402.com/buzz/adoptions/buzzhao_…` URL is safe to place in chat and creates no challenge or authority. The Buzz owner opens it, signs in directly, completes a fresh passkey step-up, and only then receives a five-minute six-digit Buzz consent attempt. Buzz returns the public signed event to the same-origin browser fragment; Run402 binds completion to that exact human and browser-session lineage. Fizz polls `run402 --wallet buzz-fizz buzz adopt offer show <buzzhao_id>` and never infers completion from a click.

The result has three visible effects: a terminal completed consent receipt, a public human `idlnk_…`, and an ordinary active owner membership. Only the membership grants organization authority. Fizz remains a separate founder-agent owner; nothing transfers and no credential is shared. Later link revocation leaves membership and receipt unchanged; membership removal leaves the link and receipt unchanged. `run402 buzz adopt direct ...` remains an advanced compatibility path, not the canonical conversation.

The human owner can then initiate community installation:

```sh
run402 buzz install \
  --org org_0123456789abcdef0123456789abcdef \
  --community buzz:community:acme.communities.buzz.xyz \
  --authority 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
```

The installation remains `pending`, and `authority_proof_content.descriptor_state: "proposed"` labels the nested active descriptor as the exact state awaiting approval. Its `event_content` is canonical JSON. A current Buzz owner or admin publishes those exact bytes with the already-shipped `buzz social publish --content '<event_content>'` kind-1 command. Activation submits that signed event and the relay URL. Run402 verifies the event signature and freshness, the relay's released NIP-11 `self`, and the current relay-signed NIP-43 kind-13534 membership snapshot before the installation becomes active. Buzz itself needs no new event kind, handler, extension, deep link, UI, CLI, or release.

Every NIP-11 and Nostr membership read re-resolves the relay, rejects literal/private/reserved or mixed public/private destinations, and pins the validated address set into the actual fresh TLS connection. Redirects are disabled and response time/size are bounded, so a relay hostname cannot pass a DNS check and then redirect or rebind the connection into a private network.

## Honey manual enrollment

Honey already has the shared skill, but starts with its own dedicated `buzz-honey` wallet and public identity link. Honey must not reuse `buzz-fizz` or Fizz's Run402 identity. New community installations always activate non-default; creation and discovery order never choose an enrollment target. A Run402 owner selects a default through an explicit policy update. Replacing it requires clearing the old default before selecting the new one. The integration derives the normalized community subject from Buzz's existing `BUZZ_RELAY_URL`, discovers Run402-owned descriptors with `run402 buzz install discover --community <subject>`, and offers enrollment only when the relay has completed the safe live read and exactly one active default is present. A safe-but-unreachable relay is a founder-setup warning, not an org-of-one blocker, but it suppresses discovery and enrollment until live proof succeeds. An unsafe relay remains blocking. It suppresses duplicate offers while an enrollment is pending or active.

The selected descriptor's safe policy summary is complete: it includes the effective capability allowlist and grant TTL cap, using explicit `null` values when neither is configured. Do not infer a permissive or restrictive hidden policy from omitted fields.

`honey-grants.json` contains a bounded request for named projects only:

```json
[
  {
    "project_id": "existing-community-site",
    "capability": "deploy",
    "policy": {},
    "expires_at": "2026-08-06T12:00:00.000Z"
  }
]
```

```sh
run402 --wallet buzz-honey buzz enroll \
  --installation buzzci_0123456789abcdef0123456789abcdef \
  --identity-link idlnk_fedcba9876543210fedcba9876543210 \
  --grants-file honey-grants.json \
  --expires-at 2026-08-06T12:00:00.000Z
```

Manual policy returns `pending`. A Run402 owner may approve an exact or narrower grant set with the descriptor and policy revisions shown in the enrollment. Automatic policy is opt-in, zero-spend, allowlist-only, finite-TTL, current-membership-gated, and still restricted to existing projects.

## Structured state reports

Success is reported only for an authoritative terminal state:

```json
{"workflow":"buzz_agent_enrollment","status":"active","agent":"Honey","organization_membership_created":false,"project_grant_ids":["grant_…"],"spend_impact":{"currency":"USD","max_amount":"0"}}
```

Pending, denial, drift, revocation, and fallback remain explicit:

```json
{"workflow":"buzz_agent_enrollment","status":"pending","next_action":{"type":"approve_buzz_agent_enrollment","requires_approval":true}}
{"workflow":"buzz_agent_enrollment","status":"denied","project_grant_ids":[],"fallback":"org_of_one"}
{"workflow":"buzz_agent_enrollment","status":"active","drift":[{"type":"identity_link_revoked","authoritative":false}],"authority_changed":false}
{"workflow":"buzz_agent_enrollment","status":"revoked","revoked_project_grant_count":1,"organization_membership_removed":false}
{"workflow":"buzz_setup","status":"ready","community_installation":"ambiguous","next_action":{"type":"offer_contextual_test","fallback":"org_of_one","requires_approval":true}}
```

Drift is advisory after authority is issued. Installation revocation removes discovery/default eligibility but does not revoke existing enrollment grants. Enrollment revocation affects exactly the grants created by that enrollment. If selection is absent, ambiguous, declined, denied, expired, stale, or revoked, the unchanged independent founder-agent org-of-one path remains available.

Gateway `next_actions` are complete safety contracts, not prose hints: preserve `type`, `method`, `path`, any exact `field`, `auth`, `why`, `safe_to_auto_execute`, `requires_approval`, `destructive`, `idempotent`, and `spend_impact`. They are also audience-specific: Honey sees inspect/wait for Honey's pending request, while an owner sees approval.

Recovery is exhaustive and code-specific; there is no generic edit-and-retry fallback. Branch on the stable error code and action type. Retry an unchanged request only when `safe_to_retry: true`: rate limiting uses the exact `Retry-After`, and a transient relay read may repeat the relay check. Unsafe relay URLs, missing relay capabilities, malformed NIP-11 documents, invalid or stale proofs, policy/scope denials, idempotency conflicts, and identity drift require their named repair first. `STEP_UP_REQUIRED` directs a session principal to the exact passkey-login or step-up path instead of merely naming the authentication failure.

Expiry is stored, not guessed by the client. A due pending adoption or installation and a due pending or active enrollment converge to `status: "expired"` with `expired_at` before the next Buzz control-plane response, including principal status. The transition commits independently of any later rejected operation, releases the non-terminal slot, and is audited. Enrollment grants expire no later than the enrollment envelope.

## Credential and routing boundary

Never put an `nsec`, Nostr private key, wallet private key, SIWX payload, session token, passkey material, service key, delegate bearer, recovery code, or payment proof in a Buzz control-plane request, fixture, report, log, or descriptor. Community descriptors contain public discovery metadata only.

Run402 notifications and monitoring are not routed into Buzz by this lifecycle contract. A separate event-routing capability can bind subscriptions to a stable active installation id while keeping Run402's event feed authoritative and independent human deadman channels intact.
