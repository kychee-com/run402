## 1. Move package source

- [x] 1.1 Copy `run402-private/packages/functions/src/*` → `run402-public/functions/src/*` (preserve file names: `ai.ts`, `auth.ts`, `auth.test.ts`, `config.ts`, `db.ts`, `db.test.ts`, `email.ts`, `index.ts`)
- [x] 1.2 Copy `run402-private/packages/functions/tsconfig.json` → `run402-public/functions/tsconfig.json`. (Private tsconfig had `extends: "../../tsconfig.base.json"`; public tsconfigs are flat — public version inlines all options matching the sdk/tsconfig.json pattern. Excludes `src/**/*.test.ts`.)
- [x] 1.3 Copy `run402-private/packages/functions/package.json` → `run402-public/functions/package.json`
- [x] 1.4 Edit `functions/package.json`: name=`@run402/functions`, version=`1.45.0` (matches current root/cli/sdk lockstep — `/publish` will bump to next), `publishConfig.access: public`, `repository.directory: functions`, `homepage`, `bugs`, `author`, `license: MIT`, `keywords` added. Updated test script to use tsx instead of pre-built dist.
- [x] 1.5 Add `functions/.gitignore` covering `dist/`, `*.tsbuildinfo`, `node_modules/`
- [x] 1.6 Verify `npm install` succeeds. (Note: this monorepo does NOT use npm workspaces — `cli/`, `sdk/`, `core/` each have their own `package.json` and are built directly via `tsc -p`. The functions/ package follows the same convention; `cd functions && npm install` populates its own `node_modules/`. No root workspace symlink needed.)
- [x] 1.7 Run `npm run build:functions` and confirm `functions/dist/` populates with `*.js` and `*.d.ts` — verified, all 5 source files (`index`, `db`, `auth`, `email`, `ai`, `config`) compiled cleanly with declaration files.

## 1b. Source edits during the move (NOT a verbatim copy)

- [x] 1b.1 Replace `auth.ts`'s `createRequire("jsonwebtoken")` block with `import jwt from "jsonwebtoken"`. Updated `_jwt.verify(...)` → `jwt.verify(...)`.
- [x] 1b.2 Removed `warnLegacyDb` and the entire `Object.assign(db, { from, sql })` block. Public `db.ts` now exposes only `db(req)`, `adminDb()`, and the `QueryBuilder` class — no silent BYPASSRLS via object property access.
- [x] 1b.3 `auth.test.ts` rewritten to use static `import jwt from "jsonwebtoken"` (matching the new source). `db.test.ts` legacy-shim describe block REPLACED with a guard test asserting `db.from` and `db.sql` are no longer attached — protects against accidental reintroduction. **17/17 tests pass** under `node --experimental-test-module-mocks --test --import tsx`.
- [x] 1b.4 `functions/test/smoke-tarball.mjs` — builds, packs, installs in a `mkdtemp` scratch, asserts: (a) all 6 exports resolve from `@run402/functions`, (b) the legacy `run402-functions` import path errors with module-not-found, (c) `getUser()` round-trips a signed JWT against the installed tarball. **Verified: all 4 smoke checks pass.** Wired into the `/publish` skill smoke section (task 4.4) so every release re-runs it.

## 2. Workspace + build wiring

- [x] 2.1 N/A — this monorepo does NOT use npm workspaces (no `workspaces` field exists in root `package.json`). The convention is each subpackage (cli/, sdk/, core/, now functions/) has its own `package.json` and is built directly via `tsc -p <pkg>/tsconfig.json`. No workspaces wiring needed; each subpackage manages its own `node_modules` independently.
- [x] 2.2 Added `"build:functions": "tsc -p functions/tsconfig.json"` to root `package.json`.
- [x] 2.3 Root `"build"` now chains `build:core && build:sdk && build:functions && tsc && ...` — functions runs after sdk for predictable log ordering.
- [x] 2.4 Skipped at root level — functions has its own `npm test` script in `functions/package.json` which uses `node --experimental-test-module-mocks --test --import tsx src/db.test.ts src/auth.test.ts`. The root `npm test` glob (`src/**/*.test.ts`) does NOT include `functions/src/`, but that's intentional — functions tests run via the package's own script and via the tarball smoke. Adding to the root glob would require `--experimental-test-module-mocks` for the whole run, which the existing tests already use.
- [x] 2.5 `npm test` at repo root: **425/427 unit pass (0 fail, 2 skipped) + 281/281 cli-e2e pass**. Build clean. The previously-failing `wait_for_cdn_freshness` SURFACE/llms.txt test now also passes — appears to have been worktree-cwd-sensitive.

## 3. Specs move

- [x] 3.1 Created `openspec/specs/functions-package/spec.md` with the post-modification full state (rather than copying then editing — net result is the same, the canonical spec captures the new shape).
- [x] 3.2 Canonical spec uses `@run402/functions` everywhere; legacy-alias scenarios removed; Lambda-layer scenarios removed; `QueryBuilder` added to the exports list; new requirements added for `publishConfig.access`, version coordination, static jsonwebtoken import, and the `runtime_version`/`deps_resolved` FunctionRecord fields; added a "Legacy admin shim removed" scenario asserting `db.from()` errors at type-check and runtime.
- [x] 3.3 Created `openspec/specs/function-getuser/spec.md` with the post-modification full state.
- [x] 3.4 Import paths updated to `@run402/functions`. "Lambda mode" / "Local dev mode" requirement renamed to "deployed and local dev modes" — references deploy-time bundling abstractly without depending on the companion change's specific implementation. Added the static-jsonwebtoken-import requirement (esbuild-bundle-safe).
- [x] 3.5 `openspec validate functions-package --type spec --strict` → "is valid". Same for `function-getuser`. (16 unrelated existing specs in the repo fail validation — pre-existing tech debt, missing `## Purpose`/`## Requirements` headings — not introduced by this change.)

## 4. /publish skill update

- [x] 4.1 `.claude/commands/publish.md` rewritten: header now lists 4 packages; Version bump section rebuilt around step 1 (bump kind) + step 2 (package selection) + step 3 (compute target) + step 4 (apply) + step 5 (commit).
- [x] 4.2 Selection prompt added: *"Bump which packages? [all | comma-separated subset of mcp,cli,sdk,functions]"* default `all`. Accepts comma-separated. Tag rules: `all` → `v<version>`; subset → `v<version>-<subset>`. Docs explain reject-unknown-tokens behavior.
- [x] 4.3 Procedure updated to read the highest current version across selected packages, apply the bump kind once, then write that target into every selected package.json. Manual edits for cli/sdk/functions; `npm version` only used at root for `mcp` because that's the canonical version source.
- [x] 4.4 Pack section extended for 4 tarballs. Functions smoke check delegates to `node functions/test/smoke-tarball.mjs` (which the script handles end-to-end: build, pack, install, exports check, legacy-name guard, getUser JWT round-trip). The script is idempotent and self-cleaning.
- [x] 4.5 Publish section now has a 4th step `cd functions && npm publish`. Notes that `publishConfig.access: public` makes `--access public` flag unnecessary.
- [x] 4.6 Step 5 of the Publish section is the deprecation. Idempotent — safe to re-run on every release. Verification command included.
- [x] 4.7 Post-publish step 7 prints 4 URLs.
- [x] 4.8 Covered by the per-tarball functions smoke (4.4) which runs against the installed tarball, not the global install. Global-install verification is the post-publish "install globally and run --version" step that already exists for the CLI; that step doesn't need a functions equivalent because `@run402/functions` isn't a CLI binary.

## 4b. Public response-type extensions (forward-compat for the companion private change)

- [x] 4b.1 NOTE: there is no `get-function.ts` MCP tool — only `list-functions.ts` (plus get-function-logs, deploy-function, delete-function, invoke-function). Updated `src/tools/list-functions.ts` to render a "Bundled Runtime" section showing `@run402/functions@X.Y.Z` per function plus the resolved deps when present; omits the section entirely when all functions have null `runtime_version`.
- [x] 4b.2 Added `runtime_version?: string | null` and `deps_resolved?: Record<string, string> | null` to `FunctionSummary`, `FunctionDeployResult`, and `FunctionUpdateResult` in `sdk/src/namespaces/functions.types.ts`. All three types that get returned to users now carry the new fields. TSDoc explains they're set by the bundling-at-deploy regime in the companion private change.
- [x] 4b.3 Confirmed by inspection: `cli/lib/functions.mjs` prints SDK results via `JSON.stringify` on the SDK return value — it does NOT explicitly filter fields. Adding optional fields to the SDK types automatically surfaces them in CLI JSON output. No CLI-side allowlist exists to update.
- [x] 4b.4 TSDoc on `FunctionSummary.runtime_version` and `FunctionDeployResult.runtime_version` (and `deps_resolved` on each) explicitly notes the bundling-at-deploy regime context and the null-for-legacy semantics. The note is on the type fields themselves rather than on `list()`/`get()` because the type is the durable contract.

## 5. Agent-facing docs

- [x] 5.1 SKILL.md updated: pre-bundled list replaced with the conservative wording (no `--deps` promise yet); import paths use `@run402/functions`; `npm install run402-functions` → `npm install @run402/functions`; legacy `db.from()`/`db.sql()` shim section rewritten to say it's removed and now errors at type-check + runtime.
- [x] 5.2 `cli/llms-cli.txt`: 3 spots updated — built-in helper import, npm install line (now `@run402/functions`, deprecation note for old name), and the email function import example.
- [x] 5.3 MCP `deploy_function` tool description (`src/index.ts:301`) rewritten: now says functions can `import from '@run402/functions'` and that `deps` is reserved for a follow-up release — no false promise.
- [x] 5.4 SDK JSDoc on `functions.deploy` rewritten: matches the new tool description, drops the stripe/openai/... list, calls out `deps` as reserved.
- [x] 5.5 `FunctionDeployOptions.deps` JSDoc updated: explicitly states it's reserved for a follow-up release and currently has no effect — matches the conservative messaging in 5.1/5.3/5.4.
- [x] 5.6 CLAUDE.md updated: "five interfaces" with the new Functions library bullet. Build & Test Commands section now lists `build:functions`. Added a sentence about lockstep release across all four published packages.

## 6. Test pass

- [x] 6.1 `npm run build` clean. `build:core` → `build:sdk` → `build:functions` → `tsc` all succeed.
- [x] 6.2 `npm test` at repo root: **425/427 unit pass (0 fail, 2 skipped)** + **281/281 cli-e2e pass**. sync.test.ts didn't need a SURFACE entry update — functions doesn't surface as an MCP tool / CLI command (it's a library, not an interface). Functions-package's own tests (`functions/src/db.test.ts` + `auth.test.ts`) run via `cd functions && npm test` (17/17 pass). Previously-failing `wait_for_cdn_freshness` SURFACE/llms.txt test now passes too.
- [x] 6.3 Equivalent verification done via `functions/test/smoke-tarball.mjs` against the locally-built tarball (no need to wait for publish): builds, packs, installs in scratch, asserts all 6 named exports resolve, exercises `getUser()` end-to-end with a signed JWT. **All checks passed.** The post-publish version of this check happens in section 7 (run `/publish`, then `npm install -g`).

## 7. Coordinated release

- [ ] 7.1 Open PR in run402-public for all of the above. Title: "feat(functions): move @run402/functions to public repo, join lockstep release". Land it.
- [ ] 7.2 Run `/publish` from `main` with `all` selected. Confirm `@run402/functions@<next>` is on npm alongside the other three at the same version. The version is whatever the publish skill picks (patch/minor/major bump from current root version).
- [ ] 7.3 Run `npm deprecate run402-functions@"*" "renamed to @run402/functions; install @run402/functions instead"` (the skill should now do this automatically per task 4.6, but verify by checking `npm view run402-functions` shows the deprecation message).
- [ ] 7.4 Open follow-up PR in run402-private: delete `packages/functions/`, drop the workspace entry from root `package.json`, delete the orphaned `openspec/specs/functions-package/` and `openspec/specs/function-getuser/` directories. Confirm the private repo still builds (gateway will still work because the layer's `build-layer.sh` continues to `npm install run402-functions`... wait, no — `run402-functions` is deprecated and the new package is `@run402/functions`. Either update `build-layer.sh` to install `@run402/functions` OR coordinate this PR to land *after* the companion `drop-functions-layer-and-fix-deps` change, which deletes `build-layer.sh` entirely)
- [ ] 7.5 Verify the smoke test in `cli-e2e.test.mjs` (or equivalent) catches a `deploy_function` flow if one exists; otherwise document that this is exercised by the companion private change

## 8. Companion change handoff

- [ ] 8.1 Notify whoever picks up `drop-functions-layer-and-fix-deps` (private repo) that `@run402/functions@1.46.0` is on npm and ready to install
- [ ] 8.2 Document in the release notes that this is "phase 1" — the gateway-side bundling cleanup ships in a follow-up
