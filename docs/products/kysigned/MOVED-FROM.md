# kysigned docs moved

**As of 2026-04-16**, all `kysigned` product docs (spec, plan, consultations, ideas, research, scripts) have been relocated to the kysigned-private repository.

## New locations (in `kychee-com/kysigned-private`)

| Old path (this repo) | New path (kysigned-private) |
|---|---|
| `run402/docs/products/kysigned/kysigned-spec.md` | `kysigned-private/docs/product/kysigned-spec.md` |
| `run402/docs/plans/kysigned-plan.md` | `kysigned-private/docs/plans/kysigned-plan.md` |
| `run402/docs/products/kysigned/zkprover/zkprover-spec.md` | `kysigned-private/docs/product/zkprover/zkprover-spec.md` |
| `run402/docs/products/kysigned/zkprover/plans/*` | `kysigned-private/docs/plans/` |
| `run402/docs/products/kysigned/zkprover/research/*` | `kysigned-private/docs/product/zkprover/research/` |
| `run402/docs/products/kysigned/consultations/*` | `kysigned-private/docs/consultations/` |
| `run402/docs/consultations/kysigned-*.md` | `kysigned-private/docs/consultations/` |
| `run402/docs/consultations/cfdkim-zk-soundness-review.md` | `kysigned-private/docs/consultations/` |
| `run402/docs/consultations/zk-email-rust-ecosystem-survey.md` | `kysigned-private/docs/consultations/` |
| `run402/docs/products/kysigned/ideas/*` | `kysigned-private/docs/ideas/` |
| `run402/docs/products/kysigned/research/*` | `kysigned-private/docs/research/` |
| `run402/docs/products/kysigned/scripts/research/*` | `kysigned-private/docs/scripts/research/` |

## Why

Per the updated saas-factory bootstrap policy (v1.16.0): **product docs live in the product's private repo**, not in run402. The earlier practice of parking docs in run402 was a bootstrap shortcut for products that didn't have a repo yet. kysigned has both public (`kychee-com/kysigned`) and private (`kychee-com/kysigned-private`) repos, so its docs belong in the private repo.

## Git history

Pre-2026-04-16 file history remains in run402's git log (e.g., `git log --follow --all -- docs/products/kysigned/kysigned-spec.md` in this repo will show the full pre-move history). Post-2026-04-16 history is in kysigned-private. The move was a **simple copy, not a filter-repo** — the destination repo's git log starts fresh from the move date.
