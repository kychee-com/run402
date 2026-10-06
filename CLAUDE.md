@AGENTS.md

## Git workflow — worktrees, never branches

Multiple agent sessions work these repos in parallel. Isolation is by **git
worktree**, not by branching or stashing.

- **ALWAYS worktree.** Do work inside a dedicated worktree (`git worktree add`).
  Never edit, branch-switch, or otherwise disturb a shared checkout — another
  session may be using it, and switching branches under them destroys their work.
- **Worktrees live under their repo's own `.claude/worktrees/<name>`.** `git -C <repo> worktree add <repo>/.claude/worktrees/<name> origin/main --detach` — never `../<repo>-wt-*` or anywhere else in `~/Developer`. This holds when a session working in one repo needs to fix another (run402-private ↔ run402-public ↔ run402-core): the worktree goes under the TARGET repo, and is removed once its commits are on `main`.
- **NEVER create branches.** No feature-branch or PR ceremony on your own
  initiative. A worktree's auto-created backing branch is plumbing, not workflow.
- **NEVER `git stash`.** It is invisible to everyone else and easy to lose.
- **Small changes commit directly to `main`, no ceremony.** From a worktree,
  push with `git push origin HEAD:main` (expect to rebase).
- If you find yourself on a branch in a primary checkout, you are already in the
  wrong place — make a worktree and clean up after yourself.
