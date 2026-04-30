# Documentation Map

Single source of truth for every agent- and developer-facing documentation surface in the run402 ecosystem. **Use this as a checklist when changing code:** for each surface you touched, scan the tables below and update every doc that mentions it.

The same code change rarely lands in just one doc. A new MCP tool needs a row in [README.md](README.md) *and* a tools-by-category entry in [SKILL.md](SKILL.md) *and* a section in [llms-mcp.txt](llms-mcp.txt) *and* a `SURFACE` entry in `sync.test.ts`. A new CLI subcommand belongs in [cli/llms-cli.txt](cli/llms-cli.txt) *and* [openclaw/SKILL.md](openclaw/SKILL.md). A new SDK method belongs in [sdk/llms-sdk.txt](sdk/llms-sdk.txt). Don't ship without scanning.

## How to use

1. Identify what you changed.
2. Scan the **Status** column to know which docs are already OK vs need work.
3. Read the **Update when…** column for the surface you touched.
4. Update every flagged doc. For private-repo docs, open a separate PR there.

### Status legend

- 🟢 **Up-to-date** with the current modern surface; no known gaps
- 🟡 **Stale or partial** — present and not actively wrong, but missing recent features OR an auto-fix-pending deploy-pulled copy
- 🔴 **Broken** — actively wrong info, missing entirely, or misleading scope
- ⚪ **Not audited / out of scope for this pass**

Status is a snapshot — refresh it whenever the underlying doc changes.

## Public repo (this repo)

| Status | File | Audience | What's there | Update when… |
|:------:|------|----------|--------------|--------------|
| 🟢 | [`README.md`](README.md) | Humans on GitHub + the [`run402-mcp` npm page](https://www.npmjs.com/package/run402-mcp) | Five-package overview, the four modern patterns (paste-and-go AssetRef, expose manifest, deploy-dir, in-function helpers), full MCP tools table, install matrix per host | A tool is added/removed; the patterns evolve; a package joins/leaves lockstep |
| 🟢 | [`AGENTS.md`](AGENTS.md) | AI coding agents working *inside* this repo (Claude Code, Codex, Cursor, Cline) | Architecture, build/test commands, SDK kernel layout, unified deploy v1.34+ details, error patterns, npm workspaces note. Also links here. | Architecture or build/test steps change; a new SDK namespace is added; a new error helper lands; deploy primitive changes |
| 🟢 | [`CLAUDE.md`](CLAUDE.md) | Claude Code | One line: `@AGENTS.md` (just an import) | Never |
| 🟢 | [`SKILL.md`](SKILL.md) | MCP-host agents (Claude Desktop, Cursor, Cline, Claude Code) — they have `run402-mcp` tools loaded | Teaches the platform via **MCP tool names** in natural-language framings. Quickstart, the four patterns, tools by category, troubleshooting matrix. Frontmatter `install: run402-mcp`. | A tool is added/removed; a pattern changes; a troubleshooting case is discovered |
| 🟢 | [`openclaw/SKILL.md`](openclaw/SKILL.md) | OpenClaw script-runtime agents | Same content as `SKILL.md` but every verb is `run402 <…>` (CLI shape). Frontmatter `install: run402` (the CLI). | A CLI subcommand is added/removed; a pattern changes; a troubleshooting case is discovered |
| 🟢 | [`SKILL.test.ts`](SKILL.test.ts) | CI | Validates frontmatter + required CLI verbs / MCP tool names / banned regressions for **both** SKILL files | Whenever a "canonical" verb or tool name moves in/out of either skill |
| 🟢 | [`cli/README.md`](cli/README.md) | Humans on GitHub + the [`run402` npm page](https://www.npmjs.com/package/run402) | 30-second start, common-command examples per category, state-on-disk note, **points at `llms-cli.txt` as authoritative** | Major CLI surface change; install flow change; new top-level command group |
| 🟢 | [`llms.txt`](llms.txt) | AI agents fetching <https://run402.com/llms.txt> (entry point) | High-level wayfinder. Vision, what we offer, the four integration surfaces (SDK ⭐ recommended, CLI, MCP, raw HTTP), pricing summary, 30-second start, links to each surface's deep reference. Served at run402.com/llms.txt via private-repo deploy pulling this file | Vision / what-we-offer / pricing changes; new integration surface added; surface-recommendation order changes |
| 🟢 | [`cli/llms-cli.txt`](cli/llms-cli.txt) | AI agents fetching <https://run402.com/llms-cli.txt> | Comprehensive CLI reference. Every subcommand, every flag, every flow, troubleshooting. Served via private-repo deploy pulling this file | **Any** CLI subcommand or flag added/removed/renamed |
| 🟢 | [`sdk/llms-sdk.txt`](sdk/llms-sdk.txt) | AI agents fetching <https://run402.com/llms-sdk.txt> | Comprehensive SDK reference. Two entry points, all 19 namespaces with method signatures, the four patterns, full `Run402Error` hierarchy with `Run402DeployError` envelope, `ReleaseSpec` shape, stability + lockstep notes. Served via private-repo deploy pulling this file | Any SDK method or namespace added/changed; `ReleaseSpec` shape changes; new error class lands |
| 🟢 | [`llms-mcp.txt`](llms-mcp.txt) | AI agents fetching <https://run402.com/llms-mcp.txt> | Comprehensive MCP reference. Every tool with parameters, the four patterns, error-envelope branching, troubleshooting, install snippets per host. Served via private-repo deploy pulling this file | Any MCP tool added/removed/renamed; pattern changes; new install host needs documenting |
| 🟢 | [`sdk/README.md`](sdk/README.md) | TypeScript devs / agents using the SDK; the [`@run402/sdk` npm page](https://www.npmjs.com/package/@run402/sdk) | Two entry-point install matrix (Node vs isomorphic), full 19-namespace catalog table, paste-and-go AssetRef pattern, unified `r.deploy.apply` v1.34+ primitive (with three layers + `fileSetFromDir`), full error hierarchy including `Run402DeployError`, stability + lockstep notes | New SDK namespace / method; new error class; entry-point changes |
| 🟢 | [`functions/README.md`](functions/README.md) | TypeScript devs / agents using `@run402/functions`; the [`@run402/functions` npm page](https://www.npmjs.com/package/@run402/functions) | In-function helper API — `db(req)` / `adminDb()` / `getUser()` / `email` / `ai` with examples, fluent surface, `adminDb().sql()` parameterized SQL, SSG build-time use, deploy-time bundling note ("don't list in `--deps`") | `db`/`adminDb`/`getUser`/`email`/`ai` surface changes; new in-function helper lands; bundling rules change |
| 🟢 | [`openclaw/README.md`](openclaw/README.md) | Humans browsing the `openclaw/` folder on GitHub | Install instructions, the script-runtime mechanism (re-export from CLI), pointer at `openclaw/SKILL.md` for the full body, the SKILL.md (root) vs openclaw/SKILL.md split, modern patterns callout (paste-and-go / expose manifest / deploy-dir / db(req)), OpenClaw-vs-MCP comparison | Major skill or install-flow change; SKILL split changes |
| 🟢 | [`documentation.md`](documentation.md) (this file) | Anyone updating docs | The map | A new doc surface is added; a doc moves / is renamed; status changes |

**This repo is public.** Don't add internal documentation, design specs, consultation transcripts, or runbooks here — they belong in `~/Developer/run402-private/docs/`. If you run `/consult` or generate any internal-thinking artifact, move the resulting file to the private repo before committing.

## Private repo (`run402-private/site/`)

Only listed here are files that **originate in the private repo** — i.e., authored and edited there directly. Deploy-pulled mirrors of public-repo files (the public-repo source rows above are authoritative — edit those, then redeploy the site to refresh) are deliberately omitted. Marketing / legal / topic pages are website concerns, also out of scope.

| Status | File | Audience | What's there | Update when… |
|:------:|------|----------|--------------|--------------|
| 🟢 | `site/llms-full.txt` | AI agents fetching <https://run402.com/llms-full.txt> — the HTTP API reference | Comprehensive HTTP / `curl`-shaped reference: every endpoint, request/response shapes, auth header rules, pricing, lifecycle. ~740 lines. (Verified live 2026-04-30 after the private-repo team rewrote it from the prior 67-line KMS-only stub.) | API surface (HTTP routes, request/response shape, auth) changes; new endpoint ships |
| 🟢 | `site/updates.txt` | AI-readable changelog (`/updates.txt`) | `## YYYY-MM-DD` headings, newest first. 25 dated entries spanning 2026-03-29 → 2026-04-30, including the v1.31 expose-manifest, v1.32 CAS substrate, v1.33 agent-DX blob CDN, v1.34 unified deploy, deploy-time functions bundling, error envelopes, and `/deploy/v2` hardening backfills | New entry on every user-visible feature ship |
| 🟢 | `site/humans/changelog.md` | Human-readable changelog (rendered to `/humans/changelog.html`) | Mirrors `updates.txt` in prose form. Same date coverage (2026-03-29 → 2026-04-30) | New entry in lockstep with `updates.txt` |

## Common change → docs to update

When you… | Update at minimum…
---|---
**Add or remove an MCP tool** | `src/index.ts` (registration), `sync.test.ts` (`SURFACE` + `SDK_BY_CAPABILITY`), [README.md](README.md) (tools table), [SKILL.md](SKILL.md) (tools by category), [llms-mcp.txt](llms-mcp.txt) (tools by category), `cli/llms-cli.txt` if there's a sibling CLI subcommand
**Add or remove a CLI subcommand** | `cli/lib/<group>.mjs` (impl), `sync.test.ts` (`SURFACE`), [cli/llms-cli.txt](cli/llms-cli.txt), [openclaw/SKILL.md](openclaw/SKILL.md) (CLI verbs), [cli/README.md](cli/README.md) only if it's a new top-level group, mirror sibling MCP tool docs
**Add an SDK namespace or method** | `sdk/src/namespaces/<name>.ts`, [sdk/llms-sdk.txt](sdk/llms-sdk.txt) (namespace section + signatures), [sdk/README.md](sdk/README.md) (namespace catalog table), [AGENTS.md](AGENTS.md) (namespace count + architecture diagram), [README.md](README.md) (namespace count), `sync.test.ts` (`SDK_BY_CAPABILITY`)
**Change `@run402/functions` surface** | `functions/src/`, [functions/README.md](functions/README.md), [AGENTS.md](AGENTS.md) (Functions library section), [SKILL.md](SKILL.md), [llms-mcp.txt](llms-mcp.txt), [sdk/llms-sdk.txt](sdk/llms-sdk.txt), and [openclaw/SKILL.md](openclaw/SKILL.md) (in-function helpers section in each)
**Rename / remove a tool, command, flag, or method** | All of the above + verify [SKILL.test.ts](SKILL.test.ts) banned-pattern list catches it; cross-repo: drop a private `site/updates.txt` entry if user-visible
**Change a pattern** (auth-as-SDLC, paste-and-go AssetRef, deploy-dir plan/commit, db(req) vs adminDb()) | [README.md](README.md) patterns section, both `SKILL.md` files, [cli/llms-cli.txt](cli/llms-cli.txt), [sdk/llms-sdk.txt](sdk/llms-sdk.txt), [llms-mcp.txt](llms-mcp.txt), [llms.txt](llms.txt) wayfinder if the pattern is part of the pitch
**Add a new integration surface** | [llms.txt](llms.txt) (the wayfinder is the source of truth for "what surfaces exist"), [README.md](README.md) integrations table, [AGENTS.md](AGENTS.md), a matching `llms-<surface>.txt` reference file
**Change pricing or limits** | [README.md](README.md), [SKILL.md](SKILL.md), [cli/llms-cli.txt](cli/llms-cli.txt), [sdk/llms-sdk.txt](sdk/llms-sdk.txt), [llms-mcp.txt](llms-mcp.txt), [llms.txt](llms.txt), [openclaw/SKILL.md](openclaw/SKILL.md). Cross-repo: private `site/humans/*.md` (terms, pricing pages)
**Change architecture (kernel, error hierarchy, build flow)** | [AGENTS.md](AGENTS.md) is the canonical place; reflect any user-visible consequences in the relevant skill / reference
**Cross-repo (private repo)** — **change an HTTP endpoint, ship a user-visible feature, or change the API surface** | `site/llms-full.txt` (HTTP API reference), `site/openapi.json` if applicable, `site/updates.txt` + `site/humans/changelog.md` for user-visible features. Open a separate PR in `run402-private/`.

## Notes on canonicality

- **`llms.txt`** (root) is canonical for the wayfinder — the entry-point document at `run402.com/llms.txt`. Deploy-pulled.
- **`cli/llms-cli.txt`** is canonical for the comprehensive CLI reference. Deploy-pulled.
- **`sdk/llms-sdk.txt`** is canonical for the comprehensive SDK reference. Deploy-pulled.
- **`llms-mcp.txt`** (root) is canonical for the comprehensive MCP reference. Deploy-pulled.
- **`SKILL.md`** (root) is canonical for the MCP-host skill body; the private site's copy is deploy-pulled.
- **`openclaw/SKILL.md`** is canonical for the OpenClaw script-runtime skill body — bundled into the OpenClaw skill install.
- **`AGENTS.md`** is canonical for repo architecture; `CLAUDE.md` just imports it.
- **`site/llms-full.txt`** (private repo) is canonical for the HTTP API reference — edit directly there.
- **`site/updates.txt`** + **`site/humans/changelog.md`** (private repo) are canonical for the changelog — edit directly there.
