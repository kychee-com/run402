Publish all four packages in this monorepo. Run each step in order, stopping on any failure.

## Pre-publish checks

1. **Verify you are on `main` and in sync with `origin/main`.** Run `git rev-parse --abbrev-ref HEAD` — if the output is not `main`, **STOP IMMEDIATELY**. Do not run tests, do not run the build, do not bump the version. Tell the user: "You're on branch `<branch>`, not `main`. Releases must be cut from `main` so the tag matches the published commit and the private-repo docs deploy picks it up. Merge the branch first, then re-run `/publish`." Do not offer to switch branches or merge for them — just stop. Then run `git fetch origin main && git rev-list --count HEAD..origin/main` — if non-zero, stop and tell the user `main` is behind `origin/main` and needs a pull.
2. Make sure the working tree is clean (`git status`). If there are uncommitted changes, stop and tell the user.
3. Run the full test suite: `npm test`. If any test fails, stop and tell the user.
4. Run the build: `npm run build`. If it fails, stop and tell the user.

## Version bump

Ask the user what kind of version bump they want: patch, minor, or major.

The MCP server (`run402-mcp`), CLI (`run402`), and SDK (`@run402/sdk`) **must always share the same version**. Bump all three `package.json` files to the same new version:

1. Root `package.json` — bump with `npm version <patch|minor|major> --no-git-tag-version` (this reads the current version and applies the bump).
2. `cli/package.json` — manually update the `"version"` field to match the new root version.
3. `sdk/package.json` — manually update the `"version"` field to match the new root version.

After updating all three package.json files, run `npm install --package-lock-only` to sync `package-lock.json` with the new version.

Stage and commit: `git add package.json cli/package.json sdk/package.json package-lock.json && git commit -m "chore: bump version to <new_version>"`

## Pre-publish tarball smoke test

`npm test` runs against the source tree, not a packed tarball, so it misses bugs like monorepo-relative imports that escape the `files` allowlist. Pack each tarball, install it in a scratch dir, and verify the entry points actually load before publishing. v1.40.1 shipped broken because this step didn't exist — every `run402` command threw `ERR_MODULE_NOT_FOUND`.

**About `--before=9999-12-31`:** the user's global npm has a `before` date pinned as a supply-chain mitigation (blocks installing packages published after that date, in case a dependency is compromised). Scratch installs in `/tmp` can safely bypass it per-invocation with `--before=9999-12-31`. Do **not** suggest the user remove the global config — they want it.

Run these in sequence. If any check fails, stop and fix the root cause. Do **not** `npm publish`.

```
SMOKE=/tmp/smoke-<new_version> && rm -rf $SMOKE && mkdir $SMOKE
npm pack --pack-destination $SMOKE
(cd cli && npm pack --pack-destination $SMOKE)
(cd sdk && npm pack --pack-destination $SMOKE)
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

## Publish

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

4. **OpenClaw skill**: No registry publish needed. The OpenClaw skill is distributed as a directory copy and uses `run402-mcp` via npx. Confirm to the user that OpenClaw is automatically up to date since its SKILL.md `install` field points to the `run402-mcp` npm package.

## Post-publish

1. `git push` to push the version bump commit.
2. Create a git tag: `git tag v<new_version> && git push --tags`
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
7. Print a summary of what was published, including the new version and npm URLs:
   - https://www.npmjs.com/package/run402-mcp
   - https://www.npmjs.com/package/run402
   - https://www.npmjs.com/package/@run402/sdk

## Twitter summary

**Skip this step for patch releases.** Patch bumps are bug fixes / internal changes and don't warrant a tweet. If the user picked `patch` in the version-bump step, stop here — do not generate tweet options.

For `minor` or `major` releases, write a tweet-ready summary of the release. This is the last thing you do.

Guidelines:
- **Focus on what developers can now build**, not what changed internally. "Your agents can now send HTML emails" not "Added raw HTML mode to email tool".
- Keep it under 280 characters. No hashtags, no emojis unless the user asks.
- If the release has multiple features, pick the 1-2 most compelling and lead with those.
- End with the version number, e.g. `(run402 v1.21.0)`
- Present 2-3 options so the user can pick or remix.
