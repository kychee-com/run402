# Identity and security

## What is linked

One run402 `agent` principal can expose two public representations:

- an active `siwx_eoa` authenticator used to authenticate run402 requests; and
- a proof-backed Nostr identity used by the managed Buzz agent.

The Nostr identity link is attribution, not authentication. run402 authorization remains organization membership, project grant, delegate, or CI authority. Projects remain organization-owned. Allowances remain a separate spending control.

The statement proven at link time is deliberately narrow: the controller of one exact active run402 EOA also controlled one exact Nostr public key during one server challenge. It does not assert that the keys share a scalar or that the Buzz owner attested to run402 authority.

## Why the keys are separate

Buzz's Nostr key is protected by the OS credential store and managed-agent harness. The ordinary run402 EOA is held by the run402 wallet profile. Crossing those custody boundaries to reuse a scalar would increase compromise impact and introduce cross-protocol key/nonce risk. An `npub` is x-only and also lacks enough public-key parity information to reconstruct a unique EVM address.

The integration therefore never accepts or derives from the Nostr private key. Both systems sign the same public, server-authored challenge using their existing signer boundaries.

## Public proof

The server authors an RFC 8785 canonical payload binding the action, audience, challenge, expiry, nonce, external principal id, Base CAIP-10 EOA, Nostr pubkey, kind 1, explicit public visibility, and EIP-191 scheme. The EOA signs those exact UTF-8 bytes. Buzz signs a kind-1 event whose content is the canonical two-field object `{public_payload,wallet_signature}`.

The accepted event has either no tags or exactly one NIP-OA owner tag:

```json
["auth", "<owner x-only pubkey>", "", "<BIP-340 signature>"]
```

The owner signature is independently verified over `SHA256("nostr:agent-auth:" + agent_pubkey + ":")`. This owner is provenance only. It never becomes a run402 identity link, authenticator, owner, or authority.

The proof record and Nostr event are public and durable. Revocation changes current lifecycle status but does not erase historical signatures or immutable action-time provenance.

## Compromise and recovery

A spending limit does not limit deployment/control-plane damage. Use one dedicated key per agent, prototype ownership by default, and human/company root ownership for production. Never place a founder identity, treasury, recovery key, or broad production owner key in a shell-capable agent.

If either key may be compromised:

1. revoke the run402 identity link;
2. revoke/rotate the affected run402 authenticator or scoped delegate as appropriate;
3. rotate the Buzz agent identity through Buzz's supported recovery process;
4. inspect deployment/audit history; and
5. create a fresh link only after both new public identities are trusted.

Revocation never moves a link to another principal. Replacement creates a fresh row and preserves old proof history.

## Adoption lifecycle

An agent-owned prototype should move into a human/company organization before production. The transfer changes project ownership, not identity-link history. After adoption, retain attribution and grant the agent only the project/deploy capabilities it needs through a revocable, capped, expiring delegate.
