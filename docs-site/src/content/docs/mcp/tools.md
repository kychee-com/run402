---
title: "The eight tools"
description: "Native MCP reference — the eight tools and their schemas."
order: 40
---

## The eight tools

`run402-mcp` registers exactly these tools, and every description other than those of `up`, `deploy`, and `expand_result` says that any other operation is a `run` snippet against `r`.

### `up`

The first deploy: any missing setup (wallet, tier, project, workspace link), then the deploy, through the shared SDK `up` action. Returns the `run402.up.result` envelope with graph steps, resources, diagnostics, verification and backup outcomes, and `next_actions`; its `result.app_result` display projection is marked `run402.up.summary`, and `expand_result` retrieves the same execution's redacted detail through the returned `result_ref`.

| Param | Meaning |
|---|---|
| `source` | Local app directory or public Git repository URL. Defaults to the current directory. |
| `name` | Project/app instance name when `up` creates the project. |
| `project_id` | Existing project to install into. |
| `manifest` | Manifest path. Defaults to `run402.json`, then advanced release-only manifests. |
| `dir` | Workspace directory to inspect when `source` is omitted. |
| `tier` | Bootstrap tier (`prototype`, `hobby`, `team`) if account readiness is needed. |
| `dry_run` | Plan only: no gateway mutation, build, release commit, local link write, or prune. |
| `yes` | Approve the non-interactive prerequisite, spend, and local-write prompts for this deploy. |
| `allow_prune` | Approve destructive managed-resource prune steps. |
| `max_spend_usd` | Maximum spend `up` may approve for readiness steps. |
| `build_mode` | `local`, `remote`, or `sandbox`. |
| `allow_shell_build` | Approve shell-string build commands after review. |
| `idempotency_key` | Root key for resumable app-up graph mutations. |
| `no_rehearse` | Skip the automatic rehearsal of a migration-bearing deploy against a live release. |
| `display_name` | Display name to set on this principal (promotion credit and room presence use it). |

Typed `run402.deploy.ts` configs are executable local code: use `run402 up --manifest run402.deploy.ts --check`, then `--plan`, then `--require-plan <plan_id>`, or the SDK `r.up({ manifest }, { mode })`. Do not ask MCP to execute a TypeScript config from a checkout.

### `deploy`

Applies a `ReleaseSpec` to a project with `r.project(id).apply`: replace-vs-patch semantics per resource, value-free `secrets.require` / `secrets.delete`, functions, `site` (with `site.public_paths` and `site.embedding`), an `assets` slice (`{ put: [...], sync?: { prefix, prune, confirm? } }`), `subdomains`, `routes.replace`, and `i18n`. All bytes ride through CAS. Returns the `DeployResult`: release id, URLs, warnings, and a structured progress-event log. Secret values are set first (`await r.secrets.set(projectId, key, { value })` in a `run` snippet, or `run402 secrets set`), never placed in a spec.

| Param | Meaning |
|---|---|
| `project_id` | The project to deploy to. |
| `base` | Diff base. Default `{ release: "current" }`; `{ release: "empty" }` fails if a release already exists. |
| `database`, `secrets`, `functions`, `site`, `assets`, `subdomains`, `routes`, `i18n` | The ReleaseSpec slices. |
| `idempotency_key` | Deduplicates retries with the project id and the gateway's manifest digest. |
| `allow_warning_codes` | Continue past these reviewed plan warning codes. |
| `allow_warnings` | Continue past every warning that requires confirmation (last resort). |

`deploy` stops before upload and commit on a warning the gateway marks `requires_confirmation: true` unless every blocking code is in `allow_warning_codes` (or `allow_warnings` is set). A read-only `GET`/`HEAD` final-wildcard function route may set `acknowledge_readonly: true` on the route itself. Rehearsal is automatic for a migration-bearing plan against a project with a live release; the result's `rehearsal` block says `passed` or why it was `skipped`.

### `status`

No input. Returns `r.status()`: the wallet this server acts as (`local_label`, `server_label`, `address`), its rail, on-chain and allowance balances, the tier and its lease, the projects, the active project, and the API target. Never key material. With no local wallet it names the command to create one.

### `whoami`

No input. Returns `r.orgs.whoami()`: the control-plane principal, its active authenticator and linked identities, every org membership (role and status), and the sign-in session grade (`browser` | `loopback` | `device`; none for the wallet an MCP host signs with). There is no MCP login: a person signs in with `run402 login`. Set the display name with `await r.orgs.setDisplayName("builder")` in a `run` snippet.

### `doctor`

| Param | Meaning |
|---|---|
| `project_id` | Target this project's vault check. Omitted: the repository's own remote, else the active project. |

Returns `r.doctor()`: `{ ok, blocking[], warnings[], checks[] }`, the report `run402 doctor` prints. `ok` is false only on a blocking finding; advisory findings land in `warnings[]`.

### `docs`

| Param | Meaning |
|---|---|
| `topic` | `index` (default: the `run` primer, the `r` namespace table, the topics), `sdk` (the whole SDK reference), `run` (the primer), or one section: a namespace (`projects`, `assets`, `project.apply`, `rooms`) or a section slug (`local-state`). An unknown topic lists the topics. |
| `search` | Words to look for; returns up to eight SDK reference sections containing all of them. |

Answers from the SDK reference and the `run` primer copied into the package at build, so the text matches the SDK the snippet runs against; it never fetches. Every answer is stored: a long one is a window plus a `ref` for `expand_result`.

### `run`

| Param | Meaning |
|---|---|
| `code` | TypeScript or JavaScript, at most 64 KB, run as the body of an async function. `r` is the Node SDK client. |
| `timeout_seconds` | 1 to 300; 60 by default. |

Returns `{ status, value, value_kind?, value_ref, shown, total, logs, logs_ref, calls, duration_ms, wallet, error? }`. The run tool section has the contract, the limits, the error codes, and examples.

### `expand_result`

| Param | Meaning |
|---|---|
| `ref` | The handle a tool printed beside its window (`res_` followed by 16 hex). |
| `offset` | First item to return; default 0. |
| `limit` | Items to return; 100 by default, at most 1000. |

Tools truncate the view, never the data: a `run` value, its logs, a `docs` answer, and `up`'s detail are stored under a `ref`, and this pages the rest. Refs live in this server process only: they expire 30 minutes after the tool ran, and only the most recent 32 are kept. A result that carried a secret is never stored and never has a ref.
