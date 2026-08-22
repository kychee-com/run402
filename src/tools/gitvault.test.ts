/**
 * gitvault MCP tool behaviour.
 *
 * What matters here, and why:
 *   - the terminal-loss sentence reaches the AGENT, not just the source file —
 *     it is printed from the SDK's own constant, so this test uses that same
 *     constant and would fail if the tool summarised it;
 *   - `list_gitvault_heads` truncates the VIEW and never the DATA: the window
 *     is bounded, `shown`/`total` disagree honestly, and the ref resolves to
 *     every row the SDK returned;
 *   - the opaque cursor is echoed back to the caller with its rules attached,
 *     because the recovery from a stale one is "restart from the anchor", not
 *     "guess";
 *   - a verification refusal keeps its code AND gains plain-language recovery.
 *
 * Run: node --experimental-test-module-mocks --test --import tsx src/tools/gitvault.test.ts
 */

import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";

import { GITVAULT_TERMINAL_LOSS_DOCTOR_TEXT, GITVAULT_TERMINAL_LOSS_STATEMENT } from "../../sdk/dist/index.js";
import { _resetResultStore, expandResult } from "../result-store.js";

const VAULT_RECORD = {
  repo_id: "src_0123456789abcdef0123456789abcdef",
  project_id: "prj_demo",
  org_id: "org_demo",
  gitvault_policy: "required" as const,
  gitvault_policy_version: "3",
  gitvault_policy_changed_at: null,
  allocation_generation: "0000000000000001",
  allocation_sha256: null,
  newest_generation: "000000000000000a",
  genesis_admitted_at: "2026-08-01T00:00:00Z",
  latest_effective_admitted_at: "2026-08-20T00:00:00Z",
  admitted_generations: "10",
  gc_epoch: "0000000000000001",
  repair_version: "0",
  repair_fence_state: "clear",
  storage: { source_bytes: "4096", open_session_reserved_bytes: "0", objects: {} },
  maintenance: { lease: null, open_cycle: null, pending_repair_attempt_id: null },
  warnings: [],
  created_at: "2026-08-01T00:00:00Z",
};

const STATUS = {
  repo_id: VAULT_RECORD.repo_id,
  project_id: "prj_demo",
  vault: VAULT_RECORD,
  keystore: { present: true, identity_fingerprint: "vk_abc", can_sign: true, holds_repo_key: true },
  pins: { highest_authenticated: "000000000000000a", highest_materialized: "000000000000000a" },
  gitvault_policy: "required" as const,
  pending_overrides: 0,
  terminal_loss_statement: GITVAULT_TERMINAL_LOSS_STATEMENT,
  terminal_loss_detail: GITVAULT_TERMINAL_LOSS_DOCTOR_TEXT,
  warnings: [] as { kind: string; message: string }[],
  next_actions: [] as { action: string; command?: string }[],
};

const headsPage = (count: number, hasMore: boolean) => ({
  format: "r402s/v0",
  repo_id: VAULT_RECORD.repo_id,
  after_generation: "0000000000000000",
  heads: Array.from({ length: count }, (_, i) => ({
    generation: (i + 1).toString(16).padStart(16, "0"),
    stored_bytes_sha256: `${i}`.padStart(64, "a"),
  })),
  has_more: hasMore,
  next_cursor: hasMore ? "opaque-cursor-token" : null,
  total: String(count),
});

const VERIFIED = {
  generation: "000000000000000a",
  head_sha256: "b".repeat(64),
  head: { generation: "000000000000000a", epoch: "0000000000000001", checkpoint: {} },
  genesis: {
    repo_id: VAULT_RECORD.repo_id,
    org_id: "org_demo",
    project_id: "prj_demo",
    writer_key_id: "vk_abc",
    created_at: "2026-08-01T00:00:00Z",
  },
};

let calls: Array<{ method: string; args: unknown[] }> = [];
let activeProject: string | null;
let statusBehavior: (options: unknown) => Promise<unknown>;
let headsBehavior: (repoId: string, request: unknown) => Promise<unknown>;
let forProjectBehavior: (projectId: string) => Promise<unknown>;
let verifyBehavior: (options: unknown) => Promise<unknown>;

mock.module("../sdk.js", {
  namedExports: {
    getSdk: () => ({
      projects: { active: async () => activeProject },
      gitvault: {
        status: (options: unknown) => {
          calls.push({ method: "status", args: [options] });
          return statusBehavior(options);
        },
        heads: (repoId: string, request: unknown) => {
          calls.push({ method: "heads", args: [repoId, request] });
          return headsBehavior(repoId, request);
        },
        forProject: (projectId: string) => {
          calls.push({ method: "forProject", args: [projectId] });
          return forProjectBehavior(projectId);
        },
        verify: (options: unknown) => {
          calls.push({ method: "verify", args: [options] });
          return verifyBehavior(options);
        },
      },
    }),
    _resetSdk: () => {},
  },
});

const { handleGetGitvaultStatus, handleListGitvaultHeads, handleVerifyGitvault } = await import("./gitvault.js");

const textOf = (result: { content: Array<{ text: string }> }): string => result.content.map((c) => c.text).join("\n");

beforeEach(() => {
  calls = [];
  _resetResultStore();
  activeProject = "prj_active";
  statusBehavior = async () => STATUS;
  headsBehavior = async () => headsPage(3, false);
  forProjectBehavior = async () => VAULT_RECORD;
  verifyBehavior = async () => VERIFIED;
});

afterEach(() => {
  _resetResultStore();
});

describe("get_gitvault_status", () => {
  it("addresses the vault by project_id and reports the record", async () => {
    const out = textOf(await handleGetGitvaultStatus({ project_id: "prj_demo" }));
    assert.deepEqual(calls[0], { method: "status", args: [{ project_id: "prj_demo" }] });
    assert.match(out, /gitvault src_0123456789abcdef0123456789abcdef/);
    assert.match(out, /policy {2,}required/);
    assert.match(out, /highest authenticated {2,}000000000000000a/);
  });

  it("repo_id wins over project_id", async () => {
    await handleGetGitvaultStatus({ project_id: "prj_demo", repo_id: "src_other" });
    assert.deepEqual(calls[0], { method: "status", args: [{ repo_id: "src_other" }] });
  });

  it("falls back to the active project when neither id is given", async () => {
    await handleGetGitvaultStatus({});
    assert.deepEqual(calls[0], { method: "status", args: [{ project_id: "prj_active" }] });
  });

  it("says so, rather than guessing, when there is no project at all", async () => {
    activeProject = null;
    const result = await handleGetGitvaultStatus({});
    assert.equal(result.isError, true);
    assert.match(textOf(result), /No project_id provided and no active project is set/);
    assert.equal(calls.length, 0, "it must not call the vault with an unresolved target");
  });

  it("prints the terminal-loss sentence VERBATIM, and its full detail", async () => {
    const out = textOf(await handleGetGitvaultStatus({ project_id: "prj_demo" }));
    assert.ok(out.includes(GITVAULT_TERMINAL_LOSS_STATEMENT), "the reviewed sentence must reach the agent unchanged");
    assert.ok(out.includes(GITVAULT_TERMINAL_LOSS_DOCTOR_TEXT), "the §0 detail paragraph is printed in full");
  });

  it("is truthful when no vault is allocated", async () => {
    statusBehavior = async () => ({ ...STATUS, repo_id: null, vault: null, pins: { highest_authenticated: null, highest_materialized: null }, next_actions: [{ action: "allocate the project's vault", command: "run402 init" }] });
    const out = textOf(await handleGetGitvaultStatus({ project_id: "prj_demo" }));
    assert.match(out, /No vault is allocated for project prj_demo\./);
    assert.match(out, /run402 init/);
    assert.ok(out.includes(GITVAULT_TERMINAL_LOSS_STATEMENT), "a vault-less project still gets the statement");
  });

  it("surfaces warnings rather than smoothing them away", async () => {
    statusBehavior = async () => ({
      ...STATUS,
      keystore: { ...STATUS.keystore, can_sign: false },
      warnings: [{ kind: "read_only", message: "the signing key is missing from identity.json" }],
    });
    const out = textOf(await handleGetGitvaultStatus({ project_id: "prj_demo" }));
    assert.match(out, /read_only: the signing key is missing/);
    assert.match(out, /can sign {2,}no — read-only/);
  });
});

describe("list_gitvault_heads", () => {
  it("passes the anchor, stringified limit and cursor straight through", async () => {
    await handleListGitvaultHeads({
      repo_id: "src_x",
      after_generation: "0000000000000000",
      limit: 500,
      cursor: "opaque-cursor-token",
    });
    assert.deepEqual(calls[0], {
      method: "heads",
      args: ["src_x", { after_generation: "0000000000000000", limit: "500", cursor: "opaque-cursor-token" }],
    });
  });

  it("omits cursor entirely on a first page", async () => {
    await handleListGitvaultHeads({ repo_id: "src_x", after_generation: "0000000000000000", limit: 10 });
    const request = calls[0]!.args[1] as Record<string, unknown>;
    assert.equal("cursor" in request, false, "an absent cursor must not be sent as undefined/null");
  });

  it("resolves repo_id from the project when only a project is known", async () => {
    await handleListGitvaultHeads({ project_id: "prj_demo", after_generation: "0000000000000000", limit: 10 });
    assert.deepEqual(calls[0], { method: "forProject", args: ["prj_demo"] });
    assert.equal((calls[1]!.args as unknown[])[0], VAULT_RECORD.repo_id);
  });

  it("truncates the VIEW and never the DATA", async () => {
    headsBehavior = async () => headsPage(137, false);
    const out = textOf(
      await handleListGitvaultHeads({ repo_id: "src_x", after_generation: "0000000000000000", limit: 1000 }),
    );
    assert.match(out, /Showing 20 of 137 in this page/, "shown and total must both be reported");
    const ref = /ref (res_[0-9a-f]{16})/.exec(out)?.[1];
    assert.ok(ref, "a bounded view must hand back the ref that reaches the rest");
    assert.match(out, /expand_result with ref res_[0-9a-f]{16}/);

    const stored = expandResult(ref!, { limit: 1000 });
    assert.equal(stored?.total, 137, "the FULL page is retained, not the window");
    assert.equal(stored?.shown, 137);
    assert.equal((stored?.items[136] as { generation: string }).generation, (137).toString(16).padStart(16, "0"));
  });

  it("does not offer an expand affordance when the whole page is already shown", async () => {
    const out = textOf(await handleListGitvaultHeads({ repo_id: "src_x", after_generation: "0000000000000000", limit: 10 }));
    assert.match(out, /Showing 3 of 3 in this page/);
    assert.equal(/expand_result with ref/.test(out), false);
  });

  it("hands back the opaque cursor with the rules that make it usable", async () => {
    headsBehavior = async () => headsPage(3, true);
    const out = textOf(await handleListGitvaultHeads({ repo_id: "src_x", after_generation: "0000000000000000", limit: 3 }));
    assert.match(out, /SAME after_generation \(0000000000000000\) and cursor opaque-cursor-token/);
    assert.match(out, /Echo that cursor unchanged/);
    assert.match(out, /INVALID_CURSOR; restart from after_generation with no cursor/);
  });

  it("says the sequence is finished when has_more is false", async () => {
    const out = textOf(await handleListGitvaultHeads({ repo_id: "src_x", after_generation: "0000000000000000", limit: 10 }));
    assert.match(out, /has_more is false — this is the last page/);
  });

  it("does not let listing be mistaken for verifying", async () => {
    const out = textOf(await handleListGitvaultHeads({ repo_id: "src_x", after_generation: "0000000000000000", limit: 10 }));
    assert.match(out, /Listing a head is not verifying it/);
  });
});

describe("verify_gitvault", () => {
  it("reports the verified generation and that the pin only moves forward", async () => {
    const out = textOf(await handleVerifyGitvault({ project_id: "prj_demo" }));
    assert.deepEqual(calls[0], { method: "verify", args: [{ project_id: "prj_demo" }] });
    assert.match(out, /Verified to generation 000000000000000a/);
    assert.match(out, /monotonic and non-destructive/);
    assert.match(out, /Writer key vk_abc/);
    assert.match(out, /checkpoint-bearing/);
  });

  it("is honest about a chain that is only genesis", async () => {
    verifyBehavior = async () => ({ ...VERIFIED, head: null, generation: "0000000000000000" });
    const out = textOf(await handleVerifyGitvault({ project_id: "prj_demo" }));
    assert.match(out, /Nothing has been admitted above genesis yet/);
  });

  it("keeps the refusal code and adds plain-language recovery", async () => {
    verifyBehavior = async () => {
      const err = new Error("listed head 000000000000000b is absent from storage") as Error & { code: string };
      err.code = "CHAIN_BROKEN";
      throw err;
    };
    const result = await handleVerifyGitvault({ project_id: "prj_demo" });
    assert.equal(result.isError, true);
    const out = textOf(result);
    assert.match(out, /absent from storage/, "the SDK's own message survives");
    assert.match(out, /A link is missing or does not match/, "and the agent is told what to do about it");
  });

  it("calls a budget pause a pause, not a failure", async () => {
    verifyBehavior = async () => {
      const err = new Error("512 heads verified this call") as Error & { code: string };
      err.code = "VERIFICATION_BUDGET_EXCEEDED";
      throw err;
    };
    const out = textOf(await handleVerifyGitvault({ project_id: "prj_demo" }));
    assert.match(out, /a pause, not a failure/);
    assert.match(out, /resumes from where it stopped/);
  });

  it("passes an unknown failure through untouched", async () => {
    verifyBehavior = async () => {
      throw new Error("socket hang up");
    };
    const result = await handleVerifyGitvault({ project_id: "prj_demo" });
    assert.equal(result.isError, true);
    assert.equal(result.content.length, 1, "no invented guidance for a failure we do not recognise");
    assert.match(textOf(result), /socket hang up/);
  });
});
