---
name: upgrade-run402
description: Check private run402 changes and report what should flow into run402-public
---

Check what's changed in the private run402 repo since the last sync and determine if any changes need to flow into run402-public (CLI, MCP, or OpenClaw skill).

## Step 0: Update the private repo first

Before reading logs or classifying anything, make sure `~/Developer/run402-private` is current with its upstream:

```bash
cd ~/Developer/run402-private
git fetch origin
git status --short
git rev-list --left-right --count HEAD...origin/main
```

If local `main` is behind `origin/main`, pull before continuing:

```bash
cd ~/Developer/run402-private
git pull --ff-only --autostash
git rev-parse HEAD
git rev-parse origin/main
```

Continue only when `HEAD` equals `origin/main`. If the pull is blocked by local changes, untracked files, or an autostash conflict, stop and report:
- the current `HEAD`
- the `origin/main` commit
- the ahead/behind count
- the paths blocking the pull

Do **not** classify stale local commits as the latest private updates. If the repo cannot be pulled cleanly, the upgrade report must say that the private checkout is not current and no conclusions were made from stale `HEAD`.

## Step 1: Find the sync point

Read the memory file `project_last_integration.md` to get the last known sync commits. If no memory exists, fall back to comparing recent git logs in both repos to find the divergence point.

## Step 2: Gather new commits from run402

```bash
cd ~/Developer/run402-private && git log --oneline --format="%h %ai %s" <last_synced_commit>..HEAD
```

If the last synced commit is missing (rebased/squashed), use `--since` with the sync date instead.

## Step 3: Classify each commit

For each new commit in run402, classify it:

| Category | Impact on run402-public? |
|----------|--------------------------|
| **gateway/API behavior change** | Maybe — if it changes request/response shapes the CLI/MCP sends or parses |
| **New API endpoint** | Yes — needs new CLI command + MCP tool + OpenClaw shim |
| **Changed API endpoint** | Maybe — if request/response schema changed |
| **Infra/CDK/deploy** | No |
| **Lambda runtime/layer** | No (but docs may need updating if getUser/db API changed) |
| **Docs (site/llms.txt)** | Check — if it documents new API behavior, the public `SKILL.md` / `cli/llms-cli.txt` may need updating (both now live in this public repo; private-site sync pulls them automatically at deploy time) |
| **OpenSpec artifacts** | No |
| **Tests** | No |
| **CORS/auth/middleware** | No (server-side only) |

Focus on commits that touch `packages/gateway/src/routes/`, `packages/gateway/src/services/`, or `site/llms.txt`. (`site/llms-cli.txt` and `site/SKILL.md` in the private repo are build artifacts — the canonical copies live in this public repo under `cli/llms-cli.txt` and `SKILL.md`.)

## Step 4: Deep-dive impactful changes

For each commit classified as "Yes" or "Maybe":

```bash
cd ~/Developer/run402-private && git show --stat <commit>
cd ~/Developer/run402-private && git show <commit> -- <relevant_files>
```

Determine specifically:
- Does this add/change/remove an API endpoint?
- Does this change request or response shape?
- Does this affect what the CLI/MCP needs to send or parse?
- Does this affect documentation accuracy?

## Step 5: Present the upgrade report

Show a summary table:

```
## Upgrade Report: run402 → run402-public

Last sync: <date> (run402-public: <commit>, run402: <commit>)
New commits in run402: <count>

### Changes requiring action

| Commit | Description | Action needed |
|--------|-------------|---------------|
| abc123 | Added /foo endpoint | New CLI command + MCP tool |

### Server-side only (no action needed)

| Commit | Description | Why no action |
|--------|-------------|---------------|
| def456 | CDN edge caching | Infra only |

### Documentation updates needed

| What changed | Where to update |
|-------------|-----------------|
| getUser returns email | SKILL.md runtime section |
```

## Step 6: Enter explore mode if there are impactful changes

If any changes require action, offer to enter `/opsx:explore` to think through the implementation:

> "There are N changes that need to flow into run402-public. Want to explore any of these in detail? I can enter explore mode to think through the design."

If the user agrees, invoke `/opsx:explore` with a summary of the impactful changes as context.

## Step 7: Update the memory

After presenting the report, update `project_last_integration.md` with the new HEAD commit from run402 as the latest reviewed point (even if no changes were synced — this tracks what's been *reviewed*, not what's been *synced*). Only update the "last synced" commits when changes are actually published to run402-public.
