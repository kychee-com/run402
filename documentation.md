# Documentation Map

Single source of truth for every agent- and developer-facing documentation surface in the run402 ecosystem. **Use this as a checklist when changing code:** for each surface you touched, scan the tables below and update every doc that mentions it.

The same code change rarely lands in just one doc. A new MCP tool needs a row in [README.md](README.md) *and* a tools-by-category entry in [SKILL.md](SKILL.md) *and* a `SURFACE` entry in `sync.test.ts`. A new CLI subcommand belongs in [cli/llms-cli.txt](cli/llms-cli.txt) *and* the public-site `site/llms-cli.txt` (deploy-pulled). Don't ship without scanning.

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
| 🟢 | [`cli/llms-cli.txt`](cli/llms-cli.txt) | AI agents fetching CLI reference (canonical) | Every subcommand, every flag, every flow, troubleshooting. Served at <https://run402.com/llms-cli.txt> via private-repo deploy pulling this file | **Any** CLI subcommand or flag added/removed/renamed |
| 🟢 | [`sdk/README.md`](sdk/README.md) | TypeScript devs / agents using the SDK; the [`@run402/sdk` npm page](https://www.npmjs.com/package/@run402/sdk) | Two entry-point install matrix (Node vs isomorphic), full 19-namespace catalog table, paste-and-go AssetRef pattern, unified `r.deploy.apply` v1.34+ primitive (with three layers + `fileSetFromDir`), full error hierarchy including `Run402DeployError`, stability + lockstep notes | New SDK namespace / method; new error class; entry-point changes |
| 🟢 | [`functions/README.md`](functions/README.md) | TypeScript devs / agents using `@run402/functions`; the [`@run402/functions` npm page](https://www.npmjs.com/package/@run402/functions) | In-function helper API — `db(req)` / `adminDb()` / `getUser()` / `email` / `ai` with examples, fluent surface, `adminDb().sql()` parameterized SQL, SSG build-time use, deploy-time bundling note ("don't list in `--deps`") | `db`/`adminDb`/`getUser`/`email`/`ai` surface changes; new in-function helper lands; bundling rules change |
| 🟢 | [`openclaw/README.md`](openclaw/README.md) | Humans browsing the `openclaw/` folder on GitHub | Install instructions, the script-runtime mechanism (re-export from CLI), pointer at `openclaw/SKILL.md` for the full body, the SKILL.md (root) vs openclaw/SKILL.md split, modern patterns callout (paste-and-go / expose manifest / deploy-dir / db(req)), OpenClaw-vs-MCP comparison | Major skill or install-flow change; SKILL split changes |
| 🟢 | [`documentation.md`](documentation.md) (this file) | Anyone updating docs | The map | A new doc surface is added; a doc moves / is renamed; status changes |

**This repo is public.** Don't add internal documentation, design specs, consultation transcripts, or runbooks here — they belong in `~/Developer/run402-private/docs/`. If you run `/consult` or generate any internal-thinking artifact, move the resulting file to the private repo before committing.

## Private repo (`run402-private/site/`)

These files live in the **private repo** at `~/Developer/run402-private/site/`. The site is deployed to <https://run402.com>. Some files are auto-pulled from this public repo at deploy time.

| Status | File | Audience | What's there | Update when… |
|:------:|------|----------|--------------|--------------|
| 🔴 | `site/llms.txt` | AI agents fetching <https://run402.com/llms.txt> | Canonical HTTP API reference. Has the expose-manifest section. **Bug:** lines ~528–530 still tell agents to use `"inherit": true` — flag was removed in v1.32 (agents following the doc verbatim fail). **Missing:** AssetRef pattern, `@run402/sdk` package mention, deploy-dir, plan/commit transport | Fix the inherit bug; add AssetRef + SDK + deploy-dir + plan/commit sections; align with current public docs |
| 🔴 | `site/llms-cli.txt` | (deploy-pulled copy of public `cli/llms-cli.txt`) | Currently 200+ lines behind the public source. **Bug:** line ~377 also has the removed `--inherit` flag | Auto-fixes on next site deploy. To trigger: deploy the site after merging `cli/llms-cli.txt` changes |
| 🔴 | `site/llms-full.txt` | AI agents wanting deep / long-form reference | Header says "Long-Form Documentation", but body **only covers KMS contract wallets**. Misleading scope — none of v1.31–v1.46 (expose, AssetRef, deploy-dir, etc.) | Either expand to cover other deep-dive subsystems, or rename to `kms-wallets.txt` so its scope is honest |
| 🟡 | `site/SKILL.md` | (deploy-pulled copy of public `SKILL.md`) | Stale copy from before the recent MCP-rewrite | Auto-fixes on next site deploy |
| 🟡 | `site/updates.txt` | AI-readable changelog | Has 2026-04-28 (functions bundling) and 2026-04-29 (error envelopes) entries. **Missing backfill** for v1.31 expose-manifest, v1.32 plan/commit, v1.33 blob CDN, v1.34 unified deploy, v1.45 paste-and-go AssetRef, legacy storage shim sunset | Backfill the missing v1.31–v1.45 entries; new entries on every user-visible feature ship |
| 🟡 | `site/humans/changelog.md` | Human-readable changelog (rendered to `/humans/changelog.html`) | Mirrors `updates.txt` — same gaps | Backfill in lockstep with `updates.txt` |
| ⚪ | `site/index.md`, `site/humans/*.md`, `site/use-cases/*` | Marketing / legal / product pages | Pricing, terms, privacy, vision, FAQ, use-case landings — not audited in this pass | Pricing or legal changes; new positioning; new use case |
| ⚪ | `site/agent-allowance/`, `site/billing/`, `site/apps/`, etc. | Topic-specific docs pages | Per-topic explainer + agent flow — not audited in this pass | Topic-specific feature changes |

## Common change → docs to update

When you… | Update at minimum…
---|---
**Add or remove an MCP tool** | `src/index.ts` (registration), `sync.test.ts` (`SURFACE` + `SDK_BY_CAPABILITY`), [README.md](README.md) (tools table), [SKILL.md](SKILL.md) (tools by category), `cli/llms-cli.txt` if there's a sibling CLI subcommand
**Add or remove a CLI subcommand** | `cli/lib/<group>.mjs` (impl), `sync.test.ts` (`SURFACE`), [cli/llms-cli.txt](cli/llms-cli.txt) (canonical reference), [openclaw/SKILL.md](openclaw/SKILL.md) (CLI verbs), [cli/README.md](cli/README.md) only if it's a new top-level group, mirror sibling MCP tool docs
**Add an SDK namespace** | `sdk/src/namespaces/<name>.ts`, [sdk/README.md](sdk/README.md) (namespace list), [AGENTS.md](AGENTS.md) (architecture diagram namespace count), [README.md](README.md) (namespace count), `sync.test.ts` (`SDK_BY_CAPABILITY`)
**Change `@run402/functions` surface** | `functions/src/`, `functions/README.md` (when it exists), [AGENTS.md](AGENTS.md) (Functions library section), [SKILL.md](SKILL.md) and [openclaw/SKILL.md](openclaw/SKILL.md) (in-function helpers section)
**Rename / remove a tool, command, or flag** | All of the above + verify [SKILL.test.ts](SKILL.test.ts) banned-pattern list catches it; consider an `updates.txt` entry if user-visible
**Change a pattern** (auth-as-SDLC, paste-and-go AssetRef, deploy-dir plan/commit, db(req) vs adminDb()) | [README.md](README.md) patterns section, both `SKILL.md` files, [cli/llms-cli.txt](cli/llms-cli.txt), private `site/llms.txt`, private `site/llms-full.txt` if it's a deep dive
**Change an HTTP endpoint** | Private `site/llms.txt` (canonical HTTP reference), `site/openapi.json` if applicable
**Ship a user-visible feature** | Private `site/updates.txt` AND `site/humans/changelog.md` (keep them in sync; new entry at the top)
**Change pricing or limits** | [README.md](README.md), [SKILL.md](SKILL.md), [cli/llms-cli.txt](cli/llms-cli.txt), [openclaw/SKILL.md](openclaw/SKILL.md), private `site/llms.txt`, private `site/humans/*.md` (especially `terms.md` and any pricing pages)
**Change architecture (kernel, error hierarchy, build flow)** | [AGENTS.md](AGENTS.md) is the canonical place; reflect any user-visible consequences in the relevant skill / reference

## Notes on canonicality

- **`cli/llms-cli.txt`** is canonical for the CLI; the private site's copy is auto-pulled at deploy time. Edit the public one only.
- **`SKILL.md`** is canonical for the MCP-host skill body; the private site's copy is auto-pulled at deploy time. Edit the public one only.
- **`site/llms.txt`** is canonical for the HTTP API reference; **edit it directly in the private repo.**
- **`site/updates.txt`** + `humans/changelog.md` are canonical for the changelog; both live in the private repo.
- **`AGENTS.md`** is canonical for repo architecture; `CLAUDE.md` just imports it.
