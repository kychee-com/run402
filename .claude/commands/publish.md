Publish the four npm packages in this monorepo (`run402-mcp`, `run402` CLI, `@run402/sdk`, `@run402/functions`). Run each step in order, stopping on any failure.

**Default behavior is lockstep** — all four packages bumped to the same version. The skill prompts you in the version-bump step if you want to bump only a subset.

## Pre-publish checks

1. **Verify you are on `main` and in sync with `origin/main`.** Run `git rev-parse --abbrev-ref HEAD` — if the output is not `main`, **STOP IMMEDIATELY**. Do not run tests, do not run the build, do not bump the version. Tell the user: "You're on branch `<branch>`, not `main`. Releases must be cut from `main` so the tag matches the published commit and the private-repo docs deploy picks it up. Merge the branch first, then re-run `/publish`." Do not offer to switch branches or merge for them — just stop. Then run `git fetch origin main && git rev-list --count HEAD..origin/main` — if non-zero, stop and tell the user `main` is behind `origin/main` and needs a pull.
2. Make sure the working tree is clean (`git status`). If there are uncommitted changes, stop and tell the user.
3. Run the full test suite: `npm test`. If any test fails, stop and tell the user.
4. Run the build: `npm run build`. If it fails, stop and tell the user.

## Version bump

**Step 1 — pick the bump kind.** Ask the user: patch, minor, or major.

**Step 2 — pick which packages.** Ask the user: *"Bump which packages? [all | comma-separated subset of mcp,cli,sdk,functions]"* — default `all`.

- `all` → lockstep release. All four packages bumped to the same new version. This is the recommended default; "Run402 v1.46.0" should mean one thing.
- Comma-separated subset (e.g., `functions` or `mcp,cli`) → selective release. Only the listed packages are bumped and published; the others retain their current published versions. The selected set is brought back into sync at the chosen target version.
- Reject any tokens not in `mcp,cli,sdk,functions,all`.

**Step 3 — compute the target version.** Read the *highest* current version across the selected packages (in case they've diverged), apply the bump kind, get one target version. Apply that exact target version to every selected package.

The four packages and their `package.json` files:

| ID | npm name | path |
|---|---|---|
| `mcp` | `run402-mcp` | `package.json` (root) |
| `cli` | `run402` | `cli/package.json` |
| `sdk` | `@run402/sdk` | `sdk/package.json` |
| `functions` | `@run402/functions` | `functions/package.json` |

**Step 4 — apply the bumps.**

1. For the root `package.json` (only if `mcp` is selected): `npm version <patch|minor|major> --no-git-tag-version`.
2. For each other selected package: manually update the `"version"` field to the target version. Use Edit, not `npm version` from inside the subpackage (that bumps relative to the subpackage's old version, which is wrong if it's diverged).

After all selected `package.json` files are updated, run `npm install --package-lock-only` from the repo root to sync `package-lock.json`.

**Step 5 — stage and commit.** Stage only the touched `package.json` files and the lockfile:

```
git add <each touched package.json> package-lock.json
git commit -m "chore: bump <selected> to v<target>"
```

For lockstep (`all`), the commit message is `chore: bump version to v<target>`.

## Pre-publish tarball smoke test

`npm test` runs against the source tree, not a packed tarball, so it misses bugs like monorepo-relative imports that escape the `files` allowlist. Pack each tarball, install it in a scratch dir, and verify the entry points actually load before publishing. v1.40.1 shipped broken because this step didn't exist — every `run402` command threw `ERR_MODULE_NOT_FOUND`.

**About `--before=9999-12-31`:** the user's global npm has a `before` date pinned as a supply-chain mitigation (blocks installing packages published after that date, in case a dependency is compromised). Scratch installs in `/tmp` can safely bypass it per-invocation with `--before=9999-12-31`. Do **not** suggest the user remove the global config — they want it.

Run these in sequence. If any check fails, stop and fix the root cause. Do **not** `npm publish`.

Pack the four tarballs (skip any package not in the selected set):

```
SMOKE=/tmp/smoke-<new_version> && rm -rf $SMOKE && mkdir $SMOKE
npm pack --pack-destination $SMOKE                # mcp
(cd cli && npm pack --pack-destination $SMOKE)    # cli
(cd sdk && npm pack --pack-destination $SMOKE)    # sdk
(cd functions && npm pack --pack-destination $SMOKE)  # functions
```

1. **CLI** — extract, install, check `--version`:
   ```
   mkdir $SMOKE/cli && tar xzf $SMOKE/run402-<new_version>.tgz -C $SMOKE/cli
   (cd $SMOKE/cli/package && npm install --omit=dev --before=9999-12-31)
   node $SMOKE/cli/package/cli.mjs --version
   ```
   Expect exit 0 and the new version string.

2. **MCP** — extract, install, verify the SDK import resolves (don't boot the stdio server — it won't exit):
   ```
   mkdir $SMOKE/mcp && tar xzf $SMOKE/run402-mcp-<new_version>.tgz -C $SMOKE/mcp
   (cd $SMOKE/mcp/package && npm install --omit=dev --before=9999-12-31)
   (cd $SMOKE/mcp/package && node -e "import('./dist/sdk.js').then(m => console.log('OK', typeof m.getSdk)).catch(e => { console.error('FAIL', e.message); process.exit(1) })")
   ```

3. **SDK** — extract, install, verify both entry points:
   ```
   mkdir $SMOKE/sdk && tar xzf $SMOKE/run402-sdk-<new_version>.tgz -C $SMOKE/sdk
   (cd $SMOKE/sdk/package && npm install --omit=dev --before=9999-12-31)
   (cd $SMOKE/sdk/package && node -e "import('./dist/node/index.js').then(m => console.log('OK node', typeof m.run402)).catch(e => { console.error('FAIL', e.message); process.exit(1) })")
   (cd $SMOKE/sdk/package && node -e "import('./dist/index.js').then(m => console.log('OK iso', typeof m.Run402)).catch(e => { console.error('FAIL', e.message); process.exit(1) })")
   ```

4. **Functions** (`@run402/functions`) — run the dedicated tarball smoke script. It builds, packs in its own scratch, installs, exports-checks, exercises `getUser()` end-to-end with a signed JWT, and verifies the deprecated `run402-functions` import path is NOT resolvable:
   ```
   node functions/test/smoke-tarball.mjs
   ```
   Expect `✓ All smoke checks passed`. The script exits non-zero on any failure. **This catches the jsonwebtoken bundling regression class** (e.g., if `auth.ts` reverts to `createRequire`, or if `jsonwebtoken` is dropped from runtime deps).

## Publish

Skip any step whose package was NOT in the selected set from the version-bump prompt.

1. **MCP server** (`run402-mcp`):
   ```
   npm publish
   ```

2. **CLI** (`run402`):
   ```
   cd cli && npm publish
   ```
   The CLI's `prepack` script copies `core/dist/*.js` into `core-dist/` so the published tarball is self-contained.

3. **SDK** (`@run402/sdk`):
   ```
   cd sdk && npm publish
   ```
   The SDK's `prepack` script copies `core/dist/*.js` and `core/dist/*.d.ts` into `core-dist/` so the published tarball is self-contained. The SDK ships two entry points: `@run402/sdk` (isomorphic — works in Node, Deno, Bun, V8 isolates) and `@run402/sdk/node` (Node defaults: keystore + allowance + x402-wrapped fetch).

4. **Functions** (`@run402/functions`):
   ```
   cd functions && npm publish
   ```
   The package has `publishConfig.access: public` set in `package.json`, so no `--access public` flag is needed. The published tarball contains `dist/` only (the source tests are excluded via the `files` allowlist).

5. **First-time deprecation of `run402-functions`** — IF this is the first `@run402/functions` release (i.e., before this run, the previously-published `run402-functions` package was the canonical name), run:
   ```
   npm deprecate run402-functions@"*" "renamed to @run402/functions; install @run402/functions instead"
   ```
   This step is idempotent — safe to re-run on subsequent publishes. Verify with `npm view run402-functions deprecated` showing the message.

6. **OpenClaw skill**: No registry publish needed. The OpenClaw skill is distributed as a directory copy and uses `run402-mcp` via npx. Confirm to the user that OpenClaw is automatically up to date since its SKILL.md `install` field points to the `run402-mcp` npm package.

## Post-publish

1. `git push` to push the version bump commit.
2. Create a git tag:
   - **Lockstep release (`all` selected):** `git tag v<new_version> && git push --tags`
   - **Subset release:** `git tag v<new_version>-<comma-separated-subset> && git push --tags` (e.g., `v1.46.1-functions`). The plain `v<version>` tag is reserved for lockstep releases — do not use it for subsets.
3. Create a GitHub release from the tag. Write a human-readable summary of the actual changes (features, fixes, improvements) — don't just list commit hashes or rely on `--generate-notes`. Use `gh release create v<new_version> --notes "..."` with a clear description.
4. **Close linked GitHub issues.** If any commit in the release references a GitHub issue (e.g. `Fixes #20`, `Closes #42`), verify the issue is closed. If not, close it with `gh issue close <number> --reason completed`.
5. **Update `cli/llms-cli.txt` (in this repo).** This is the CLI reference served at `https://run402.com/llms-cli.txt`. If any CLI commands, manifest fields, or user-facing behavior changed since the last release, update `cli/llms-cli.txt` to match, then commit and push. Same applies to `SKILL.md` (MCP server skill) if tool signatures changed. The private `run402-private` repo pulls both files from here at site-deploy time — do **not** edit the copies under `run402-private/site/`.

   After the docs commit lands on `main`, trigger a private-repo site redeploy so the fresh docs go live immediately:
   ```
   gh workflow run deploy-site.yml -R kychee-com/run402-private
   ```
   (Or `gh api repos/kychee-com/run402-private/dispatches -f event_type=public-docs-updated` if you want the trigger to show up in the audit log as a `repository_dispatch`.)
6. **Install the new version locally and smoke-test it** so `run402` on the command line uses the just-published version — and so a broken publish gets caught immediately, not when the user next runs a command:
   ```
   npm install -g run402@<new_version> --prefer-online --before=9999-12-31
   run402 --version
   run402 allowance status
   ```
   - `--prefer-online` forces npm to hit the registry instead of a stale local cache (the new version can otherwise appear missing for a minute after publish).
   - `--before=9999-12-31` bypasses the user's global `before` supply-chain guard for this one install. Keep the global config intact — do not run `npm config delete before`.
   - Expect `run402 --version` to print the new version, and `run402 allowance status` to return valid JSON with the user's wallet info. If either fails with `ERR_MODULE_NOT_FOUND` or similar, the published tarball is broken — tell the user loudly and prepare a hotfix version immediately.
7. Print a summary of what was published, including the new version and npm URLs (skip any package not in the selected set):
   - https://www.npmjs.com/package/run402-mcp
   - https://www.npmjs.com/package/run402
   - https://www.npmjs.com/package/@run402/sdk
   - https://www.npmjs.com/package/@run402/functions

## Twitter summary

**Skip this step for patch releases.** Patch bumps are bug fixes / internal changes and don't warrant a tweet. If the user picked `patch` in the version-bump step, stop here — do not generate tweet options.

For `minor` or `major` releases, write a tweet-ready summary of the release. This is the last thing you do.

Guidelines:
- **Focus on what developers can now build**, not what changed internally. "Your agents can now send HTML emails" not "Added raw HTML mode to email tool".
- Lead with the big picture, not the release bookkeeping. Say "run402 adds GitHub Actions OIDC..." instead of "run402 v1.55.0 adds GitHub Actions OIDC..." because people care about the capability, not the exact version number.
- Keep it under 280 characters. No hashtags. A small personal touch is welcome when it feels natural, including an emoji if it adds warmth.
- If the release has multiple features, pick the 1-2 most compelling and lead with those.
- Do not end with the exact version number. Version details belong in the release summary and npm/GitHub links, not in the tweet.
- Example personal touch: "OIDC is really cool 😎"
- Present 2-3 options so the user can pick or remix.
