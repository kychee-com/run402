# run402 for Buzz

This repository-local integration lets a managed Buzz coding agent link its existing Nostr public identity to its independent run402 wallet, then build and ship an application as the same run402 control-plane principal.

The keys remain separate. Buzz keeps the Nostr signer behind its OS/harness boundary; run402 keeps using its ordinary EOA profile. The public association is a challenge-bound statement signed by both keys. run402 never accepts, derives, reads, or stores an `nsec` or Nostr private key.

## Minimal workflow

Prerequisites: Buzz v0.4.26 or a capability-compatible release, `buzz` available inside the managed-agent harness, and a configured `run402` wallet profile.

```sh
run402 org whoami --json
run402 identity link nostr begin \
  --pubkey 6b6951a5738dfe576d0c44bf7a5f8afe655005a156f9d3e648d81437c3f5ebbf \
  --visibility public \
  --json > /tmp/run402-identity-begin.json

node integrations/run402-for-buzz/scripts/buzz-publish-proof.mjs \
  --begin /tmp/run402-identity-begin.json \
  --event /tmp/run402-identity-event.json

run402 identity link nostr complete \
  --event-file /tmp/run402-identity-event.json \
  --json

run402 org whoami --json
```

The helper invokes Buzz with an argument array and `shell: false`; it does not interpolate proof bytes into a shell command. It publishes a standalone kind-1 note, obtains the signed raw event by id, validates the exact seven-field envelope, and writes only public proof material.

Do not substitute `buzz://nostr-bind`. In the tested desktop release that deep link is signed by the desktop owner/device identity, not the managed builder agent. The committed negative fixture pins this distinction.

## Package contents

- `.agents/skills/run402/SKILL.md` — conservative repository-local workflow for the coding agent.
- `docs/identity-and-security.md` — cryptographic, custody, disclosure, revocation, and adoption model.
- `fixtures/` — released-Buzz positive and wrong-principal negative envelopes.
- `scripts/buzz-publish-proof.mjs` — public-only, no-shell orchestration helper.
- `examples/multiplayer-app/` — customer-feedback reference app, schema, deployment config, and smoke test.

The proof event is separate from the human-readable deployment receipt posted in the originating Buzz thread. The proof is public and permanent; the receipt is operational collaboration context.
