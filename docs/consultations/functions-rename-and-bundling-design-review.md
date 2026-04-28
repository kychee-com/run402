# Consultation Result

**Model**: gpt-5.5-pro
**Submitted**: 2026-04-28T10:07:21.734585
**Completed**: 2026-04-28T10:33:54.136630
**Status**: completed

---

Overall direction is good: moving the importable helper package public first, then consuming it from the gateway, is the right split. But I would not implement from these specs/tasks as-is. There are several correctness/security traps that an implementer could easily miss.

## Biggest blockers / design fixes

### 1. `npm install` in the gateway is a serious RCE boundary

Installing arbitrary npm packages during deploy is the highest-risk part of this design. The current spec only says “validate names, no shell metachars/path traversal,” which is not enough.

If lifecycle scripts run, a malicious package can execute inside the gateway and read AWS creds, DB URLs, env vars, npm tokens, filesystem, metadata service, etc.

Minimum required changes:

- Run install with lifecycle scripts disabled:

```bash
npm install --ignore-scripts --omit=dev --no-audit --no-fund
```

- Prefer writing a generated `package.json` and running `npm install` in the temp dir, rather than passing user strings as CLI args.
- Use `execFile`/spawn without shell.
- Scrub the child env. Do not pass gateway secrets, AWS creds, DB URLs, `RUN402_*`, npm tokens, etc.
- Force public npm registry only for now. No private registries, no user `.npmrc`.
- Reject non-registry specs:
  - reject `file:`
  - reject `link:`
  - reject `workspace:`
  - reject git URLs
  - reject http tarballs
  - reject npm aliases unless you explicitly want them
- Add resource limits:
  - max dependency count
  - max spec length
  - install timeout
  - max stdout/stderr
  - max temp directory size / node_modules size
  - deploy concurrency semaphore
- Longer term: run bundling in a low-privilege worker/container with no production secrets. Pre-launch is not a reason to let package install scripts run in the API process.

Use `npm-package-arg` or equivalent. “No shell metacharacters” is the wrong abstraction.

---

### 2. Do **not** put the gateway’s whole `node_modules` on esbuild’s `nodePaths`

The implementation sketch says:

```ts
nodePaths: [
  "/tmp/deploy-.../node_modules",
  "gateway's own node_modules",
]
```

This is a big architectural bug.

It means user functions can statically import any dependency installed by the gateway, whether or not they listed it in `--deps`. That reintroduces the undocumented “prebundled package” problem under a different name. It could also accidentally make `@run402/sdk` work inside functions, contradicting the explicit decision not to support that yet.

Better shape:

- Create a per-deploy temp project.
- Install only user-declared deps there.
- Materialize only `@run402/functions` into that temp project.
  - Either install exact `@run402/functions` into temp.
  - Or symlink/copy only `@run402/functions` into temp.
- Run esbuild with resolution rooted in the temp project.
- Do **not** expose gateway-level `node_modules` wholesale.

Also reserve these dependency names:

- Reject `@run402/functions` in `--deps`; it is platform-provided.
- Strongly consider rejecting `run402-functions` in `--deps`; otherwise users can explicitly install the deprecated package and the “no legacy import path” story becomes muddy.

---

### 3. `auth.ts` is probably not bundle-safe as written

This pattern is a likely esbuild failure:

```ts
const _require = createRequire(import.meta.url);
const _jwt = _require("jsonwebtoken");
```

Esbuild usually does not statically bundle packages loaded through a `createRequire()` alias. The bundled Lambda may contain a runtime `require("jsonwebtoken")`, but there will be no `node_modules/jsonwebtoken` in the zip.

Change `@run402/functions` to use a static import for `jsonwebtoken`, for example:

```ts
import jwt from "jsonwebtoken";
```

Then add a real bundling smoke test that imports `getUser()` from `@run402/functions`, signs/verifies a token, and runs from the produced bundle with no `node_modules`.

This is a release blocker for Change 2.

---

### 4. AWS Lambda layer removal semantics are wrong/underspecified

For existing Lambdas, omitting `Layers` from `UpdateFunctionConfigurationCommand` does **not** remove existing layers. It preserves them.

So this spec text is misleading:

> updates existing via `UpdateFunctionConfigurationCommand` without `Layers`

Correct behavior:

- On `CreateFunctionCommand`: omit `Layers`.
- On redeploy/update of function code: send `Layers: []` to clear old layers.
- On config-only updates of legacy functions: do **not** send `Layers: []`, unless code was rebuilt/bundled too.

Also order matters. For an existing legacy function:

1. Bundle new code.
2. `UpdateFunctionCode`.
3. Wait for update.
4. `UpdateFunctionConfiguration` with `Layers: []`.

Do not clear the layer before code update succeeds, or a failed redeploy can break the currently working legacy function.

---

### 5. `deps_resolved` is not specified accurately

Current task says:

> pinned → verbatim

But `deps_resolved` must record the actual installed version, not the requested spec.

Examples:

- `lodash@4.17.21` → resolved `4.17.21`
- `date-fns@^3.0.0` → resolved maybe `3.6.0`
- `openai@latest` → resolved exact version at deploy time

So split the model clearly:

- existing `deps TEXT[]` = requested direct dependency specs
- new `deps_resolved JSONB` = resolved exact versions of direct dependencies

Also: `{ name: version }` is not a real lockfile. It does not capture transitive versions, integrity hashes, peer deps, or registry metadata. That is fine if intentional, but do not call it a “lock” in docs/specs. Call it “resolved direct dependency versions.”

---

### 6. Public SDK/MCP/CLI response types are missing from the plan

Change 2 says:

> `list_functions` and `get_function` return `runtime_version` and `deps_resolved`.

But those user-visible clients live in `run402-public`.

If the SDK/MCP/CLI schemas/types filter or type responses, this private-only change may not actually expose the fields. Even if raw JSON passes through, docs/types will lag.

You need one of:

- fold optional `runtime_version` / `deps_resolved` response fields into Change 1, before private rollout; or
- add a third public change; or
- explicitly verify the public SDK/CLI/MCP do not drop unknown fields.

Same issue for the 10 MB warning: the spec says the warning is “returned in response,” but there is no response schema change. Define where it goes, or remove that requirement.

---

## Sequencing / release hazards

### Public docs may lie during the gap between Change 1 and Change 2

Change 1 proposes replacing docs with:

> Other packages must be listed in `--deps`.

But until Change 2 deploys, `--deps` is still a lie.

So either:

- do not publish that docs change until after the private gateway deploy; or
- phrase it as migration/future-gated; or
- split docs cleanup into the private change’s rollout.

Import rename docs are fine in Change 1 because the current layer already has the `@run402/functions` symlink. But `--deps` semantics should not be documented as real until the gateway actually installs deps.

---

### Do not hardcode `1.46.0`

Several tasks bake in `1.46.0`. That will go stale or produce weird behavior if the next release is patch/major.

Use “the next selected publish version” everywhere.

For the first public move, be careful with the initial `functions/package.json` version. If the publish skill increments package versions independently, it could bump `@run402/functions` from `1.46.0` to `1.47.0` accidentally.

Safer release rule:

- Compute one target version for an all-package lockstep release.
- Set every selected package to that exact target.
- Do not semver-increment `functions` relative to its old private `1.1.0`.

---

### Scoped npm package needs public access config

For first publish of `@run402/functions`, `npm publish` may fail or try restricted access unless you use:

```bash
npm publish --access public
```

Better: add this to `functions/package.json`:

```json
"publishConfig": {
  "access": "public"
}
```

Still keep the publish command explicit if possible.

---

### `/publish` subset mode is underdesigned

The prompt:

> `Bump which? [all|mcp|cli|sdk|functions|combo]`

is too vague.

Problems to define:

- What does `combo` mean?
- Are comma-separated package IDs accepted?
- If package versions have diverged, how is the next “patch/minor/major” target computed?
- If only `sdk` is bumped, do MCP/CLI dependency ranges change?
- If only `cli` is bumped but it depends on `@run402/sdk`, what version range should be published?
- What git tag is created for subset releases?
  - `v1.46.0` only makes sense for lockstep releases.
  - subset releases need package-specific tags or no global tag.

Given lockstep is the default, subset support can be minimal, but it must be deterministic.

---

## Change 1 review: move package public

### `tsconfig.json untouched` is risky

The task says copy `tsconfig.json` untouched. That may be wrong if it has private-repo-relative `extends`, paths, includes, or output assumptions.

Task should be:

> copy tsconfig, then adjust path references for the public repo layout.

---

### Spec omits `QueryBuilder`

The moved source exports:

```ts
export { db, adminDb, QueryBuilder } from "./db.js";
```

But the new spec requirement lists only:

```md
db, adminDb, getUser, email, ai
```

Either include `QueryBuilder` in the public API requirement or stop exporting it. The reference table says six exports, including `QueryBuilder`, so the spec should include it.

---

### Reconsider the legacy `db.from` admin shim

The source still has:

```ts
Object.assign(db, { from: ..., sql: ... });
```

That means `db.from(...)` silently uses admin/bypass-RLS behavior.

Since you are already doing a hard rename with no alias and have no paying users, this is the best time to remove that legacy shim. Keeping it creates a security/UX footgun: agents may call `db.from` instead of `db(req).from` and accidentally bypass RLS.

If you keep it, the spec must explicitly say it exists and document the security implications. Right now the spec implies the clean model:

- `db(req)` = caller/RLS
- `adminDb()` = privileged/admin

The code does not fully match that model.

---

### Add package publish metadata/smoke tests

Add/verify:

- `publishConfig.access = "public"`
- `repository`
- `license`
- `README` or package docs
- `scripts.build`
- maybe `prepack`

Tarball smoke should test the actual installed package:

```bash
node --input-type=module -e "
  import { db, adminDb, getUser, email, ai, QueryBuilder } from '@run402/functions';
  console.log(typeof db, typeof getUser, typeof QueryBuilder);
"
```

Also smoke `getUser()` specifically so `jsonwebtoken` packaging problems are caught.

---

## Change 2 review: bundling/deps/layer removal

### Prefer generated wrapper as esbuild entrypoint

The current sketch says:

> transpile user code → esbuild bundle → buildShimCode

That can work, but it preserves too much of the old cold-start `/tmp` model.

Cleaner:

1. Write user source to temp, e.g. `user.ts`.
2. Write generated wrapper entrypoint, e.g. `entry.ts`, that imports user default export and exports Lambda `handler`.
3. Run esbuild on `entry.ts`.
4. Zip one `index.mjs`.

This removes cold-start `writeFileSync`, catches imports at deploy time, and makes bundle sizing simpler.

---

### Static imports are supported; dynamic imports are best-effort

With bundling, static imports fail fast at deploy time:

```ts
import OpenAI from "openai";
```

without `--deps openai` should fail during deploy.

But dynamic imports may not:

```ts
await import(pkgName);
```

Those can still become runtime failures. Docs/spec should say static imports and esbuild-bundleable packages are supported; arbitrary dynamic module loading is not guaranteed.

---

### Native-module requirement is too optimistic

Spec says native modules fail at bundle time. Some will, but not all. Some fail only at runtime due to dynamic requires, `.node` loading, WASM/assets, or postinstall-generated files.

Better requirement:

> Native binaries and packages requiring install scripts, runtime assets, or non-bundleable dynamic requires are unsupported. Deploy rejects when detected; otherwise runtime failure is possible and surfaced in logs.

Also add detection:

- fail if esbuild metafile/output references `.node`
- fail unresolved dynamic native loads where possible
- test with `sharp`, `canvas`, native `bcrypt`

---

### Size warning response is undefined

Task says:

> 10 MB warning returned in response

But `deployFunction` returns `FunctionRecord`.

Decide one:

- add `warnings?: string[]` to deploy response wrapper;
- add `bundle_size_bytes` / `warnings` fields;
- log only;
- remove warning requirement.

Do not leave it implicit.

---

### Existing layer behavior needs louder docs

The docs should say all of this explicitly:

- Legacy functions have `runtime_version = null`.
- Legacy functions have `deps_resolved = null`.
- Existing `deps` values on legacy functions were not actually installed.
- Existing functions may still import packages from `run402-functions-runtime:10`.
- Redeploy switches to bundling.
- Old imports may fail:
  - `run402-functions` → change to `@run402/functions`
  - `openai`/`stripe`/etc. → add `--deps`
- The AWS layer version `:10` must not be deleted until no legacy Lambdas reference it.

---

## Naming / UX concerns

### `runtime_version` is ambiguous

If the column name is still changeable, `functions_runtime_version` or `run402_functions_version` would be clearer.

If `runtime_version` is locked, every UI/API doc should label it as:

> bundled `@run402/functions` version

Do not display it as just “runtime,” because users will reasonably assume it means `nodejs22.x`.

---

### `deps_resolved` is a direct-deps map, not a full manifest

The proposal says this solves the machine-readable manifest gap. It partially does, but only for direct user deps plus the helper runtime version.

It does not expose transitive deps. That is acceptable, but phrase it accurately.

---

## Test gaps I would add

Minimum tests before rollout:

### Public repo

- Tarball install/import test for `@run402/functions`.
- `getUser()` test from installed tarball, not workspace source.
- Verify `run402-functions` import fails in a clean project.
- Verify exported names include `QueryBuilder` if it remains public.
- Publish dry-run/pack test for scoped package with public access.

### Private repo

- Real esbuild bundle test importing `@run402/functions`.
- Real bundle test calling `getUser()` to catch the `createRequire/jsonwebtoken` issue.
- Scoped package dep parser tests:
  - `@anthropic-ai/sdk`
  - `@anthropic-ai/sdk@1.2.3`
- Reject tests:
  - `file:`
  - git URL
  - http tarball
  - `workspace:`
  - duplicate deps
  - `run402-functions`
  - `@run402/functions`
- Lifecycle script disabled test.
- “Undeclared gateway dep import fails” test.
- Existing Lambda redeploy sends `Layers: []`.
- Config-only update does not clear layers.
- Bundling failure does not update Lambda or DB metadata.
- `deps_resolved` records actual installed version for ranges.
- Legacy rows return `runtime_version: null`, `deps_resolved: null`.
- New empty deps returns `{}`.
- Temp dir cleanup on npm failure, esbuild failure, timeout.
- Bundle size rejection and warning schema.

---

## Bottom line

The high-level architecture is sound, but the current specs understate the dangerous parts. I would amend before implementation, especially:

1. disable npm lifecycle scripts and restrict package specs;
2. isolate bundling from gateway `node_modules`;
3. fix `@run402/functions` static imports for bundling;
4. send `Layers: []` on redeploy, not merely omit `Layers`;
5. add public SDK/MCP/CLI response field updates;
6. avoid publishing docs that claim `--deps` works before the gateway rollout;
7. make the first scoped npm publish/version flow deterministic.

---
**Wall time**: 26m 32s
**Tokens**: 10,844 input, 34,670 output (30,981 reasoning), 45,514 total
**Estimated cost**: $6.5659
