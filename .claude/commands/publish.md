# /publish — Lockstep publish run402-mcp + run402 + @run402/sdk via OIDC

Trigger the canonical publish pipeline at `.github/workflows/publish.yml`. The workflow handles version bump, tarball smoke test, three npm publishes (via OIDC Trusted Publisher — no stored tokens), commit-back to main, tag, and GitHub release. This skill is your local-machine wrapper around `gh workflow run`.

> **Why CI-driven, not local-publish:** each of `run402-mcp`, `run402`, and `@run402/sdk` has npm Trusted Publisher OIDC federation configured. The npm settings page for each package lists this repository, branch, and workflow filename as a trusted publisher. Any publish attempted from anywhere else (a developer laptop, a fork, a different workflow file) fails the npm-side claim check. The whole point of OIDC is to remove the "do you have a token" question — only this workflow file running on main can publish.

> **`@run402/functions` is NOT published here.** That package ships from `kychee-com/run402-private` (`packages/functions/`) via `/publish-functions` in that repo. The gateway and the in-function helpers live in the same monorepo there so they can be tested together. Only the source of truth moved — the npm package name stays `@run402/functions`.

> **`@run402/astro`** ships via `/publish-astro` (its own OIDC workflow at `.github/workflows/publish-astro.yml`). Independent release train.

**Lockstep only.** The workflow bumps and publishes all three packages at the same version. There is no subset release path through OIDC — running `npm publish` locally for one package would fail the Trusted Publisher claim check (or succeed only via an OTP-elevated bypass token, which defeats the security model). If you genuinely need to ship one package without the others, extend the workflow with a selective input — do not fall back to a local publish.

Stop on any failure. Do NOT skip checks.

## Pre-flight (local, before triggering the workflow)

These run on your machine to catch obvious problems before the workflow burns Actions minutes:

1. **Verify you are on `main` and fully in sync with `origin/main` in BOTH directions.** Run `git rev-parse --abbrev-ref HEAD` — if the output is not `main`, **STOP IMMEDIATELY**. Tell the user: "You're on branch `<branch>`, not `main`. Releases must be cut from `main` so the tag matches the published commit and the private-repo docs deploy picks it up. Merge the branch first, then re-run `/publish`." Do not offer to switch branches or merge for them. Then run `git fetch origin main` and check BOTH directions:
   - **Behind:** `git rev-list --count HEAD..origin/main` — if non-zero, stop and tell the user `main` is behind `origin/main` and needs a pull. The workflow itself enforces `if: github.ref == 'refs/heads/main'`, but catching the mismatch locally avoids a wasted run.
   - **Ahead:** `git rev-list --count origin/main..HEAD` — if non-zero, **STOP IMMEDIATELY**. Local `main` has unpushed commits that the workflow will not see. The workflow checks out `origin/main` on the runner, so any unpushed work is invisible — you will publish a version without the changes the user thinks they're shipping. Tell the user: "You have N unpushed commits on `main`. The publish workflow builds from `origin/main`, so those changes will not be in the published tarball. Run `git push origin main` before re-running `/publish`." Run `git log --oneline origin/main..HEAD` to show them what would be missed. **This is the critical "ghost release" failure mode**: workflow succeeds, all three packages publish at the new version, but the published tarballs are byte-identical to the previous release except for the version bump. There is no recovery short of cutting another release.
2. **Working tree clean** (`git status`). Uncommitted changes are invisible to the workflow — it builds from the pushed commit. If the user has work in flight that they want included, commit + push it first. Note that "working tree clean" is necessary but not sufficient — step 1 also catches commits that are committed locally but unpushed.
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

## Social post (mini-article style)

**Skip for patch releases.** Patch bumps are bug fixes / internal changes and don't warrant a post. If the user picked `patch`, stop here — do not generate post options.

For `minor` or `major` releases, write a **mini-article social post on a related topic — NOT a tweet-sized release blurb, and NOT focused on what the release contains.** The release is the receipt, not the lede. This is the last thing you do.

### Why this shape

A "tweet-sized" release announcement ("v2.12.0 ships X") is forgettable. People scroll past version numbers. They DO read a small story that takes them somewhere they hadn't been. So: pick a general DX puzzle, web-platform quirk, or industry trade-off that this release happens to embody, walk through it warmly, mention the release as a one-line closing receipt.

### Structure — a 4-act mini-article

1. **Relatable hook.** Open with something the reader has already seen on the open web (a Medium-style image fade-in, a button that feels wrong, a deploy that took 40 minutes). One or two sentences. No jargon yet.
2. **Name the trick.** Give the underlying concept a name and explain it simply, enough for a beginner web dev to follow. Use plain numbers ("30 characters", "600 bytes", "~30ms"), not benchmarks. Avoid library namedrops beyond the one being named.
3. **The catch.** The cost or footgun the standard implementation has — the "obvious in hindsight" tension. Frame as a trade-off most platforms accept and you didn't.
4. **The fix + receipt.** The change in thinking, then ONE line of "shipped this in run402 today" as proof. Close on a general principle ("if you're decoding the same thing every render, you're doing it wrong"), not a feature.

### Voice

- **First person, sparingly.** One or two "I" beats land harder than constant ones — usually at the opener ("took me too long to see") or closer ("ship this once, save it forever"). Don't fabricate biographical details (specific years, project names, employers) — the reader can tell.
- Curious + warm, not promotional. The reader should feel they're learning, not being sold to.
- Concrete numbers beat vague claims. "30ms × 20 thumbnails = 600ms" beats "noticeable performance hit".
- No emdashes (per the user's global rule). Use regular dashes ` - `.
- No hashtags. No trailing version number. No "we just shipped" energy in the body — only as the small closing receipt.

### Length

Target ~1100-1400 chars (≈ 4x Twitter). Go shorter when the story is tight; up to ~1800 when substance earns it. Trim ruthlessly before sacrificing the arc.

### Optional code-snippet image

If a tight "what everyone does vs. what you should do" before/after fits the post, ship a carbon.now.sh image of it. Two short blocks, ~5 lines each, comments only where they earn the space. Skip imports and boilerplate that don't advance the contrast.

To generate the URL the user can click → Export → PNG, write the snippet to a temp file and run:

```bash
node -e 'const fs = require("fs"); const code = fs.readFileSync("/tmp/post-snippet.ts", "utf8"); const url = "https://carbon.now.sh/?bg=rgba(74,144,226,1)&t=one-dark&wt=none&l=typescript&width=680&ds=true&dsyoff=20px&dsblur=68px&wc=true&wa=true&pv=56px&ph=56px&ln=false&fl=1&fm=Hack&fs=14px&lh=152%25&si=false&es=2x&wm=false&code=" + encodeURIComponent(code); console.log(url);'
```

Skip the image entirely if the post is about infrastructure or process rather than a developer-facing API change — code would distract from the story.

### Delivery (per the user's global social-post rule)

1. Write the post to `/tmp/tweet.txt`.
2. Copy to clipboard with `pbcopy < /tmp/tweet.txt`.
3. Print a one-line confirmation (char count + "on clipboard").
4. **Do NOT render the post text inline in the chat** — the user pastes from the clipboard.
5. If you generated a carbon image URL, print it as a single clickable line.

### Options

Present 2-3 options ONLY if the angle is genuinely ambiguous. If you have a clear read on what story this release embodies, write one and offer to remix from feedback — don't burn cycles producing three variants of a story you already know is the right one.

### Example (what good looks like)

For a release that added pre-decoded blurhash placeholders to the SDK's AssetRef, the post led with the Medium-style image fade everyone has seen, named the trick (blurhash), explained the 30-char hash and its decode cost (~30ms × 20 thumbnails = 600ms of CPU just to render placeholders), surfaced the "decode once at upload, store the 600-byte data URL" fix, and closed with one line about run402 shipping it. ~1300 chars. Personal opener ("there's a tiny DX puzzle hiding inside it that took me too long to see") and principled closer ("if you're decoding the same thing every render, you're doing it wrong"). The release itself appeared in exactly one sentence near the bottom. Carbon image showed a 4-line "what everyone does" block above a 3-line "what you should do" block.

## Troubleshooting

- **Workflow fails at `Publish run402-mcp to npm` (or `run402` / `@run402/sdk`) with 401/403:** Trusted Publisher config doesn't match for that package. Check its npm access page — org / repo / workflow filename must exactly match this workflow's metadata. Note the workflow publishes the three packages in three separate steps; if only one fails, only that package's npm-side config is wrong.
- **Workflow fails at `Verify npm has OIDC publish support`:** the runner's npm is older than 11.5.1. The workflow pins Node 24 specifically because npm 10 (bundled with Node 22) can sign provenance attestations but cannot exchange OIDC tokens for an npm publish credential. Do not downgrade the Node pin.
- **Workflow fails at `Commit version bump` with permission denied:** Repo Settings → Actions → General → Workflow permissions → must be "Read and write." The default GITHUB_TOKEN's permissions are read-only unless this is flipped.
- **One package publishes but the others don't, leaving versions out of sync on npm:** the workflow publishes the three in sequence (mcp → cli → sdk). If mcp publishes successfully but the cli step fails (e.g., transient network), the run is in a partial state. Recover by manually re-running just the failed publish from a clean checkout — but only after confirming with the user that this falls under the "subset publish OK as a recovery" exception. Do not normalize this path.
- **`npm view <pkg>@<new_version>` returns 404 right after a successful publish:** almost always the user's `--before` date pin filtering, not a real propagation issue. Confirm with the direct `curl` against `registry.npmjs.org`.
- **"Ghost release" — workflow succeeded but the published tarballs are missing changes the user expected.** Almost always: the pre-flight ahead-of-origin check was skipped, and local `main` had committed-but-unpushed work at the time `/publish` triggered. The workflow checks out `origin/main` on the runner, so any commits not pushed at trigger time are absent from the build. Diagnose by running `git show v<new_version>:<path-to-changed-file>` against the just-cut tag and comparing to the local committed file. Recovery: push the missing commits, then cut a follow-up release (patch bump unless the missing changes warrant minor/major). Mark the empty version's GitHub release notes as a no-op and point to the follow-up. There is no way to re-publish over an existing npm version, so the empty version stays on the registry permanently.

## What this skill does NOT do

- Does NOT publish locally via `npm publish`. The Trusted Publisher OIDC trust ONLY accepts publishes from THIS workflow file on `main`. Attempting a local publish would fail the npm-side claim check (or succeed only with an unrelated bypass-2FA token, which defeats the whole point).
- Does NOT bump `@run402/astro` — that ships via `/publish-astro`.
- Does NOT bump `@run402/functions` — that lives in the private gateway monorepo and ships via `/publish-functions` there.
- Does NOT support subset releases (publish just `cli` without `mcp` and `sdk`). The workflow is lockstep-only — extend the workflow with a selective input if you need this.
- Does NOT prompt for an OTP or token. If you ever see the workflow asking for one, the Trusted Publisher config drifted — fix the npm-side config rather than reverting to token auth.
