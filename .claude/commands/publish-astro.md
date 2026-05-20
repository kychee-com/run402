# /publish-astro — Publish @run402/astro to npm via OIDC

Trigger the canonical publish pipeline at `.github/workflows/publish-astro.yml`. The workflow handles version bump, smoke test, npm publish (via OIDC Trusted Publisher — no stored tokens), commit-back, tag, and GitHub release. This skill is your local-machine wrapper around `gh workflow run`.

> **Why CI-driven not local-publish:** `@run402/astro` uses npm's Trusted Publisher OIDC federation. The npm package's settings page lists this repository, branch, and workflow filename as a trusted publisher. Any publish attempted from anywhere else (a developer laptop, a fork, a different workflow file) fails the npm-side claim check. The whole point of OIDC is to remove the "do you have a token" question — only this workflow file running on main can publish.
>
> **One bootstrap exception:** v0.1.0 was published manually with an OTP-elevated automation token because npm requires the package to exist before a Trusted Publisher can be configured. That bootstrap is done and never repeats; from 0.1.1 onwards, all publishes go through this skill → this workflow.

> **`@run402/functions` is published from a different repo** (`kychee-com/run402-private` via `/publish-functions`). This skill is only for `@run402/astro`.
>
> **`run402-mcp`, `run402` CLI, and `@run402/sdk`** ship via `/publish` (lockstep). This skill is independent of that release train.

Stop on any failure. Do NOT skip checks.

## Pre-flight (local, before triggering the workflow)

These run on your machine to catch obvious problems before the workflow burns Actions minutes:

1. **On `main`, in sync with `origin/main`.** `git rev-parse --abbrev-ref HEAD` must be `main`. `git fetch origin main && git rev-list --count HEAD..origin/main` must be `0`. If not, stop and tell the user. The workflow itself enforces `if: github.ref == 'refs/heads/main'`, but catching the mismatch locally avoids a wasted run.
2. **Working tree clean** (`git status`). Uncommitted changes don't go to the workflow — they'd be invisible to the publish. If the user has work in flight that they want included in the publish, commit + push it first.
3. **Unit tests pass:** `npm test --workspace=astro`. Expect ~50 tests, 0 failures. The workflow re-runs these but a local pre-check gives fast feedback.
4. **Type-check clean:** `npx tsc --noEmit -p astro`. Empty output = clean.
5. **Confirm npm Trusted Publisher is configured.** Open https://www.npmjs.com/package/@run402/astro/access in a browser and confirm the "Trusted Publishers" section lists this repo + workflow. If the section is empty, the publish step will fail with 401 — stop and ask the user to configure it before proceeding (org `kychee-com`, repo `run402`, workflow filename `publish-astro.yml`, no environment).

If any local check fails, stop and tell the user.

## Choose the bump kind

Ask the user: **patch, minor, or major.**

- **Patch** (`0.1.0 → 0.1.1`): bug fix, no surface change. Example: blurhash decoder crash on edge case, error message wording.
- **Minor** (`0.1.0 → 0.2.0`): new prop, new integration option, or new optional behavior. Backwards-compatible. Example: new `placeholder="dominantColor"` mode, support for AVIF variants when they ship in v1.50.
- **Major** (`0.x → 1.0` or `1.x → 2.0`): breaking prop change, removed option, or behavior change that requires consumer code changes. Example: removing `priority` in favor of `fetchpriority`, changing the variant URL format. Reserve `1.0` for the "stable surface" promotion when the prop API is locked.

## Trigger the workflow

The workflow does ALL the publish work — version bump, smoke test, npm publish, commit-back to main, tag, GitHub release. You just trigger it:

```
gh workflow run publish-astro.yml -F bump=<patch|minor|major> -R kychee-com/run402
```

For a dry-run that builds + smoke-tests without publishing (useful when validating a workflow change):

```
gh workflow run publish-astro.yml -F bump=patch -F dry_run=true -R kychee-com/run402
```

The dry run still bumps the local version on the runner and packs the tarball, but skips the publish + commit + tag + release steps. Useful for "does the bumped version pack right?" testing.

## Watch the workflow

Find the run ID and watch:

```
RUN_ID=$(gh run list -w publish-astro.yml -R kychee-com/run402 --limit 1 --json databaseId --jq '.[0].databaseId')
gh run watch "$RUN_ID" -R kychee-com/run402 --exit-status
```

`--exit-status` makes the watch command exit non-zero if the workflow fails — useful for chaining into a verification step.

## Verify post-publish

After the workflow completes successfully:

1. **Verify the new version is live:**
   ```
   curl -sS "https://registry.npmjs.org/@run402/astro/<new_version>" | jq -r .version
   ```
   The user's local npm may have a `--before` date pin set as a supply-chain mitigation that filters out newly-published packages from `npm view`. Use direct `curl` to confirm registry state. If the user wants to see it via `npm view`, they need `--before=9999-12-31` (do NOT suggest changing their global config).

2. **Confirm provenance attestation:**
   ```
   curl -sS "https://registry.npmjs.org/@run402/astro/<new_version>" | jq '.dist.attestations'
   ```
   Should return a non-null object. If null, OIDC didn't kick in and the publish silently fell back to anonymous — investigate.

3. **Print summary** for the user:
   - Published version
   - npm URL: `https://www.npmjs.com/package/@run402/astro/v/<new_version>`
   - Workflow run URL
   - GitHub release URL: `https://github.com/kychee-com/run402/releases/tag/v<new_version>-astro`

## What this skill does NOT do

- Does NOT publish locally via `npm publish`. The Trusted Publisher OIDC trust ONLY accepts publishes from THIS workflow file on `main`. Attempting a local publish would fail the npm-side claim check (or succeed only if the user has an unrelated bypass-2FA token, which defeats the whole point).
- Does NOT bump `mcp`, `cli`, `sdk` — those lockstep via `/publish`.
- Does NOT bump `@run402/functions` — that lives in the private gateway monorepo.
- Does NOT pull a release branch — the workflow operates on `main` directly. Use a feature branch for the code change, merge to main, then run this skill.
- Does NOT prompt for an OTP or token. If you ever see the workflow asking for one, the Trusted Publisher config drifted — fix the npm-side config rather than reverting to token auth.

## Troubleshooting

- **Workflow fails at `Publish to npm` with 401 or 403:** Trusted Publisher config doesn't match. Check the npm package access page — org / repo / workflow filename must exactly match this workflow's metadata.
- **Workflow fails at `Commit version bump` with permission denied:** Repo Settings → Actions → General → Workflow permissions → must be "Read and write." The default GITHUB_TOKEN's permissions are read-only unless this is flipped.
- **Workflow fails at `Tarball smoke test` after a successful publish-in-progress:** the tarball was generated incorrectly. Recover by manually patching `astro/package.json` to bump the version back (workflow had already bumped locally on the runner but not committed) and re-run. The npm-side already-published version blocks re-publish, which is the safety net.
- **`npm view` returns 404 right after a successful publish:** almost always the user's `--before` date pin filtering, not a real propagation issue. Confirm with the direct `curl` against `registry.npmjs.org`.
