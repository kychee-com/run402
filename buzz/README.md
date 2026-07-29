# Run402 for Buzz

`run402-buzz` is a self-contained skill for a managed [Buzz](https://github.com/block/buzz) coding agent. It installs or updates the user's global Run402 CLI when needed, initializes a dedicated agent profile when absent, links the agent's separate public Buzz/Nostr and Run402 wallet identities, verifies the result, and stops before creating or deploying an application.

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

That explicit request authorizes the disclosed public link when it is absent. The skill reuses compatible existing state, otherwise installs `run402@latest` in the user's global npm installation, runs `run402 init`, confirms a dedicated agent EOA, creates or reuses the public identity link, and verifies it. It then reports `Run402 is ready` with `Deployment: none`, proposes one small contextual test or demo, and waits for your approval before writing an app, selecting a tier, creating a project, provisioning, spending, or deploying.

## Compatibility and contents

The tested fixture is Buzz v0.4.26. A later release is compatible when its managed-agent harness exposes `buzz social publish --content` and `buzz social event --event` and returns the same standalone seven-field kind-1 event shape. No Buzz fork, custom event kind, or upstream PR is required.

- [`SKILL.md`](SKILL.md) — onboarding, readiness, contextual-offer, and approved deployment contract.
- [`scripts/`](scripts/) — dependency-free setup state machine and no-shell public proof handoff.
- [`references/`](references/) — identity/security model and structured receipts.
- [`fixtures/`](fixtures/) — released-Buzz positive, desktop-owner negative, and cryptographic golden vectors.

Buzz is provided by Block under the [Apache-2.0 license](https://github.com/block/buzz/blob/main/LICENSE). This integration is independently maintained in Run402's MIT-licensed repository and does not modify or redistribute the Buzz application.

Migrating from `integrations/run402-for-buzz` only requires updating the installed skill. Existing identity links, projects, and deployments remain valid; do not relink or delete infrastructure merely because the package moved.
