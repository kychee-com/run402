## Context

Today the five agent-facing docs are authored here but published only through `run402-private`: `scripts/sync-agent-docs.mjs` fetches them from `raw.githubusercontent.com/kychee-com/run402/main`, writes them into `apps/marketing/`, regenerates `apps/marketing/.well-known/agent-skills/index.json` with a fresh `sha256` of `SKILL.md`, then `aws s3 sync … → S3 → CloudFront (E1FX7YW8K8VPR) → run402.com`. The redeploy fires from a `repository_dispatch: public-docs-updated` sent by this repo's `/publish` skill.

This change keeps the **discovery layer** (`llms.txt` wayfinder + `/.well-known/agent-skills/index.json`) on the apex (private CloudFront) and moves the **deep references** (`llms-cli.txt`, `llms-sdk.txt`, `llms-mcp.txt`, `SKILL.md`) to a run402-hosted static site at `docs.run402.com`, deployed from this repo via run402's own GitHub OIDC CI. Constraints: the discovery layer must not depend on the run402 platform; the discovery-index digest must keep matching the served `SKILL.md`; and we must not strand externally cached `run402.com/<doc>` links.

## Goals / Non-Goals

**Goals:**
- Public repo owns publishing the deep references end-to-end, with no AWS creds and no required private-repo step (only a one-time DNS record).
- Dogfood run402 static hosting + `run402 ci link github` OIDC deploy.
- Stable (latest) URLs for each moved doc, served with correct content types.
- Discovery index stays apex-served, public-repo-authoritative for its digest, and never drifts from the served `SKILL.md`.
- Old apex URLs for moved docs keep resolving (redirect).

**Non-Goals:**
- **Per-version immutable URLs on the docs site.** Git tags already provide free, immutable, content-pinned permalinks (`raw.githubusercontent.com/kychee-com/run402/v<version>/<path>`); minting `/v/<version>/` paths on the docs site would only add manifest growth and carry-forward complexity for near-identical bytes (see D3).
- Moving the `llms.txt` wayfinder, the discovery index, `llms-full.txt`, `openapi.json`, the extensionless `.well-known/api-catalog`, or any marketing/legal page off the apex.
- Hosting `run402.com` itself on run402 (bigger bootstrapping question).
- Implementing the `run402-private` cleanup. That is a tracked external follow-up PR (see Migration Plan).

## Decisions

### D1 — Discovery index is a committed, test-verified file in the public repo; the apex copies it verbatim

The public repo owns `.well-known/agent-skills/index.json` as a **committed file**, with `skills[0].url = https://docs.run402.com/SKILL.md` and `digest = sha256:<hex of this repo's SKILL.md bytes>`. A small generator (`scripts/build-agent-skills-index.mjs`, ported from the private `sync-agent-docs.mjs` logic) reads `SKILL.md`, computes the digest, and writes the index. A `sync.test.ts` assertion enforces `index.digest === sha256(SKILL.md)` so drift fails CI in the authoritative repo. The private apex deploy then **fetches this complete `index.json` verbatim** (no recomputation) and serves it at `run402.com/.well-known/agent-skills/index.json`.

- **Alternatives considered:** private keeps recomputing the digest from a fetched `SKILL.md` but rewrites `url` (rejected — keeps digest logic split, re-introduces drift); serve the index from `docs.run402.com` (rejected — violates "discovery off-platform").
- **Why:** single source of truth for both index content and digest; the private side becomes a dumb copy; digest/`SKILL.md` match is guaranteed at the git ref.
- **Trade-off:** the apex `index.json` is only as fresh as the last apex deploy; `/publish` must still poke the apex when `SKILL.md`/`index.json` change (D4).

### D2 — Dedicated docs project, deployed via OIDC `run402 ci link github`, push-to-main path-filtered

A dedicated run402 project hosts the docs site. **Provisioned: `run402-docs` = `prj_1780488560350_0018`, owned by the default wallet (`0xaD17…8874`), under your Team billing account (tier is a billing-account property — not per-project, not per-wallet).** A human runs `run402 ci link github --project prj_1780488560350_0018 --route-scope /llms-cli.txt --route-scope /llms-sdk.txt --route-scope /llms-mcp.txt --route-scope /SKILL.md` to mint the OIDC binding and generate `.github/workflows/deploy-docs.yml`. The workflow runs `run402 deploy apply --manifest <docs-manifest> --project <docs-project>` under GitHub OIDC (`id-token: write`), no stored run402 secret. Trigger: **push to `main`** touching `cli/llms-cli.txt`, `sdk/llms-sdk.txt`, `llms-mcp.txt`, `SKILL.md`, or the manifest. Decoupled from `/publish`.

- **Alternatives considered:** a step inside `/publish` (rejected — couples docs liveness to the release flow and the operator's local `gh`/wallet); a hand-run `deploy.ts` SDK script like the private repo's `apps/console`/demos (rejected — those are manual, not push-triggered, and the console's own comment flags it as a launch-time shortcut to harden later; for the *public* repo, deploying via `run402 ci link github` OIDC is a live dogfood of the exact CI flow we ship to external devs). Path-filtered push-to-main is self-serve and fires on doc edits that aren't releases.
- **Why:** matches `ci-github-actions-dx` (a capability we already ship); zero long-lived secrets; the public repo is fully self-sufficient.
- **Trade-offs:** the OIDC binding is signed by one human's allowance wallet at link time — document the owning wallet so it can be re-linked. Docs availability now tracks run402 uptime (acceptable for deep refs; discovery stays on apex). `docs.run402.com` is a reserved `*.run402.com` subdomain (O1): bind it by un-reserving `docs` (operator-side) then claiming, or via a non-reserved alternative — no custom domain or external DNS involved.

### D3 — Stable paths only; immutable version pins come from git tags, not the docs site

The manifest's `site.public_paths` (explicit mode) maps the stable paths (`/llms-cli.txt` → `llms-cli.txt`, etc.), always replaced to the latest bytes. The docs site mints **no** per-version URLs.

- **Why (this reversed an earlier draft):** docs change trivially between most releases, so per-release `/v/<version>/` snapshots add a growing `public_paths` table, carry-forward logic, and a retention policy — all for near-duplicate bytes. The immutable-pin use case is already covered for free by the public repo's git tags: `https://raw.githubusercontent.com/kychee-com/run402/v2.33.1/cli/llms-cli.txt` is permanent and content-pinned with zero deploy machinery.
- **Alternatives considered:** per-release `/v/<version>/` carry-forward (rejected — complexity/bloat for low value); the CAS content-addressed `immutableUrl` the deploy returns (rejected as a public permalink — not CDN-fronted today per `cli/llms-cli.txt:1126`).
- **Trade-off:** a run402-branded immutable URL isn't offered. If that's ever wanted, it's a purely additive fast-follow (mint `/v/<version>/` on release tags) — nothing here precludes it.

### D4 — `/publish` retains only the apex dispatch; docs deploy is independent

`/publish` keeps firing `repository_dispatch: public-docs-updated` so the apex refreshes `llms.txt` + the verbatim `index.json`. It gains no responsibility for the docs site (push-triggered, D2). Net: `/publish` does *less* coupling work, not more.

### D5 — Content types are correct out of the box (O1 resolved)

**Verified on live run402 static hosting** (probe deploy to `prj_1780488560350_0018`, `curl -I`):

| Path | Served `Content-Type` |
|------|------------------------|
| `probe.md` | `text/markdown; charset=utf-8` |
| `probe.txt` | `text/plain; charset=utf-8` |
| `index.html` | `text/html; charset=utf-8` |

The gateway's static MIME table maps `.md → text/markdown` and `.txt → text/plain` by extension, matching the content types the private CloudFront sets today. **No per-path content-type override and no gateway MIME change are needed.** (Observed cache headers for `.md`/`.txt`: `public, max-age=300, stale-while-revalidate=3600` — fine for docs.) A `curl -I` content-type assertion will be kept as a post-deploy smoke check to guard against regression.

## Risks / Trade-offs

- **[Wayfinder/self-refs flipped before the docs site is live → broken links / digest mismatch]** → Deploy and `curl -I`-verify `docs.run402.com` first; only then land the wayfinder rewrite, the self-ref URL edits, and the `index.json` `url` change (Migration Plan ordering).
- **[Old apex URLs 404 until the private redirect lands]** → Sequence the private follow-up to land the redirect at/just-after the public cutover; the wayfinder + npm READMEs already route live agents to the new URLs, so only hard-coded/cached links are exposed in the gap.
- **[Custom-domain availability]** → O1: tier is a **billing-account** property (your account is Team), not per-project/per-wallet, so a custom domain should be available — confirm when running `domains add`. Static docs are tiny, so cost is negligible.
- **[OIDC binding tied to one wallet]** → document the owning wallet (default, `0xaD17…8874`); `run402 ci revoke` + re-link is the recovery path.

## Migration Plan

1. **Provision (one-time):** ✅ docs project (`run402-docs` = `prj_1780488560350_0018`, default wallet). ✅ OIDC binding + `deploy-docs.yml` via `run402 ci link github` (branch `main`, docs manifest, 4 route-scopes). Remaining: bind `docs.run402.com` — a plain subdomain claim (no custom domain / DNS), but `docs` is reserved, so un-reserve it (operator) then `run402 subdomains claim docs`, or pick a non-reserved alternative.
2. **Add manifest + index generator + workflow** in this repo (no URL flips yet). Content-type is already confirmed (D5) — keep a `curl -I` smoke check.
3. **First real docs deploy** → stable paths live at `docs.run402.com`, replacing the probe content. Verify all four docs + content-types.
4. **Flip the apex-facing surface in one PR:** rewrite the `llms.txt` wayfinder to point at `docs.run402.com`; update the ~27 in-repo self-refs per the moved-vs-discovery rule; set `index.json` `url → https://docs.run402.com/SKILL.md` and regenerate the digest; update `documentation.md` canonicality rows; update/repoint `sync.test.ts`.
5. **`/publish`** (or a manual apex dispatch) refreshes the apex with the new `llms.txt` + verbatim `index.json`.
6. **Tracked follow-up PR in `run402-private`** (out of band): trim `scripts/sync-agent-docs.mjs` to the apex-retained files (drop the four moved docs from `SOURCES`; fetch `index.json` verbatim); add an apex CloudFront redirect for the four old `run402.com/<doc>` paths → `docs.run402.com/<doc>`; remove the moved-file rows from `docs/agent-docs-sync.md`.

**Rollback:** revert the step-4 PR; the apex private deploy keeps serving the previous `llms.txt`/`index.json`, and the `docs.run402.com` site can stay up harmlessly (nothing points at it). No data migration to undo.

## Open Questions

- **O1 — `docs` subdomain is reserved.** Empirically `*.run402.com` is wildcard-routed to the platform (`docs.run402.com` already resolves, returns 404 = unclaimed), so `docs.run402.com` is a plain subdomain claim — no custom domain, no manual DNS. But `docs` is a gateway-**reserved** subdomain. Resolve by un-reserving `docs` (operator-side gateway config) then `run402 subdomains claim docs`, or by claiming a non-reserved alternative subdomain.
- **O2 — DNS ownership.** Dissolved. `docs.run402.com` rides run402's own `*.run402.com` wildcard (run402-managed zone); no external/registrar DNS record is needed.
- **O3 — `sync.test.ts` MCP-coverage assertion.** It currently keys off a `run402-private` `site/llms.txt` path (now stale — private moved to `apps/marketing/`). Repoint it to verify the public repo's own `llms-mcp.txt` tool coverage instead of reaching into a sibling checkout.

**Resolved during proposal:** content-type for `.md`/`.txt` on run402 static hosting (D5).
