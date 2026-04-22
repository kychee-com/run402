Publish all three packages in this monorepo. Run each step in order, stopping on any failure.

## Pre-publish checks

1. **Verify you are on `main` and in sync with `origin/main`.** Run `git rev-parse --abbrev-ref HEAD` — if the output is not `main`, **STOP IMMEDIATELY**. Do not run tests, do not run the build, do not bump the version. Tell the user: "You're on branch `<branch>`, not `main`. Releases must be cut from `main` so the tag matches the published commit and the private-repo docs deploy picks it up. Merge the branch first, then re-run `/publish`." Do not offer to switch branches or merge for them — just stop. Then run `git fetch origin main && git rev-list --count HEAD..origin/main` — if non-zero, stop and tell the user `main` is behind `origin/main` and needs a pull.
2. Make sure the working tree is clean (`git status`). If there are uncommitted changes, stop and tell the user.
3. Run the full test suite: `npm test`. If any test fails, stop and tell the user.
4. Run the build: `npm run build`. If it fails, stop and tell the user.

## Version bump

Ask the user what kind of version bump they want: patch, minor, or major.

Then bump the version in **both** package.json files (root `package.json` and `cli/package.json`) to the same new version. The MCP package (`run402-mcp`) and CLI package (`run402`) must always have matching versions. Use `npm version <patch|minor|major> --no-git-tag-version` in the root, then manually update `cli/package.json` to match.

After updating both package.json files, run `npm install --package-lock-only` to sync `package-lock.json` with the new version.

Stage all three files and commit: `git add package.json cli/package.json package-lock.json && git commit -m "chore: bump version to <new_version>"`

## Publish

1. **MCP server** (`run402-mcp`):
   ```
   npm publish
   ```

2. **CLI** (`run402`):
   ```
   cd cli && npm publish
   ```

3. **OpenClaw skill**: No registry publish needed. The OpenClaw skill is distributed as a directory copy and uses `run402-mcp` via npx. Confirm to the user that OpenClaw is automatically up to date since its SKILL.md `install` field points to the `run402-mcp` npm package.

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
6. **Install the new version locally** so `run402` on the command line uses the just-published version:
   ```
   npm install -g run402@<new_version>
   ```
   Verify with `run402 --version` and confirm it matches the new version.
7. Print a summary of what was published, including the new version and npm URLs:
   - https://www.npmjs.com/package/run402-mcp
   - https://www.npmjs.com/package/run402

## Twitter summary

**Skip this step for patch releases.** Patch bumps are bug fixes / internal changes and don't warrant a tweet. If the user picked `patch` in the version-bump step, stop here — do not generate tweet options.

For `minor` or `major` releases, write a tweet-ready summary of the release. This is the last thing you do.

Guidelines:
- **Focus on what developers can now build**, not what changed internally. "Your agents can now send HTML emails" not "Added raw HTML mode to email tool".
- Keep it under 280 characters. No hashtags, no emojis unless the user asks.
- If the release has multiple features, pick the 1-2 most compelling and lead with those.
- End with the version number, e.g. `(run402 v1.21.0)`
- Present 2-3 options so the user can pick or remix.
