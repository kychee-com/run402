## Why

The five agent-facing docs (`llms.txt`, `cli/llms-cli.txt`, `sdk/llms-sdk.txt`, `llms-mcp.txt`, `SKILL.md`) are authored in this public repo but reach the web only through the **private** `run402-private` marketing deploy: a deploy-time fetch (`scripts/sync-agent-docs.mjs` pulls them from `raw.githubusercontent.com`) → `apps/marketing/` → `aws s3 sync` → CloudFront → `run402.com`, kicked off by a cross-repo `repository_dispatch: public-docs-updated` fired from this repo's `/publish` skill.

So docs liveness depends on the private AWS pipeline, the marketing build ordering, and a dual-repo dispatch — and none of the docs are hosted on run402 itself. We want the public repo to own publishing end-to-end and to dogfood run402's own static hosting + GitHub OIDC CI, while keeping the discovery layer off the platform it advertises.

## What Changes

- **Split the agent-doc surface by role (Option C — hybrid):**
  - **Keep on apex `run402.com`** (still served by the private CloudFront): the `llms.txt` wayfinder and `/.well-known/agent-skills/index.json`. The discovery entry points must not depend on the platform they advertise.
  - **Move to a new run402-hosted static site at `docs.run402.com`:** the three heavy per-surface references (`llms-cli.txt`, `llms-sdk.txt`, `llms-mcp.txt`) and `SKILL.md`.
- **BREAKING (agent-facing URL move):** the canonical URLs for the four moved docs change from `https://run402.com/<doc>` to `https://docs.run402.com/<doc>`. Old apex paths SHOULD keep working via redirect for back-compat (mechanism decided in `design.md`), but the advertised/canonical URLs move.
- Rewrite the apex `llms.txt` wayfinder so it points agents at `docs.run402.com` for the deep references.
- Publish the docs site from **this repo's own GitHub Actions** via run402 OIDC CI (`run402 ci link github` → `run402 deploy apply`), using explicit `site.public_paths` for the stable latest URLs (`/llms-cli.txt`, …). The docs site does **not** mint per-version URLs — the public repo's git tags already provide immutable, content-pinned permalinks for free (`raw.githubusercontent.com/kychee-com/run402/v<version>/…`).
- Make this repo authoritative for the discovery index: the index's `url` for `SKILL.md` becomes `https://docs.run402.com/SKILL.md`, and the `sha256` digest is produced here (the private apex deploy stops fetching `SKILL.md` to compute it).
- Update in-repo self-references (~27 occurrences) so links to the *moved* docs point at `docs.run402.com` while links to the wayfinder / discovery index stay `run402.com`; update `documentation.md` canonicality rows and `sync.test.ts` assertions tied to the served path.
- One-time bootstrap: `run402 domains add docs.run402.com <subdomain>` + a DNS CNAME (`docs` → `domains.run402.com`). This DNS record is the only residual cross-repo/infra touch.

## Capabilities

### New Capabilities
- `agent-docs-distribution`: the client-facing contract for where each agent-facing doc is canonically served, how the apex `llms.txt` wayfinder points to the deep references, and the agent-skills discovery-index `url`/`digest` contract. This is the observable surface agents depend on; the deploy mechanics (OIDC CI, manifest shape, content-types) are implementation detail in `design.md`/`tasks.md`.

### Modified Capabilities
<!-- None. No existing spec governs doc distribution. The CI/deploy capabilities this change consumes — `ci-github-actions-dx`, `deploy-site-public-paths-client-surface` — are used as-is and their requirements do not change. -->

## Impact

- **This repo (primary):** a docs-site deploy manifest mapping the four moved docs to stable public paths; a new OIDC deploy workflow (`.github/workflows/deploy-docs.yml`); a discovery-index digest-emit step; ~27 self-reference URL edits across `cli/llms-cli.txt`, `sdk/llms-sdk.txt`, `llms-mcp.txt`, `SKILL.md`, `llms.txt`; `documentation.md` canonicality updates; `sync.test.ts` updates; the `/publish` skill's post-publish step.
- **run402 platform:** a new dedicated docs project, a custom domain `docs.run402.com`, and the DNS CNAME.
- **Agents / consumers:** the four deep-reference URLs move to `docs.run402.com` (back-compat redirect from apex decided in design); the wayfinder and discovery index keep their apex URLs.
- **Private repo `run402-private` (separate, tracked, out-of-band PR — NOT implemented by this change):** trim `scripts/sync-agent-docs.mjs` to the apex-retained files only (drop the four moved docs from `SOURCES`, keep `llms.txt` + index regeneration consuming the public-emitted digest), adjust `deploy-site.yml` ordering if needed, and remove the moved-file rows from `docs/agent-docs-sync.md`. Tracked here as an external dependency.
