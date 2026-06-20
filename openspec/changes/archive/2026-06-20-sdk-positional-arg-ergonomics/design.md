## Context

`@run402/sdk` is the canonical kernel; MCP tools, the CLI (`cli/lib/*.mjs`), OpenClaw, and external integrators all call it. TypeScript catches a transposed pair only when both parameters have distinct types; the audit found ~50 methods with two or more order-significant positionals, mostly two same-type strings, plus one boolean trap. At the plain-JS edge (the CLI is `.mjs`; integrators may use `any`) there is no compile-time protection at all, so a swap is a live runtime bug — and `wallets.setLabel` even swallows the resulting error.

The SDK already has the right primitive: `r.project(id)` (`ScopedRun402`) and `r.org(id)` (`ScopedOrg`) bind a recurring id once, and the existing `r.admin` namespace already nests a sub-object (`r.admin.transfers`). The pattern simply was not applied to the orphan `wallets` namespace or to the operator org/project actions on `r.admin`, and the residual same-type pairs were never moved into options objects. This design extends the established pattern rather than inventing a new one, and additionally makes the new shapes the only ones first-party code and docs use.

## Goals / Non-Goals

**Goals:**
- Codify one precise, swap-focused call-shape rule for the whole public surface (see D1).
- Add the missing handles (`r.wallet(address)`, `r.admin.org(id)`, `r.admin.project(id)`) and move same-type pairs into options objects so no public method has a same-type positional pair or a boolean positional.
- Make the canonical forms the **only** shapes first-party callers (MCP `src/tools/*`, CLI `cli/lib/*`) use and the **only** shapes any doc surface teaches — enforced by CI, not just recommended (see D7).
- Ship additively for external callers: nothing breaks when this change lands.

**Non-Goals:**
- No removals. Positional forms stay (deprecated) until a later major.
- No change to the **frozen** `contracts` namespace (would need an explicit lift).
- No deeper sub-handles yet (`job(jobId)`, `asset(key)`) — those methods are already tolerable once `r.project(id)` binds the project id; tracked as follow-ups.
- No new gateway endpoints or wire-format changes; HTTP API / `openapi.json` / `llms-full.txt` are unaffected (only client call shape changes).

## Decisions

### D1 — The convention is the same-type / no-boolean rule
A public method SHALL NOT take two order-significant positionals of the **same runtime type**, and SHALL NOT take a **boolean** positional. At most one leading id/handle is positional; a second positional is allowed only when it is a **different runtime type** *and* the operation's **primary payload** (`sql(query, params?)` — string + array; `assets.put(key, source)` — string + ContentSource). Everything else, and any same-type second value, is a named field of a trailing options object. *Why this rule and not "everything but the leading id goes in an object":* the strict form would needlessly box legitimate single-payload methods (`put(key, { source })`), while the same-type rule is the precise thing that prevents silent swaps and is crisply decidable for every method. *Why not Python-style keyword-only params:* unavailable in TS/JS; the options object is the only call-site naming mechanism the language offers.

### D2 — Extend the existing `r.admin`; keep it off `r.org(id)`
`r.admin` already exists and nests `r.admin.transfers`, so adding `r.admin.org(orgId)` and `r.admin.project(projectId)` follows the established shape. Operator actions stay on `r.admin` (platform-admin `X-Admin-Mode` auth), **not** on the member-facing `r.org(id)` (org-role auth) — hanging an operator escape hatch off the member handle would imply an org owner can pin their own lease, which they cannot. *Alternative — `r.org(id).admin.*`:* rejected for that reason.

### D3 — Verb-split the boolean, do not just box it
`admin.setLeasePerpetual(orgId, perpetual: boolean)` → `r.admin.org(orgId).pinLease()` / `.unpinLease()`. *Why:* two intent-revealing verbs delete the boolean entirely and read at the call site. *Alternative — `setLeasePerpetual({ perpetual })`:* still carries an invertible boolean; rejected as the public form (the underlying primitive may keep a boolean body).

### D4 — Lazy handles, gateway-authoritative auth (resolves Open Question 1)
`r.wallet(address)`, `r.admin.org(id)`, and `r.admin.project(id)` SHALL be lazy — constructed without key/network access, with auth errors surfacing from the first real method call, exactly like `r.project(id)`. We do **not** gate handle access on locally-present operator credentials: operator authorization is a server-side allow-list the client cannot reliably classify (auth may arrive via allowance wallet, cookie, or a provided header), so a client-side gate would either block legitimate operators or be theater. The gateway is the authoritative oracle; the call-time operator-auth error SHALL be actionable. *Alternative — gate at access:* rejected (a property present in the types but throwing on mere access is more surprising than one that throws on call, and the client can't classify operator-grade auth anyway).

### D5 — Additive overload + `@deprecated`, warnings to stderr only
Each touched method gains an object/handle overload while the positional overload remains, marked `@deprecated`, routed through a shared `deprecatePositional(method)` helper that emits one de-duplicated notice per method per process to **stderr** (never stdout — the CLI's stdout is an agent-parsed JSON contract), suppressible via env. Runtime form-detection branches on argument shape (`typeof arg === "object"`). *Alternative — hard cutover:* rejected; `@run402/sdk` has external consumers.

### D6 — Enforce the new handles via the existing drift test
Extend `sdk/src/scoped.test.ts` to assert `r.wallet(address)`, `r.admin.org(id)`, `r.admin.project(id)` exist and expose the specified methods. `sync.test.ts` `SURFACE` / `SDK_BY_CAPABILITY` stay stable (method names unchanged; only arities/handles added).

### D7 — Canonical-only is enforced, not merely recommended (resolves Open Question 2)
The deprecated positional overloads exist **purely for external back-compat**. First-party code and docs SHALL use only the canonical forms, enforced by two guards: (a) a source guard asserting no deprecated positional call signature appears in `cli/lib/**` or `src/tools/**`; (b) the `SKILL.test.ts` banned-pattern list + `sync.test.ts` doc-drift guards asserting the skill/reference docs teach only the new shapes. This is why `transfers.cancel` and `projects.rest` are folded into this change rather than deferred — leaving any same-type pair unreshaped would make the new convention spec ship already-violated, and would force downstream through two deprecation waves instead of one.

## Risks / Trade-offs

- **Overload ambiguity** (`set(key, value)` vs `set(key, { value })`) → branch on `typeof arg === "object" && arg !== null`; a string value is legacy, an object is new. Covered by unit tests on both forms.
- **Docs/skills silently drift back to old forms** → the banned-pattern list (D7) fails CI if a deprecated form reappears in a skill; reference-doc drift guards in `sync.test.ts` cover the comprehensive `.txt` files.
- **`r.admin` over-promises an admin SDK** → the org/project handles wrap exactly the existing operator methods and surface the same auth errors; no new capability implied.
- **Deprecation-warning noise** → dedupe per method per process, stderr only, env opt-out (D5).
- **Two ways to do the same thing during the window** → docs and types teach only the new form; the legacy path is `@deprecated` and warns once, so editors and logs both steer forward.
- **Scope creep into frozen `contracts`** → explicit non-goal; the signer-handle idea is recorded as a follow-up requiring an explicit lift.

## Migration Plan

1. **Land this change (additive for externals):** new handles, options-object overloads, `deprecatePositional` shims, extended drift + banned-pattern + source guards.
2. **Convert all first-party callers to canonical-only:** MCP handlers (`src/tools/*.ts`) and CLI (`cli/lib/*.mjs`) — the source guard then keeps them that way; OpenClaw re-exports follow.
3. **Rewrite docs to canonical-only:** every public surface in `documentation.md`, plus `CHANGELOG.md` and the private `updates.txt` / `changelog.html`.
4. **Later major (separate change):** remove the `@deprecated` positional overloads once external usage has drained.

Rollback: additive, so reverting the SDK commit removes the new handles/overloads with no data or wire impact.
