# Run402 for Buzz

`run402-buzz` is a self-contained skill for a managed [Buzz](https://github.com/block/buzz) coding agent. It installs or updates the user's global Run402 CLI when needed, deliberately creates or selects one named agent wallet profile, links the agent's separate public Buzz/Nostr and Run402 identities, verifies the result, and stops before creating or deploying an application.

The keys remain separate. Buzz signs inside its managed-agent/OS boundary, while Run402 signs through its ordinary EOA profile. The skill never asks for, reads, derives, exports, or shares either private key.

## Getting started

Buzz managed-agent workspaces default to `~/.buzz`. Install this direct package so the generic root Run402 skill cannot shadow it:

```sh
cd ~/.buzz
npx skills add https://github.com/kychee-com/run402/tree/main/buzz -a codex -y
```

The URL points directly at this one-skill package, so no skill selector or install-mode flag is needed. `-a codex` makes the Buzz managed-agent target explicit and `-y` accepts the installer prompt. You can inspect the exact [skills.sh listing](https://skills.sh/kychee-com/run402/run402-buzz) or review every installed file in this directory before setup.

Installation only copies files; it executes nothing. Before continuing, understand the one public side effect: setup publishes a durable public kind-1 Nostr event associating the agent's public Buzz identity with its public Run402 wallet and creates a durable public Run402 proof. Revocation changes current status but does not erase either historical record. If Buzz adds its NIP-OA owner attestation, the owner's public key and signature are also public but gain no Run402 authority.

Then tell the intended managed agent in Buzz:

```text
@Builder, set up Run402.
```

That explicit request authorizes the disclosed public link when it is absent. The agent inspects `run402 wallets list`, chooses a stable dedicated label such as `buzz-fizz`, and creates that exact profile separately with `run402 wallets new <name>` only when it is genuinely absent. It does not change the global active wallet or bind the shared Buzz workspace.

The setup helper then requires both `--wallet <profile>` and the public Buzz key. It refuses unknown labels, pins every Run402 invocation it makes to that explicit wallet, initializes the existing profile when needed, confirms a dedicated agent EOA, rejects a different active Nostr link, creates or reuses the intended public link, and verifies it. Before a link mutation and again at readiness it reports the profile label, public wallet address, and `selection_source: explicit_argument`. Ambient environment variables, directory bindings, and global defaults cannot redirect the ceremony.

The agent then reports `Run402 is ready` with `Deployment: none`, proposes one small contextual test or demo, and waits for your approval before writing an app, selecting a tier, creating a project, provisioning, spending, or deploying.

## Compatibility and contents

The tested fixture is Buzz v0.4.26. A later release is compatible when its managed-agent harness exposes `buzz social publish --content` and `buzz social event --event` and returns the same standalone seven-field kind-1 event shape. No Buzz fork, custom event kind, or upstream PR is required.

- [`SKILL.md`](SKILL.md) — onboarding, readiness, contextual-offer, and approved deployment contract.
- [`scripts/`](scripts/) — dependency-free setup state machine and no-shell public proof handoff.
- [`references/`](references/) — identity/security model and structured receipts.
- [`fixtures/`](fixtures/) — released-Buzz positive, desktop-owner negative, and cryptographic golden vectors.

Buzz is provided by Block under the [Apache-2.0 license](https://github.com/block/buzz/blob/main/LICENSE). This integration is independently maintained in Run402's MIT-licensed repository and does not modify or redistribute the Buzz application.

Migrating from `integrations/run402-for-buzz` only requires updating the installed skill. Existing identity links, projects, and deployments remain valid; do not relink or delete infrastructure merely because the package moved.
