# Installing `run402-buzz`

The human-facing path is a Buzz message, not a terminal session:

```text
Please install the run402.com skill.
```

The human does not need to know a bootstrap path or runtime target. In a managed Buzz context, the apex install router and discovery metadata map this generic request to `run402-buzz`. The managed agent runs the installer from the Buzz workspace (normally `~/.buzz`). Skill installation is inert: it copies reviewed files and grants no Run402 or Buzz authority. Because this sentence asks only to install, stop after the installation receipt; setup begins only after a later explicit setup/connect/deploy request.

## First-party source

Select only the runtimes actually present. The canonical first-party command is:

```sh
cd ~/.buzz
DO_NOT_TRACK=1 npx --yes skills@latest add https://run402.com -s run402-buzz -a <target> -y
```

Use these exact target ids and discovery paths:

| Managed runtime | Target | Expected workspace path |
| --- | --- | --- |
| Claude Code | `claude-code` | `.claude/skills/run402-buzz` |
| Codex | `codex` | `.agents/skills/run402-buzz` |
| Goose | `goose` | `.goose/skills/run402-buzz` |
| Built-in Buzz Agent or another confirmed `.agents/skills` consumer | `universal` | `.agents/skills/run402-buzz` |
| Claude Code and Codex | `claude-code codex` | `.agents/skills/run402-buzz` plus Claude Code's link/copy |

For example, Claude Code and Codex together use:

```sh
cd ~/.buzz
DO_NOT_TRACK=1 npx --yes skills@latest add https://run402.com -s run402-buzz -a claude-code codex -y
```

Do not use `-a claude`: `claude` is a detection alias, not a valid explicit target. `-a universal` means the `.agents/skills` convention; it does not install for every runtime and does not populate `.claude/skills` or `.goose/skills`. The advanced all-agent selector is `-a '*'`, but it is deliberately not the default because it over-installs.

`DO_NOT_TRACK=1` disables the generic installer's optional third-party telemetry for this invocation. The first `npx` invocation can still need `registry.npmjs.org` to obtain `skills@latest`. The skill bytes themselves come from the content-addressed artifacts advertised at `https://run402.com/.well-known/agent-skills/index.json`; GitHub, raw GitHub content, `docs.run402.com`, and skills.sh are not required. skills.sh remains an optional discovery catalog.

## One bounded fallback

Use the public GitHub `buzz/` source only after a classified availability failure from the first-party index or artifact: DNS failure, TLS failure, timeout, connection refusal, or unavailable HTTP response. Preserve the same explicit runtime target(s):

```sh
cd ~/.buzz
DO_NOT_TRACK=1 npx --yes skills@latest add https://github.com/kychee-com/run402/tree/main/buzz -a <target> -y
```

Never fall back after an integrity failure: a missing or mismatched digest, invalid archive, unsafe path or link, package-identity mismatch, or disagreement between the index and artifact. An ambiguous failure is not proven availability failure, so stop safely instead of changing source.

## Installation result

Read the first-party discovery entry before reporting success, verify the expected workspace path after installation, and report these non-secret fields before setup. Do not infer the source from a repository label or claim a digest/path that was not observed:

```json
{
  "installation_state": "installed",
  "source_class": "run402_first_party",
  "runtime_targets": ["codex"],
  "installed_paths": [".agents/skills/run402-buzz"],
  "artifact_digest": "sha256:<verified-hex-or-null-when-the-fallback-installer-does-not-expose-it>",
  "mutation_state": "not_started"
}
```

Use `source_class: "github_source_fallback"` when the bounded fallback was required. On an integrity failure, report the exact reason with `installation_state: "blocked"` and `mutation_state: "not_started"`. Installing or updating the skill never initializes a wallet, publishes a Nostr event, links an identity, creates infrastructure, requests faucet funds, selects a tier, deploys, or changes ownership.

Never describe `kychee-com/run402/buzz` as the first-party artifact origin. Never report a user-global runtime directory such as `~/.codex/skills/run402-buzz` as the expected managed Buzz workspace install. The first-party source is the content-addressed archive advertised by `https://run402.com/.well-known/agent-skills/index.json`; the expected install path is determined by the explicit runtime target from the matrix above.
