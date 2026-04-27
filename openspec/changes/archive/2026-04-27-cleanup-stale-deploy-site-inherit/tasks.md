## 1. Spec edit

- [x] 1.1 Open `openspec/specs/incremental-deploy/spec.md` and remove the `### Requirement: Deploy a static site` block (header + scenarios) — describes the removed `deploy_site` `inherit` mechanism that 410-Gone'd in v1.32.
- [x] 1.2 Remove the `### Requirement: CLI sites deploy with --inherit flag` block (header + scenarios) — the CLI now actively rejects `--inherit`.
- [x] 1.3 Leave the three remaining requirements untouched (`Bundle deploy with inherit`, `Upload file shows public URL`, `CLI deploy manifest supports inherit`).

## 2. Validation

- [x] 2.1 Run `openspec validate cleanup-stale-deploy-site-inherit` and resolve any errors.
- [x] 2.2 Run `openspec archive cleanup-stale-deploy-site-inherit -y` to move the change to `openspec/changes/archive/<date>-cleanup-stale-deploy-site-inherit/`. Use `--skip-specs` if the parser quirk reported in the v1.32 handoff (REMOVED-against-legacy-delta-spec) trips on this archive; the spec edit in step 1 already does the canonical change.
