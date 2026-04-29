---
name: bugs
description: Automated bug triage and fix pipeline. Fetches open GitHub Issues, performs root cause analysis, writes failing tests, fixes bugs in isolated worktrees, and publishes. Use when the user says /bugs, "check for bugs", "triage bugs", or "fix reported issues".
---

# /bugs - Triage, Fix, Publish

Autonomous bug triage pipeline for `run402-mcp`. Fetches all open GitHub issues, analyzes root causes, fixes what can be fixed, and publishes.

Execute all steps in order. Do NOT ask for confirmation until Step 6.

Note: this package is a client-side MCP server / CLI with no server-side error telemetry, so there is no Bugsnag source. GitHub issues on `kychee-com/run402` are the only bug source.

## Step 0: Sync with remote

Before analyzing any issues, make sure the local `main` branch is up to date with the remote. A stale local branch leads to wasted analysis, version-bump collisions at publish time, and worktrees that rebase poorly.

```
git fetch origin main
git status
```

If the working tree is clean and local `main` is behind `origin/main`, fast-forward: `git pull --ff-only origin main`.
If there are uncommitted changes, stop and tell the user before continuing.
If `main` has diverged (local commits that aren't on remote), stop and ask the user how to proceed — do not auto-rebase or force-push.

## Step 1: Fetch all open bugs

### GitHub issues

`gh issue list` defaults to 30 results and silently truncates the rest — pass `--limit` high enough to cover the full backlog and paginate internally:

```
gh issue list --repo kychee-com/run402 --state open --limit 1000 --json number,title,body,labels,createdAt
```

If the result count equals the limit, the backlog may be larger — re-run with `gh api "/repos/kychee-com/run402/issues?state=open&per_page=100" --paginate --jq '[.[] | select(.pull_request | not) | {number, title, body, labels, createdAt: .created_at}]'` (the REST endpoint mixes issues and PRs, so the `select(.pull_request | not)` filter is required) and proceed with the full list.

### Build unified list

Assign each issue an ID for reference throughout the pipeline:
- GitHub issues: `GH-<number>` (using the actual issue number)

Ignore issues labelled `feature-request`, `enhancement`, `question`, or `discussion` - this pipeline only triages bug reports.

If zero bug-type issues found, report "No open bugs" and stop.

## Step 2: Root cause analysis

For each bug:

1. Read the issue title, body, and any reproduction steps or stack traces
2. Trace through the source code. Relevant roots in this monorepo:
   - `src/` - MCP server entry + tool handlers
   - `core/src/` - shared logic (config, client, keystore, allowance, allowance-auth)
   - `cli/lib/` - CLI command modules (`*.mjs`)
   - `openclaw/scripts/` - OpenClaw skill shims (`*.mjs`, usually re-export from `cli/lib/`)
3. Check git log to see if the relevant code has already been changed
4. **Ask: where does the root cause OPTIMALLY live?** Not "where *can* I patch it" — where does the fix belong architecturally. This repo (`run402-public`) is a thin client over a server API. The server lives in `~/Developer/run402-private` (GitHub: `kychee-com/run402-private`). If the symptom surfaces in the CLI/MCP but the clean fix is server-side (API contract, error-body shape, auth model, pricing logic, rate limits, payment flow, etc.), the bug belongs in the private repo. **Do NOT patch the client to compensate for a non-optimal server response, even if you can.** Client-side band-aids ossify bad server contracts — every consumer (CLI, MCP, OpenClaw, third-party integrations) then has to reimplement the same workaround. Example from v1.35.1 triage: the image endpoint returned a bare 402 with no error body. The CLI *could* have added a hardcoded "check your allowance" hint on empty 402s, but that would hide the real issue (server not returning `message`/`hint`/`accepts`) and only patch one of the three consumers. That bug was moved to the private repo so the server can be fixed once for all clients.
5. Categorize into exactly one bucket:

| Category | Criteria | Action |
|----------|----------|--------|
| `already-fixed` | Code already changed, or a release was published that contains the fix | Close |
| `not-a-bug` | Expected behavior, environment issue, or user error | Close with explanation |
| `wrong-repo` | Symptom is here but root cause OPTIMALLY belongs in `run402-private` (server API, backend logic, infra) | Move to private repo, close here with pointer |
| `needs-spec-change` | "Bug" is actually missing functionality or a design decision | Flag as feature request - do NOT fix |
| `fixable` | Real code bug with a clear client-side fix (the root cause genuinely lives in this repo) | Spawn fix agent |

Print a summary table as you go so progress is visible.

## Step 3: Close resolved bugs, move wrong-repo bugs, flag feature requests

### Already-fixed / not-a-bug

```
gh issue close <NUMBER> --repo kychee-com/run402 --comment "<one-line explanation>"
```

### Wrong-repo (server-side root cause)

Create a new issue in the private repo with the full reproduction, then close the public issue with a pointer:

```
gh issue create --repo kychee-com/run402-private --title "<original title>" --body "Moved from kychee-com/run402#<NUMBER> — root cause is server-side (<one-line why>).

<original body>

## Where to fix
<one or two sentences on which server module / endpoint owns the fix, and what the corrected behavior should look like>"
gh issue close <NUMBER> --repo kychee-com/run402 --comment "Moved to private repo for server-side fix: kychee-com/run402-private#<N>. <one-line on why the client-side workaround is not the right layer>"
```

Do NOT also ship a client-side band-aid unless the user explicitly asks for one. Move the bug and move on.

### Needs-spec-change

Add label and comment, do NOT close:

```
gh issue edit <NUMBER> --repo kychee-com/run402 --add-label "feature-request"
gh issue comment <NUMBER> --repo kychee-com/run402 --body "Triaged as feature request: <explanation>"
```

If no fixable bugs remain, skip to Step 5.

## Step 4: Fix bugs in isolated worktrees

For each fixable bug, launch an Agent tool call with `isolation: "worktree"`. Launch all fixable bugs in parallel (single message, multiple Agent tool calls).

Each agent prompt MUST be self-contained - include the literal issue title, reproduction steps, file paths with line numbers, and root cause analysis. The agent has no access to this conversation's context.

**Agent prompt template:**

    Fix bug {ID}: {issue title}

    Repro / symptom: {from the issue body}
    Root cause: {analysis}
    Files: {file paths with line numbers}

    Steps:
    1. Write a failing test in the appropriate test file. Follow the existing pattern for the area:
       - `src/tools/*.test.ts` or `core/src/*.test.ts` - Node `node:test` + `assert` + `mock.module`, TypeScript via `tsx`
       - `cli-e2e.test.mjs` - CLI end-to-end tests (plain `node --test`, no `tsx`)
    2. Run the test to confirm it fails:
       - TS unit test: `node --experimental-test-module-mocks --test --import tsx <test-file>`
       - CLI e2e: `node --test <test-file>`
    3. Implement the fix in the source file. Respect the shared-core pattern: if the bug is in `core/src/`, fix it there and rebuild; MCP/CLI/OpenClaw should not diverge.
    4. Run the test again to confirm it passes
    5. Run typecheck: `npx tsc --noEmit && npx tsc --noEmit -p core/tsconfig.json`
    6. Run the full build: `npm run build`
    7. Run the full test suite: `npm test`
    8. If all pass, commit with message: `fix(<scope>): <description>`
       Add `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>` to the commit.
    9. If any step fails, do NOT commit. Report what went wrong.

    IMPORTANT:
    - Never use `$()` command substitution in shell commands. Run commands separately and use literal values.
    - If you add a new MCP tool or CLI command as part of the fix, update the `SURFACE` array in `sync.test.ts` so `npm run test:sync` passes.

If more than 10 fixable bugs are found, warn the user and suggest batching before spawning agents.

## Step 5: Report

After all agents complete (or if there were no fixable bugs), present the full report:

```
## Bug Triage Report

### Summary
- Total: N open GitHub issues
- Closed (already-fixed): N
- Closed (not-a-bug): N
- Moved to private repo (server-side root cause): N
- Feature requests (flagged): N
- Fixes ready: N
- Fix failures: N

### Fixes Ready to Merge
| ID | Title | Worktree Branch | Test | TSC | Build | npm test |
|---|---|---|---|---|---|---|

### Failed Fixes (if any)
| ID | Title | What went wrong |
|---|---|---|

### Moved to Private Repo
| ID | Title | Destination | Why server-side |
|---|---|---|---|

### Closed Bugs
| ID | Title | Reason |
|---|---|---|

### Feature Requests (not auto-fixed)
| ID | Title | Recommendation |
|---|---|---|
```

If there are no fixes to merge, stop here.

## Step 6: User decision

Use AskUserQuestion with these options:
- **Merge all** - merge all ready fixes, publish, and close issues
- **Exclude specific bugs** - let the user type which bug IDs to skip
- **Merge only, skip publish** - land the fixes on `main` without cutting a new release

Wait for the user's response before proceeding.

## Step 7: Merge, publish, close

### 7a. Merge fix branches

For each included fix, the Agent tool with `isolation: "worktree"` returns the worktree path and branch name. Merge each branch into the current branch:

```
git merge <branch-name> --no-edit
```

If a merge conflict occurs, stop and report which branches conflict. Let the user resolve manually.

### 7b. Publish (if the user chose to publish)

Invoke the publish skill:

```
Use the Skill tool: Skill(skill: "publish")
```

The publish skill runs pre-publish checks (clean tree, `npm test`, `npm run build`), bumps versions in both `package.json` files, and publishes `run402-mcp` and `run402`. It will ask for the bump type (patch/minor/major) - recommend `patch` for pure bug fixes.

### 7c. Close fixed bugs

After a successful merge (and publish, if applicable):

```
gh issue close <NUMBER> --repo kychee-com/run402 --comment "Fixed in <commit-hash>, released in v<version>"
```

If the user chose "merge only, skip publish", drop the "released in" clause.

### 7d. Clean up

Excluded fix worktrees are kept (user can revisit). Merged worktrees are cleaned up automatically by the Agent tool.

Report final summary: which bugs were fixed, merged, published (if applicable), and closed.
