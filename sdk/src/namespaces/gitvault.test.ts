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
import { gitvaultRemoteUrl, parseGitvaultRemoteUrl } from "./gitvault.js";
import { GITVAULT_TERMINAL_LOSS_DOCTOR_TEXT, GITVAULT_TERMINAL_LOSS_STATEMENT } from "./gitvault.crypto.js";
import type { CredentialsProvider } from "../credentials.js";

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

describe("gitvault remote URLs", () => {
  it("round-trips `run402::<org_id>/<project_id>`", () => {
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
      status.next_actions.some((a) => a.command === "run402 gitvault init"),
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
});
