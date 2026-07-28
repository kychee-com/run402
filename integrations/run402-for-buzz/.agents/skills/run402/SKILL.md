---
name: run402
description: Link this Buzz agent's public Nostr identity to its independent run402 wallet, deploy this repository through run402, verify it, and report a structured receipt without exposing either private key.
---

# Run402 deployment from Buzz

Use this skill when the user asks this managed Buzz coding agent to provision, deploy, update, verify, or transfer a run402 application.

## Hard security boundaries

- Never request, read, export, transform, derive, print, log, or post `BUZZ_PRIVATE_KEY`, an `nsec`, a Nostr private key, a wallet private key, mnemonic, seed, recovery key, cookie, bearer, service key, SIWX payload, or payment proof.
- The Buzz/Nostr key and run402 EOA are intentionally separate. Never derive one from the other and never claim common key material.
- Use only `run402 identity link nostr begin` and the released managed-agent `buzz social publish --content` signer boundary. Never use the desktop `buzz://nostr-bind` owner/device callback as the agent proof.
- Linking is explicitly public and durable. Stop unless the user has authorized `--visibility public`. The agent pubkey, wallet, proof signatures, and optional NIP-OA owner attestation become public. Never place channel ids, reply tags, recipients, workspace context, private prose, or user data in the proof.
- Accept only a standalone kind-1 event with `tags: []` or one independently verifiable `auth` tag with empty conditions. Stop on every other tag or event shape.

## Identity link

1. Run `run402 org whoami --json`. Confirm the active authenticator is `siwx_eoa`, the principal is an agent, and this is not a human root, treasury, recovery, or production-owner wallet.
2. If `linked_identities` already contains the intended active Nostr key, reuse it. Do not create a new proof.
3. Run `run402 identity link nostr begin --pubkey <configured-agent-pubkey> --visibility public --json` and save stdout to a private temporary path. This file contains public material but should not be committed by default.
4. Run `scripts/buzz-publish-proof.mjs --begin <begin.json> --event <event.json>` inside the managed-agent harness. The helper invokes `buzz` without a shell. Do not paste the content through model-authored shell interpolation.
5. Run `run402 identity link nostr complete --event-file <event.json> --json`.
6. Independently read `run402 identity link show <identity_link_id> --json` and verify that the event id, Nostr pubkey, wallet account, link status, and verification timestamp match.
7. Run `run402 org whoami --json` again. Treat the Nostr link as public attribution only: it is never an authenticator, owner, membership, grant, delegate, or payment authority.

If completion fails, report the exact stable code, stage, mutation state, and one bounded recovery action. An expired challenge requires a fresh event; a consumed challenge with another event id must never be replayed.

## Build and deploy

1. Inspect the repository, deployment config, migrations, auth/RLS, routes, storage, functions, and secrets requirements.
2. Prefer the already linked project. If none exists, use a prototype-tier project owned by the agent's org-of-one. State which organization owns it; do not say the wallet or Nostr key owns the project.
3. Run local tests and `run402 deploy rehearse` or the applicable plan/rehearsal command before applying mutations.
4. Apply through the normal run402 CLI under the confirmed wallet principal. Use the lowest-risk tier; request funding only for an actually required paid resource or persistence level.
5. Deployment is incomplete until an independent HTTP request and critical-flow smoke test pass. A successful command alone is not verification.
6. Capture project id, owning organization id, release/deployment id, commit, URL, tier, lease expiry, spend, and verification result from structured outputs.
7. Make and deploy a second requested change to the same project when demonstrating continuity.
8. Before production adoption, preview transfer to the human/company organization. Root ownership moves to the company; continuing agent access becomes a scoped grant/delegate.

## Buzz reporting contract

Success:

```markdown
### Deployment complete
- Buzz agent: `npub1…`
- run402 wallet: `0x…`
- Principal: `prin_…`
- Identity link: `idlnk_…` (public dual proof; separate keys)
- Project: `prj_…`
- Owning organization: `org_…`
- Release: `rel_…`
- Commit: `…`
- URL: https://…
- Tier: Prototype
- Lease expires: `…`
- Verification: HTTP 200 and smoke tests passed
- Spend: `$…`
```

Failure:

```markdown
### Deployment blocked
- Stage: `…`
- Error code: `…`
- Requested capability: `…`
- Mutation state: `none|partial|applied`
- Ownership effect: `none|…`
- Next action: `…`
```

Redact all credentials and proof-request headers. Do not report success without independent verification.
