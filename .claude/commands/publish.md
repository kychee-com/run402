# /publish — Lockstep publish run402-mcp + run402 + @run402/sdk via OIDC

Trigger the canonical publish pipeline at `.github/workflows/publish.yml`. The workflow handles version bump, tarball smoke test, three npm publishes (via OIDC Trusted Publisher — no stored tokens), commit-back to main, tag, and GitHub release. This skill is your local-machine wrapper around `gh workflow run`.

> **Why CI-driven, not local-publish:** each of `run402-mcp`, `run402`, and `@run402/sdk` has npm Trusted Publisher OIDC federation configured. The npm settings page for each package lists this repository, branch, and workflow filename as a trusted publisher. Any publish attempted from anywhere else (a developer laptop, a fork, a different workflow file) fails the npm-side claim check. The whole point of OIDC is to remove the "do you have a token" question — only this workflow file running on main can publish.

> **`@run402/functions` is NOT published here.** That package ships from `kychee-com/run402-private` (`packages/functions/`) via `/publish-functions` in that repo. The gateway and the in-function helpers live in the same monorepo there so they can be tested together. Only the source of truth moved — the npm package name stays `@run402/functions`.

> **`@run402/astro`** ships via `/publish-astro` (its own OIDC workflow at `.github/workflows/publish-astro.yml`). Independent release train.

**Lockstep only.** The workflow bumps and publishes all three packages at the same version. There is no subset release path through OIDC — running `npm publish` locally for one package would fail the Trusted Publisher claim check (or succeed only via an OTP-elevated bypass token, which defeats the security model). If you genuinely need to ship one package without the others, extend the workflow with a selective input — do not fall back to a local publish.

Stop on any failure. Do NOT skip checks.

## Pre-flight (local, before triggering the workflow)

These run on your machine to catch obvious problems before the workflow burns Actions minutes:

1. **Verify you are on `main` and in sync with `origin/main`.** Run `git rev-parse --abbrev-ref HEAD` — if the output is not `main`, **STOP IMMEDIATELY**. Tell the user: "You're on branch `<branch>`, not `main`. Releases must be cut from `main` so the tag matches the published commit and the private-repo docs deploy picks it up. Merge the branch first, then re-run `/publish`." Do not offer to switch branches or merge for them. Then run `git fetch origin main && git rev-list --count HEAD..origin/main` — if non-zero, stop and tell the user `main` is behind `origin/main` and needs a pull. The workflow itself enforces `if: github.ref == 'refs/heads/main'`, but catching the mismatch locally avoids a wasted run.
2. **Working tree clean** (`git status`). Uncommitted changes are invisible to the workflow — it builds from the pushed commit. If the user has work in flight that they want included, commit + push it first.
3. **Unit tests pass locally:** `npm test`. The workflow re-runs these but a local pre-check gives fast feedback. If it fails, stop and tell the user.
4. **Build passes locally:** `npm run build`. Same logic.
5. **Confirm npm Trusted Publisher is configured for all three packages.** Open each in a browser and confirm the "Trusted Publishers" section lists this repo + `publish.yml`:
   - https://www.npmjs.com/package/run402-mcp/access
   - https://www.npmjs.com/package/run402/access
   - https://www.npmjs.com/package/@run402/sdk/access

   If any section is empty, that package's publish step will fail with 401 — stop and ask the user to configure it before proceeding (org `kychee-com`, repo `run402`, workflow filename `publish.yml`, no environment).

If any local check fails, stop and tell the user.

## Choose the bump kind

Ask the user: **patch, minor, or major.**

- **Patch** (`2.5.0 → 2.5.1`): bug fix, no surface change.
- **Minor** (`2.5.0 → 2.6.0`): new feature, new method, backwards-compatible.
- **Major** (`2.5.0 → 3.0.0`): breaking change.

The bump applies to all three packages (lockstep). The workflow reads the root `package.json` version, applies the bump, and mirrors the exact target into `cli/package.json` and `sdk/package.json` before publishing.

If the user asks for a subset release (e.g., "just patch the CLI"), redirect them: the OIDC workflow is lockstep-only. Either bump all three, or extend `.github/workflows/publish.yml` with a `packages` input — do **not** fall back to a local `npm publish`.

## Trigger the workflow

```
gh workflow run publish.yml -F bump=<patch|minor|major> -R kychee-com/run402
```

For a dry-run that builds + smoke-tests without publishing (useful when validating a workflow change):

```
gh workflow run publish.yml -F bump=patch -F dry_run=true -R kychee-com/run402
```

The dry run still bumps the local version on the runner and packs the three tarballs, but skips the npm publish + commit + tag + release steps.

## Watch the workflow

```
RUN_ID=$(gh run list -w publish.yml -R kychee-com/run402 --limit 1 --json databaseId --jq '.[0].databaseId')
gh run watch "$RUN_ID" -R kychee-com/run402 --exit-status
```

`--exit-status` makes the watch command exit non-zero if the workflow fails — useful for chaining into a verification step.

## Verify the publish landed

After the workflow completes successfully:

1. **Confirm each new version is live on the registry.** Use `curl` directly, not `npm view` — the user's global npm has `--before` pinned as a supply-chain mitigation and would filter newly-published packages out of `npm view`:
   ```
   curl -sS "https://registry.npmjs.org/run402-mcp/<new_version>" | jq -r .version
   curl -sS "https://registry.npmjs.org/run402/<new_version>" | jq -r .version
   curl -sS "https://registry.npmjs.org/@run402/sdk/<new_version>" | jq -r .version
   ```
   Each should print the new version. A `null` or 404 means that package's publish did not land — investigate before continuing.

2. **Confirm provenance attestations exist.** The OIDC publish attaches one; a null `attestations` field means the publish silently fell back to anonymous, which is a real problem:
   ```
   curl -sS "https://registry.npmjs.org/run402-mcp/<new_version>" | jq '.dist.attestations'
   curl -sS "https://registry.npmjs.org/run402/<new_version>" | jq '.dist.attestations'
   curl -sS "https://registry.npmjs.org/@run402/sdk/<new_version>" | jq '.dist.attestations'
   ```
   Each should return a non-null object.

3. **Pull the bump commit and tag locally** (the workflow pushed both to `main`):
   ```
   git pull --rebase origin main
   git fetch --tags
   ```

## Post-publish manual steps

The workflow handles the publishes, the version-bump commit, the tag, and an auto-generated GitHub release. The steps below stay in this skill because they need judgement or repo-level coordination the workflow cannot do.

1. **Rewrite the GitHub release notes.** The workflow uses `generate_release_notes: true`, which lists commits but does not tell the story. Replace the body with a human-readable summary of the actual changes (features, fixes, improvements) — features grouped by surface, not a commit hash list. Edit the existing release:
   ```
   gh release edit v<new_version> -R kychee-com/run402 --notes "..."
   ```

2. **Close linked GitHub issues.** If any commit in the release references a GitHub issue (e.g. `Fixes #20`, `Closes #42`), verify the issue is closed. If not, close it with `gh issue close <number> --reason completed`.

3. **Update `cli/llms-cli.txt`** if any CLI commands, manifest fields, or user-facing behavior changed since the last release. This is the CLI reference served at `https://run402.com/llms-cli.txt`. Same applies to `SKILL.md` (MCP server skill) if tool signatures changed. The private `run402-private` repo pulls both files from here at site-deploy time — do **not** edit the copies under `run402-private/site/`.

   After the docs commit lands on `main`, trigger a private-repo site redeploy so the fresh docs go live immediately:
   ```
   gh workflow run deploy-site.yml -R kychee-com/run402-private
   ```
   (Or `gh api repos/kychee-com/run402-private/dispatches -f event_type=public-docs-updated` if you want the trigger to show up in the audit log as a `repository_dispatch`.)

4. **Install the new CLI version locally and smoke-test it** so `run402` on the command line uses the just-published version, and so a broken publish gets caught immediately, not when the user next runs a command:
   ```
   npm install -g run402@<new_version> --prefer-online --before=9999-12-31
   run402 --version
   run402 allowance status
   ```
   - `--prefer-online` forces npm to hit the registry instead of a stale local cache (the new version can otherwise appear missing for a minute after publish).
   - `--before=9999-12-31` bypasses the user's global `before` supply-chain guard for this one install. Keep the global config intact — do not run `npm config delete before`.
   - Expect `run402 --version` to print the new version, and `run402 allowance status` to return valid JSON with the user's wallet info. If either fails with `ERR_MODULE_NOT_FOUND` or similar, the published tarball is broken — tell the user loudly and prepare a hotfix version immediately.

5. **OpenClaw skill:** no registry publish needed. The OpenClaw skill is distributed as a directory copy and uses `run402-mcp` via npx. Confirm to the user that OpenClaw is automatically up to date since its `SKILL.md` `install` field points to the `run402-mcp` npm package.

6. **Print a summary** of what was published:
   - Workflow run URL
   - Released version
   - https://www.npmjs.com/package/run402-mcp/v/<new_version>
   - https://www.npmjs.com/package/run402/v/<new_version>
   - https://www.npmjs.com/package/@run402/sdk/v/<new_version>
   - GitHub release URL: `https://github.com/kychee-com/run402/releases/tag/v<new_version>`

## Twitter summary

**Skip this step for patch releases.** Patch bumps are bug fixes / internal changes and don't warrant a tweet. If the user picked `patch` in the bump step, stop here — do not generate tweet options.

For `minor` or `major` releases, write a tweet-ready summary of the release. This is the last thing you do.

Guidelines:
- **Focus on what developers can now build**, not what changed internally. "Your agents can now send HTML emails" not "Added raw HTML mode to email tool".
- Lead with the big picture, not the release bookkeeping. Say "run402 adds GitHub Actions OIDC..." instead of "run402 v1.55.0 adds GitHub Actions OIDC..." because people care about the capability, not the exact version number.
- Keep it under 280 characters. No hashtags. A small personal touch is welcome when it feels natural, including an emoji if it adds warmth.
- If the release has multiple features, pick the 1-2 most compelling and lead with those.
- Do not end with the exact version number. Version details belong in the release summary and npm/GitHub links, not in the tweet.
- Example personal touch: "OIDC is really cool 😎"
- Present 2-3 options so the user can pick or remix.

## Troubleshooting

- **Workflow fails at `Publish run402-mcp to npm` (or `run402` / `@run402/sdk`) with 401/403:** Trusted Publisher config doesn't match for that package. Check its npm access page — org / repo / workflow filename must exactly match this workflow's metadata. Note the workflow publishes the three packages in three separate steps; if only one fails, only that package's npm-side config is wrong.
- **Workflow fails at `Verify npm has OIDC publish support`:** the runner's npm is older than 11.5.1. The workflow pins Node 24 specifically because npm 10 (bundled with Node 22) can sign provenance attestations but cannot exchange OIDC tokens for an npm publish credential. Do not downgrade the Node pin.
- **Workflow fails at `Commit version bump` with permission denied:** Repo Settings → Actions → General → Workflow permissions → must be "Read and write." The default GITHUB_TOKEN's permissions are read-only unless this is flipped.
- **One package publishes but the others don't, leaving versions out of sync on npm:** the workflow publishes the three in sequence (mcp → cli → sdk). If mcp publishes successfully but the cli step fails (e.g., transient network), the run is in a partial state. Recover by manually re-running just the failed publish from a clean checkout — but only after confirming with the user that this falls under the "subset publish OK as a recovery" exception. Do not normalize this path.
- **`npm view <pkg>@<new_version>` returns 404 right after a successful publish:** almost always the user's `--before` date pin filtering, not a real propagation issue. Confirm with the direct `curl` against `registry.npmjs.org`.

## What this skill does NOT do

- Does NOT publish locally via `npm publish`. The Trusted Publisher OIDC trust ONLY accepts publishes from THIS workflow file on `main`. Attempting a local publish would fail the npm-side claim check (or succeed only with an unrelated bypass-2FA token, which defeats the whole point).
- Does NOT bump `@run402/astro` — that ships via `/publish-astro`.
- Does NOT bump `@run402/functions` — that lives in the private gateway monorepo and ships via `/publish-functions` there.
- Does NOT support subset releases (publish just `cli` without `mcp` and `sdk`). The workflow is lockstep-only — extend the workflow with a selective input if you need this.
- Does NOT prompt for an OTP or token. If you ever see the workflow asking for one, the Trusted Publisher config drifted — fix the npm-side config rather than reverting to token auth.
