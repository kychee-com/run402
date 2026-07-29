---
name: run402-buzz
description: Set up Run402 for a managed Buzz agent by installing or updating the user's global CLI, initializing its dedicated profile, publicly linking its separate Buzz/Nostr and Run402 wallet identities, and stopping at a verified ready state. Use when a Buzz user asks to install, initialize, set up, or connect Run402, or later asks the linked agent to build, deploy, update, verify, or operate an application through Run402.
---

# Run402 for Buzz

Keep the Buzz/Nostr key and Run402 wallet key separate. Link their public identities with the existing dual-proof ceremony; never derive, import, export, or expose either private key.

Installing, copying, updating, or discovering this skill performs no setup and authorizes no proof. Begin the setup workflow only after the user explicitly asks this managed Buzz agent to set up, initialize, install, or connect Run402.

## Public-link disclosure

The canonical install instructions tell the user that setup publishes a durable public kind-1 Nostr proof associating the agent's public Buzz identity with its public Run402 wallet. Revocation changes current status but does not erase the Nostr event or historical Run402 proof. A Buzz-managed event may also expose the owner's public NIP-OA attestation. None of these public identities gains authentication, authorization, organization ownership, spending, or transfer authority from the link.

Treat the user's explicit setup request after that disclosure as authorization to create the public link when absent. Do not ask for a redundant confirmation. If this skill was installed by an undisclosed third-party process and the user has not seen the disclosure, explain it and obtain authorization before `identity link nostr begin`.

## Hard boundaries

- Never request, read, locate, export, transform, derive, print, log, or post an `nsec`, `BUZZ_PRIVATE_KEY`, Nostr private key, wallet private key, mnemonic, seed, recovery key, cookie, bearer, service key, SIWX payload, or payment proof.
- Never access the OS keyring directly. Buzz signs only through its managed-agent `buzz social publish` boundary; Run402 signs only through its selected CLI profile.
- Never use `buzz://nostr-bind` for an agent proof. It signs as the desktop owner/device identity, not the managed agent.
- During setup, do not select or purchase a tier, create a project, provision infrastructure, write application source, deploy, transfer, delete, or spend. The only permitted setup mutations are a necessary user-global CLI install/update, ordinary Run402 profile initialization, and the disclosed public identity link.
- Do not overwrite or relink a human root, treasury, recovery, production-owner, or unrelated profile. Stop unless `run402 org whoami` resolves a dedicated `agent` principal using `siwx_eoa`.
- Accept only a standalone seven-field kind-1 event with `tags: []` or the fixture-frozen empty-condition NIP-OA `auth` tag. Never rewrite a signed event.

Read [references/identity-and-security.md](references/identity-and-security.md) when reasoning about custody, proof permanence, compromise, revocation, or production adoption. Read [references/receipts.md](references/receipts.md) before reporting readiness, deployment, or failure.

## Set up Run402

1. Read the current managed agent's public Nostr `npub` or 64-character hex pubkey from Buzz's supplied context. Never obtain it by accessing private key material.
2. Resolve this installed skill's directory from the loaded supporting-file paths. Do not assume the repository root or current working directory contains the helper.
3. Run the self-contained setup state machine:

   ```sh
   node <skill-directory>/scripts/setup.mjs --pubkey <public-agent-npub-or-hex>
   ```

   The helper invokes commands with argument arrays and `shell: false`. It:

   - reuses a compatible user-global `run402` CLI or runs `npm install -g run402@latest` when missing/incompatible;
   - runs `run402 init` only when the selected profile is not initialized;
   - confirms a dedicated agent EOA principal;
   - reuses an intended active Nostr link or creates one through the released Buzz signer boundary;
   - independently verifies the public proof and final `run402 org whoami`; and
   - emits one structured ready or blocked result.

4. Branch on `status`, not prose. On `blocked`, report the exact `stage`, stable `code`, `mutation_state`, and the single `next_action`. Do not invent a secret-export workaround or claim readiness.
5. On `ready`, post the readiness receipt from [references/receipts.md](references/receipts.md). State `Deployment: none` and stop. Do not follow any CLI `next_actions` that create, fund, subscribe, provision, or deploy.

Running setup again must be a no-op when the compatible CLI, dedicated profile, and intended verified link already exist.

## Offer one contextual test

After posting readiness, propose exactly one small application in one or two sentences, then ask whether the user wants you to try it. Do not build anything until the user affirmatively agrees.

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
3. Reconfirm `run402 org whoami` and the intended active identity link before mutation.
4. Inspect the repository and current Run402 capabilities. Prefer an existing linked project when appropriate and distinguish the acting principal from the organization that owns the project.
5. Use the prototype or lowest-risk viable tier. Request funding only for a capability or persistence level the approved application actually needs.
6. Validate locally and use the applicable plan/rehearsal path before apply.
7. Deploy through the existing global Run402 CLI.
8. Treat deploy success as intermediate. Independently request the live endpoint and exercise the application's critical flow.
9. Post the structured deployment or failure receipt from [references/receipts.md](references/receipts.md). Report only behavior actually verified.

Do not require a second deployment or ownership transfer for a quick test. If the user later adopts the application for production, preview the ordinary organization transfer and retain only explicitly scoped agent authority.
