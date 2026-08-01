# Run402 for Buzz

`run402-buzz` is a self-contained skill for a managed [Buzz](https://github.com/block/buzz) coding agent. It installs or updates the user's global Run402 CLI when needed, deliberately creates or selects one named agent wallet profile, links the agent's separate public Buzz/Nostr and Run402 identities, reports the independent human/community/enrollment states, and continues until it reaches a real human approval or repair boundary.

The keys remain separate. Buzz signs inside its managed-agent/OS boundary, while Run402 signs through its ordinary EOA profile. The skill never asks for, reads, derives, exports, or shares either private key.

Buzz and Run402 share a participant model: people and agents are peers that act through their own identities and accumulate their own attributable histories. In Buzz, that means one Nostr identity and keypair per participant. In Run402, it means one principal and authenticator per participant. Equal standing does not mean equal permissions—memberships, grants, delegates, freshness, and spend policy determine what each Run402 principal may do.

The records also stay separate. Buzz is authoritative for signed collaboration: the people and agents in the workspace, their conversations, approvals, and Nostr events. Run402 is authoritative for infrastructure facts: organizations, project authority, deployments, leases, billing, delivery attempts, and runtime receipts. The public identity link and returned receipts connect those records; Buzz proof never becomes Run402 authentication or authorization.

## Getting started

Tell the intended managed agent in Buzz:

```text
Please install the run402.com skill.
```

The human does not need a terminal or a special bootstrap URL. In a managed Buzz conversation, `run402.com` discovery routes that request to the distinct `run402-buzz` package. Buzz managed-agent workspaces normally live at `~/.buzz`; the agent installs it there so the generic root Run402 skill cannot shadow it. This canonical sentence means “install and connect Run402”: after verifying the inert files, the agent reads the installed skill directly and continues onboarding in the same turn instead of waiting for runtime rediscovery or asking a second setup question.

For agents and operators auditing the exact command, select only the runtime(s) actually present:

| Runtime | Installer target | Installed workspace path |
| --- | --- | --- |
| Claude Code | `claude-code` | `.claude/skills/run402-buzz` |
| Codex | `codex` | `.agents/skills/run402-buzz` |
| Goose | `goose` | `.goose/skills/run402-buzz` |
| Built-in Buzz Agent / confirmed `.agents/skills` consumer | `universal` | `.agents/skills/run402-buzz` |

Prefer a command runner that supplies `working_directory: <user-home>/.buzz` and `environment: { "DO_NOT_TRACK": "1" }` separately, then runs `npx --yes skills@latest add https://run402.com -s run402-buzz -a codex -y`. If only a shell is available, use the current shell's native syntax. For example:

```sh
cd "$HOME/.buzz"
DO_NOT_TRACK=1 npx --yes skills@latest add https://run402.com -s run402-buzz -a codex -y
```

```powershell
Set-Location (Join-Path $HOME '.buzz')
$env:DO_NOT_TRACK = '1'
npx --yes skills@latest add https://run402.com -s run402-buzz -a codex -y
```

For a workspace used by both Claude Code and Codex, use `-a claude-code codex`. Do not use `-a claude`. `universal` means the shared `.agents/skills` path, not every agent; `-a '*'` is the advanced all-agent selector and intentionally is not the default.

The apex install router at `https://run402.com/install.txt` and Buzz bootstrap at `https://run402.com/buzz/install.txt` point to the apex index and its immutable, digest-verified archive, whose bytes are served entirely by `run402.com`. They are agent-facing implementation details, not text the human must know. The `DO_NOT_TRACK=1` child-process environment disables the installer's optional telemetry; it is rendered with POSIX, PowerShell, or `cmd.exe` syntax only when a shell string is required. The first `npx` invocation can still require the npm registry. GitHub is used only as a reported fallback after a DNS, TLS, timeout, connection-refusal, or unavailable-HTTP failure. Digest, archive, path/link, package-identity, or index disagreement is an integrity failure and must stop before setup—never fall back. The receipt must report the observed first-party digest, actual runtime target, and verified workspace path; it must never call a GitHub source or global runtime directory the first-party Buzz install. See the exact [installation and reporting policy](references/installation.md). The public repository remains the reviewable source, and the [skills.sh listing](https://skills.sh/kychee-com/run402/run402-buzz) remains optional discovery rather than a runtime dependency.

Installation only copies files; it executes nothing. Before continuing, understand the one public side effect: setup publishes a durable public kind-1 Nostr event associating the agent's public Buzz identity with its public Run402 wallet and creates a durable public Run402 proof. Revocation changes current status but does not erase either historical record. If Buzz adds its NIP-OA owner attestation, the owner's public key and signature are also public but gain no Run402 authority.

The canonical request authorizes the disclosed public link when it is absent. Only an explicit instruction to install/copy the files **without** setup or connection stops after the inert receipt. Before trusting preflight, the agent ensures its user-global Run402 CLI is 4.17.2 or newer, automatically runs `npm install -g run402@latest` when it is missing or older, verifies the executing version, and reruns the full preflight without asking the human to use a terminal. Otherwise the agent inspects `run402 wallets list`, chooses a stable dedicated label such as `buzz-fizz`, and creates that exact profile separately with `run402 wallets new <name>` only when it is genuinely absent. It does not change the global active wallet or bind the shared Buzz workspace.

The setup helper then requires both `--wallet <profile>` and the public Buzz key. It refuses unknown labels, pins every Run402 invocation it makes to that explicit wallet, initializes the existing profile when needed, confirms a dedicated agent EOA, rejects a different active Nostr link, creates or reuses the intended public link, and verifies it. Before a link mutation and again at readiness it reports the profile label, public wallet address, and `selection_source: explicit_argument`. Ambient environment variables, directory bindings, and global defaults cannot redirect the ceremony.

The agent then says Run402 is connected and immediately offers one contextual demo. The expanded receipt still records `Deployment: none`. It derives the normalized community from Buzz's existing relay context and asks Run402 for active public descriptors only after the relay completes its safe live read. An unsafe relay blocks setup; a safe relay transport/TLS failure warns, preserves the ordinary founder/org-of-one path, and suppresses community discovery/enrollment until repaired. If exactly one installation is the default, it offers bounded enrollment before provisioning; otherwise it preserves the ordinary org-of-one path. Either path waits for your approval before writing or deploying an app.

On the founder-agent path, the canonical conversation demonstrates value first: the agent proposes one relevant small application, waits for approval, automatically uses the Base Sepolia faucet/prototype path, builds it, deploys it, and independently verifies it. Only then does it create an inert durable adoption offer and post a normal `https://console.run402.com/buzz/adoptions/buzzhao_…` “Become an owner” link. The browser handles human login/passkey, the six-digit Buzz consent, callback, and completion; the human types no terminal command. An explicit request for ownership before the demo is also honored through the same HTTPS handoff.

The vocabulary is deliberate: skill installation is inert shared capability; community installation (the community connection) associates a Buzz community with a Run402 organization; human adoption creates human co-ownership by making the Buzz owner a distinct Run402 human co-owner; agent enrollment gives each Buzz agent its own principal and bounded existing-project grants. See the [Fizz/Honey workflow and state reports](references/community-control-plane.md).

## Compatibility and contents

Buzz itself remains unchanged. The supported boundary is Buzz Desktop v0.5.2's already-shipped behavior: ordinary kind-1 publishing, NIP-11 `self`, relay-signed NIP-43 kind-13534 membership snapshots, the managed `BUZZ_RELAY_URL` context, and the existing `buzz://nostr-bind` human-proof path. Run402 owns descriptor discovery, policy/default revisions, and revocation. Missing relay evidence fails closed for community operations without blocking the independent identity link and org-of-one fallback; unsafe destinations still block the setup doctor itself.

- [`SKILL.md`](SKILL.md) — onboarding, readiness, contextual-offer, and approved deployment contract.
- [`scripts/`](scripts/) — dependency-free setup state machine and no-shell public proof handoff.
- [`references/`](references/) — identity/security model, Fizz/Honey community control-plane workflow, and structured receipts.
- [`fixtures/`](fixtures/) — released-Buzz positive, desktop-owner negative, and cryptographic golden vectors.

Buzz is provided by Block under the [Apache-2.0 license](https://github.com/block/buzz/blob/main/LICENSE). This integration is independently maintained in Run402's MIT-licensed repository and does not modify or redistribute the Buzz application.

Migrating from `integrations/run402-for-buzz` only requires updating the installed skill. Existing identity links, projects, and deployments remain valid; do not relink or delete infrastructure merely because the package moved.
