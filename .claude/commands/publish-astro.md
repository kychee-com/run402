# /publish-astro — Publish @run402/astro to npm

Publish the `@run402/astro` Astro integration package from `astro/` in this repo. Unlike `@run402/sdk`, `run402` CLI, and `run402-mcp` (which lockstep via `/publish`), `@run402/astro` has its own versioning cadence because it's a framework adapter, not part of the core SDK release train.

> **`@run402/functions` is published from the private gateway monorepo** (`kychee-com/run402-private` via `/publish-functions`). This skill is only for `@run402/astro`.

Stop on any failure. Do NOT skip checks.

## When to publish

- New `<Image>` component prop, integration option, or behavior change → publish
- Bug fix to the resolver / scanner / uploader / picture-builder → publish patch
- Compat fix for a new Astro major version → publish minor (after testing against the new major)
- Documentation-only README fix → publish at your discretion (no functional change)

The package has **no runtime relationship with the gateway** — there is no equivalent of `@run402/functions`'s "gateway redeploy alone propagates the fix." A consumer must bump their `@run402/astro` dependency to see any change.

## Pre-publish checks

1. **On main, in sync with origin/main.** `git rev-parse --abbrev-ref HEAD` must be `main`. `git fetch origin main && git rev-list --count HEAD..origin/main` must be `0`. If not, stop and tell the user.
2. **Working tree clean** (`git status`). Stop if not.
3. **Unit tests pass:** `npm test --workspace=astro`. Expect 50+ tests, 0 failures.
4. **Type-check clean:** `npx tsc --noEmit -p astro`. No output = clean.
5. **Build the package:** `npm run build --workspace=astro`. Confirms `dist/` is current.

If any step fails, stop and tell the user.

## Version bump

1. Ask the user: **patch, minor, or major.**
   - Patch (`0.1.0 → 0.1.1`): bug fix, no surface change.
   - Minor (`0.1.0 → 0.2.0`): new prop, new integration option, or new optional behavior. Backwards-compatible.
   - Major (`0.1.0 → 1.0.0` or `1.0.0 → 2.0.0`): breaking prop change, removed option, or behavior change that requires consumer code changes. v0.x → v1.x is the "stable surface" promotion.
2. Read current version from `astro/package.json`.
3. Compute target: apply bump kind. Apply directly to `astro/package.json` (use Edit, not `npm version` — `npm version` from inside a workspace can have surprising lockfile behavior).
4. `npm install --package-lock-only` from repo root to sync `package-lock.json`.

## Tarball smoke test

`npm test` runs against source, not the packed tarball. Pack it and verify the entry points resolve:

```
SMOKE=/tmp/smoke-astro-<new_version> && rm -rf $SMOKE && mkdir $SMOKE
(cd astro && npm pack --pack-destination $SMOKE)
mkdir $SMOKE/astro && tar xzf $SMOKE/run402-astro-<new_version>.tgz -C $SMOKE/astro
(cd $SMOKE/astro/package && npm install --omit=dev --before=9999-12-31)
node -e "import('$SMOKE/astro/package/dist/index.js').then(m => console.log('OK', typeof m.run402)).catch(e => { console.error('FAIL', e.message); process.exit(1) })"
```

Expect `OK function`. The script exits non-zero on any failure.

**Also verify the .astro component file ships:**

```
ls $SMOKE/astro/package/src/Image.astro
```

Must print the path. If the file is missing, the `files` allowlist in `package.json` is broken — do not publish.

**Also verify the tarball does NOT include source `.ts` files:**

```
find $SMOKE/astro/package -name "*.ts" -not -name "*.d.ts" | head
```

Should print nothing (only `.d.ts` types ship). Source `.ts` files in the tarball means `files` allowlist is wrong.

**About `--before=9999-12-31`:** if the user's global npm has a `before` date pinned (supply-chain mitigation), the scratch install needs this flag to bypass it for `/tmp` installs. Do **not** suggest removing the global config.

## Commit and publish

1. Stage and commit the version bump:
   ```
   git add astro/package.json package-lock.json
   git commit -m "chore(astro): bump @run402/astro to v<new_version>"
   ```
2. Publish:
   ```
   cd astro && npm publish --access public
   ```
   The `publishConfig.access: public` field is set in `package.json`, so the explicit flag is redundant but harmless. The tarball contains `dist/`, `src/Image.astro`, and `README.md` only (per the `files` allowlist; `node_modules`, tests, and `*.test.*` are excluded).

## Post-publish

1. `git push` to push the version bump commit.
2. Create a git tag:
   ```
   git tag v<new_version>-astro && git push --tags
   ```
   Use the `-astro` suffix because the other public-repo packages (`run402-mcp`, `run402`, `@run402/sdk`) have their own tag scheme; this clarifies which package the tag belongs to.
3. Create a GitHub release (public repo):
   ```
   gh release create v<new_version>-astro -R kychee-com/run402 --notes "..."
   ```
   Write a human-readable summary naming user-facing changes. Don't rely on auto-generated notes.
4. **Verify live on npm:**
   ```
   npm view @run402/astro@<new_version> version
   ```
   Should print the new version. May take up to a minute to propagate.
5. **Update `documentation.md`** if the prop surface or integration options changed. The doc serves as the canonical reference for the public repo. Commit + push.
6. **Update `llms-full.txt` in the private repo** (`kychee-com/run402-private` at `site/llms-full.txt`) if the Astro integration section needs to point at a new version or document a new feature. The site at https://run402.com/llms-full.txt is regenerated from there; trigger a redeploy after the update:
   ```
   gh workflow run deploy-site.yml -R kychee-com/run402-private
   ```
7. Print a summary:
   - Published version
   - npm URL: `https://www.npmjs.com/package/@run402/astro`
   - GitHub release URL

## What this skill does NOT do

- Does NOT bump `mcp`, `cli`, or `sdk`. Those lockstep via `/publish`.
- Does NOT bump `@run402/functions`. That lives in the private gateway monorepo and ships via `/publish-functions` there.
- Does NOT trigger any gateway redeploy. There is no gateway-side dependency on this package.
- Does NOT migrate consumer projects. After publishing, consumers (Kychon, etc.) update their `@run402/astro` dependency on their own cadence.
