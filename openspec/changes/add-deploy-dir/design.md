## Context

The SDK's `sites.deploy(project, files, opts)` takes a pre-built `SiteFile[]` array — each entry is `{ file, data, encoding? }` where `data` is either UTF-8 text or a base64-encoded byte string. Every caller that starts from a directory on disk (MCP agents, CLI users, scripts, the OpenClaw skill) reimplements the same dir walk + binary detection + base64 encoding, often poorly (e.g. missing encoding auto-detection, mishandling nested directories, leaking absolute paths). The existing `cli/lib/deploy.mjs` has its own manifest resolver (`cli/lib/deploy.mjs:130`) that already does this work correctly; none of it is reusable from the SDK or from MCP.

This change lifts that logic into the SDK's Node entry so all three surfaces share it. It is deliberately the smallest step on the agent-DX ladder — zero server changes, zero new payload shapes, zero new endpoints. The 200 MB ceiling, CAS-style dedup, and progress events are explicitly later rungs.

## Goals / Non-Goals

**Goals:**
- Provide a single `sites.deployDir({ dir, project })` call that an agent can make with a directory path and get back a deployment URL.
- Share the dir-walk implementation between the SDK, MCP tool, and CLI subcommand. No duplication.
- Preserve the existing `sites.deploy(files)` signature exactly — sandbox callers keep working, incremental `inherit: true` still works.
- Keep the helper Node-only, out of the isomorphic entry point, so the V8-isolate isomorphism invariant is preserved.

**Non-Goals:**
- Solving the payload-size ceiling. A 200 MB directory will fail the same way it does today — the fix belongs to the later blob-backed manifest change.
- Any server-side change. The wire format, the endpoint, and the payload schema are identical to today.
- Progress events, streaming, or partial-deploy recovery. Those land after blob-backed uploads make them meaningful.
- Database migrations, seed data, or any `apps.bundleDeploy`-shaped work. This change only touches the `sites.deploy` code path.
- Glob-style include/exclude filters beyond a minimal default ignore list. Complex filtering is a future enhancement.

## Decisions

### Node-only helper, augmenting the `sites` namespace

The helper is attached to the `sites` namespace in the **Node** SDK entry (`@run402/sdk/node`), not in the isomorphic SDK. Implementation: a `NodeSites` class extending the isomorphic `Sites`, wired in by the Node `Run402` factory in `sdk/src/node/index.ts`.

**Why:** `fs.readdir` / `fs.readFile` are unavailable in a V8 isolate, and the isomorphism invariant is load-bearing for future code-mode execution. Keeping the isomorphic class untouched means a sandbox caller still imports from `@run402/sdk` and gets a `Sites.deploy(files)` that works. Node callers import from `@run402/sdk/node` and transparently get the extra `deployDir` method on the same `r402.sites` handle.

**Alternatives considered:**
- **Free function export.** Rejected — breaks namespace ergonomics. Agents already learn `r402.sites.deploy()`; `r402.sites.deployDir()` is the natural sibling. A free function buried under `import { deployDir } from "@run402/sdk/node"` is harder to discover.
- **Method on the isomorphic class with a runtime guard.** Rejected — methods that throw in one environment but not another are a footgun. A sandbox agent calling `sites.deployDir()` would fail at runtime with a confusing error. Compile-time separation is cleaner.

### New MCP tool and CLI subcommand, not overloaded existing ones

A new MCP tool `deploy_site_dir` with schema `{ project, dir, inherit? }` and a new CLI subcommand `run402 sites deploy-dir <path>`. The existing `deploy_site` tool and `sites deploy` subcommand are untouched.

**Why:** Overloading the existing tool to accept either a `files` array or a `dir` path requires the schema to express "exactly one of two mutually exclusive fields" and forces the handler to branch on which one was passed. Separate names are clearer for agents to discover (a tool list with two distinct verbs beats one tool with a disjoint schema) and keep the MCP/CLI surfaces straightforward.

**Alternatives considered:**
- **Extend `deploy_site` with an optional `dir` parameter.** Rejected — the Zod schema gets messy, and agents reading the tool description must now parse "pass files *or* dir, not both."
- **Sniff the CLI argument.** (e.g. `run402 sites deploy ./dir` treats the arg as a manifest JSON if it ends in `.json`, otherwise a directory.) Rejected — magic behavior that surprises human users, and the CLI surface cares more about predictability than convenience.

### Binary detection by content-sniff, not file extension

`deployDir` reads each file as a `Buffer`, checks whether the bytes are valid UTF-8 (via `Buffer.isEncoding` / `TextDecoder` with `fatal: true`), and chooses encoding accordingly. Text files go through as `{ encoding: "utf-8", data: <string> }`; binaries as `{ encoding: "base64", data: <b64> }`.

**Why:** Extension-based detection gets `.svg` right (text) but fails silently on extensionless files, misclassifies `.js` that happens to contain a BOM, and disagrees with what the backend actually stores. Content-sniff is the same strategy the existing `cli/lib/deploy.mjs` manifest resolver uses — we lift it into the SDK rather than reinvent.

**Alternatives considered:**
- **Extension allow-list.** Rejected — brittle, needs maintenance, disagrees with existing CLI behavior.
- **Always base64.** Rejected — blows up the payload size ~33% for text-heavy sites, making the inline ceiling hurt sooner.

### Default ignore list: `.git/`, `.DS_Store`, `node_modules/`

`deployDir` skips these three patterns by default. No configuration surface in this change — a `ignore: string[]` option can be added later if needed.

**Why:** These three cover >99% of "oh, I accidentally deployed 800 MB of `node_modules`" foot-guns without inventing a glob DSL. Agents that need different behavior can pre-stage a clean build directory; this is also what Vercel and Netlify effectively enforce via build pipelines.

**Alternatives considered:**
- **No filtering.** Rejected — the first time an agent points `deployDir` at a repo root, they'll hit the payload ceiling or blow their allowance on garbage.
- **Read `.gitignore`.** Rejected — out of scope for a baby step. Non-trivial parsing, implicit dependency on git presence, and subtle semantics (globs, negations). Defer until there's demand.

### Path normalization: POSIX forward slashes in the manifest

File paths in the `SiteFile[]` manifest use forward-slash separators regardless of host OS. On Windows, `path.relative` produces backslashes; we normalize to `/` before constructing manifest entries.

**Why:** The backend serves files by URL path, which uses `/`. A Windows agent deploying `assets\logo.png` would produce an un-servable entry otherwise.

### Failure modes

- **Missing or unreadable directory** → throw `Run402Error` with a clear message. MCP translates via `mapSdkError` to its error shape; CLI's `reportSdkError` writes the JSON envelope and exits 1. No `process.exit` inside the SDK.
- **Empty directory** → throw `Run402Error` with "directory contains no deployable files." A zero-file deploy is almost always a mistake and the server rejects it anyway; we surface the error earlier with better context.
- **Individual file read error mid-walk** (permissions, race) → throw `Run402Error` with the offending path, no partial deploy.
- **Payload exceeds server limit** → existing behavior unchanged. The error surfaces from the underlying `sites.deploy` call as today; this change adds no new size-related handling.

## Risks / Trade-offs

- **Risk**: An agent points `deployDir` at a directory larger than the inline ceiling and gets a confusing "payload too large" error from the server rather than an early client-side check.
  **Mitigation**: Document the current ceiling in the MCP tool description and the CLI `--help` text. The proper fix is step 2 on the ladder (blob-backed manifest), which this change explicitly defers.

- **Risk**: Binary detection misclassifies a valid-UTF-8 binary (e.g., a short file that happens to parse as UTF-8) as text. Harmless — the server stores the exact bytes — but the manifest grows slightly and the file decodes as text on download.
  **Mitigation**: Content-sniff with `TextDecoder({ fatal: true })` rejects invalid UTF-8 sequences; for valid-UTF-8-but-actually-binary edge cases (extremely rare), the behavior is still correct, just mildly wasteful. Not worth a heavier heuristic.

- **Risk**: Large manifests read the full directory into memory before POSTing. A directory near the ceiling (~100 MB) briefly uses ~150 MB of RAM (bytes + base64 overhead).
  **Mitigation**: Acceptable for the current inline-ceiling regime. Streaming / chunked upload comes for free once step 2 lands (blob multipart already streams).

- **Trade-off**: Two ways to do the same thing in the CLI (`sites deploy --manifest site.json` vs `sites deploy-dir ./site`). Potential confusion for humans, non-issue for agents.
  **Mitigation**: The existing `sites deploy` stays the canonical "I already have a manifest" path; `deploy-dir` is the "I have a directory" path. Clear names, no overlap in when to use each.

## Migration Plan

No migration required. The change is purely additive:

- Existing `sites.deploy(files)` calls continue to work unchanged.
- Existing `deploy_site` MCP tool continues to work unchanged.
- Existing `run402 sites deploy --manifest <path>` CLI command continues to work unchanged.
- No server changes, no wire-format changes, no breaking behavior.

Rollback: revert the change — nothing else to undo.

## Open Questions

- **Should the MCP tool description explicitly state the ~100 MB ceiling?** Leaning yes. An agent reading the tool description should know the limit before trying to deploy a 200 MB dir. Concrete number TBD by measuring the current server behavior.
- **Should symlinks be followed or rejected?** Default to *rejecting* (throw with the symlinked path) to match security-conscious defaults and avoid infinite-loop cycles. Revisit if users ask for follow-semantics.
- **Should the SDK return the list of files included in the manifest for observability?** Not in this change — the return shape matches `sites.deploy` exactly (just `{ deployment_id, url }`). A future progress-events change will cover this.
