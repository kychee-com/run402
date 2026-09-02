/**
 * The handoff mint / claim responses' wire shape vs the SDK's result shape
 * (kygit-handoff design D10).
 *
 * The gateway names the vault by its three ids — `repo_id`, `org_id`,
 * `project_id` (docs/style.md vocabulary) — and the minted role as `role`;
 * the claim's `membership` block spells the org `org_id` too. The SDK groups
 * the ids under `vault` and uses `organization_id` like every other SDK
 * result. The 2026-09-02 live handoff rehearsal caught the SDK reading
 * `minted_role` / `vault` / `membership.organization_id` off the wire —
 * names the gateway never sends — which printed "handoff minted: role
 * undefined" at the CLI and would have refused every `resume`. The fixtures
 * below are the documented response bodies (llms-full.txt "Handoff /
 * resume"), so a drift on either side fails here first.
 *
 * Run: node --test --import tsx sdk/src/namespaces/gitvault-handoff-wire.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { handoffMembershipFromWire, handoffVaultFromWire } from "./gitvault.js";

// The documented mint response body — every field the gateway sends, so a
// rename on either side of the boundary is visible in one place.
const MINT_RESPONSE = {
  handoff_id: "a3266fe6-31ca-4ed0-b3b8-cbe41525e472",
  kind: "handoff" as const,
  role: "owner",
  expires_at: "2026-09-02T16:11:58.419Z",
  repo_id: "src_777c3254203e2ae80cfb302a2810791b",
  org_id: "7c524d76-208f-42de-aba7-a9f0f1c4f8b0",
  project_id: "prj_1788360609776_0053",
  checkpoint: { generation: "0000000000000005", snapshot_oid_hmac: "ab".repeat(32) },
  warning: "Anyone holding this key becomes an owner of this org until first use or 2026-09-02T16:11:58.419Z.",
  warnings: [{ code: "HANDOFF_KEY_CONFERS_ROLE", message: "Anyone holding this key becomes an owner of this org until first use or 2026-09-02T16:11:58.419Z." }],
  next_actions: [{ type: "revoke_handoff", why: "…", method: "DELETE", path: "/gitvault/v1/vaults/src_777c3254203e2ae80cfb302a2810791b/handoffs/a3266fe6-31ca-4ed0-b3b8-cbe41525e472" }],
};

// The documented claim response body (minus the sealed envelope bytes).
const CLAIM_RESPONSE = {
  handoff_id: MINT_RESPONSE.handoff_id,
  kind: "handoff" as const,
  deduplicated: false,
  sealed_envelope: "…",
  envelope_kind: "kgh1",
  repo_id: MINT_RESPONSE.repo_id,
  org_id: MINT_RESPONSE.org_id,
  project_id: MINT_RESPONSE.project_id,
  checkpoint: MINT_RESPONSE.checkpoint,
  membership: { org_id: MINT_RESPONSE.org_id, role: "owner", status: "active" },
  members: [],
  expires_at: MINT_RESPONSE.expires_at,
  next_actions: [{ type: "push_repo", why: "…", command: "git push origin main" }],
};

describe("handoffVaultFromWire — the gateway's three ids become the SDK's `vault` block", () => {
  it("maps repo_id / org_id / project_id from a mint response, with no address unless the caller supplies one", () => {
    assert.deepEqual(handoffVaultFromWire(MINT_RESPONSE), {
      vault_id: MINT_RESPONSE.repo_id,
      address: null,
      organization_id: MINT_RESPONSE.org_id,
      project_id: MINT_RESPONSE.project_id,
    });
  });

  it("maps the same three ids from a claim response — the two bodies share the vault vocabulary", () => {
    assert.deepEqual(handoffVaultFromWire(CLAIM_RESPONSE), handoffVaultFromWire(MINT_RESPONSE));
  });

  it("carries a caller-known slug-form address through verbatim (a minter's own remote), never inventing one", () => {
    assert.equal(handoffVaultFromWire(MINT_RESPONSE, "acme/notes").address, "acme/notes");
    assert.equal(handoffVaultFromWire(MINT_RESPONSE, null).address, null);
  });

  it("never reads the names the gateway does not send (`minted_role`, `vault`, `organization_id`)", () => {
    // A body carrying ONLY the wrong spellings must not satisfy the mapper —
    // the point of the fixture is that the documented names are the ones read.
    const wrongSpellings = { minted_role: "owner", vault: { vault_id: "x", organization_id: "y", project_id: "z" } } as unknown as Parameters<typeof handoffVaultFromWire>[0];
    const mapped = handoffVaultFromWire(wrongSpellings);
    assert.equal(mapped.vault_id, undefined);
    assert.equal(mapped.organization_id, undefined);
    assert.equal(mapped.project_id, undefined);
  });
});

describe("handoffMembershipFromWire — the claim's `membership.org_id` becomes `organization_id`", () => {
  it("maps role and status through unchanged", () => {
    assert.deepEqual(handoffMembershipFromWire(CLAIM_RESPONSE.membership), {
      organization_id: MINT_RESPONSE.org_id,
      role: "owner",
      status: "active",
    });
  });
});
