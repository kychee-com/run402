# Run402 OpenClaw Skill

[OpenClaw](https://openclaw.ai) skill for [Run402](https://run402.com) — provision Postgres databases, deploy static sites, run serverless functions, host content-addressed CDN assets, send email, and sign on-chain. Paid autonomously via x402.

Run402 treats the OpenClaw agent as a first-class participant acting through its own principal and authenticator—not as a hidden process borrowing a human account. The agent's authority remains explicit and bounded by its organization role, grant, grant key, freshness, and spend policy. People remain first-class owners and members without having to work in a cloud console.

This is the **CLI-shaped** distribution. The skill body in [`SKILL.md`](./SKILL.md) teaches the platform exclusively via `run402 <verb>` commands — it doesn't depend on an MCP host.

## Install

In OpenClaw: **Settings → Skills → Add from path** and point at this directory, or:

```bash
cp -r openclaw ~/.openclaw/skills/run402
cd ~/.openclaw/skills/run402/scripts && npm install
```

The skill's frontmatter declares `install: run402` so OpenClaw also installs the [`run402`](https://www.npmjs.com/package/run402) CLI globally — every script in `scripts/` re-exports from `cli/lib/`, so the CLI is the runtime. The wallet, active-project state, and the local project-key credential cache live under `~/.config/run402/` and are shared across the CLI / MCP server / OpenClaw skill.

## How it works

The scripts in `scripts/` are thin shims that re-export from the [`run402`](https://www.npmjs.com/package/run402) CLI's internals — same code path as `run402 <verb>` from a shell. OpenClaw's runtime invokes them directly:

```bash
node scripts/projects.mjs sql <project_id> "SELECT * FROM items"
node scripts/assets.mjs put ./logo.png
node scripts/deploy.mjs apply --project <project_id> --dir ./dist
```

In practice, **prefer reading [`SKILL.md`](./SKILL.md)** — it teaches the modern surface end-to-end:

- **Paste-and-go assets** — `run402 assets put` returns content-addressed CDN URLs with SRI baked in
- **Dark-by-default tables + the expose manifest** — `run402 projects validate-expose` for non-mutating checks, then `run402 projects apply-expose` (preferred: ship `manifest.json` in the bundle's `files[]`)
- **Slick deploys** — `run402 sites deploy-dir` and `run402 deploy` with plan/commit transport, `run402 up verify` for app HTTP verification without redeploying, `site.public_paths` clean URLs such as `/events` backed by release asset `events.html`, route-only static aliases such as `{ "target": { "type": "static", "file": "events.html" } }` for exact method-aware behavior (including the "static home page + SPA shell" recipe: a root `"/"` alias serving a real static home page in front of a SPA `index.html` shell), stable `static_assets` / `static_manifest_sha256` / `static_public_paths` observability with `reachability_authority`, and `run402 deploy resolve https://example.com/events --project prj_123 --method GET` diagnostics that preserve `authorization_result`, `cas_object`, `response_variant`, `edge_propagation`, route `allow`, `active_release_missing`, `unsupported_manifest_version`, `negative_cache_hit`, `route_function`, `route_static_alias`, and `route_method_miss`
- **Typed config review loop** — executable `run402.deploy.ts` files are trusted local code. Use the CLI/SDK path rather than a separate MCP/OpenClaw command: `run402 up --manifest run402.deploy.ts --check`, then `--plan`, then `--require-plan <plan_id>`. `--check` is local-only and verifies every file the manifest references (a missing one is `MANIFEST_FILE_MISSING` with a `create_file` next action per file; a missing `--manifest` path is `MANIFEST_NOT_FOUND`); `--plan` is gateway-reviewed and returns `plan_fingerprint`; `--require-plan` applies only the reviewed intent. `--nested` gives an app root inside another repository its own nested repo and encrypted remote.
- **In-function helpers** — `db(req)` (caller-context, RLS) vs `adminDb()` (bypass) inside deployed functions
- **Diagnostics** — `run402 logs --request-id <req_…>` reads every function in the project for one request (app output first; `--all` for the raw Lambda stream) and `run402 doctor` answers `{ ok, blocking[], warnings[], checks[] }`, where `ok` means the agent can ship and advisory findings never flip it

## Skill distribution

The root `SKILL.md` is the generic CLI-first discovery artifact. `openclaw/SKILL.md` carries the same body for OpenClaw installations. MCP setup and native tool examples live in the dedicated MCP reference.

## Quick start

Use the CLI by default. Create the manifest and referenced app files from [Your first deploy](https://docs.run402.com/start/first-deploy/), then run:

```bash
npm install -g run402@latest
run402 up --name my-app -y
```

The root and OpenClaw skills teach the same CLI workflow. MCP-only hosts use the [MCP reference](https://docs.run402.com/mcp/reference/); typed scripts use the [SDK guide](https://docs.run402.com/sdk/scripting/).

## Output contract

Every script prints **JSON to stdout**, **JSON errors to stderr**, and exits **0 on success / 1 on failure** — pipe through `jq`. Same contract as the `run402` CLI.

## OpenClaw vs MCP

| | OpenClaw skill (this) | `run402-mcp` |
|---|---|---|
| **Runtime** | OpenClaw script runner (Node) | MCP-host (Claude Desktop / Cursor / Cline / Claude Code) |
| **Install** | Copy directory + `npm install` (frontmatter installs `run402` globally) | `npx run402-mcp` |
| **Skill body** | [`openclaw/SKILL.md`](./SKILL.md) — `run402 <verb>` examples | [root `SKILL.md`](../SKILL.md) — MCP tool names |
| **Credentials** | `~/.config/run402/` (shared) | `~/.config/run402/` (shared) |
| **Payment** | x402 or MPP (Tempo, Bitcoin Lightning) via the CLI's wallet | x402 or MPP (Tempo, Bitcoin Lightning) via the CLI's wallet |

## Full reference

Treat [`https://docs.run402.com/llms-cli.txt`](https://docs.run402.com/llms-cli.txt) as the authoritative CLI reference: it is the index (the whole first-deploy contract plus a table of fetchable topic slices, `/llms-cli-<slice>.txt` for `deploy`, `commands`, `repos`, `orgs`, `functions`, `assets`, `ops`, `errors`, `frontend`, `platform`), and <https://docs.run402.com/llms-cli-full.txt> is the whole reference (every flag, every subcommand, every flow, troubleshooting) in one document. The skill body teaches when to reach for which verb; the llms-cli files are the manual.

## License

MIT
