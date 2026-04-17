## Context

Run402 ships two unauthenticated service-level endpoints in production:

- `GET /health` — ~110 byte JSON, no cache. Returns `{status, checks: {postgres, postgrest, s3, cloudfront}, version}`. Built for load balancers and uptime probes.
- `GET /status` — ~2.9 KB JSON, `Cache-Control: max-age=30`. Schema-versioned `run402-status-v1`. Returns operator identity (legal name, terms URL, contact), availability objective, 24h/7d/30d uptime per capability, deployment topology (AWS region, AZs, DB, CDN, IaC), capability-level status, and discovery links. `/status` references `/health` as its external probe target.

Neither endpoint is consumed by this repo today. The existing `run402 status` CLI command and `status` MCP tool report the **caller's account** (allowance, balance, tier, projects) via `/tiers/v1/status` — a different, authenticated endpoint. The word "status" is already overloaded.

Agents building on Run402 (via MCP or OpenClaw skill) have no programmatic way to verify the service is up or to cite its availability track record. This is a trust-building gap: the `/status` payload exists specifically to answer "should I trust this service with my work?" and is unreachable without a raw `curl`.

## Goals / Non-Goals

**Goals:**
- Expose `/health` and `/status` through all three shipping interfaces (MCP, CLI, OpenClaw) with symmetric surface.
- Make the tools callable from a fresh install — no allowance, no auth, no keystore required.
- Preserve the existing `status` command/tool meaning (account-level) without rename or breaking change.
- Summarize `/status` output in a form an agent can reason about and cite to the end user ("Run402 has been 99.99% up over 30 days").

**Non-Goals:**
- Renaming the existing account-level `status` tool or command.
- Adding authenticated or paid variants of these endpoints.
- Caching client-side beyond what the HTTP `Cache-Control` header already provides.
- Historical trend charts, per-region breakdowns, or anything the `/status` endpoint does not already return.
- Polling, watching, or alerting modes.

## Decisions

### Decision 1: Noun is `service`, not `account` / `platform` / `system`

We chose `service` because the `/status` payload self-identifies as `"service": "Run402"`, it does not clash with existing CLI nouns (`allowance`, `billing`, `tier`, `projects`, `agent`), and it cleanly separates "the thing you pay for" (service) from "your relationship with it" (account). `account` was rejected because `allowance` and `billing` already occupy that mental space. `platform` was rejected as vague. `system` was rejected because it implies internal/ops tooling.

### Decision 2: Two subcommands, not one merged command

`run402 service status` and `run402 service health` map 1:1 to the two HTTP endpoints. Rationale:
- The endpoints are shaped differently (small liveness vs. large public report) and cached differently.
- An agent deciding "should I use Run402?" wants `/status`. A script probing "is the API responsive right now?" wants `/health`. Merging them forces every caller to pay for the bigger payload.
- 1:1 mapping keeps the sync test trivial and leaves room for each endpoint to evolve independently.

Alternative rejected: a single `run402 service` that fetches both and merges the output. This would couple the two cache lifetimes and make the MCP tool output harder to summarize.

### Decision 3: MCP tool output is summarized, CLI output is raw JSON

- **MCP tools** (`service_status`, `service_health`): return a human/agent-readable markdown summary (current status, uptime bullets, operator line, links). This matches every other MCP tool in the repo — agents consume markdown, not raw JSON.
- **CLI commands**: return raw JSON on stdout (agent-first CLI convention per project memory). A `--pretty` flag is out of scope; agents can pipe to `jq`.

This mirrors the split already in use for `run402 status` vs. the `status` MCP tool.

### Decision 4: No allowance, no auth, no keystore

Both endpoints are unauthenticated at the API layer. The tools MUST NOT call `readAllowance()`, `getAllowanceAuthHeaders()`, or `loadKeyStore()`. They MUST work on a fresh install before `init` has ever run. This is a hard requirement — the whole point of surfacing `/status` is to let an agent evaluate the service *before* committing.

### Decision 5: OpenClaw is a re-export shim (standard pattern)

`openclaw/scripts/service.mjs` is a one-line `export { run } from "../../cli/lib/service.mjs"`. This matches the existing pattern for every other OpenClaw command and keeps `sync.test.ts`'s parity check happy without duplicating logic.

### Decision 6: Error handling — soft-fail, do not exit non-zero on 5xx

If `/health` or `/status` returns non-200 or the request throws, the tool returns a structured error payload describing what happened. Rationale: an agent asking "is the service up?" and getting "the request to check if the service is up failed" is a meaningful answer, not a crash. CLI exits 0 with an error JSON body; MCP returns `isError: true` with a descriptive message.

## Risks / Trade-offs

- **[Risk]** Agents conflate `service status` and `status` → **Mitigation**: help text and SKILL.md explicitly contrast the two ("`status` = your account; `service status` = the Run402 service"). Tool descriptions for the MCP tools state this in the first sentence.
- **[Risk]** `/status` schema evolves and breaks our summary → **Mitigation**: the payload includes `schema_version: "run402-status-v1"`. The tools pass through the raw payload plus a best-effort summary, so unknown fields are preserved rather than dropped. If `schema_version` changes, the summary falls back to a minimal view.
- **[Risk]** Agent hammers `/status` on every turn → **Mitigation**: server already sets `Cache-Control: public, max-age=30`. No client-side caching needed. This is a documentation concern only.
- **[Trade-off]** We add two tools to the MCP surface (now ~40+ tools). Each additional tool has a small context cost for every MCP session. **Accepted** because the trust-building value of `/status` is exactly the kind of thing an agent should see early, and `/health` is cheap.

## Migration Plan

Fully additive change. No migration needed.

Rollback: revert the commits. No data, no persistent state, no API contract changes on the server side.

## Open Questions

None. The endpoints are stable in production, the naming is settled, and the implementation pattern is identical to existing tools.
