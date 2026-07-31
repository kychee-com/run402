# Run402 for Buzz

`run402-buzz` is a self-contained skill for a managed [Buzz](https://github.com/block/buzz) coding agent. It installs or updates the user's global Run402 CLI when needed, deliberately creates or selects one named agent wallet profile, links the agent's separate public Buzz/Nostr and Run402 identities, reports the independent human/community/enrollment states, and stops before creating authority or deploying an application.

The keys remain separate. Buzz signs inside its managed-agent/OS boundary, while Run402 signs through its ordinary EOA profile. The skill never asks for, reads, derives, exports, or shares either private key.

Buzz and Run402 share a participant model: people and agents are peers that act through their own identities and accumulate their own attributable histories. In Buzz, that means one Nostr identity and keypair per participant. In Run402, it means one principal and authenticator per participant. Equal standing does not mean equal permissions—memberships, grants, delegates, freshness, and spend policy determine what each Run402 principal may do.

The records also stay separate. Buzz is authoritative for signed collaboration: the people and agents in the workspace, their conversations, approvals, and Nostr events. Run402 is authoritative for infrastructure facts: organizations, project authority, deployments, leases, billing, delivery attempts, and runtime receipts. The public identity link and returned receipts connect those records; Buzz proof never becomes Run402 authentication or authorization.

## Getting started

Tell the intended managed agent in Buzz:

```text
@Fizz install the Run402 Buzz skill and set up Run402.
```

The human does not need a terminal. Buzz managed-agent workspaces normally live at `~/.buzz`; the agent installs the distinct `run402-buzz` package there so the generic root Run402 skill cannot shadow it.

For agents and operators auditing the exact command, select only the runtime(s) actually present:

| Runtime | Installer target | Installed workspace path |
| --- | --- | --- |
| Claude Code | `claude-code` | `.claude/skills/run402-buzz` |
| Codex | `codex` | `.agents/skills/run402-buzz` |
| Goose | `goose` | `.goose/skills/run402-buzz` |
| Built-in Buzz Agent / confirmed `.agents/skills` consumer | `universal` | `.agents/skills/run402-buzz` |

```sh
cd ~/.buzz
DO_NOT_TRACK=1 npx --yes skills@latest add https://run402.com -s run402-buzz -a codex -y
```

For a workspace used by both Claude Code and Codex, use `-a claude-code codex`. Do not use `-a claude`. `universal` means the shared `.agents/skills` path, not every agent; `-a '*'` is the advanced all-agent selector and intentionally is not the default.

The apex index advertises an immutable, digest-verified archive whose bytes are served entirely by `run402.com`. `DO_NOT_TRACK=1` disables the installer's optional telemetry; the first `npx` invocation can still require the npm registry. GitHub is used only as a reported fallback after a DNS, TLS, timeout, connection-refusal, or unavailable-HTTP failure. Digest, archive, path/link, package-identity, or index disagreement is an integrity failure and must stop before setup—never fall back. See the exact [installation and reporting policy](references/installation.md). The public repository remains the reviewable source, and the [skills.sh listing](https://skills.sh/kychee-com/run402/run402-buzz) remains optional discovery rather than a runtime dependency.

Installation only copies files; it executes nothing. Before continuing, understand the one public side effect: setup publishes a durable public kind-1 Nostr event associating the agent's public Buzz identity with its public Run402 wallet and creates a durable public Run402 proof. Revocation changes current status but does not erase either historical record. If Buzz adds its NIP-OA owner attestation, the owner's public key and signature are also public but gain no Run402 authority.

If the original request asked only to copy the skill, stop after the inert installation receipt. To begin setup later, tell the intended managed agent:

```text
@Builder, set up Run402.
```

That explicit request authorizes the disclosed public link when it is absent. The agent inspects `run402 wallets list`, chooses a stable dedicated label such as `buzz-fizz`, and creates that exact profile separately with `run402 wallets new <name>` only when it is genuinely absent. It does not change the global active wallet or bind the shared Buzz workspace.

The setup helper then requires both `--wallet <profile>` and the public Buzz key. It refuses unknown labels, pins every Run402 invocation it makes to that explicit wallet, initializes the existing profile when needed, confirms a dedicated agent EOA, rejects a different active Nostr link, creates or reuses the intended public link, and verifies it. Before a link mutation and again at readiness it reports the profile label, public wallet address, and `selection_source: explicit_argument`. Ambient environment variables, directory bindings, and global defaults cannot redirect the ceremony.

The agent then reports `Run402 is ready` with `Deployment: none`. It derives the normalized community from Buzz's existing relay context and asks Run402 for active public descriptors. If exactly one installation is the default, it offers bounded enrollment before provisioning; otherwise it preserves the ordinary org-of-one path. Either path waits for your approval before creating grants, writing an app, selecting a tier, creating a project, provisioning, spending, or deploying.

The vocabulary is deliberate: skill installation is inert shared capability; community installation (the community connection) associates a Buzz community with a Run402 organization; human adoption creates human co-ownership by making the Buzz owner a distinct Run402 human co-owner; agent enrollment gives each Buzz agent its own principal and bounded existing-project grants. See the [Fizz/Honey workflow and state reports](references/community-control-plane.md).

## Compatibility and contents

Buzz itself remains unchanged. The supported boundary is Buzz Desktop v0.5.2's already-shipped behavior: ordinary kind-1 publishing, NIP-11 `self`, relay-signed NIP-43 kind-13534 membership snapshots, the managed `BUZZ_RELAY_URL` context, and the existing `buzz://nostr-bind` human-proof path. Run402 owns descriptor discovery, policy/default revisions, and revocation. Capability detection fails closed when the released relay evidence or Run402 gateway surface is unavailable; the identity link and org-of-one fallback remain usable.

- [`SKILL.md`](SKILL.md) — onboarding, readiness, contextual-offer, and approved deployment contract.
- [`scripts/`](scripts/) — dependency-free setup state machine and no-shell public proof handoff.
- [`references/`](references/) — identity/security model, Fizz/Honey community control-plane workflow, and structured receipts.
- [`fixtures/`](fixtures/) — released-Buzz positive, desktop-owner negative, and cryptographic golden vectors.

Buzz is provided by Block under the [Apache-2.0 license](https://github.com/block/buzz/blob/main/LICENSE). This integration is independently maintained in Run402's MIT-licensed repository and does not modify or redistribute the Buzz application.

Migrating from `integrations/run402-for-buzz` only requires updating the installed skill. Existing identity links, projects, and deployments remain valid; do not relink or delete infrastructure merely because the package moved.
