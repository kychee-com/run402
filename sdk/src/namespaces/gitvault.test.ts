/**
 * `r.gitvault` namespace tests (add-gitvault task 5.10).
 *
 * These cover the SEAM, not the protocol: the protocol itself is replayed
 * against the frozen vectors in `gitvault.crypto.test.ts`,
 * `gitvault-publication.test.ts`, and `gitvault-deploy.test.ts`. What is
 * asserted here is what the namespace promises its callers — the CLI, the
 * remote helper, and the MCP tools — because those are adapters that add no
 * behaviour of their own and therefore inherit every one of these guarantees.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Run402 } from "../index.js";
import { GITVAULT_CHECKPOINT_ADVISORY_GENERATIONS, computeOpenProofOutcome, gitvaultCheckpointStaleness, gitvaultRemoteUrl, gitvaultRemoteUrlForRepo, parseGitvaultRemoteUrl } from "./gitvault.js";
import type { GitvaultHandle } from "./gitvault.js";
import type { GitvaultOpenReceipt, GitvaultSignedObject } from "./gitvault.types.js";
import { GITVAULT_TERMINAL_LOSS_DOCTOR_TEXT, GITVAULT_TERMINAL_LOSS_STATEMENT, sha256Hex, storedBytes } from "./gitvault.crypto.js";
import { hardenedGit } from "../node/gitvault-snapshot.js";
import { pinGitvaultRepo } from "../node/gitvault-address.js";
import { GitvaultKeystore } from "../node/gitvault-keystore.js";
import type { CredentialsProvider } from "../credentials.js";
import { commitFile, makeVault } from "../node/gitvault-memory-transport.test.js";
import { gitvaultPaths } from "../node/gitvault-publication.js";
import { buildVerifierReceipt } from "../node/gitvault-prune.js";

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function sdkWith(handler: (call: Call) => { status?: number; body: unknown }): { sdk: Run402; calls: Call[] } {
  const calls: Call[] = [];
  const creds: CredentialsProvider = {
    async getAuth() {
      return { authorization: "Bearer test" };
    },
    async getProject() {
      return null;
    },
  };
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const out = handler(call);
    return new Response(JSON.stringify(out.body), { status: out.status ?? 200, headers: { "content-type": "application/json" } });
  };
  return { sdk: new Run402({ apiBase: "https://api.test", credentials: creds, fetch: fetchImpl }), calls };
}

const VAULT_RECORD = {
  repo_id: "src_11111111111111111111111111111111",
  project_id: "prj_demo",
  org_id: "org_demo",
  gitvault_policy: "required",
  gitvault_policy_version: "1",
  gitvault_policy_changed_at: null,
  allocation_generation: "1",
  allocation_sha256: null,
  newest_generation: "0000000000000003",
  genesis_admitted_at: null,
  latest_effective_admitted_at: null,
  admitted_generations: "3",
  gc_epoch: "0",
  repair_version: "0",
  repair_fence_state: "none",
  storage: { source_bytes: "1024", open_session_reserved_bytes: "0", objects: {} },
  maintenance: { lease: null, open_cycle: null, pending_repair_attempt_id: null },
  warnings: [],
  created_at: null,
};

/**
 * A genuinely UUID-shaped org id for building ID-FORM remote URLs
 * (`gitvaultRemoteAddressForm`'s own discrimination — repo-first-onramp
 * design D6 — requires BOTH halves to look id-shaped: a UUID org id and a
 * `prj_`-prefixed project id). `VAULT_RECORD.org_id` above ("org_demo") is
 * deliberately NOT this shape — it is a control-plane response field the
 * remote-matching logic never reads — but a URL built for these tests must
 * be, or `status()`'s new tri-state logic (kychee-com/run402#562) correctly
 * classifies it as slug-form instead and these id-form-only tests would be
 * exercising the wrong code path.
 */
const GITVAULT_TEST_ID_ORG = "11111111-1111-4111-8111-111111111111";

describe("gitvault remote URLs", () => {
  it("round-trips `run402::<org_id>/<project_id>`", () => {
    // A plain round-trip of the URL builder/parser — classification into
    // id-form vs slug-form is a SEPARATE concern (see GITVAULT_TEST_ID_ORG's
    // own doc comment) this test does not exercise, so "org_demo" is fine
    // here even though it is not UUID-shaped.
    const url = gitvaultRemoteUrl("org_demo", "prj_demo");
    assert.equal(url, "run402::org_demo/prj_demo");
    assert.deepEqual(parseGitvaultRemoteUrl(url), { org_id: "org_demo", project_id: "prj_demo" });
  });

  it("returns null for a URL that is not a gitvault remote", () => {
    for (const url of ["https://github.com/x/y.git", "git@github.com:x/y.git", "run402:", "run402::onlyorg", ""]) {
      assert.equal(parseGitvaultRemoteUrl(url), null, url);
    }
  });

  it("tolerates surrounding whitespace (git hands the URL through argv)", () => {
    assert.deepEqual(parseGitvaultRemoteUrl("  run402::o/p \n"), { org_id: "o", project_id: "p" });
  });
});

describe("gitvault control-plane reads", () => {
  it("get() addresses the vault by :vault_id while the wire object stays repo_id (D185)", async () => {
    const { sdk, calls } = sdkWith(() => ({ body: VAULT_RECORD }));
    const record = await sdk.gitvault.get("src_11111111111111111111111111111111");
    assert.equal(calls[0]!.url, "https://api.test/gitvault/v1/vaults/src_11111111111111111111111111111111");
    assert.equal(record.repo_id, "src_11111111111111111111111111111111");
  });

  it("forProject() is the cold-restart entry point — an agent with no local state finds its repo_id", async () => {
    const { sdk, calls } = sdkWith(() => ({ body: VAULT_RECORD }));
    const record = await sdk.gitvault.forProject("prj_demo");
    assert.match(calls[0]!.url, /\/gitvault\/v1\/vaults\?project_id=prj_demo$/);
    assert.equal(record.repo_id, VAULT_RECORD.repo_id);
  });

  it("heads() sends after_generation AND limit — limit is REQUIRED (rev 40), not optional", async () => {
    const { sdk, calls } = sdkWith(() => ({
      body: { format: "r402s/v0", repo_id: VAULT_RECORD.repo_id, after_generation: "0000000000000000", heads: [], has_more: false, next_cursor: null, total: "0" },
    }));
    await sdk.gitvault.heads(VAULT_RECORD.repo_id, { after_generation: "0000000000000000", limit: "100" });
    const url = new URL(calls[0]!.url);
    assert.equal(url.searchParams.get("after_generation"), "0000000000000000");
    assert.equal(url.searchParams.get("limit"), "100");
    assert.equal(url.searchParams.get("cursor"), null, "no cursor on the FIRST request");
  });

  it("heads() refuses a request without a valid anchor rather than letting the server guess", async () => {
    const { sdk, calls } = sdkWith(() => ({ body: {} }));
    await assert.rejects(() => sdk.gitvault.heads(VAULT_RECORD.repo_id, { after_generation: "nope", limit: "100" }), /after_generation is REQUIRED/);
    await assert.rejects(() => sdk.gitvault.heads(VAULT_RECORD.repo_id, { after_generation: "0000000000000000", limit: "0" }), /limit is REQUIRED/);
    assert.equal(calls.length, 0, "an invalid listing request must never reach the network");
  });

  it("allHeads() echoes each page's next_cursor UNCHANGED and keeps the anchor constant", async () => {
    let page = 0;
    const { sdk, calls } = sdkWith(() => {
      page += 1;
      if (page === 1) {
        return {
          body: {
            format: "r402s/v0", repo_id: VAULT_RECORD.repo_id, after_generation: "0000000000000000",
            heads: [{ generation: "0000000000000001", stored_bytes_sha256: "a".repeat(64) }],
            has_more: true, next_cursor: "hc_OPAQUE", total: "2",
          },
        };
      }
      return {
        body: {
          format: "r402s/v0", repo_id: VAULT_RECORD.repo_id, after_generation: "0000000000000000",
          heads: [{ generation: "0000000000000002", stored_bytes_sha256: "b".repeat(64) }],
          has_more: false, next_cursor: null, total: "2",
        },
      };
    });
    const out = await sdk.gitvault.allHeads(VAULT_RECORD.repo_id, { after_generation: "0000000000000000", limit: "1" });
    assert.equal(out.pages, 2);
    assert.equal(out.total, "2");
    assert.deepEqual(out.heads.map((h) => h.generation), ["0000000000000001", "0000000000000002"]);
    const second = new URL(calls[1]!.url);
    assert.equal(second.searchParams.get("cursor"), "hc_OPAQUE", "the cursor is echoed byte-for-byte, never re-derived");
    assert.equal(second.searchParams.get("after_generation"), "0000000000000000", "the anchor is CONSTANT across a page sequence");
  });

  it("allHeads() refuses a page that moved the anchor — that is not a continuation", async () => {
    let page = 0;
    const { sdk } = sdkWith(() => {
      page += 1;
      return {
        body: {
          format: "r402s/v0", repo_id: VAULT_RECORD.repo_id,
          after_generation: page === 1 ? "0000000000000000" : "0000000000000001",
          heads: [{ generation: `000000000000000${page}`, stored_bytes_sha256: "a".repeat(64) }],
          has_more: page === 1, next_cursor: page === 1 ? "hc_X" : null, total: null,
        },
      };
    });
    await assert.rejects(() => sdk.gitvault.allHeads(VAULT_RECORD.repo_id, { after_generation: "0000000000000000", limit: "1" }), /after_generation anchor/);
  });

  it("allHeads() reports a GAP as CHAIN_BROKEN rather than silently skipping a generation", async () => {
    const { sdk } = sdkWith(() => ({
      body: {
        format: "r402s/v0", repo_id: VAULT_RECORD.repo_id, after_generation: "0000000000000000",
        heads: [
          { generation: "0000000000000001", stored_bytes_sha256: "a".repeat(64) },
          { generation: "0000000000000003", stored_bytes_sha256: "c".repeat(64) },
        ],
        has_more: false, next_cursor: null, total: null,
      },
    }));
    await assert.rejects(() => sdk.gitvault.allHeads(VAULT_RECORD.repo_id, { after_generation: "0000000000000000", limit: "10" }), (e: unknown) => (e as { code?: string }).code === "CHAIN_BROKEN");
  });
});

describe("gitvault compaction headroom preflight (gitvault-compaction-headroom-preflight)", () => {
  /**
   * `pool_usage` figures are what `GET /tiers/v1/status` actually returns —
   * the preflight reads exactly these two fields plus the vault record's
   * billed `source_bytes`, so this fixture is also the pin against tier-status
   * shape drift (design D2's mitigation).
   */
  function tierStatus(used: number, limit: number): Record<string, unknown> {
    return { tier: "prototype", active: true, pool_usage: { projects: 1, total_api_calls: 0, total_storage_bytes: used, api_calls_limit: 500_000, storage_bytes_limit: limit } };
  }

  function route(record: Record<string, unknown>, tier: { status?: number; body: unknown }) {
    return (call: Call): { status?: number; body: unknown } => {
      if (call.url.includes("/tiers/v1/status")) return tier;
      return { body: record };
    };
  }

  const REPO = VAULT_RECORD.repo_id;
  const withSource = (bytes: string): Record<string, unknown> => ({ ...VAULT_RECORD, storage: { ...VAULT_RECORD.storage, source_bytes: bytes } });

  it("reports the arithmetic when the projection fits", async () => {
    const { sdk } = sdkWith(route(withSource("50"), { body: tierStatus(100, 1000) }));
    assert.deepEqual(await sdk.gitvault.compactHeadroom({ repo_id: REPO }), {
      pool_used_bytes: 100,
      pool_limit_bytes: 1000,
      vault_source_bytes: 50,
      projected_transient_bytes: 150,
      ok: true,
      overridden: false,
    });
  });

  it("reports ok:false — without throwing — when the standalone read is asked", async () => {
    // The READ is not the policy: `compactHeadroom` never refuses, it reports.
    // Only `compact` turns a false verdict into a refusal.
    const { sdk } = sdkWith(route(withSource("500"), { body: tierStatus(900, 1000) }));
    const headroom = await sdk.gitvault.compactHeadroom({ repo_id: REPO });
    assert.equal(headroom?.ok, false);
    assert.equal(headroom?.projected_transient_bytes, 1400);
  });

  it("the boundary is inclusive — exactly filling the pool still fits", async () => {
    const { sdk } = sdkWith(route(withSource("100"), { body: tierStatus(900, 1000) }));
    assert.equal((await sdk.gitvault.compactHeadroom({ repo_id: REPO }))?.ok, true);
  });

  it("returns null when the tier-status read fails, rather than guessing (D2 posture 3)", async () => {
    const { sdk } = sdkWith(route(withSource("50"), { status: 500, body: { error: "nope" } }));
    assert.equal(await sdk.gitvault.compactHeadroom({ repo_id: REPO }), null);
  });

  it("returns null when tier status carries no usable pooled figures (shape drift)", async () => {
    for (const body of [{}, { pool_usage: {} }, { pool_usage: { total_storage_bytes: 1, storage_bytes_limit: 0 } }]) {
      const { sdk } = sdkWith(route(withSource("50"), { body }));
      assert.equal(await sdk.gitvault.compactHeadroom({ repo_id: REPO }), null, JSON.stringify(body));
    }
  });

  it("refuses a compaction that will not fit BEFORE any upload, naming the arithmetic and the override", async () => {
    const { sdk, calls } = sdkWith(route(withSource("200000000"), { body: tierStatus(134_000_000, 250 * 1024 * 1024) }));
    let thrown: unknown;
    try {
      await sdk.gitvault.compact({ repo_id: REPO });
    } catch (e) {
      thrown = e;
    }
    const err = thrown as { code?: string; message?: string; details?: Record<string, number | string> };
    assert.equal(err?.code, "GITVAULT_COMPACT_INSUFFICIENT_HEADROOM");
    assert.equal(err.details?.pool_used_bytes, 134_000_000);
    assert.equal(err.details?.pool_limit_bytes, 250 * 1024 * 1024);
    assert.equal(err.details?.vault_source_bytes, 200_000_000);
    assert.equal(err.details?.projected_transient_bytes, 334_000_000);
    assert.equal(err.details?.override, "--force-headroom");
    // The mechanism, not just a quota number — that is the whole point.
    assert.match(String(err.message), /both the new checkpoint and the/i);
    assert.match(String(err.message), /--force-headroom/);
    // Nothing was published: only the two preflight reads plus the
    // compaction-grant open+close (gitvault-checkpoint-cadence — `compact()`
    // now brackets the ENTIRE preflight with the grant, so a refusal still
    // closes a grant it opened) went out. A maintenance lease or an upload
    // session here would mean the refusal arrived after the cost, which is
    // the bug this change exists to fix.
    const nonGet = calls.filter((c) => c.method !== "GET");
    assert.deepEqual(
      nonGet.map((c) => `${c.method} ${new URL(c.url).pathname}`),
      [`POST /gitvault/v1/vaults/${REPO}/compaction-grant`, `DELETE /gitvault/v1/vaults/${REPO}/compaction-grant`],
      `unexpected writes: ${JSON.stringify(nonGet)}`,
    );
    assert.equal(calls.some((c) => c.url.includes("maintenance-leases")), false);
  });
});

describe("gitvault compaction headroom grant (gitvault-checkpoint-cadence)", () => {
  const REPO = VAULT_RECORD.repo_id;
  const withSource = (bytes: string): Record<string, unknown> => ({ ...VAULT_RECORD, storage: { ...VAULT_RECORD.storage, source_bytes: bytes } });
  function tierStatus(used: number, limit: number): Record<string, unknown> {
    return { tier: "prototype", active: true, pool_usage: { projects: 1, total_api_calls: 0, total_storage_bytes: used, api_calls_limit: 500_000, storage_bytes_limit: limit } };
  }

  it("409 GITVAULT_COMPACTION_GRANT_ACTIVE refuses BEFORE any preflight read — single-flight-per-vault", async () => {
    const { sdk, calls } = sdkWith((call) => {
      if (call.url.includes("/compaction-grant")) {
        return { status: 409, body: { code: "GITVAULT_COMPACTION_GRANT_ACTIVE", message: "active", details: { expires_at: "2026-09-01T00:00:00.000Z" } } };
      }
      return { body: withSource("50") };
    });
    let thrown: unknown;
    try {
      await sdk.gitvault.compact({ repo_id: REPO });
    } catch (e) {
      thrown = e;
    }
    const err = thrown as { code?: string; details?: { expires_at?: string | null } };
    assert.equal(err?.code, "GITVAULT_COMPACTION_IN_PROGRESS");
    assert.equal(err.details?.expires_at, "2026-09-01T00:00:00.000Z");
    // Refused before the tier-status preflight read even happened — the
    // grant conflict is the earliest, cheapest signal that another
    // compaction (this process or another) already owns this vault's cycle.
    assert.equal(calls.some((c) => c.url.includes("/tiers/v1/status")), false);
    assert.equal(calls.some((c) => c.url.includes("maintenance-leases")), false);
    // Nothing to close — the failed open never produced a grant to release.
    assert.equal(calls.filter((c) => c.url.includes("/compaction-grant")).length, 1);
  });

  it("an older gateway (404/ROUTE_NOT_FOUND on /compaction-grant) falls back to the plain, un-raised preflight — same refusal as before this change", async () => {
    const { sdk, calls } = sdkWith((call) => {
      if (call.url.includes("/compaction-grant")) return { status: 404, body: { code: "ROUTE_NOT_FOUND", message: "no such route" } };
      if (call.url.includes("/tiers/v1/status")) return { body: tierStatus(134_000_000, 250 * 1024 * 1024) };
      return { body: withSource("200000000") };
    });
    let thrown: unknown;
    try {
      await sdk.gitvault.compact({ repo_id: REPO });
    } catch (e) {
      thrown = e;
    }
    const err = thrown as { code?: string; details?: Record<string, unknown> };
    // Same refusal, same numbers, as the plain (no-grant) preflight test
    // above — an absent grant route changes NOTHING about today's behavior.
    assert.equal(err?.code, "GITVAULT_COMPACT_INSUFFICIENT_HEADROOM");
    assert.equal(err.details?.pool_limit_bytes, 250 * 1024 * 1024);
    assert.equal(err.details?.effective_pool_limit_bytes, undefined, "no grant was ever opened, so no effective (raised) limit should appear");
    // The grant route was tried exactly once (POST, 404) and never a
    // matching DELETE — there was never anything to close.
    const grantCalls = calls.filter((c) => c.url.includes("/compaction-grant"));
    assert.equal(grantCalls.length, 1);
    assert.equal(grantCalls[0]!.method, "POST");
  });

  it("a grant whose byte fields are WIRE STRINGS relieves an otherwise-refused preflight (the 2026-08-31 live bug)", async () => {
    // The live gateway serializes its BIGINTs as strings. The original guard
    // — Number.isFinite(effective_pool_limit_bytes) on the RAW value — is
    // false for "472697418", so an opened grant was silently discarded and
    // the preflight refused with the unraised limit. Caught only by the live
    // acceptance run on the bench vault; this pins the coercion.
    const { sdk, calls } = sdkWith((call) => {
      if (call.url.includes("/compaction-grant") && call.method === "POST") {
        return { body: { granted_bytes: "200000000", expires_at: "2026-09-01T00:00:00.000Z", pool_used_bytes: "134000000", pool_limit_bytes: "262144000", effective_pool_limit_bytes: "462144000" } };
      }
      if (call.url.includes("/compaction-grant") && call.method === "DELETE") return { body: { closed: true } };
      if (call.url.includes("/tiers/v1/status")) return { body: tierStatus(134_000_000, 250 * 1024 * 1024) };
      return { body: withSource("200000000") };
    });
    let thrown: unknown;
    try {
      await sdk.gitvault.compact({ repo_id: REPO });
    } catch (e) {
      thrown = e;
    }
    // The mock cannot carry a full compaction to success — what matters is
    // that the refusal did NOT fire (the raised limit covered the projected
    // 334 MB) and the grant was still closed on the way out (the finally).
    assert.notEqual((thrown as { code?: string } | undefined)?.code, "GITVAULT_COMPACT_INSUFFICIENT_HEADROOM", `preflight refused despite a covering grant: ${String((thrown as Error | undefined)?.message)}`);
    const grantCalls = calls.filter((c) => c.url.includes("/compaction-grant")).map((c) => c.method);
    assert.deepEqual(grantCalls, ["POST", "DELETE"], "the grant must be opened once and closed once, whatever happened in between");
  });
});

/**
 * `prune({ submit })` end-to-end (kychee-com/run402#578, fixes 2 + 3).
 *
 * `sdk.gitvault.open()` always builds the REAL HTTP transport
 * (`createGitvaultHttpTransport(this.#client)`) — there is no injection
 * point for a different `GitvaultTransport`. `open` is a plain (non-`#`)
 * instance method, so these tests override it on the `sdk.gitvault`
 * instance to hand back a handle wrapping a REAL vault built on
 * `GitvaultMemoryTransport` (the same fixture `gitvault-prune.test.ts` uses
 * at the `GitvaultVault` level) — genuinely correct materialize/chain-walk/
 * attestation behavior, with zero wire-translation risk, while still
 * exercising the actual `namespaces/gitvault.ts` `prune()` orchestration
 * (the receipt-reupload recovery and the compaction-grant bracket both
 * live there, as private `#` methods unreachable from outside `prune()`
 * itself).
 */
describe("gitvault prune({ submit }) — receipt idempotency + compaction headroom grant (kychee-com/run402#578)", () => {
  /** Two checkpoint-bearing generations so a real prune plan (candidates + a bound retention_cutoff ticket) exists. */
  async function preparedPruneFixture(t: { after: (fn: () => void) => void }) {
    const root = mkdtempSync(join(tmpdir(), "run402-gitvault-prune-submit-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const f = await makeVault(root);
    const c1 = await commitFile(f.repoDir, "a.txt", "one");
    await f.vault.push({ transaction: { updates: [{ ref: "refs/heads/main", expected_old_oid: null, new_oid: c1, force: false }] } });
    await f.vault.publishCheckpoint();
    const c2 = await commitFile(f.repoDir, "b.txt", "two");
    await f.vault.push({ transaction: { updates: [{ ref: "refs/heads/main", expected_old_oid: c1, new_oid: c2, force: false }] } });
    await f.vault.publishCheckpoint();

    const { sdk } = sdkWith(() => ({ body: {} })); // fetch is never reached — open() is overridden below
    sdk.gitvault.open = async (): Promise<GitvaultHandle> => ({ repo_id: f.repoId, keystore: f.keystore, transport: f.transport, vault: f.vault });

    const planned = await sdk.gitvault.prune({ repo_id: f.repoId });
    assert.ok(planned.intent_core && planned.attestation, "fixture must produce a real, submittable prune plan");
    return { f, sdk, planned };
  }

  /** A `r402s-verify`-shaped receipt over the SAME plan, signed by the vault's own owner key (matches `gitvault-prune.test.ts`'s convention). */
  function verifierReceiptFor(
    f: Awaited<ReturnType<typeof makeVault>>,
    planned: Awaited<ReturnType<typeof preparedPruneFixture>>["planned"],
    overrides: { object_id?: string; implementation_version?: string } = {},
  ) {
    return buildVerifierReceipt(
      {
        repo_id: f.repoId,
        intent_core_sha256: planned.intent_core_sha256!,
        checkpoint_head_sha256: planned.attestation!.checkpoint_head_sha256,
        cutoff_ticket_sha256: planned.attestation!.cutoff_ticket_sha256,
        restored_object_set_hmac: planned.attestation!.restored_object_set_hmac,
        retention_evolution_ok: true,
        candidates_outside_roots_ok: true,
        implementation_id: "r402s-verify",
        implementation_version: overrides.implementation_version ?? "r402s-verify/0.1.0",
        ...(overrides.object_id ? { object_id: overrides.object_id } : {}),
      },
      f.vault.signer(),
    );
  }

  /**
   * Install the REAL gateway's "an id is never reusable" rule on top of the
   * fixture, which is otherwise lenient (silent idempotent overwrite) —
   * matching `services/gitvault/upload-sessions.ts`'s actual
   * `VALIDATION_FAILED` + `details.reused_object_ids` refusal.
   */
  function makeUploadStrictAboutReuse(f: Awaited<ReturnType<typeof makeVault>>) {
    const real = f.transport.uploadObjects.bind(f.transport);
    f.transport.uploadObjects = async (req: { repo_id: string; objects: Array<{ path: string; object_id: string | null }> }) => {
      const reused = req.objects.filter((o) => o.object_id && f.transport.objects.has(`${req.repo_id}/${o.path}`)).map((o) => o.object_id as string);
      if (reused.length > 0) {
        throw Object.assign(new Error("an object id in the manifest is already used (ids are never reusable in any state)"), {
          isRun402Error: true,
          code: "VALIDATION_FAILED",
          details: { reused_object_ids: reused },
        });
      }
      return real(req as Parameters<typeof real>[0]);
    };
  }

  it("fix 2: a receipt refused as reused, with IDENTICAL stored bytes, is treated as already-uploaded — the submit still completes", async (t) => {
    const { f, sdk, planned } = await preparedPruneFixture(t);
    const FIXED_ID = `vr_${"7".repeat(32)}`;
    const verifierReceipt = verifierReceiptFor(f, planned, { object_id: FIXED_ID });

    // Simulate: a prior attempt already landed this EXACT receipt (a failed
    // submit after a successful upload — issue #578's core scenario).
    const bytes = storedBytes(verifierReceipt as unknown as GitvaultSignedObject);
    await f.transport.uploadObjects({
      repo_id: f.repoId,
      objects: [{ path: gitvaultPaths.verifierReceipt(FIXED_ID), object_kind: "verifier_receipt", object_id: FIXED_ID, bytes, sha256: sha256Hex(bytes), size_bytes: String(bytes.length) }],
    });
    makeUploadStrictAboutReuse(f);

    const result = await sdk.gitvault.prune({ repo_id: f.repoId, submit: { core: planned.intent_core!, verifier_receipt: verifierReceipt } });
    assert.equal(result.submitted, true, "a recoverable reused-id refusal must not block the submit");
    assert.ok(result.intent, "the intent must actually have been submitted");
  });

  it("fix 2: a reused id whose stored bytes DIFFER is refused by name, with both hashes — never silently proceeds", async (t) => {
    const { f, sdk, planned } = await preparedPruneFixture(t);
    const FIXED_ID = `vr_${"8".repeat(32)}`;
    // A DIFFERENT receipt at the SAME id (differs only in implementation_version,
    // so both are `restored_and_verified` and buildPruneIntent still accepts
    // the ACTUALLY-submitted one below) — models a genuinely burned id.
    const staleReceipt = verifierReceiptFor(f, planned, { object_id: FIXED_ID, implementation_version: "r402s-verify/0.0.1-stale" });
    const staleBytes = storedBytes(staleReceipt as unknown as GitvaultSignedObject);
    await f.transport.uploadObjects({
      repo_id: f.repoId,
      objects: [{ path: gitvaultPaths.verifierReceipt(FIXED_ID), object_kind: "verifier_receipt", object_id: FIXED_ID, bytes: staleBytes, sha256: sha256Hex(staleBytes), size_bytes: String(staleBytes.length) }],
    });
    makeUploadStrictAboutReuse(f);

    const verifierReceipt = verifierReceiptFor(f, planned, { object_id: FIXED_ID });
    await assert.rejects(
      sdk.gitvault.prune({ repo_id: f.repoId, submit: { core: planned.intent_core!, verifier_receipt: verifierReceipt } }),
      (e: unknown) => {
        const err = e as { code?: string; details?: { object_id?: string; existing_sha256?: string; this_attempt_sha256?: string } };
        assert.equal(err.code, "GITVAULT_RECEIPT_ID_REUSED_DIFFERENT");
        assert.equal(err.details?.object_id, FIXED_ID);
        assert.ok(err.details?.existing_sha256);
        assert.ok(err.details?.this_attempt_sha256);
        assert.notEqual(err.details?.existing_sha256, err.details?.this_attempt_sha256);
        return true;
      },
    );
  });

  it("fix 3: brackets the receipt upload + submit with the compaction headroom grant — opened before, closed after success", async (t) => {
    const { f, sdk, planned } = await preparedPruneFixture(t);
    const verifierReceipt = verifierReceiptFor(f, planned);
    const grantCalls: string[] = [];
    const realOpen = f.transport.openCompactionGrant.bind(f.transport);
    const realClose = f.transport.closeCompactionGrant.bind(f.transport);
    f.transport.openCompactionGrant = async (req: { repo_id: string }) => {
      grantCalls.push("open");
      return realOpen(req);
    };
    f.transport.closeCompactionGrant = async (req: { repo_id: string }) => {
      grantCalls.push("close");
      return realClose(req);
    };

    const result = await sdk.gitvault.prune({ repo_id: f.repoId, submit: { core: planned.intent_core!, verifier_receipt: verifierReceipt } });
    assert.equal(result.submitted, true);
    assert.deepEqual(grantCalls, ["open", "close"]);
  });

  it("fix 3: closes the grant even when the submit itself fails after the receipts uploaded", async (t) => {
    const { f, sdk, planned } = await preparedPruneFixture(t);
    const verifierReceipt = verifierReceiptFor(f, planned);
    const grantCalls: string[] = [];
    const realOpen = f.transport.openCompactionGrant.bind(f.transport);
    const realClose = f.transport.closeCompactionGrant.bind(f.transport);
    f.transport.openCompactionGrant = async (req: { repo_id: string }) => {
      grantCalls.push("open");
      return realOpen(req);
    };
    f.transport.closeCompactionGrant = async (req: { repo_id: string }) => {
      grantCalls.push("close");
      return realClose(req);
    };
    f.transport.submitPruneIntent = async () => {
      throw new Error("simulated submit failure — e.g. the 90-day retention floor, or a network blip");
    };

    await assert.rejects(sdk.gitvault.prune({ repo_id: f.repoId, submit: { core: planned.intent_core!, verifier_receipt: verifierReceipt } }));
    assert.deepEqual(grantCalls, ["open", "close"], "the grant must close in the `finally` even though the submit threw");
  });

  it("fix 3: a 409 GITVAULT_COMPACTION_GRANT_ACTIVE surfaces as the single-flight conflict BEFORE any receipt upload is attempted", async (t) => {
    const { f, sdk, planned } = await preparedPruneFixture(t);
    const verifierReceipt = verifierReceiptFor(f, planned);
    f.transport.openCompactionGrant = async () => {
      throw Object.assign(new Error("a compaction grant is already active for this project"), {
        isRun402Error: true,
        code: "GITVAULT_COMPACTION_GRANT_ACTIVE",
        details: { expires_at: "2026-09-01T00:00:00.000Z" },
      });
    };
    let uploadCalled = false;
    const realUpload = f.transport.uploadObjects.bind(f.transport);
    f.transport.uploadObjects = async (req: Parameters<typeof realUpload>[0]) => {
      uploadCalled = true;
      return realUpload(req);
    };

    await assert.rejects(
      sdk.gitvault.prune({ repo_id: f.repoId, submit: { core: planned.intent_core!, verifier_receipt: verifierReceipt } }),
      (e: unknown) => {
        assert.equal((e as { code?: string }).code, "GITVAULT_COMPACTION_IN_PROGRESS");
        return true;
      },
    );
    assert.equal(uploadCalled, false, "the conflicting grant must refuse before any ceremony object is uploaded");
  });

  it("fix 3: an older gateway (404 on compaction-grant) proceeds ungranted — same as before this fix, and closes nothing", async (t) => {
    const { f, sdk, planned } = await preparedPruneFixture(t);
    const verifierReceipt = verifierReceiptFor(f, planned);
    f.transport.openCompactionGrant = async () => {
      throw Object.assign(new Error("no such route"), { isRun402Error: true, code: "ROUTE_NOT_FOUND", status: 404 });
    };
    let closeCalled = false;
    const realClose = f.transport.closeCompactionGrant.bind(f.transport);
    f.transport.closeCompactionGrant = async (req: { repo_id: string }) => {
      closeCalled = true;
      return realClose(req);
    };

    const result = await sdk.gitvault.prune({ repo_id: f.repoId, submit: { core: planned.intent_core!, verifier_receipt: verifierReceipt } });
    assert.equal(result.submitted, true);
    assert.equal(closeCalled, false, "nothing to close when the grant was never opened");
  });
});

describe("gitvault owner writes", () => {
  it("setPolicy() PATCHes the policy route and carries the reason", async () => {
    const { sdk, calls } = sdkWith(() => ({ body: { gitvault_policy: "grandfathered", gitvault_policy_version: "2", changed: true, warnings: [] } }));
    const out = await sdk.gitvault.setPolicy(VAULT_RECORD.repo_id, { gitvault_policy: "grandfathered", reason: "migrating an existing project" });
    assert.equal(calls[0]!.method, "PATCH");
    assert.match(calls[0]!.url, /\/policy$/);
    assert.deepEqual(calls[0]!.body, { gitvault_policy: "grandfathered", reason: "migrating an existing project" });
    assert.equal(out.changed, true);
  });

  it("completeOverride() posts the full capture receipt — a partial match must never clear an advisory", async () => {
    const receipt = { repo_id: VAULT_RECORD.repo_id, capture_id: "c".repeat(32), apply_plan_sha256: "d".repeat(64), snapshot_oid_hmac: "e".repeat(64), generation: "0000000000000002", head_sha256: "f".repeat(64) };
    const { sdk, calls } = sdkWith(() => ({ body: { operation_id: "op_1", advisory_cleared: true, generation: "0000000000000002", head_sha256: "f".repeat(64) } }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await sdk.gitvault.completeOverride(VAULT_RECORD.repo_id, { operation_id: "op_1", capture_receipt: receipt as any });
    assert.match(calls[0]!.url, /\/override-completions$/);
    assert.deepEqual((calls[0]!.body as { capture_receipt: unknown }).capture_receipt, receipt, "every field rides — the server compares all of them");
    assert.equal(out.advisory_cleared, true);
  });
});

describe("gitvault secret handling", () => {
  it("the maintenance lease is NEVER memoised — holder_token is issued once, so a second call must reach the server", async () => {
    let issued = 0;
    const { sdk, calls } = sdkWith(() => {
      issued += 1;
      return {
        body: {
          maintenance_lease_id: `ml_${String(issued).repeat(32).slice(0, 32)}`,
          repo_id: VAULT_RECORD.repo_id, base_head_sha256: "a".repeat(64), current_checkpoint_hash: null,
          reservation_size_bytes: "0", maintenance_headroom_bytes: "0",
          holder_token: `00000000-0000-4000-8000-00000000000${issued}`,
          expires_at: null, hard_deadline_at: null,
        },
      };
    });
    const first = await sdk.gitvault.acquireMaintenanceLease({ repo_id: VAULT_RECORD.repo_id, base_head_sha256: "a".repeat(64), r1_size_bytes: "0", r2_cap_size_bytes: "0" });
    const second = await sdk.gitvault.acquireMaintenanceLease({ repo_id: VAULT_RECORD.repo_id, base_head_sha256: "a".repeat(64), r1_size_bytes: "0", r2_cap_size_bytes: "0" });
    assert.equal(calls.length, 2, "a cached lease would hand back a holder_token the server no longer honours");
    assert.notEqual(first.holder_token, second.holder_token);
  });

  it("sends the p_before_* accounting fields with explicit zeros rather than omitting them", async () => {
    const { sdk, calls } = sdkWith(() => ({ body: { maintenance_lease_id: "ml_" + "1".repeat(32), repo_id: VAULT_RECORD.repo_id, base_head_sha256: "a".repeat(64), current_checkpoint_hash: null, reservation_size_bytes: "0", maintenance_headroom_bytes: "0", holder_token: "00000000-0000-4000-8000-000000000000", expires_at: null, hard_deadline_at: null } }));
    await sdk.gitvault.acquireMaintenanceLease({ repo_id: VAULT_RECORD.repo_id, base_head_sha256: "a".repeat(64), r1_size_bytes: "0", r2_cap_size_bytes: "0" });
    assert.deepEqual(calls[0]!.body, {
      base_head_sha256: "a".repeat(64),
      current_checkpoint_hash: null,
      r1_size_bytes: "0",
      r2_cap_size_bytes: "0",
      p_before_c1_size_bytes: "0",
      p_before_c2_size_bytes: "0",
    });
  });
});

describe("gitvault status — the terminal-loss statement is normative copy", () => {
  it("states the V0 terminal-loss sentence VERBATIM, and never implies the receipt can decrypt", async () => {
    const { sdk } = sdkWith(() => ({ body: VAULT_RECORD }));
    const status = await sdk.gitvault.status({ project_id: "prj_demo", keystore_root: join(tmpdir(), "gitvault-absent-keystore-fixture") });
    assert.equal(status.terminal_loss_statement, GITVAULT_TERMINAL_LOSS_STATEMENT);
    assert.equal(status.terminal_loss_statement, "whole-machine or whole-keystore loss is terminal for vault history until human envelopes ship");
    assert.equal(status.terminal_loss_detail, GITVAULT_TERMINAL_LOSS_DOCTOR_TEXT);
    assert.match(status.terminal_loss_detail, /a recovery receipt authenticates a genesis — it cannot decrypt anything/);
  });

  it("stays truthful for a VAULT-ONLY project: never a deploy-related warning for the absence of deploys (D183)", async () => {
    const { sdk } = sdkWith(() => ({ body: { ...VAULT_RECORD, warnings: [] } }));
    const status = await sdk.gitvault.status({ project_id: "prj_demo", keystore_root: join(tmpdir(), "gitvault-absent-keystore-fixture") });
    assert.deepEqual(status.warnings, [], "a project that never deployed is a first-class shape, not a degraded one");
    assert.equal(status.gitvault_policy, "required");
  });

  it("raises a persistent warning while the policy is grandfathered", async () => {
    const { sdk } = sdkWith(() => ({ body: { ...VAULT_RECORD, gitvault_policy: "grandfathered" } }));
    const status = await sdk.gitvault.status({ project_id: "prj_demo", keystore_root: join(tmpdir(), "gitvault-absent-keystore-fixture") });
    assert.ok(status.warnings.some((w) => w.kind === "policy_grandfathered"));
  });

  // D7 (repo-first-onramp task 2.7): the progressive terminal-loss warning.
  // Quiet at genesis (the fixture default — 3 generations, 1 KB, no genesis
  // timestamp — trips nothing above), standing once any composite threshold
  // crosses. See gitvault.ts's `gitvaultLossWarningTrip` for the OR-composite.
  it("stays quiet for a small, young vault — a red banner on an empty vault teaches agents to ignore red banners", async () => {
    const { sdk } = sdkWith(() => ({ body: VAULT_RECORD }));
    const status = await sdk.gitvault.status({ project_id: "prj_demo", keystore_root: join(tmpdir(), "gitvault-absent-keystore-fixture") });
    assert.equal(status.warnings.some((w) => w.kind === "terminal_loss_risk"), false);
  });

  it("escalates to a standing warning once generations cross the threshold alone", async () => {
    const { sdk } = sdkWith(() => ({ body: { ...VAULT_RECORD, admitted_generations: "10" } }));
    const status = await sdk.gitvault.status({ project_id: "prj_demo", keystore_root: join(tmpdir(), "gitvault-absent-keystore-fixture") });
    const w = status.warnings.find((w) => w.kind === "terminal_loss_risk");
    assert.ok(w, `expected terminal_loss_risk, got ${JSON.stringify(status.warnings)}`);
    assert.match(w!.message, /generations/);
    assert.match(w!.message, /No attestation or flag clears it\./);
  });

  it("escalates on source_bytes alone", async () => {
    const { sdk } = sdkWith(() => ({ body: { ...VAULT_RECORD, storage: { ...VAULT_RECORD.storage, source_bytes: String(11 * 1024 * 1024) } } }));
    const status = await sdk.gitvault.status({ project_id: "prj_demo", keystore_root: join(tmpdir(), "gitvault-absent-keystore-fixture") });
    assert.ok(status.warnings.some((w) => w.kind === "terminal_loss_risk" && /MB of source/.test(w.message)));
  });

  it("escalates on days-since-genesis alone", async () => {
    const oldGenesis = new Date(Date.now() - 20 * 86_400_000).toISOString();
    const { sdk } = sdkWith(() => ({ body: { ...VAULT_RECORD, genesis_admitted_at: oldGenesis } }));
    const status = await sdk.gitvault.status({ project_id: "prj_demo", keystore_root: join(tmpdir(), "gitvault-absent-keystore-fixture") });
    assert.ok(status.warnings.some((w) => w.kind === "terminal_loss_risk" && /days since genesis/.test(w.message)));
  });

  it("names every metric that tripped, not just the first", async () => {
    const oldGenesis = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const { sdk } = sdkWith(() => ({ body: { ...VAULT_RECORD, admitted_generations: "50", genesis_admitted_at: oldGenesis } }));
    const status = await sdk.gitvault.status({ project_id: "prj_demo", keystore_root: join(tmpdir(), "gitvault-absent-keystore-fixture") });
    const w = status.warnings.find((w) => w.kind === "terminal_loss_risk");
    assert.match(w!.message, /generations/);
    assert.match(w!.message, /days since genesis/);
  });

  it("does NOT mint key material — observing a vault must never create the identity it reports on", async () => {
    // Regression: `status()` originally called `ensureIdentity()`, which
    // GENERATES an Ed25519 + X25519 keypair and writes it to disk. That made a
    // read-only status call create the very thing it was reporting, and broke
    // the client-surface guarantee that no key material exists until first
    // capture — the cold-start path must gain no new artifacts before then.
    const root = mkdtempSync(join(tmpdir(), "gitvault-status-noalloc-"));
    rmSync(root, { recursive: true, force: true });
    const { sdk } = sdkWith(() => ({ body: VAULT_RECORD }));
    const status = await sdk.gitvault.status({ project_id: "prj_demo", keystore_root: root });
    assert.equal(status.keystore.present, false);
    assert.equal(status.keystore.identity_fingerprint, null);
    assert.equal(status.keystore.can_sign, false);
    assert.equal(existsSync(join(root, "identity.json")), false, "status() must not write identity.json");
    assert.equal(existsSync(root), false, "status() must not even create the keystore root");
  });

  it("reports no vault (rather than throwing) when the project has none, and says what to do next", async () => {
    const { sdk } = sdkWith(() => ({ status: 404, body: { error: { code: "RESOURCE_NOT_FOUND", message: "no gitvault for this project" } } }));
    const status = await sdk.gitvault.status({ project_id: "prj_none", keystore_root: join(tmpdir(), "gitvault-absent-keystore-fixture") });
    assert.equal(status.vault, null);
    assert.equal(status.repo_id, null);
    // The command named here must be one that ACTUALLY ALLOCATES. This
    // assertion used to pin `run402 init`, which scaffolds the git remote and
    // deliberately allocates nothing — so status sent every user with no vault
    // to a command that silently did not do what status promised, and the test
    // enshrined it (gitvault dogfood #1, finding A).
    assert.ok(
      status.next_actions.some((a) => a.command === "run402 repos create --project <id>"),
      `expected the allocation verb, got ${JSON.stringify(status.next_actions)}`,
    );
    assert.equal(
      status.next_actions.some((a) => a.command === "run402 init"),
      false,
      "`run402 init` scaffolds the remote and allocates nothing — it must never be offered as the allocation step",
    );
  });

  it("says where the keystore lives, so 'whole-keystore loss is terminal' is actionable", async () => {
    const root = join(tmpdir(), "gitvault-keystore-paths-fixture");
    const { sdk } = sdkWith(() => ({ body: VAULT_RECORD }));
    const status = await sdk.gitvault.status({ project_id: "prj_demo", keystore_root: root });
    assert.equal(status.keystore.root, root);
    assert.equal(status.keystore.paths.identity, join(root, "identity.json"));
    assert.equal(status.keystore.paths.receipts, join(root, "receipts"));
    assert.ok(status.keystore.paths.repo?.startsWith(join(root, "repos")), status.keystore.paths.repo ?? "null");
    // A path is not key material; nothing here may leak a value.
    assert.equal(JSON.stringify(status).includes("k_repo"), false);
  });

  it("leaves the ref map null unless it is asked for — status is an observation, not a verification", async () => {
    const { sdk } = sdkWith(() => ({ body: VAULT_RECORD }));
    const status = await sdk.gitvault.status({ project_id: "prj_demo", keystore_root: join(tmpdir(), "gitvault-refs-off-fixture") });
    assert.equal(status.refs, null);
    assert.equal(status.head_target, null);
    assert.equal(status.remote, null, "no repo_dir was given, so there is no remote to report");
  });

  describe("status() remote detection checks both conventional names (kychee-com/run402#559c)", () => {
    // D1's own scaffold (`scaffoldRemote`) claims `origin` when the
    // repository has none yet, falling back to `run402` only when `origin`
    // is already taken by something else — so `origin` is the COMMON case,
    // not `run402`. Before this fix `status()` checked ONLY the literal name
    // "run402", so the ordinary post-`repos create` repository (whose vault
    // remote is `origin`) reported `remote: null` even though the remote was
    // sitting right there — a dogfood-observed regression, not a hypothetical.
    let root: string;
    async function freshRepoWithRemote(name: string, url: string): Promise<string> {
      root = mkdtempSync(join(tmpdir(), "run402-gitvault-status-remote-"));
      const dir = join(root, "repo");
      await hardenedGit(root, ["init", "-q", "-b", "main", "repo"]);
      await hardenedGit(dir, ["remote", "add", name, url]);
      return dir;
    }

    it("reports an 'origin' remote (the common case) — not just one literally named 'run402'", async () => {
      const url = gitvaultRemoteUrl(GITVAULT_TEST_ID_ORG, "prj_demo");
      const dir = await freshRepoWithRemote("origin", url);
      try {
        const { sdk } = sdkWith(() => ({ body: VAULT_RECORD }));
        const status = await sdk.gitvault.status({ project_id: "prj_demo", repo_dir: dir, keystore_root: join(tmpdir(), "gitvault-status-remote-ks") });
        assert.ok(status.remote, "an origin remote pointing at this project must be reported, not null");
        assert.equal(status.remote!.name, "origin");
        assert.equal(status.remote!.url, url);
        assert.equal(status.remote!.matches, true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("still reports a 'run402'-named remote when that is what exists (the pre-fix behavior, preserved)", async () => {
      const url = gitvaultRemoteUrl(GITVAULT_TEST_ID_ORG, "prj_demo");
      const dir = await freshRepoWithRemote("run402", url);
      try {
        const { sdk } = sdkWith(() => ({ body: VAULT_RECORD }));
        const status = await sdk.gitvault.status({ project_id: "prj_demo", repo_dir: dir, keystore_root: join(tmpdir(), "gitvault-status-remote-ks2") });
        assert.equal(status.remote!.name, "run402");
        assert.equal(status.remote!.matches, true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("prefers 'run402' over 'origin' when BOTH exist (D1's own naming precedence)", async () => {
      const runUrl = gitvaultRemoteUrl(GITVAULT_TEST_ID_ORG, "prj_demo");
      const dir = await freshRepoWithRemote("run402", runUrl);
      try {
        await hardenedGit(dir, ["remote", "add", "origin", "https://github.com/someone/else.git"]);
        const { sdk } = sdkWith(() => ({ body: VAULT_RECORD }));
        const status = await sdk.gitvault.status({ project_id: "prj_demo", repo_dir: dir, keystore_root: join(tmpdir(), "gitvault-status-remote-ks3") });
        assert.equal(status.remote!.name, "run402");
        assert.equal(status.remote!.url, runUrl);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("an 'origin' that is NOT run402-form is skipped in favor of a run402-form remote under the other name", async () => {
      const url = gitvaultRemoteUrl(GITVAULT_TEST_ID_ORG, "prj_demo");
      const dir = await freshRepoWithRemote("origin", "https://github.com/someone/unrelated.git");
      try {
        await hardenedGit(dir, ["remote", "add", "run402", url]);
        const { sdk } = sdkWith(() => ({ body: VAULT_RECORD }));
        const status = await sdk.gitvault.status({ project_id: "prj_demo", repo_dir: dir, keystore_root: join(tmpdir(), "gitvault-status-remote-ks4") });
        assert.equal(status.remote!.name, "run402");
        assert.equal(status.remote!.url, url);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("reports matches: false when the remote names a DIFFERENT project", async () => {
      const url = gitvaultRemoteUrl(GITVAULT_TEST_ID_ORG, "prj_other");
      const dir = await freshRepoWithRemote("origin", url);
      try {
        const { sdk } = sdkWith(() => ({ body: VAULT_RECORD }));
        const status = await sdk.gitvault.status({ project_id: "prj_demo", repo_dir: dir, keystore_root: join(tmpdir(), "gitvault-status-remote-ks5") });
        assert.equal(status.remote!.name, "origin");
        assert.equal(status.remote!.matches, false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("neither name present: remote stays null, same as before", async () => {
      root = mkdtempSync(join(tmpdir(), "run402-gitvault-status-remote-"));
      const dir = join(root, "repo");
      await hardenedGit(root, ["init", "-q", "-b", "main", "repo"]);
      try {
        const { sdk } = sdkWith(() => ({ body: VAULT_RECORD }));
        const status = await sdk.gitvault.status({ project_id: "prj_demo", repo_dir: dir, keystore_root: join(tmpdir(), "gitvault-status-remote-ks6") });
        assert.equal(status.remote, null);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  // ─── remote.matches tri-state for SLUG-FORM remotes (kychee-com/run402#562) ──
  //
  // THE DEFECT. `status()` used to compare `parsed.project_id` (the parsed
  // second half of the remote URL) against the real `prj_...` id for EVERY
  // remote form. For an id-form remote that second half genuinely IS the
  // project id, so the comparison is correct. For a SLUG-FORM remote
  // (`run402::<org-slug>/<name>`) that second half is a repo NAME, never a
  // project id — so a correctly-configured slug-form remote always failed
  // the comparison and `status`/`doctor` printed a misleading "points at a
  // DIFFERENT project" warning. The fix compares a slug-form remote against
  // the local id-pin instead (no network — `status` stays a pure
  // observation), and reports `null` (with a `reason`, never a mismatch)
  // when nothing is pinned there yet.
  describe("status() remote.matches is a tri-state for slug-form remotes (kychee-com/run402#562)", () => {
    const SLUG_URL = gitvaultRemoteUrlForRepo("acme", "my-notes");
    let root: string;

    async function freshRepoWithSlugRemote(): Promise<string> {
      root = mkdtempSync(join(tmpdir(), "run402-gitvault-status-remote-slug-"));
      const dir = join(root, "repo");
      await hardenedGit(root, ["init", "-q", "-b", "main", "repo"]);
      await hardenedGit(dir, ["remote", "add", "origin", SLUG_URL]);
      return dir;
    }

    it("pin present + equal → matches: true", async () => {
      const dir = await freshRepoWithSlugRemote();
      try {
        await pinGitvaultRepo(dir, VAULT_RECORD.repo_id, { org_slug: "acme", repo_name: "my-notes" });
        const { sdk } = sdkWith(() => ({ body: VAULT_RECORD }));
        const status = await sdk.gitvault.status({ repo_id: VAULT_RECORD.repo_id, repo_dir: dir, keystore_root: join(tmpdir(), "gitvault-status-remote-slug-ks1") });
        assert.ok(status.remote, "a slug-form remote must still be reported, not null");
        assert.equal(status.remote!.matches, true);
        assert.equal(status.remote!.reason, null);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("pin present + DIFFERENT → matches: false", async () => {
      const dir = await freshRepoWithSlugRemote();
      try {
        await pinGitvaultRepo(dir, "src_99999999999999999999999999999999", { org_slug: "acme", repo_name: "my-notes" });
        const { sdk } = sdkWith(() => ({ body: VAULT_RECORD }));
        const status = await sdk.gitvault.status({ repo_id: VAULT_RECORD.repo_id, repo_dir: dir, keystore_root: join(tmpdir(), "gitvault-status-remote-slug-ks2") });
        assert.equal(status.remote!.matches, false);
        assert.equal(status.remote!.reason, null);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("no pin yet → matches: null, with a reason — never a mismatch", async () => {
      const dir = await freshRepoWithSlugRemote();
      try {
        const { sdk } = sdkWith(() => ({ body: VAULT_RECORD }));
        const status = await sdk.gitvault.status({ repo_id: VAULT_RECORD.repo_id, repo_dir: dir, keystore_root: join(tmpdir(), "gitvault-status-remote-slug-ks3") });
        assert.equal(status.remote!.matches, null, "no pin exists yet, so there is nothing local to compare against — that is not evidence of a mismatch");
        assert.equal(status.remote!.reason, "name-form remote, not yet resolved on this machine");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("an id-form remote is entirely unaffected — its own URL text is still the whole comparison, no pin involved", async () => {
      root = mkdtempSync(join(tmpdir(), "run402-gitvault-status-remote-idform-"));
      const dir = join(root, "repo");
      await hardenedGit(root, ["init", "-q", "-b", "main", "repo"]);
      const idUrl = gitvaultRemoteUrl(GITVAULT_TEST_ID_ORG, "prj_demo");
      await hardenedGit(dir, ["remote", "add", "origin", idUrl]);
      try {
        const { sdk } = sdkWith(() => ({ body: VAULT_RECORD }));
        const status = await sdk.gitvault.status({ project_id: "prj_demo", repo_dir: dir, keystore_root: join(tmpdir(), "gitvault-status-remote-idform-ks") });
        assert.equal(status.remote!.matches, true);
        assert.equal(status.remote!.reason, null, "id-form never carries a reason — the comparison is always fully determined");
        assert.equal(status.pinned, null, "id-form never pins — a project id already never changes");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
});

/**
 * `access()`. The gateway's `envelope-recipients` read carries
 * server-authoritative `desired[]` + `desired_state_version` — these tests
 * pin both the current-gateway shape (real envelope_state/stale_access) and
 * the honest fallback against an older gateway that has not shipped
 * `desired[]` yet.
 */
describe("gitvault access() — envelope_state + stale_access from desired[]", () => {
  const REPO = VAULT_RECORD.repo_id;
  const ORG = VAULT_RECORD.org_id;

  function routeAccess(directoryKeys: unknown[], coverageBody: Record<string, unknown>) {
    return (call: Call) => {
      const url = new URL(call.url);
      if (url.pathname === `/gitvault/v1/vaults/${REPO}`) return { body: VAULT_RECORD };
      if (url.pathname === `/orgs/v1/${ORG}/encryption-keys`) return { body: { org_id: ORG, keys: directoryKeys } };
      if (url.pathname === `/gitvault/v1/vaults/${REPO}/envelope-recipients`) return { body: coverageBody };
      throw new Error(`unexpected request in access() test: ${call.url}`);
    };
  }

  it("reports real per-recipient envelope_state and stale_access when the gateway ships desired[]", async () => {
    const { sdk } = sdkWith(
      routeAccess(
        [
          { principal_id: "prn_alice", display_name: "Alice", ek_fingerprint: "ek_alice" },
          { principal_id: "prn_bob", display_name: "Bob", ek_fingerprint: "ek_bob" },
        ],
        {
          vault_id: REPO,
          // ek_orphan is covered but explained by NEITHER the directory NOR desired[] — genuinely unmatched.
          recipient_fingerprints: ["ek_alice", "ek_charlie", "ek_orphan"],
          desired: [
            { principal_id: "prn_alice", display_name: "Alice", status: "active", ek_fingerprint: "ek_alice", public_key: "pk_a", suite: "x25519-hkdf-sha256", covered: true },
            { principal_id: "prn_bob", display_name: "Bob", status: "active", ek_fingerprint: "ek_bob", public_key: "pk_b", suite: "x25519-hkdf-sha256", covered: false },
            // Removed from membership (no longer in the directory) but still covered — the real, un-revoked access gap.
            { principal_id: "prn_charlie", display_name: "Charlie", status: "pending_removal", ek_fingerprint: "ek_charlie", public_key: "pk_c", suite: "x25519-hkdf-sha256", covered: true },
          ],
          desired_state_version: 7,
        },
      ),
    );

    const result = await sdk.gitvault.access({ repo_id: REPO });

    assert.equal(result.envelope_state_available, true);
    assert.equal(result.history_scope_available, false);

    const alice = result.recipients.find((r) => r.principal_id === "prn_alice")!;
    assert.equal(alice.covered, true);
    assert.equal(alice.envelope_state, "converged");
    const bob = result.recipients.find((r) => r.principal_id === "prn_bob")!;
    assert.equal(bob.covered, false);
    assert.equal(bob.envelope_state, "pending");

    assert.deepEqual(result.stale_access, [{ principal_id: "prn_charlie", display_name: "Charlie", fingerprint: "ek_charlie" }]);

    // ek_charlie is explained by stale_access, not unmatched; ek_orphan is genuinely unexplained.
    assert.deepEqual(result.unmatched_covered_fingerprints, ["ek_orphan"]);

    assert.match(result.gap, /history_scope/);
    assert.match(result.gap, /stale_access/);
    assert.doesNotMatch(result.gap, /did not report desired-recipient state/);
  });

  it("falls back honestly — null envelope_state, no stale_access — against an older gateway with no desired[]", async () => {
    const { sdk } = sdkWith(
      routeAccess(
        [{ principal_id: "prn_alice", display_name: "Alice", ek_fingerprint: "ek_alice" }],
        { vault_id: REPO, recipient_fingerprints: ["ek_alice", "ek_orphan"] },
      ),
    );

    const result = await sdk.gitvault.access({ repo_id: REPO });

    assert.equal(result.envelope_state_available, false);
    assert.equal(result.history_scope_available, false);
    assert.equal(result.recipients[0]!.envelope_state, null);
    assert.deepEqual(result.stale_access, []);
    assert.deepEqual(result.unmatched_covered_fingerprints, ["ek_orphan"]);
    assert.match(result.gap, /did not report desired-recipient state/);
    assert.match(result.gap, /history_scope/);
  });

  it("breaks this keystore's own fingerprint out of unmatched_covered_fingerprints (dogfood #4)", async () => {
    const root = mkdtempSync(join(tmpdir(), "gitvault-access-this-keystore-"));
    try {
      const identity = new GitvaultKeystore({ rootDir: root }).ensureIdentity();
      const ownFingerprint = identity.encryption_fingerprint;

      const { sdk } = sdkWith(
        routeAccess(
          [{ principal_id: "prn_alice", display_name: "Alice", ek_fingerprint: "ek_alice" }],
          // The vault creator's own wallet-principal keystore is covered but
          // never in the org directory (it only lists human-enrolled keys) —
          // this must NOT read as orphaned/external.
          { vault_id: REPO, recipient_fingerprints: ["ek_alice", ownFingerprint, "ek_truly_orphan"] },
        ),
      );

      const result = await sdk.gitvault.access({ repo_id: REPO, keystore_root: root });

      assert.deepEqual(result.this_keystore, { fingerprint: ownFingerprint, covered: true });
      assert.deepEqual(result.unmatched_covered_fingerprints, ["ek_truly_orphan"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("this_keystore is null when this machine holds no local identity for the vault", async () => {
    const root = mkdtempSync(join(tmpdir(), "gitvault-access-no-keystore-"));
    try {
      const { sdk } = sdkWith(
        routeAccess(
          [{ principal_id: "prn_alice", display_name: "Alice", ek_fingerprint: "ek_alice" }],
          { vault_id: REPO, recipient_fingerprints: ["ek_alice", "ek_orphan"] },
        ),
      );

      const result = await sdk.gitvault.access({ repo_id: REPO, keystore_root: root });

      assert.equal(result.this_keystore, null);
      assert.deepEqual(result.unmatched_covered_fingerprints, ["ek_orphan"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("never wraps a key — access() issues only GET requests", async () => {
    const { sdk, calls } = sdkWith(routeAccess([], { vault_id: REPO, recipient_fingerprints: [], desired: [], desired_state_version: 0 }));
    await sdk.gitvault.access({ repo_id: REPO });
    assert.ok(calls.length > 0);
    for (const c of calls) assert.equal(c.method, "GET");
  });
});

describe("listByOrg follows the keyset cursor (never a silent page one)", () => {
  it("aggregates every page and returns has_more:false at the end", async () => {
    const { sdk, calls } = sdkWith((call) => {
      const cursor = new URL(call.url).searchParams.get("cursor");
      if (cursor === "c2") return { body: { vaults: [{ repo_id: "src_" + "3".repeat(32) }], has_more: false, next_cursor: null } };
      if (cursor === "c1") return { body: { vaults: [{ repo_id: "src_" + "2".repeat(32) }], has_more: true, next_cursor: "c2" } };
      return { body: { vaults: [{ repo_id: "src_" + "1".repeat(32) }], has_more: true, next_cursor: "c1" } };
    });
    const out = await sdk.gitvault.listByOrg("57035b1e-ec41-4ce6-a7a5-a5b2560efdd7");
    assert.equal(out.vaults.length, 3, "all three pages aggregated");
    assert.equal(out.has_more, false);
    assert.equal(out.next_cursor, null);
    assert.equal(calls.length, 3, "exactly one request per page");
    assert.match(calls[1]!.url, /cursor=c1/);
    assert.match(calls[2]!.url, /cursor=c2/);
  });

  it("a single-page listing makes exactly one request", async () => {
    const { sdk, calls } = sdkWith(() => ({ body: { vaults: [], has_more: false, next_cursor: null } }));
    const out = await sdk.gitvault.listByOrg("57035b1e-ec41-4ce6-a7a5-a5b2560efdd7");
    assert.equal(out.vaults.length, 0);
    assert.equal(calls.length, 1);
  });
});

/**
 * D210 (rev 44) — the CLI/SDK follow-up "an `fsck --attest-open`-class
 * submitter" the decision log names. Two layers, matching the file's own
 * stated split (protocol replay lives elsewhere; this is the SEAM):
 *
 *  1. `Gitvault.submitProofOfOpen` — the wire call itself (exact body sent,
 *     200-vs-201 status mapped to `deduplicated`).
 *  2. `computeOpenProofOutcome` — `fsck`'s auto-submission DECISION logic,
 *     factored out specifically so it is testable with injected
 *     dependencies rather than requiring a full HTTP-mocked chain-walking
 *     vault (`fsck()` itself has no dedicated seam test here for exactly
 *     that reason — its `verifyToNewest` machinery is covered end-to-end
 *     against the REAL `GitvaultMemoryTransport` fixture in
 *     `gitvault-epoch-reader.test.ts`/`gitvault-rotate.test.ts`; what this
 *     file owns is the auto-submission WIRING `fsck()` layers on top).
 */
describe("gitvault D210 proof-of-open submission (rev 44)", () => {
  it("Gitvault.submitProofOfOpen POSTs the evidence VERBATIM to the self-match route and reports deduplicated:false on a fresh 201 mint", async () => {
    const { sdk, calls } = sdkWith((call) => {
      return {
        status: 201,
        body: {
          format: "r402s/v0", object_kind: "recipient_open_receipt", object_id: "ror_" + "a".repeat(32),
          repo_id: "src_test", principal_id: "prn_alice", ek_fingerprint: "ek_alice",
          chain_verified_to_generation: "0000000000000002", decryptable_to_generation: "0000000000000003",
          reader_entrypoint: "run402@1.0.0/fsck", source: "recipient_submission",
          issued_at: "2026-08-28T12:00:00.000Z", service_key_id: "sk_test-1", signature: "AA",
        },
      };
    });
    const out = await sdk.gitvault.submitProofOfOpen("src_test", "prn_alice", {
      ek_fingerprint: "ek_alice",
      chain_verified_to_generation: "0000000000000002",
      decryptable_to_generation: "0000000000000003",
      reader_entrypoint: "run402@1.0.0/fsck",
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.method, "POST");
    assert.match(calls[0]!.url, /\/gitvault\/v1\/vaults\/src_test\/recipients\/prn_alice\/proof-of-open$/);
    assert.deepEqual(calls[0]!.body, {
      ek_fingerprint: "ek_alice",
      chain_verified_to_generation: "0000000000000002",
      decryptable_to_generation: "0000000000000003",
      reader_entrypoint: "run402@1.0.0/fsck",
    });
    assert.equal(out.deduplicated, false);
    assert.equal(out.receipt.decryptable_to_generation, "0000000000000003");
  });

  it("a 200 response (the D206 idempotent-replay shape) reports deduplicated:true", async () => {
    const { sdk } = sdkWith(() => ({
      status: 200,
      body: {
        format: "r402s/v0", object_kind: "recipient_open_receipt", object_id: "ror_" + "b".repeat(32),
        repo_id: "src_test", principal_id: "prn_alice", ek_fingerprint: "ek_alice",
        chain_verified_to_generation: "0000000000000002", decryptable_to_generation: "0000000000000003",
        reader_entrypoint: "run402@1.0.0/fsck", source: "recipient_submission",
        issued_at: "2026-08-28T12:00:00.000Z", service_key_id: "sk_test-1", signature: "AA",
      },
    }));
    const out = await sdk.gitvault.submitProofOfOpen("src_test", "prn_alice", {
      ek_fingerprint: "ek_alice", chain_verified_to_generation: "0000000000000002", decryptable_to_generation: "0000000000000003", reader_entrypoint: "run402@1.0.0/fsck",
    });
    assert.equal(out.deduplicated, true, "the gateway returned the tuple's EXISTING receipt, not a fresh mint");
  });
});

describe("computeOpenProofOutcome — fsck's D210 auto-submission decision logic (rev 44)", () => {
  const evidence = { chain_verified_to_generation: "0000000000000002", decryptable_to_generation: "0000000000000003" };
  const stubReceipt = { object_id: "ror_" + "c".repeat(32) } as unknown as GitvaultOpenReceipt;

  it("write:false (a genuine audit mode) never calls resolvePrincipalId or submit — no network side effect from --no-write", async () => {
    let resolveCalled = false;
    let submitCalled = false;
    const out = await computeOpenProofOutcome({
      write: false,
      ekFingerprint: "ek_alice",
      evidence,
      resolvePrincipalId: async () => { resolveCalled = true; return "prn_alice"; },
      readerEntrypoint: async () => "run402@1.0.0/fsck",
      submit: async () => { submitCalled = true; return { receipt: stubReceipt, deduplicated: false }; },
    });
    assert.deepEqual(out, { attempted: false, submitted: false, deduplicated: null, receipt: null, error: null });
    assert.equal(resolveCalled, false);
    assert.equal(submitCalled, false);
  });

  it("no local encryption identity — the same silent, network-free skip as write:false", async () => {
    let called = false;
    const out = await computeOpenProofOutcome({
      write: true,
      ekFingerprint: null,
      evidence,
      resolvePrincipalId: async () => { called = true; return "prn_alice"; },
      readerEntrypoint: async () => "run402@1.0.0/fsck",
      submit: async () => { called = true; return { receipt: stubReceipt, deduplicated: false }; },
    });
    assert.deepEqual(out, { attempted: false, submitted: false, deduplicated: null, receipt: null, error: null });
    assert.equal(called, false);
  });

  it("principal resolution returning null (e.g. a delegate-authenticated caller GET /agent/v1/whoami cannot resolve) is REPORTED, never thrown, and submit is never called", async () => {
    let submitCalled = false;
    const out = await computeOpenProofOutcome({
      write: true,
      ekFingerprint: "ek_alice",
      evidence,
      resolvePrincipalId: async () => null,
      readerEntrypoint: async () => "run402@1.0.0/fsck",
      submit: async () => { submitCalled = true; return { receipt: stubReceipt, deduplicated: false }; },
    });
    assert.equal(out.attempted, true);
    assert.equal(out.submitted, false);
    assert.equal(out.deduplicated, null);
    assert.equal(out.receipt, null);
    assert.equal(out.error?.code, "GITVAULT_PROOF_OF_OPEN_PRINCIPAL_UNRESOLVED");
    assert.equal(submitCalled, false);
  });

  it("submit throwing (e.g. the gateway's own OPEN_PROOF_MISMATCH) is CAUGHT and reported — never thrown through, never changing fsck's own already-computed verdict", async () => {
    class FakeRun402Error extends Error {
      readonly isRun402Error = true as const;
      readonly code = "OPEN_PROOF_MISMATCH";
    }
    const out = await computeOpenProofOutcome({
      write: true,
      ekFingerprint: "ek_alice",
      evidence,
      resolvePrincipalId: async () => "prn_alice",
      readerEntrypoint: async () => "run402@1.0.0/fsck",
      submit: async () => { throw new FakeRun402Error("decryptable_to_generation exceeds the vault's newest committed generation"); },
    });
    assert.equal(out.attempted, true);
    assert.equal(out.submitted, false);
    assert.equal(out.error?.code, "OPEN_PROOF_MISMATCH");
  });

  it("a resolvePrincipalId THROW (e.g. a network failure resolving whoami) is caught identically — the failure mode is uniform regardless of WHICH step failed", async () => {
    const out = await computeOpenProofOutcome({
      write: true,
      ekFingerprint: "ek_alice",
      evidence,
      resolvePrincipalId: async () => { throw new Error("network unreachable"); },
      readerEntrypoint: async () => "run402@1.0.0/fsck",
      submit: async () => { throw new Error("must not be reached"); },
    });
    assert.equal(out.attempted, true);
    assert.equal(out.submitted, false);
    assert.equal(out.error?.code, "UNKNOWN", "a plain Error (not a Run402Error) has no .code — falls back honestly rather than fabricating one");
    assert.match(out.error!.message, /network unreachable/);
  });

  it("the happy path submits fsck's OWN evidence VERBATIM — exact principal_id/ek_fingerprint/chain_verified_to_generation/decryptable_to_generation/reader_entrypoint reach submit() unchanged", async () => {
    let seen: { principalId: string; ekFingerprint: string; evidence: unknown } | null = null;
    const out = await computeOpenProofOutcome({
      write: true,
      ekFingerprint: "ek_alice",
      evidence,
      resolvePrincipalId: async () => "prn_alice",
      readerEntrypoint: async () => "run402@1.0.0/fsck",
      submit: async (principalId, ekFingerprint, ev) => {
        seen = { principalId, ekFingerprint, evidence: ev };
        return { receipt: stubReceipt, deduplicated: true };
      },
    });
    assert.deepEqual(seen, {
      principalId: "prn_alice",
      ekFingerprint: "ek_alice",
      evidence: { chain_verified_to_generation: "0000000000000002", decryptable_to_generation: "0000000000000003", reader_entrypoint: "run402@1.0.0/fsck" },
    });
    assert.equal(out.attempted, true);
    assert.equal(out.submitted, true);
    assert.equal(out.deduplicated, true);
    assert.equal(out.receipt, stubReceipt);
    assert.equal(out.error, null);
  });
});

// ─── gitvault-clone-scaling (P3): checkpoint-staleness helper ────────────────

describe("gitvaultCheckpointStaleness — pure, never-throwing, threshold in one place", () => {
  const staleness = (newest: string, covered: string | null) =>
    gitvaultCheckpointStaleness({ newest_generation: newest, covers_through_generation: covered });

  it("unknown coverage is silent — {0, advised: false}, never a guess", () => {
    assert.deepEqual(staleness("00000000000000ff", null), { generations_since_checkpoint: 0, advised: false });
  });

  it("coverage at the newest generation reads current", () => {
    assert.deepEqual(staleness("0000000000000020", "0000000000000020"), { generations_since_checkpoint: 0, advised: false });
  });

  it("the threshold boundary is >= (24 quiet, 25 advises) — the one constant to tune", () => {
    assert.equal(GITVAULT_CHECKPOINT_ADVISORY_GENERATIONS, 25);
    // covered=1, newest=25 → 24 since; newest=26 → 25 since.
    assert.deepEqual(staleness("0000000000000019", "0000000000000001"), { generations_since_checkpoint: 24, advised: false });
    assert.deepEqual(staleness("000000000000001a", "0000000000000001"), { generations_since_checkpoint: 25, advised: true });
  });

  it("genesis coverage (a WAL-only vault whose walk anchored at genesis) counts from zero", () => {
    // newest = 0x19 = 25 generations past the genesis sentinel.
    assert.deepEqual(staleness("0000000000000019", "0000000000000000"), { generations_since_checkpoint: 25, advised: true });
  });

  it("coverage AHEAD of newest clamps to zero (a stale local newest never advises)", () => {
    assert.deepEqual(staleness("0000000000000005", "0000000000000009"), { generations_since_checkpoint: 0, advised: false });
  });

  it("malformed generations on either side are silent, not a throw", () => {
    assert.deepEqual(staleness("not-hex", "0000000000000001"), { generations_since_checkpoint: 0, advised: false });
    assert.deepEqual(staleness("0000000000000005", "xyz"), { generations_since_checkpoint: 0, advised: false });
    assert.deepEqual(staleness("", ""), { generations_since_checkpoint: 0, advised: false });
  });
});
