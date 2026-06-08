## 1. One-time provisioning (manual prerequisite, not code)

- [x] 1.1 Provision the dedicated docs run402 project — DONE: `run402-docs` = `prj_1780488560350_0018`, owned by the default wallet (`0xaD17…8874`), under the Team billing account (tier is account-level). (Currently serving placeholder probe content; replaced in 2.2.)
- [x] 1.2 Bind `docs.run402.com` — DONE: `docs` un-reserved (run402-private#466) + `subdomains claim docs`; docs.run402.com live. (DECIDED: un-reserve `docs`, keep the canonical URL.) `*.run402.com` is wildcard-routed to the platform — no custom domain, no DNS. `docs` is reserved in the gateway `BLOCKLIST` (`run402-private` `packages/gateway/src/services/subdomains.ts:27-34`). **Operator step (private repo + gateway redeploy):** remove `"docs"` from `BLOCKLIST` (or add a docs-project-scoped exception — removing it globally un-reserves `docs` for all projects, so claim immediately after redeploy). **Then I run:** `run402 subdomains claim docs --project prj_1780488560350_0018`.
- [x] 1.3 ~~DNS CNAME~~ — N/A: `docs.run402.com` rides run402's own `*.run402.com` wildcard; no external/registrar DNS record needed (O2 dissolved).
- [x] 1.4 Minted the OIDC binding (`bnd_85854647d23be56336860d795c34d002`, subject `repo:kychee-com/run402:ref:refs/heads/main`, 4 route-scopes, repo id 1173507078) and generated `.github/workflows/deploy-docs.yml` via `run402 ci link github --branch main --manifest run402.docs.deploy.json`.

## 2. Docs-site manifest (public repo)

- [x] 2.1 Add the docs deploy manifest with `site.replace` for the four moved docs and `site.public_paths` (explicit mode) mapping the stable paths `/llms-cli.txt`, `/llms-sdk.txt`, `/llms-mcp.txt`, `/SKILL.md`.
- [x] 2.2 First real deploy to `docs.run402.com` (replaces the probe content); `curl -I`-verify all four docs return 200 with the right content types (`text/markdown` for `SKILL.md`, `text/plain` for the `.txt` refs — already confirmed live in design D5, this is the smoke check).

## 3. Discovery index becomes public-repo-authoritative (public repo)

- [x] 3.1 Port the index generator into `scripts/build-agent-skills-index.mjs`: read `SKILL.md`, compute `sha256`, write `.well-known/agent-skills/index.json` with `skills[0].url = https://docs.run402.com/SKILL.md` and `digest = sha256:<hex>`.
- [x] 3.2 Commit the generated `.well-known/agent-skills/index.json` to the repo. (Generated; staged with the change — not yet `git commit`ed.)
- [x] 3.3 Add a `sync.test.ts` assertion that `index.json` digest equals `sha256(SKILL.md)` so drift fails CI in the authoritative repo. (Passing: `test:sync` 32/32.)

## 4. CI deploy workflow (public repo)

- [x] 4.1 Finalized `.github/workflows/deploy-docs.yml`: renamed "Deploy Docs Site", added push-to-`main` path filter (`cli/llms-cli.txt`, `sdk/llms-sdk.txt`, `llms-mcp.txt`, `SKILL.md`, manifest, workflow) → `run402 deploy apply`. `permissions: id-token: write`, no run402 secret.
- [x] 4.2 (DONE: #442/#443 auto-triggered Deploy Docs Site via OIDC, runs succeeded) Verify a push-to-main docs edit triggers the workflow and updates the stable paths end-to-end via OIDC (no stored secret used).

## 5. Cutover PR — flip the apex-facing surface (public repo; only AFTER 2–4 verify the docs site is live)

- [x] 5.1 Rewrite the `llms.txt` wayfinder so the deep-reference links use `https://docs.run402.com/<doc>`, keeping the wayfinder's own location and the discovery-index link on `run402.com`.
- [x] 5.2 Update the ~27 in-repo self-references (33 flipped via host-anchored substitution): links to the moved docs (`llms-cli/sdk/mcp.txt`, `SKILL.md`) → `docs.run402.com`; links to the wayfinder/discovery index → `run402.com`. Audit the exact occurrences (llms.txt ×8, mcp ×7, sdk ×6, cli ×3, SKILL ×3) and apply the moved-vs-discovery rule to each.
- [x] 5.3 Update `documentation.md`: the canonicality notes and the per-surface "Served at run402.com/…" rows now state the four moved docs are canonical at `docs.run402.com` and the wayfinder/index at `run402.com`.
- [x] 5.4 Resolve the stale `sync.test.ts` "llms.txt alignment" test (O3) — RESOLVED BY REMOVAL. Endpoint coverage is already owned (better) by `run402-private` `test/api-docs-alignment.test.ts` (gateway routes ↔ `llms-full.txt` ↔ `openapi.json`, both directions); the MCP-tool *set* is guarded by the live `SURFACE`↔`src/index.ts` checks. Deleted the redundant block + its now-unused `parseLlmsTxt*` helpers (183 lines). Optional public follow-up: an `llms-mcp.txt` tool-listing completeness check.
- [x] 5.5 Add a self-reference lint test: moved docs MUST NOT link to `run402.com/<moved-doc>`, and the wayfinder MUST use `docs.run402.com` for the deep refs.
- [x] 5.6 Run `npm test` (skill + sync + unit + e2e) and get it green. (0 fail.)

## 6. Publish wiring + apex refresh (public repo + /publish skill)

- [x] 6.1 Confirm `/publish` still fires the apex dispatch + note it no longer owns the deep references. DONE: `publish.md` step 3 rewritten — the deep refs auto-deploy via `deploy-docs.yml` OIDC; the private `deploy-site.yml` redeploy is now only for the apex `llms.txt` wayfinder + index.
- [x] 6.2 (DONE: run402.com/llms.txt = new wayfinder; apex index url=docs.run402.com/SKILL.md, digest d9e3e9dc matches served SKILL.md) Trigger an apex refresh and verify `run402.com/llms.txt` is the new wayfinder and `run402.com/.well-known/agent-skills/index.json` has `url = docs.run402.com/SKILL.md` with a digest matching the served `SKILL.md`.

## 7. Spec verification (public repo)

- [x] 7.1 Verify canonical serving locations: apex serves the wayfinder + index; `docs.run402.com` serves the four deep refs.
- [x] 7.2 Verify the discovery-index digest matches the served `SKILL.md` (fetch both, compare sha256) — the no-drift scenario.
- [x] 7.3 Verify content-types on the wire (`text/markdown` for `SKILL.md`, `text/plain` for the `.txt` refs).
- [x] 7.4 Verify the stable paths return the latest published bytes.

## 8. Tracked follow-up — run402-private (SEPARATE, out-of-band PR; NOT merged as part of this change)

> External dependency. This change can merge and the docs site can go live before this PR lands; until then, hard-coded old apex URLs 404 (the wayfinder + npm READMEs already route live agents to the new URLs).

- [x] 8.1 (DONE: run402-private#479) Trim `scripts/sync-agent-docs.mjs`: drop the four moved docs from `SOURCES`; fetch `.well-known/agent-skills/index.json` verbatim from the public repo instead of recomputing the digest.
- [x] 8.2 (DONE: #479; verified run402.com/<doc> → 301 → docs.run402.com) Add an apex CloudFront redirect (301/308) for the four old `run402.com/<doc>` paths → `docs.run402.com/<doc>` (satisfies the back-compat spec requirement).
- [x] 8.3 (DONE: #479) Remove the moved-file rows from `docs/agent-docs-sync.md` and reflect the new verbatim-index flow.
- [x] 8.4 Verify old apex URLs redirect to their `docs.run402.com` canonical locations. (DONE: 301s confirmed live.)
- [x] 8.5 Update the cross-repo integration record. DONE: `project_last_integration` memory now has an `agent-docs-self-host` section (both repos' PRs/issues, live state, /publish change).
