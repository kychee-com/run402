Publish all three packages in this monorepo. Run each step in order, stopping on any failure.

## Pre-publish checks

1. Make sure the working tree is clean (`git status`). If there are uncommitted changes, stop and tell the user.
2. Run the full test suite: `npm test`. If any test fails, stop and tell the user.
3. Run the build: `npm run build`. If it fails, stop and tell the user.

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
5. **Update `llms-cli.txt` in the run402 repo.** The CLI documentation lives in a separate repo at `~/Developer/run402-private/site/llms-cli.txt`. If any CLI commands, manifest fields, or user-facing behavior changed since the last release, update that file to match, then commit and push the run402 repo.
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
