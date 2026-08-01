# Installing `run402-buzz`

The human-facing path is a Buzz message, not a terminal session:

```text
Please install the run402.com skill.
```

The human does not need to know a bootstrap path or runtime target. In a managed Buzz context, the apex install router and discovery metadata map this generic request to `run402-buzz`. The managed agent runs the installer from the Buzz workspace (normally `~/.buzz`). Skill installation itself is inert: it copies reviewed files and grants no Run402 or Buzz authority. The canonical sentence is a goal-shaped onboarding request, however, so do not stop after the installation receipt. After verification, immediately load the installed `SKILL.md` from the verified workspace path and continue in the same turn through preflight, setup, and public identity-link verification. Do not say the skill will be available on the next turn and do not ask a second “set up Run402?” question.

Only an explicit files-only constraint such as `Install the skill files only; do not set up or connect Run402` changes that behavior. In that case, stop after the inert receipt with `mutation_state: "not_started"`.

## First-party source

Select only the runtimes actually present. Treat the working directory, child-process environment, and command as separate values whenever the managed command runner supports that:

```text
working_directory: <user-home>/.buzz
environment: { "DO_NOT_TRACK": "1" }
command: npx --yes skills@latest add https://run402.com -s run402-buzz -a <target...> -y
```

Do not paste a POSIX `NAME=value command` prefix into an unknown shell. If the runner accepts only a native shell command, detect the current shell and use its syntax.

POSIX `sh`/Bash/zsh:

```sh
cd "$HOME/.buzz"
DO_NOT_TRACK=1 npx --yes skills@latest add https://run402.com -s run402-buzz -a <target> -y
```

Windows PowerShell:

```powershell
Set-Location (Join-Path $HOME '.buzz')
$env:DO_NOT_TRACK = '1'
npx --yes skills@latest add https://run402.com -s run402-buzz -a <target> -y
```

Windows `cmd.exe`:

```bat
cd /d "%USERPROFILE%\.buzz"
set "DO_NOT_TRACK=1"
npx --yes skills@latest add https://run402.com -s run402-buzz -a <target> -y
```

Use these exact target ids and discovery paths:

| Managed runtime | Target | Expected workspace path |
| --- | --- | --- |
| Claude Code | `claude-code` | `.claude/skills/run402-buzz` |
| Codex | `codex` | `.agents/skills/run402-buzz` |
| Goose | `goose` | `.goose/skills/run402-buzz` |
| Built-in Buzz Agent or another confirmed `.agents/skills` consumer | `universal` | `.agents/skills/run402-buzz` |
| Claude Code and Codex | `claude-code codex` | `.agents/skills/run402-buzz` plus Claude Code's link/copy |

For Claude Code and Codex together, use the same platform-native execution form with `-a claude-code codex`.

Do not use `-a claude`: `claude` is a detection alias, not a valid explicit target. `-a universal` means the `.agents/skills` convention; it does not install for every runtime and does not populate `.claude/skills` or `.goose/skills`. The advanced all-agent selector is `-a '*'`, but it is deliberately not the default because it over-installs.

The `DO_NOT_TRACK` child-process environment value disables the generic installer's optional third-party telemetry for this invocation. It is an environment value, not an installer argument. The first `npx` invocation can still need `registry.npmjs.org` to obtain `skills@latest`. The skill bytes themselves come from the content-addressed artifacts advertised at `https://run402.com/.well-known/agent-skills/index.json`; GitHub, raw GitHub content, `docs.run402.com`, and skills.sh are not required. skills.sh remains an optional discovery catalog.

## One bounded fallback

Use the public GitHub `buzz/` source only after a classified availability failure from the first-party index or artifact: DNS failure, TLS failure, timeout, connection refusal, or unavailable HTTP response. Preserve the same working directory, child-process environment, native shell syntax, and explicit runtime target(s), replacing only the installer source and omitting the first-party `-s` selector:

```text
command: npx --yes skills@latest add https://github.com/kychee-com/run402/tree/main/buzz -a <target...> -y
```

Never fall back after an integrity failure: a missing or mismatched digest, invalid archive, unsafe path or link, package-identity mismatch, or disagreement between the index and artifact. An ambiguous failure is not proven availability failure, so stop safely instead of changing source.

## Installation result

Read the first-party discovery entry before reporting success, verify the expected workspace path after installation, and retain these non-secret fields as the installation stage of the continuing onboarding receipt. Do not infer the source from a repository label or claim a digest/path that was not observed:

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

Never describe `kychee-com/run402/buzz` as the first-party artifact origin. Never report a user-global runtime directory such as `~/.codex/skills/run402-buzz` or `%USERPROFILE%\.codex\skills\run402-buzz` as the expected managed Buzz workspace install. The first-party source is the content-addressed archive advertised by `https://run402.com/.well-known/agent-skills/index.json`; the expected install path is determined by the explicit runtime target from the matrix above, using native path separators when reporting an absolute Windows path.
