## Context

Today the run402 family ships four user-visible packages:

```
run402-mcp        @ 1.45.0   (npm, MCP stdio server)            — public repo
run402            @ 1.45.0   (npm, CLI)                         — public repo
@run402/sdk       @ 1.45.0   (npm, typed TS client)             — public repo
run402-functions  @ 1.1.0    (npm, in-function helpers)         — PRIVATE repo
```

The asymmetry is historical. `run402-functions` was extracted from a heredoc inside `build-layer.sh` on 2026-04-02 and parked next to its only consumer (the layer build script). It then drifted: different name shape (`run402-functions` flat vs `@run402/sdk` scoped), different release cadence, different repo.

This change closes the gap. The companion private-repo change (`drop-functions-layer-and-fix-deps`) removes the original justification for the package living next to the layer build (the layer goes away). This change moves and renames the package itself.

## Goals / Non-Goals

**Goals:**

- Move `packages/functions/` from `run402-private` to `run402-public` (at top level, sibling to `sdk/`).
- Rename `run402-functions` → `@run402/functions` on npm. No legacy alias.
- Join the lockstep release at the next version bump (likely `1.46.0`).
- Update `/publish` skill to handle four packages with optional per-package selection (default: all).
- Update agent-facing docs (`SKILL.md`, `cli/llms-cli.txt`, `CLAUDE.md`) for the new name.

**Non-Goals:**

- Removing the Lambda layer (private repo, separate change).
- Implementing actual `--deps` install (private repo, separate change).
- Adding new helpers / API to `@run402/functions` (separate change if/when needed).
- Changing the runtime behavior of the current code. The TypeScript source moves untouched.

## Decisions

### 1. Scoped name (`@run402/functions`), not flat (`run402-functions`)

**Chose:** `@run402/functions`.

**Rejected:** Keep `run402-functions`. Rename `@run402/sdk` to `run402-sdk` instead.

**Why:** A simple rule covers all four packages and resolves the inconsistency cleanly:

```
EXECUTABLES (you run them)        LIBRARIES (you import them)
──────────────────────             ──────────────────────────
run402-mcp                         @run402/sdk
run402         (CLI)               @run402/functions
```

Renaming the SDK back to flat would require unpublishing/republishing 1.45.0 and breaking external consumers who already `npm install @run402/sdk`. Renaming the functions package is the smaller, safer move — no paying users for it yet.

### 2. No legacy alias

**Chose:** Hard rename. `npm deprecate run402-functions@"*"` with a message pointing at `@run402/functions`. No npm package republished under the old name. No runtime symlink in the public package.

**Rejected:**
- Keep publishing `run402-functions` as a re-export of `@run402/functions` indefinitely (matches today's `@run402/functions` symlink in the layer, but doubles the publishing work).
- `npm deprecate` only, leaving the last version installable forever (low cost, but stale code rots over time and confuses agents reading docs).

**Why:** No paying users. The cost of breakage is low and the ongoing tax of dual maintenance is real. `npm deprecate` produces a loud install-time warning that catches anyone still using the old name. The companion private change drops the layer's runtime symlink at the same time, so there's no in-deployed-function compat path either.

The current SKILL.md line *"Both 'run402-functions' and legacy '@run402/functions' work in deployed functions"* is reversed: pre-this-change `run402-functions` is canonical and `@run402/functions` is the layer-symlink legacy name. Post-this-change `@run402/functions` is canonical and `run402-functions` is gone.

### 3. Lockstep release, but optional per-package bumping

**Chose:** Default behavior is lockstep — bump all four packages to the same version on every release. The `/publish` skill prompts: *"Bump which? [all|mcp|cli|sdk|functions|combo]"* with default `all`. The smoke-test, publish, and post-publish blocks loop over the chosen subset.

**Rejected:**
- Strict lockstep: all four always bump. Simple but forces unnecessary publishes.
- Independent versioning per package: maximally flexible but burdens users with cross-package version matrices.

**Why:** Lockstep is the right default for an integrated platform — *"run402 v1.46.0"* should mean one thing. The optional opt-out preserves the ability to ship a `@run402/functions` patch alone if the SDK and CLI haven't changed, without forcing a no-op publish on the other three.

The current skill enforces lockstep on the existing three: *"must always share the same version"*. Extending to four with the optional escape hatch is a small but real change to the skill's prompt flow.

### 4. Move sites the package at top level (`functions/`), not under `packages/`

**Chose:** `run402-public/functions/` — sibling to `sdk/`, `cli/`, `core/`.

**Rejected:**
- `run402-public/packages/functions/` — matches the private repo's layout but no one else in the public repo uses `packages/`.

**Why:** The public repo is flat (`sdk/`, `cli/`, `core/`, `openclaw/`, `src/`); adding `packages/` for one new entry doesn't fit. Top-level keeps the structure consistent.

### 5. Specs move with the code

**Chose:** Move `openspec/specs/functions-package/` and `openspec/specs/function-getuser/` from private to public, simultaneously with the code move. Update them to remove the legacy-alias scenarios and the Lambda-layer-coupled scenarios that the private companion change is about to obsolete.

**Rejected:**
- Leave specs in private. Then the public package has no spec, breaking the "every capability has a spec" invariant.
- Move specs first, then the code. Pointless ordering — they belong together.

**Why:** The spec describes the package surface. The package now lives in public. The spec follows.

### 6. Documentation cleanup at the same time, but no `--deps` claims yet

**Chose:** Update `SKILL.md`, `cli/llms-cli.txt`, and the MCP `deploy_function` tool description in this change. Drop the *"Pre-bundled packages: stripe, openai, …"* line entirely — that list was always coupled to the layer, and the layer is going away in the companion change. Replace it with: *"All deployed functions can `import { db, getUser, email, ai } from '@run402/functions'`. Other npm packages are not yet supported in deployed code; this will change in a follow-up release."*

**Rejected:**
- Document `--deps` as functional now. `--deps` is currently a no-op (stored in DB, never installed). Telling agents it works *before* the companion change ships would create a real misuse window.
- Leave the docs alone, fix in companion change. Creates a window where the public-repo docs reference the gone-but-still-present layer behavior.

**Why:** Coordinating the *rename* and the *layer-pre-bundle removal* docs together keeps them coherent. But the *`--deps` works* claim has to wait for the gateway change that makes it true — a doc-then-fix window is fine for a rename (no behavioral surprise), not fine for a behavioral promise.

### 7. Remove the legacy `db.from` / `db.sql` admin shim during the move

**Chose:** Strip `Object.assign(db, { from, sql })` from `db.ts` (currently lines ~249-258 in the private source). The clean model is `db(req).from(...)` for RLS-context queries and `adminDb().from(...)` / `adminDb().sql(...)` for BYPASSRLS — and the spec already documents this as the canonical surface.

**Rejected:**
- Keep the shim with the existing deprecation warning. Buys nothing — there are no paying users with code to break, and every release we keep it is another release where an agent might type `db.from(...)` and silently bypass RLS.

**Why:** This is a real RLS-bypass footgun. Agents who don't read the docs carefully will type `db.from(...)` (looks reasonable, similar to many ORMs), and the shim routes it through `adminDb()` — silent BYPASSRLS. The deprecation warning prints to function logs but the request still succeeds. With the rename moment, this is the right time to close the gap. After this change, `db.from(...)` (object access) errors immediately at type-check time and at runtime — exactly the loud, fast feedback we want.

### 8. Fix `auth.ts` to use static `import jwt from "jsonwebtoken"`

**Chose:** Replace `const _require = createRequire(import.meta.url); const _jwt = _require("jsonwebtoken")` with `import jwt from "jsonwebtoken"`.

**Why:** The companion private change esbuild-bundles `@run402/functions` into each function zip. esbuild can't statically follow `createRequire(...)("jsonwebtoken")`, so the bundle would ship with a runtime `require("jsonwebtoken")` and no `node_modules/jsonwebtoken` in the zip — i.e., `getUser()` would fail at first call. Static import fixes this. It's a one-line source change in `auth.ts`; verify with a tarball-install smoke test that calls `getUser()`.

## Risks / Trade-offs

- **Coordination risk between the two changes** → Mitigated by ordering: this change publishes `@run402/functions@<next>` first; the private change can then `npm install` it. If the private change is delayed, the public change is harmless on its own — `@run402/functions` is just a new package on npm; the layer continues to work for existing functions. We do NOT make `--deps` claims in docs until the companion private change ships (see decision 6).

- **Breakage for early users** → Anyone with deployed functions doing `import "run402-functions"` is fine until the layer is dropped (private companion change). After that, they need to redeploy with `import "@run402/functions"`. Loud release notes + the `npm deprecate` warning at install time handle this. No paying users today.

- **`run402-functions@1.1.0` stays installable on npm forever** → That's how npm `deprecate` works; the package version is not removed, just flagged. Agents reading old docs and copy-pasting `npm install run402-functions` will hit the deprecation warning. Acceptable.

- **`/publish` skill complexity creep** → Adding a per-package selection prompt expands the skill body by ~10 lines. Worth it. Reverting later is trivial.

- **OpenSpec spec duplication during the cutover** → For a brief window the same `functions-package` and `function-getuser` specs exist in both repos. The PR that moves them in public should be merged in lockstep with a PR in private that deletes them. Document this in the tasks list.

## Migration Plan

1. **Land in public repo (this change)**:
   1. Copy `run402-private/packages/functions/{src,package.json,tsconfig.json}` → `run402-public/functions/`. After copy, **review tsconfig.json** and rewrite any private-repo-relative `extends`/`paths`/`include`/`outDir` references to public-repo paths.
   2. Edit `functions/package.json`: rename to `@run402/functions`, set `"version"` to whatever the next lockstep release will pick (do NOT hardcode `1.46.0` in the spec — the value is determined at `/publish` time and must match the other three packages exactly), keep all other fields. Add `"publishConfig": { "access": "public" }` so the first scoped publish doesn't fail or default to restricted.
   3. **Source edits during the move** (not just a verbatim copy):
      - Remove the legacy `Object.assign(db, { from, sql })` admin shim from `db.ts`.
      - Replace `createRequire("jsonwebtoken")` in `auth.ts` with a static `import jwt from "jsonwebtoken"`.
   4. Add `"functions"` to root `package.json` workspaces.
   5. Add `build:functions` script: `tsc -p functions/tsconfig.json`. Wire into top-level `build`.
   6. **Add `runtime_version?: string | null` and `deps_resolved?: Record<string, string> | null` to `FunctionRecord`** (in `src/tools/list-functions.ts`, `get-function.ts`, the SDK's `functions.types.ts`, and the CLI's JSON output). Both fields stay null in this change; the companion change populates them. Forward-compatible from day one.
   7. Move the two specs from private `openspec/specs/` → public `openspec/specs/`. Update import paths to `@run402/functions`. Strip layer-symlink and legacy-alias scenarios. Add `QueryBuilder` to the public exports list (the source has always exported it; the original spec omitted it).
   8. Update `/publish` skill: add per-package selection prompt, extend smoke-test/publish loops to four packages. Smoke test must include a `getUser()` call from the installed tarball to catch jsonwebtoken bundling regressions.
   9. Update `SKILL.md`, `cli/llms-cli.txt`, MCP `deploy_function` tool description. Use the conservative wording from decision 6 (don't claim `--deps` works yet).
   10. Update `CLAUDE.md` architecture section.
   11. Run `npm test` (sync.test.ts has no functions-coupled assertions, should still pass).
   12. Open PR. Merge.
2. **Cut a release** via `/publish` (with `all` selected). This publishes `@run402/functions@<next>` along with the other three at the same version. The exact version is computed by the publish skill from the current root version + the chosen bump (patch/minor/major); do not bake a literal version into the spec.
3. **Run `npm deprecate run402-functions@"*" "renamed to @run402/functions; install @run402/functions instead"`** *after* the new publish completes (no race window where neither name resolves).
4. **Update private repo (cleanup PR)**: delete `packages/functions/` (now redundant), drop the workspace entry, delete the now-orphaned spec files. This is a private-repo PR but is purely a deletion — no functional change. Coordinate with the companion `drop-functions-layer-and-fix-deps` change so the deletes don't leave the gateway uncompilable.
5. **Rollback plan**: revert the public-repo PR; the published npm package stays (npm doesn't support unpublish after 72h). If a critical bug ships, publish a `@run402/functions@1.46.1` patch from `main` per the standard `/publish` flow.

## Open Questions

- **Workspace dependency or registry dependency in the gateway?** When the private companion change adds `@run402/functions` to `gateway/package.json`, should it be `"@run402/functions": "workspace:*"` (only works while the package is in the same monorepo) or `"@run402/functions": "^1.46.0"` (resolves from npm)? Once this change lands and the package moves out of `run402-private`'s workspaces, the answer is forced: it must be a registry dependency. The companion change's design needs to assume that.
- **`/publish` per-package prompt UX**: should it accept comma-separated lists (`mcp,sdk`)? Probably yes — same shape as how `npm publish` consumers think. Detail can land in the skill update.
- **Type bump policy when only one package changed**: if you select `functions` only and bump it to `1.47.0`, the others stay at `1.46.0`. The lockstep semantic *"v1.47.0 means all four"* is broken from then on. Acceptable as long as users understand "lockstep is the default, divergence is opt-in." Document this in the skill output.
