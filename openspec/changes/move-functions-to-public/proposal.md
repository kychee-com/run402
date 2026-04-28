## Why

The `run402-functions` npm package — the in-function helper library users import inside deployed serverless functions — currently lives in the private gateway repo (`run402-private/packages/functions/`). It is the only run402 library *not* in this repo: the SDK, MCP server, CLI, and OpenClaw skill all live here. The asymmetry is purely historical (the package was extracted from a layer-build heredoc on 2026-04-02 and stayed where the layer-build script was).

Three things motivate moving it now:

1. **Open source consistency.** Every library users `import` from us should be in the public, open-source repo. Today `@run402/sdk` is open and `run402-functions` is closed — same audience, opposite policies.
2. **Coordinated releases.** The `/publish` skill cuts `run402-mcp`, `run402` (CLI), and `@run402/sdk` together at a shared version (currently `1.45.0`). `run402-functions` is independently versioned at `1.1.0`, drifting. Joining the lockstep release means one release event ships all four packages at one version, simpler for users and agents to reason about.
3. **Naming consistency.** The other library in this family is `@run402/sdk` (scoped). The functions package was originally `@run402/functions` (per the design doc), got renamed to `run402-functions` during extraction without rationale, and the rename is not reflected anywhere except `package.json`. We're reverting to the consistent shape: scoped names for libraries, flat names for executables.

There are no paying users yet. Renaming with no alias is acceptable now and gets dramatically more expensive every week we wait.

## What Changes

- Move `run402-private/packages/functions/` → `run402-public/functions/` (top-level, sibling to `sdk/`, `cli/`).
- Add `functions/` to the root `package.json` workspaces array. Add a `build:functions` script and wire it into `npm run build`.
- **Rename the npm package: `run402-functions` → `@run402/functions`.** No legacy alias. Old name gets `npm deprecate run402-functions@"*" "renamed to @run402/functions"` after the new package publishes.
- Bump `@run402/functions` to the next lockstep version (the version chosen at the next `/publish` run — likely `1.46.0`).
- Update the `/publish` skill to publish four packages instead of three. Default behavior stays lockstep; new optional prompt asks which packages to bump (default: all four). Smoke-test block extends to a fourth tarball.
- Update agent-facing docs (`SKILL.md`, `cli/llms-cli.txt`) to use `@run402/functions` consistently. Drop the misleading "Pre-bundled packages: stripe, openai, …" line — that list was shipped with the layer that's about to go away. **Do NOT yet document `--deps` as functional** — it remains a no-op until the companion private change (`drop-functions-layer-and-fix-deps`) ships. Wording: *"All deployed functions can `import { db, getUser, email, ai } from '@run402/functions'`. Other npm packages are not yet supported in deployed code; this will change in a follow-up release."*
- **Surface `runtime_version` and `deps_resolved` in public types** so the companion change has a place to populate them. Add the optional fields to `FunctionRecord` in `src/tools/list-functions.ts`/`get-function.ts`, the SDK's `functions.types.ts`, and the CLI's JSON output. Both fields will be `null` until the companion change ships; the type is forward-compatible from day one.
- Update `CLAUDE.md` architecture section: four interfaces (SDK + MCP + CLI + OpenClaw) becomes five (add functions).
- Move the `functions-package` and `function-getuser` capability specs from `run402-private/openspec/specs/` to `run402-public/openspec/specs/`. Update them to remove legacy-alias scenarios (the `run402-functions` legacy import path).
- **Remove the legacy `db.from()` / `db.sql()` admin shim from `db.ts`** during the move. The shim silently routes to `adminDb()` (BYPASSRLS) with a deprecation warning — a real RLS-bypass footgun for agents who type `db.from(...)` instead of `db(req).from(...)`. No paying users to break; clean rename is the right time to close this.
- **Replace `auth.ts`'s `createRequire("jsonwebtoken")` with a static `import jwt from "jsonwebtoken"`.** The createRequire pattern is not statically resolvable by esbuild and would prevent the bundling step in the companion change from inlining the dep correctly.

**Not in scope** (covered by the private-repo `drop-functions-layer-and-fix-deps` change):
- Removing the Lambda layer and bundling `@run402/functions` into each function zip at deploy time.
- Implementing real `--deps` installation via esbuild bundling.
- Recording the bundled `@run402/functions` version in the function metadata.

These are deliberately split: this change publishes the package; the next change consumes it from the gateway. The two must land in this order — the gateway can't `npm install @run402/functions` until it exists.

## Capabilities

### New Capabilities

_None._ The capabilities (`functions-package`, `function-getuser`) already exist in the private repo and are simply being relocated and updated.

### Modified Capabilities

- `functions-package`: relocated to public repo. Canonical npm name changes from `run402-functions` to `@run402/functions`. Legacy-alias scenarios removed. Lambda-layer-related scenarios removed (the layer is going away in the companion private change; those scenarios become irrelevant).
- `function-getuser`: relocated to public repo. Import path updated to `@run402/functions`. Lambda/local-dev resolution scenarios simplified (the local-dev workspace link still works; the Lambda-layer install path is replaced by deploy-time bundling in the private change).

## Impact

- **Public repo (`run402-public`)**:
  - New top-level `functions/` directory with `src/`, `package.json` (`@run402/functions@1.46.0`), `tsconfig.json`, tests.
  - Root `package.json` workspaces gains `"functions"`.
  - Root build scripts gain `build:functions`.
  - `.claude/commands/publish.md` updated for 4 packages with optional lockstep.
  - `SKILL.md` updated: `@run402/functions` everywhere, "Pre-bundled packages" line removed.
  - `cli/llms-cli.txt` updated: same.
  - `CLAUDE.md` updated: architecture section adds functions.
  - `openspec/specs/functions-package/spec.md` and `openspec/specs/function-getuser/spec.md` added.

- **Private repo (`run402-private`)**:
  - `packages/functions/` deleted (moved to public).
  - `package.json` workspaces array drops `packages/functions`.
  - `packages/functions-runtime/build-layer.sh` keeps its `npm install run402-functions` line working only until the next layer rebuild (which the private companion change will eliminate). In the interim the layer continues attaching whatever it built last.
  - `openspec/specs/functions-package/` and `openspec/specs/function-getuser/` deleted (moved to public).

- **npm registry**:
  - New package: `@run402/functions@1.46.0` (or whatever lockstep version is chosen).
  - Deprecation: `run402-functions@"*"` with message pointing at `@run402/functions`. Done *after* the new publish to avoid a window where neither name resolves cleanly.

- **User-facing impact**:
  - User functions doing `import { db } from 'run402-functions'` will continue to work *until* the private companion change ships and the layer is dropped (the layer's existing symlink keeps both names alive on layer `:10`).
  - After the private companion change ships, only `import { db } from '@run402/functions'` works in newly deployed functions.
  - Existing deployed functions stay on layer `:10` (which still has both names) until they're redeployed.
  - No paying users today, so the breakage window is tolerable. Document loudly in release notes.
