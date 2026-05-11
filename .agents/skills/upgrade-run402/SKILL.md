---
name: upgrade-run402
description: Check the private run402 repo for changes that need to flow into run402-public. Use when the user says /upgrade-run402, asks to upgrade run402-public, or asks what changed in private run402 since the last sync.
---

# upgrade-run402

This skill exposes the repo's Claude `/upgrade-run402` workflow to Codex without
copying the procedure.

When this skill is triggered:

1. Read [upgrade-run402.md](upgrade-run402.md), which is a symlink to the repo's
   `.claude/commands/upgrade-run402.md`.
2. Follow that workflow exactly.
3. Stop on any failure or unmet precondition.
