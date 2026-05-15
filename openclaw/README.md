# Run402 OpenClaw Skill

[OpenClaw](https://openclaw.ai) skill for [Run402](https://run402.com) — provision Postgres databases, deploy static sites, run serverless functions, host content-addressed CDN assets, send email, and sign on-chain. Paid autonomously via x402.

This is the **CLI-shaped** distribution. The skill body in [`SKILL.md`](./SKILL.md) teaches the platform exclusively via `run402 <verb>` commands — it doesn't depend on an MCP host.

## Install

In OpenClaw: **Settings → Skills → Add from path** and point at this directory, or:

```bash
cp -r openclaw ~/.openclaw/skills/run402
cd ~/.openclaw/skills/run402/scripts && npm install
```

The skill's frontmatter declares `install: run402` so OpenClaw also installs the [`run402`](https://www.npmjs.com/package/run402) CLI globally — every script in `scripts/` re-exports from `cli/lib/`, so the CLI is the runtime. Allowance and project credentials live at `~/.config/run402/` and are shared across the CLI / MCP server / OpenClaw skill.

## How it works

The scripts in `scripts/` are thin shims that re-export from the [`run402`](https://www.npmjs.com/package/run402) CLI's internals — same code path as `run402 <verb>` from a shell. OpenClaw's runtime invokes them directly:

```bash
node scripts/projects.mjs sql <project_id> "SELECT * FROM items"
node scripts/blob.mjs put ./logo.png
node scripts/deploy.mjs apply --project <id> --dir ./dist
```

In practice, **prefer reading [`SKILL.md`](./SKILL.md)** — it teaches the modern surface end-to-end:

- **Paste-and-go assets** — `run402 blob put` returns content-addressed CDN URLs with SRI baked in
- **Dark-by-default tables + the expose manifest** — `run402 projects validate-expose` for non-mutating checks, then `run402 projects apply-expose` (preferred: ship `manifest.json` in the bundle's `files[]`)
- **Slick deploys** — `run402 sites deploy-dir` and `run402 deploy apply` with plan/commit transport, `site.public_paths` clean URLs such as `/events` backed by release asset `events.html`, route-only static aliases such as `{ "target": { "type": "static", "file": "events.html" } }` for exact method-aware behavior, stable `static_assets` / `static_manifest_sha256` / `static_public_paths` observability with `reachability_authority`, and URL-first `run402 deploy diagnose --project prj_123 https://example.com/events --method GET` diagnostics that preserve `authorization_result`, `cas_object`, `response_variant`, route `allow`, `active_release_missing`, `unsupported_manifest_version`, `negative_cache_hit`, `route_function`, `route_static_alias`, and `route_method_miss`
- **In-function helpers** — `db(req)` (caller-context, RLS) vs `adminDb()` (bypass) inside deployed functions

## Two skill files in this repo

This skill body is one of two parallel skill bodies that ship from the same monorepo:

| File | Audience | Modality |
|---|---|---|
| [`openclaw/SKILL.md`](./SKILL.md) | OpenClaw script-runtime agents | CLI verbs (`run402 …`) — installs the `run402` package |
| [`SKILL.md`](../SKILL.md) (root) | MCP-host agents (Claude Desktop / Cursor / Cline / Claude Code) | MCP tool names — installs `run402-mcp` |

Both teach the same patterns; pick the file matching your runtime.

## Quick start

```bash
# Set up allowance (once)
node scripts/init.mjs                              # composes allowance create + faucet + tier check

# Provision a project
node scripts/projects.mjs provision --name my-app  # → anon_key, service_key, project_id

# Deploy a directory
node scripts/sites.mjs deploy-dir ./dist           # incremental upload via plan/commit
node scripts/subdomains.mjs claim my-app           # → https://my-app.run402.com
```

## Output contract

Every script prints **JSON to stdout**, **JSON errors to stderr**, and exits **0 on success / 1 on failure** — pipe through `jq`. Same contract as the `run402` CLI.

## OpenClaw vs MCP

| | OpenClaw skill (this) | `run402-mcp` |
|---|---|---|
| **Runtime** | OpenClaw script runner (Node) | MCP-host (Claude Desktop / Cursor / Cline / Claude Code) |
| **Install** | Copy directory + `npm install` (frontmatter installs `run402` globally) | `npx run402-mcp` |
| **Skill body** | [`openclaw/SKILL.md`](./SKILL.md) — `run402 <verb>` examples | [root `SKILL.md`](../SKILL.md) — MCP tool names |
| **Credentials** | `~/.config/run402/` (shared) | `~/.config/run402/` (shared) |
| **Payment** | x402 via the CLI's allowance | x402 via the CLI's allowance |

## Full reference

Treat [`https://run402.com/llms-cli.txt`](https://run402.com/llms-cli.txt) as the authoritative CLI reference (every flag, every subcommand, every flow, troubleshooting). The skill body teaches when to reach for which verb; the llms-cli file is the manual.

## License

MIT
