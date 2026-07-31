---
name: run402-buzz
description: Set up Run402 for a managed Buzz agent with a dedicated wallet/public identity link, report independent human-adoption and community-installation state, offer bounded per-agent enrollment before provisioning, and stop at a verified approval boundary. Use when a Buzz user asks to install, initialize, set up, or connect Run402; asks to adopt a human, install a community, or enroll another agent; or later asks the linked agent to build, deploy, update, verify, or operate through Run402.
---

# Run402 for Buzz

Keep the Buzz/Nostr key and Run402 wallet key separate. Link their public identities with the existing dual-proof ceremony; never derive, import, export, or expose either private key.

Buzz and Run402 treat people and agents as first-class participants. Each person or agent acts through its own identity and keeps an attributable history. Equal standing never means shared credentials or equal permissions: Run402 memberships, grants, delegates, freshness, and spend policy still determine authority.

Keep the authority domains explicit. Buzz is authoritative for signed collaboration evidence. Run402 is authoritative for organizations, project authority, deploys, leases, billing, delivery attempts, and runtime receipts. Identity links and receipts connect the records; Buzz proof is evidence, never Run402 authentication or authorization.

Installing, copying, updating, or discovering this skill performs no setup and authorizes no proof. Begin the setup workflow only after the user explicitly asks this managed Buzz agent to set up, initialize, install, or connect Run402.

## Public-link disclosure

The canonical install instructions tell the user that setup publishes a durable public kind-1 Nostr proof associating the agent's public Buzz identity with its public Run402 wallet. Revocation changes current status but does not erase the Nostr event or historical Run402 proof. A Buzz-managed event may also expose the owner's public NIP-OA attestation. None of these public identities gains authentication, authorization, organization ownership, spending, or transfer authority from the link.

Treat the user's explicit setup request after that disclosure as authorization to create the public link when absent. Do not ask for a redundant confirmation. If this skill was installed by an undisclosed third-party process and the user has not seen the disclosure, explain it and obtain authorization before `identity link nostr begin`.

## Hard boundaries

- Never request, read, locate, export, transform, derive, print, log, or post an `nsec`, `BUZZ_PRIVATE_KEY`, Nostr private key, wallet private key, mnemonic, seed, recovery key, cookie, bearer, service key, SIWX payload, or payment proof.
- Never access the OS keyring directly. Buzz signs only through its managed-agent `buzz social publish` boundary; Run402 signs only through its selected CLI profile.
- Never use `buzz://nostr-bind` for an agent proof. It signs as the desktop owner/device identity, not the managed agent.
- During setup, do not select or purchase a tier, create a project, provision infrastructure, write application source, deploy, transfer, delete, or spend. The only permitted setup mutations are a necessary user-global CLI install/update, deliberate creation of the one named agent wallet after profile inspection, ordinary Run402 profile initialization, and the disclosed public identity link.
- Do not use an ambient `RUN402_WALLET`, directory binding, `wallets use` selection, or default profile for this ceremony. Choose one explicit dedicated profile label and pass it with `--wallet` on every profile-sensitive Run402 command.
- Do not overwrite or relink a human root, treasury, recovery, production-owner, or unrelated profile. Stop unless explicitly scoped `run402 org whoami` resolves a dedicated `agent` principal using `siwx_eoa`.
- Accept only a standalone seven-field kind-1 event with `tags: []` or the fixture-frozen empty-condition NIP-OA `auth` tag. Never rewrite a signed event.

Read [references/identity-and-security.md](references/identity-and-security.md) when reasoning about custody, proof permanence, compromise, revocation, or production adoption. Read [references/community-control-plane.md](references/community-control-plane.md) whenever human adoption, community installation, another Buzz agent, enrollment, drift, or fallback is present. Read [references/receipts.md](references/receipts.md) before reporting readiness, deployment, or failure.

## Set up Run402

1. Read the current managed agent's public Nostr `npub` or 64-character hex pubkey from Buzz's supplied context. Never obtain it by accessing private key material.
2. Resolve this installed skill's directory from the loaded supporting-file paths. Do not assume the repository root or current working directory contains the helper.
3. Choose one stable, dedicated wallet label for this managed agent, such as `buzz-fizz`. The label is ordinary local metadata; do not derive it from either private key. Inspect local profiles first:

   ```sh
   run402 wallets list
   ```

   Reuse the exact intended label when it exists. If it is genuinely absent, create it deliberately as a separate step:

   ```sh
   run402 wallets new <profile>
   ```

   Never call `run402 wallets use` or bind the shared Buzz workspace merely for setup. Creating the wallet separately is intentional: the setup helper refuses unknown labels so a typo cannot silently create and link a new principal.
4. Run the self-contained setup state machine with that exact profile:

   ```sh
   node <skill-directory>/scripts/setup.mjs \
     --wallet <profile> \
     --pubkey <public-agent-npub-or-hex>
   ```

   The helper invokes commands with argument arrays and `shell: false`. It:

   - reuses a compatible user-global `run402` CLI or runs `npm install -g run402@latest` when missing/incompatible;
   - requires the named profile to exist before it can run initialization;
   - passes `--wallet <profile>` to every Run402 invocation it makes, overriding ambient environment, directory, and global defaults without changing them;
   - uses the existing `run402 init` workflow only as `run402 --wallet <profile> init`, and only when that existing profile is not initialized;
   - confirms a dedicated agent EOA principal;
   - reuses the intended active Nostr link, refuses a different active agent link, or creates the intended link through the released Buzz signer boundary;
   - reports the profile label, public wallet address, and `selection_source: explicit_argument` before any link mutation;
   - independently verifies the public proof and final `run402 org whoami`; and
   - emits one structured ready or blocked result.

5. Branch on `status`, not prose. On `blocked`, report the exact `stage`, stable `code`, `mutation_state`, and the single `next_action`. `RUN402_WALLET_NOT_FOUND` means confirm the label, create it with the separately reported `wallets new` command, and rerun setup. Do not invent a secret-export workaround or claim readiness.
6. On `ready`, post the readiness receipt from [references/receipts.md](references/receipts.md). Include the explicit profile-selection evidence, state `Deployment: none`, and stop. Do not follow any CLI `next_actions` that create, fund, subscribe, provision, or deploy.

Running setup again must be a no-op when the compatible CLI, dedicated profile, and intended verified link already exist.

## Continue from the independent control-plane states

The setup receipt reports skill installation, human adoption, community installation, and this agent's enrollment separately. Never infer one from another.

When `next_action.type` is `offer_community_enrollment`, explain the Run402-verified and explicitly selected installation, its complete effective capability allowlist and TTL cap, requested named-project scope, finite expiry, manual/automatic policy, zero spend impact, and org-of-one fallback. Wait for affirmative approval before running `run402 --wallet <profile> buzz enroll ...`. A pending request grants nothing, and a pending or active request suppresses any second enrollment offer. Never approve an enrollment as the requesting agent or reuse another agent's profile.

Preserve gateway-authored `next_actions` fields exactly when reporting recovery, including an exact `field` when present. Branch on the stable error code and action type; never collapse identity drift, authorization failure, stale descriptor, invalid proof, idempotency conflict, relay incompatibility, or rate limiting into a generic edit-and-retry instruction. Retry an unchanged request only when `safe_to_retry: true`: a rate limit uses the exact `Retry-After`, while a transient relay read can repeat its relay check. An unsafe URL, missing NIP-43 evidence, malformed NIP-11 document, invalid proof, policy/scope denial, or identity drift requires the named repair first. A pending community resource remains pending even though its nested `descriptor_state: "proposed"` payload describes the active state awaiting approval. Buzz itself remains unchanged: use the returned ordinary kind-1 content and existing publisher only; never invent a custom Buzz protocol or release dependency.

If there is no verified default, more than one eligible installation, or the user declines, preserve the ordinary contextual app offer below. Do not silently select a community. An absent, denied, expired, stale, or revoked enrollment does not block the independent founder-agent org-of-one path once the user separately approves project creation or deployment.

## Offer one contextual test

After posting readiness, and after resolving or declining any single verified community-enrollment offer, propose exactly one small application in one or two sentences, then ask whether the user wants you to try it. Do not build anything until the user affirmatively agrees.

Choose the idea from, in order:

1. the user's request and recent Buzz conversation;
2. the current repository's domain, stack, and unfinished work;
3. non-sensitive user context already available to you; and
4. capabilities actually exposed by the installed Run402 CLI and current public Run402 documentation.

Inspect current help/documentation rather than trusting a frozen feature list. A **quick test** is the smallest meaningful vertical slice, usually one runtime surface plus one persistent or interactive behavior. A **demo** may combine a few capabilities when they genuinely fit the context. Astro SSR, multiplayer data, translations, authentication, storage, functions, email, and other features are examples, not requirements.

Use this shape:

```text
Run402 is ready. I can build and deploy <one concrete, contextual idea> using <the relevant capabilities>. Would you like me to try it?
```

If context is sparse, offer a small generic end-to-end test without collecting more personal information merely for personalization.

## Build and deploy only after approval

After affirmative approval:

1. Build the offered application from scratch; there is no bundled demo or template.
2. Avoid another planning interview unless missing information materially changes scope, cost, external effects, or safety.
3. Reconfirm `run402 --wallet <profile> org whoami` and the intended active identity link before mutation, using the `profile_label` from the ready receipt.
4. Inspect the repository and current Run402 capabilities. Prefer an existing linked project when appropriate and distinguish the acting principal from the organization that owns the project.
5. Use the prototype or lowest-risk viable tier. Request funding only for a capability or persistence level the approved application actually needs.
6. Validate locally and use the applicable plan/rehearsal path before apply.
7. Deploy through the existing global Run402 CLI with `--wallet <profile>` on every profile-sensitive command; do not rely on ambient selection.
8. Treat deploy success as intermediate. Independently request the live endpoint and exercise the application's critical flow.
9. Post the structured deployment or failure receipt from [references/receipts.md](references/receipts.md). Report only behavior actually verified.

Do not require a second deployment or ownership transfer for a quick test. If the user later adopts the application for production, preview the ordinary organization transfer and retain only explicitly scoped agent authority.
