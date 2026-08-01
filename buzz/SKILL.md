---
name: run402-buzz
description: Complete Run402 onboarding for a managed Buzz agent with a dedicated wallet/public identity link, report independent human-adoption and community-installation state, offer bounded per-agent enrollment before provisioning, and stop only at a real approval or repair boundary. Use when a managed Buzz user says "install the run402.com skill" or otherwise asks to install, initialize, set up, or connect Run402; asks to adopt a human, install a community, or enroll another agent; or later asks the linked agent to build, deploy, update, verify, or operate through Run402.
---

# Run402 for Buzz

Keep the Buzz/Nostr key and Run402 wallet key separate. Link their public identities with the existing dual-proof ceremony; never derive, import, export, or expose either private key.

Buzz and Run402 treat people and agents as first-class participants. Each person or agent acts through its own identity and keeps an attributable history. Equal standing never means shared credentials or equal permissions: Run402 memberships, grants, delegates, freshness, and spend policy still determine authority.

Keep the authority domains explicit. Buzz is authoritative for signed collaboration evidence. Run402 is authoritative for organizations, project authority, deploys, leases, billing, delivery attempts, and runtime receipts. Identity links and receipts connect the records; Buzz proof is evidence, never Run402 authentication or authorization.

Copying, updating, or discovering the skill files performs no setup and grants no authority. In a managed Buzz conversation, the canonical request `Please install the run402.com skill` is nevertheless a goal-shaped request to install **and connect** Run402: after the inert files are verified, continue in the same turn through preflight, setup, and public identity-link verification. Stop after file installation only when the human explicitly says to copy/install the files only or says not to set up or connect Run402.

## Install or update this skill

Read [references/installation.md](references/installation.md) when installing, updating, repairing, or reporting this skill. Use first-party discovery at `https://run402.com`, the exact managed-runtime target, and the bounded transport-only GitHub fallback defined there. An integrity failure or ambiguous failure stops before setup with `mutation_state: "not_started"`; never hide it by changing source. Installation itself remains inert. After verifying the installed package and target path, immediately read the installed `SKILL.md` from that verified path and continue with the setup workflow below in the current turn. Do not say that the skill will be available on the next turn, ask whether to set up Run402, or stop at the installation receipt unless the human explicitly requested files only or prohibited setup/connection.

Buzz setup requires Run402 4.17.2 or newer. The outer bootstrap or setup helper SHALL run `npm install -g run402@latest` once when the user-global CLI is absent or older, verify the executing version, and restart the complete preflight in the same turn. This agent-side prerequisite needs no human approval and happens before any remote setup or authority mutation. Never present a stale CLI's relay verdict to the human.

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
Read [references/conversations.md](references/conversations.md) when rendering the initial demo-first conversation or an explicit early-adoption request; preserve its sequence and authority disclosures while replacing the example application with a contextual one.

## Set up Run402

1. Read [references/preflight.md](references/preflight.md) and run its zero-mutation outer bootstrap plus the exact `run402 --wallet <profile> doctor --buzz --buzz-agent <subject>` diagnostic before any setup helper or mutation. Resolve the current managed agent's public subject only from Buzz-supplied public context. Return every independent block and its exact action in one response. `BUZZ_PREFLIGHT_RELAY_UNSAFE` blocks; a safe `BUZZ_PREFLIGHT_RELAY_UNREACHABLE` warning permits only the independent founder/org-of-one setup path and suppresses community discovery/enrollment. A passing doctor means environment readiness only.
2. Resolve this installed skill's directory from the loaded supporting-file paths. Do not assume the repository root or current working directory contains the helper.
3. Reuse the unique dedicated profile label proven by preflight. When the doctor reports `BUZZ_PREFLIGHT_WALLET_PROFILE_NOT_FOUND`, auto-execute its exact safe `run402 wallets new <profile>` action and rerun the complete preflight. Never call `wallets use`, rely on ambient selection, or create a profile before the read-only doctor has reported that exact deliberate action.

   To inspect existing local labels without changing selection:

   ```sh
   run402 wallets list
   ```

4. Run the self-contained setup state machine with that exact profile:

   ```sh
   node <skill-directory>/scripts/setup.mjs \
     --wallet <profile> \
     --pubkey <public-agent-npub-or-hex>
   ```

   The helper reruns or validates a fresh target/profile/runtime/relay-bound passing doctor report before its first mutation. It invokes ordinary commands with argument arrays and `shell: false`; on Windows it runs npm's and Run402's JavaScript entrypoints through the exact managed Node executable instead of spawning `.cmd` shims. It:

   - converges an absent or pre-4.17.2 user-global `run402` CLI once before any remote setup mutation, verifies the executing version, and reruns the complete doctor;
   - requires the named profile to exist before it can run initialization;
   - passes `--wallet <profile>` to every Run402 invocation it makes, overriding ambient environment, directory, and global defaults without changing them;
   - uses the existing `run402 init` workflow only as `run402 --wallet <profile> init`, and only when that existing profile is not initialized;
   - confirms a dedicated agent EOA principal;
   - reuses the intended active Nostr link, refuses a different active agent link, or creates the intended link through the released Buzz signer boundary;
   - reports the profile label, public wallet address, and `selection_source: explicit_argument` before any link mutation;
   - independently verifies the public proof and final `run402 org whoami`; and
   - emits one structured ready or blocked result.

5. Branch on `status`, not prose. On `blocked`, report the exact `stage`, stable `code`, `mutation_state`, and the single `next_action`. `RUN402_WALLET_NOT_FOUND` means confirm the label, create it with the separately reported `wallets new` command, and rerun setup. Do not invent a secret-export workaround or claim readiness.
6. On `ready`, retain the complete readiness receipt from [references/receipts.md](references/receipts.md), including the explicit profile-selection evidence and `Deployment: none`, then continue immediately to the contextual demo offer below. Do not exit onboarding at the receipt and do not ask a separate setup question. Do not follow any CLI `next_actions` that create, fund, subscribe, provision, or deploy before the human approves the demo.

Running setup again must be a no-op when the compatible CLI, dedicated profile, and intended verified link already exist.

## Continue from the independent control-plane states

The setup receipt reports skill installation, human adoption, community installation, and this agent's enrollment separately. Never infer one from another. When `control_plane.community_installation.status` is `relay_unavailable`, preserve its exact `next_action`, continue with the contextual org-of-one offer, and do not run discovery or offer enrollment.

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

Use this concise human-facing shape; keep the expanded readiness receipt available without dumping it into chat:

```text
Done—Run402 is connected to my Buzz identity. Would you like me to build and deploy <one concrete, contextual idea> as a quick demo?
```

If context is sparse, offer a small generic end-to-end test without collecting more personal information merely for personalization.

## Build and deploy only after approval

After affirmative approval:

1. Build the offered application from scratch; there is no bundled demo or template.
2. Avoid another planning interview unless missing information materially changes scope, cost, external effects, or safety.
3. Reconfirm `run402 --wallet <profile> org whoami` and the intended active identity link before mutation, using the `profile_label` from the ready receipt.
4. Inspect the repository and current Run402 capabilities. Prefer an existing linked project when appropriate and distinguish the acting principal from the organization that owns the project.
5. For the canonical pre-launch demo, use the Base Sepolia faucet and prototype tier automatically. Do not mention a price, cost, purchase, spend, or funding decision in ordinary Buzz conversation. Preserve `network: base_sepolia`, `funding_source: faucet`, and the observed tier in the expanded receipt. For a real-value rail, use the ordinary spend-disclosure boundary.
6. Validate locally and use the applicable plan/rehearsal path before apply.
7. Deploy through the existing global Run402 CLI with `--wallet <profile>` on every profile-sensitive command; do not rely on ambient selection.
8. Treat deploy success as intermediate. Independently request the live endpoint and exercise the application's critical flow.
9. Post the structured deployment or failure receipt from [references/receipts.md](references/receipts.md). Report only behavior actually verified.

10. After successful live verification, create or reuse one durable adoption offer when the founder-agent organization is eligible:

    ```sh
    run402 --wallet <profile> buzz adopt offer \
      --org <owning-org-id> \
      --identity-link <active-identity-link-id> \
      --deployment-context-file <verified-deployment-context.json>
    ```

    The deployment context contains the verified project, release, live URL, source revision, and verification timestamp from the receipt. Offer creation is inert: it creates no challenge, human principal, membership, transfer, shared credential, or authority change.

11. Lead with the verified result and the normal HTTPS handoff, using this shape:

    ```text
    Done—I built it, deployed it, and verified it at <verified URL>.
    Would you also like to become a co-owner of the Run402 organization that owns this deployment?
    Become an owner: <handoff_url>
    ```

    Do not expose a `buzz://` URL, verification code, raw resource id, event JSON, terminal command, or testnet price in chat. The hosted handoff owns login, passkey enrollment/step-up, the short Buzz signing attempt, and completion.

12. Poll authoritative state with `run402 --wallet <profile> buzz adopt offer show <offer-id>`. Opening the link never implies success. Report completion only when the offer is `completed` and the linked adoption is active, using: `Done—you’re now a co-owner. I remain the founder-agent owner. Whenever you want me to deploy something to Run402, just say “deploy.”` For `available`, `cancelled`, or `ineligible`, preserve the exact state and gateway-authored recovery action.

Do not require a second deployment or ownership transfer for a quick test. If the user later adopts the application for production, preview the ordinary organization transfer and retain only explicitly scoped agent authority.

## Honor explicit early adoption

Demo-first is the canonical bootstrap conversation, not a barrier to direct human intent. If the verified Buzz owner explicitly asks to become an owner before a demo, create or reuse the same durable offer without `deployment_context`, post its normal HTTPS handoff, and poll it exactly as above. Do not deploy an application as an unrequested prerequisite.

Keep `run402 buzz adopt direct ...`, raw event completion, and clipboard/manual handling as advanced compatibility or recovery paths only. Never present them when the offer-capable status reports `capabilities.human_adoption_offers: true`.
