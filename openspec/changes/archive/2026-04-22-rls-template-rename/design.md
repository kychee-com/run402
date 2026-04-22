## Context

The run402 gateway renamed its RLS templates on 2026-04-21 (#35). The rename was a deliberate security action, not cosmetic:

- The old name `public_read_write` undersold what it actually did — grant full INSERT/UPDATE/DELETE to the `anon` role. An LLM picking a "public_read_write" template for a user-scoped todos table would silently create an open-to-the-internet table.
- The new name `public_read_write_UNRESTRICTED` makes the semantics unavoidable at a glance, and the additional `i_understand_this_is_unrestricted: true` body field forces a second deliberate act before the template applies.
- `public_read` → `public_read_authenticated_write` corrects a subtler lie: any authenticated user could write **any** row, not just their own. The previous name implied authenticated writes worked like `user_owns_rows` with auth on top, which was wrong.

The gateway accepts only the new names — old names return `HTTP 400 Invalid RLS template. Valid: user_owns_rows, public_read_authenticated_write, public_read_write_UNRESTRICTED`.

run402-public's MCP tool Zod schemas still enumerate the old names. Calls using the new names fail before they leave the MCP tool. Calls using the old names are passed through and fail at the gateway with the 400 above.

## Goals / Non-Goals

**Goals:**
- Align MCP Zod schemas with the gateway's accepted templates.
- Add the `i_understand_this_is_unrestricted` ACK to both `setup-rls` and `bundle-deploy.rls`, enforced at the MCP boundary so agents get a fast, local error instead of a round-trip 400.
- Replace the 28 doc refs with the new names + the ⚠ warning guidance that the gateway's `site/llms.txt` adopted.
- Keep CLI help verbose so `--help` readers get full safety context.
- Minor version bump to `1.36.0` across the three packages.

**Non-Goals:**
- Backward-compat aliases in the MCP/CLI layer. The server already broke this; aliasing would mask the security intent.
- Gateway changes. Server-side contract is already shipped.
- Touching the `user_owns_rows` behavior. Type-aware predicates and auto-indexing are server-side — no client change needed. (We may want to mention the index warning in docs eventually, but not in this change.)
- Fixing the pre-existing `sync.test.ts:143` drift (`get_quote` endpoint mismatch). Separate concern.

## Decisions

### 1. Hard rename in the Zod enum (no aliases)

The MCP tool's Zod enum for the `template` field will contain exactly:
```
["user_owns_rows", "public_read_authenticated_write", "public_read_write_UNRESTRICTED"]
```

Old names produce a standard Zod validation error listing the valid options.

**Alternative considered:** Silent aliasing (`public_read_write` → `public_read_write_UNRESTRICTED` + auto-ACK in the handler). Rejected because it would let callers use the old, misleading name without ever seeing the scary one — directly undermining the security intent of the rename.

**Alternative considered:** Deprecation shim with custom error text ("`public_read` was renamed to `public_read_authenticated_write` on 2026-04-21"). Rejected as low value for the extra surface — the Zod default error already lists valid options, and agents will re-read docs on failure.

### 2. ACK enforced at the MCP handler boundary

The `setup-rls` schema and the `bundle-deploy.rls` sub-schema will both add:

```ts
i_understand_this_is_unrestricted: z.boolean().optional()
```

The MCP SDK's `server.tool()` accepts only a `ZodRawShape` (plain map of field-name → Zod type), not a refined `ZodObject.superRefine()`. So the exported `setupRlsSchema` and `bundleDeploySchema` stay as raw shapes. The refinement is applied inside each handler via an internal `z.object(rawShape).superRefine(...)` that runs `.safeParse(args)` at the top of the handler; on failure, the handler returns an `isError: true` MCP result listing the Zod issue.

**Why local enforcement:** The gateway already enforces this, so we don't *need* a client check. But we pay a round-trip for every missed ACK. For LLMs iterating on a deploy, a local error includes the exact field path (`rls.i_understand_this_is_unrestricted`) and is zero latency. The server error is fine too, just slower.

**Behavior when template is not UNRESTRICTED:** The flag is ignored. We don't forbid passing it with other templates — no value in that strictness.

**Tests:** The internal refined schema is exported (or imported by the test via a non-public path) so tests can call `.safeParse()` directly and assert on the refinement.

### 3. Doc scope: B (rename + guidance refresh)

We adopt the guidance copy the gateway added to `site/llms.txt`:

- Preamble: "Three templates. Prefer `user_owns_rows` for anything user-scoped."
- `public_read_authenticated_write` description flags that any authenticated user can write any row.
- `public_read_write_UNRESTRICTED` description leads with ⚠, calls out anon_key write access, and notes the ACK requirement + audit log.
- `user_owns_rows` description mentions that uuid owner columns are index-friendly and that a warning is returned for other types.

CLI help (`cli/lib/deploy.mjs` RLS section, `cli/lib/projects.mjs` help block) keeps the verbose style — at least one sentence of guidance per template, not just a name.

**Why not Scope A (names only):** Changing the name without updating the surrounding prose ships half a message. An agent reading `"public_read_write_UNRESTRICTED — anyone reads and writes"` doesn't learn anything the old name didn't already say. The warning copy *is* the rename's value.

**Why not Scope C (B + unrelated drift fix):** Mixing the `sync.test.ts:143` `get_quote` fix into this change muddles the changelog. Separate work.

### 4. Version: minor bump to 1.36.0

run402-public has been bumping patch releases (`1.35.1` through `1.35.4`). The Zod enum change *is* a breaking change for the MCP tool's accepted input — any caller feeding `public_read` in is now rejected at validation. Per semver, breaking changes warrant at least a minor bump pre-1.0; post-1.0 they'd warrant major. Since run402-public is at `1.x` with no formal stability contract, **minor** matches the user's preference and the repo's release cadence (major bumps have been reserved for whole-interface rewrites).

**Alternative considered:** Patch `1.35.5`. Rejected because silent breakage in a patch violates semver expectations. Some users may have automated patch upgrades.

**Alternative considered:** Major `2.0.0`. Rejected — overkill for a surface-aligned API rename that most callers hit via docs, not saved scripts.

### 5. Error message posture when an old name is used

We rely on three layers, in order:

1. **Zod**: rejects old names at MCP tool boundary with `Invalid enum value. Expected: 'user_owns_rows' | 'public_read_authenticated_write' | 'public_read_write_UNRESTRICTED'`.
2. **Gateway**: rejects old names with `HTTP 400 Invalid RLS template. Valid: ...`.
3. **Docs**: the 28-ref doc sweep means agents re-reading on failure land on the new names.

No dedicated deprecation notice. The security rationale is that seeing the scary new name is the point.

## Risks / Trade-offs

- **[Risk] Agents mid-deploy with `public_read_write` manifests break on next apply.** Accepted — the gateway already broke this, our rename doesn't worsen the blast. Agents will 400, re-read docs, find new names. Discovery is short.
- **[Risk] We miss a doc ref in the sweep.** Mitigation: grep for `public_read` and `public_read_write` with `-w` before shipping; run tests against a live staging gateway to catch runtime refs.
- **[Risk] `i_understand_this_is_unrestricted` is easy to typo.** Accepted — same string as server, matching typos would hit either side. Zod `.optional()` with exact string match catches `.i_understand_this_is_UNRESTRICTED` or similar misspellings with a clear error.
- **[Trade-off] `superRefine` adds ~15 lines across two files.** Cheap; worth the fast local error.
- **[Trade-off] Minor version bump may surprise callers on `^1.35.x`.** Standard semver — `^` allows minor bumps. Users on `~1.35.x` pin-pattern stay on old versions, which still work against the gateway only if they don't try to use the new templates.

## Open questions

_None. The four user decisions from exploration settled the design space:_

1. Hard rename — **Option A**
2. Explicit ACK via superRefine — **Option A + superRefine**
3. Doc scope — **B (rename + guidance refresh)**
4. Version — **minor (1.36.0)**
