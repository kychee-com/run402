import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  saveApproval,
  clearApprovals,
  readApprovals,
  loadLiveApproval,
  approvalFromTokenResponse,
  hashControlPlaneSession,
  type WriteAuthApproval,
} from "./write-auth-session.js";

let dir: string;
let cachePath: string;

function entry(over: Partial<WriteAuthApproval> = {}): WriteAuthApproval {
  return {
    write_auth_token: "wat_tok",
    token_type: "write_auth",
    header: "X-Run402-Write-Auth",
    action: "project.deploy",
    project_id: "prj_x",
    expires_at: Date.now() + 60_000,
    control_plane_session_hash: "cphash1",
    control_plane_principal_id: "prn_1",
    api_origin: "https://api.run402.com",
    minted_at: Date.now(),
    ...over,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wa-sess-"));
  cachePath = join(dir, "write-auth-session.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("write-auth-session cache", () => {
  it("round-trips a saved approval", () => {
    saveApproval(entry({ write_auth_token: "tok-a" }), cachePath);
    const got = loadLiveApproval(
      { apiOrigin: "https://api.run402.com", cpSessionHash: "cphash1", capability: "project.deploy", target: { project_id: "prj_x" } },
      cachePath,
    );
    assert.equal(got?.write_auth_token, "tok-a");
  });

  it("keeps distinct (action, target) approvals — multi-entry, non-thrashing", () => {
    saveApproval(entry({ action: "project.deploy", project_id: "prj_x", write_auth_token: "deploy-x" }), cachePath);
    saveApproval(entry({ action: "org.project.create", project_id: undefined, org_id: "org_y", write_auth_token: "create-y" }), cachePath);
    assert.equal(readApprovals(cachePath).length, 2);
    const a = loadLiveApproval({ apiOrigin: "https://api.run402.com", cpSessionHash: "cphash1", capability: "project.deploy", target: { project_id: "prj_x" } }, cachePath);
    const b = loadLiveApproval({ apiOrigin: "https://api.run402.com", cpSessionHash: "cphash1", capability: "org.project.create", target: { org_id: "org_y" } }, cachePath);
    assert.equal(a?.write_auth_token, "deploy-x");
    assert.equal(b?.write_auth_token, "create-y");
  });

  it("replaces the entry with the same key, keeps others", () => {
    saveApproval(entry({ project_id: "prj_x", write_auth_token: "old" }), cachePath);
    saveApproval(entry({ project_id: "prj_other", write_auth_token: "keep" }), cachePath);
    saveApproval(entry({ project_id: "prj_x", write_auth_token: "new" }), cachePath);
    assert.equal(readApprovals(cachePath).length, 2);
    const x = loadLiveApproval({ apiOrigin: "https://api.run402.com", cpSessionHash: "cphash1", capability: "project.deploy", target: { project_id: "prj_x" } }, cachePath);
    assert.equal(x?.write_auth_token, "new");
  });

  it("returns null on a non-matching target, action, origin, or cp-session", () => {
    saveApproval(entry({ project_id: "prj_x" }), cachePath);
    const q = { apiOrigin: "https://api.run402.com", cpSessionHash: "cphash1", capability: "project.deploy" as const };
    assert.equal(loadLiveApproval({ ...q, target: { project_id: "prj_OTHER" } }, cachePath), null, "wrong target");
    assert.equal(loadLiveApproval({ ...q, capability: "project.secret.write", target: { project_id: "prj_x" } }, cachePath), null, "wrong action");
    assert.equal(loadLiveApproval({ ...q, apiOrigin: "https://staging.run402.com", target: { project_id: "prj_x" } }, cachePath), null, "wrong origin");
    assert.equal(loadLiveApproval({ ...q, cpSessionHash: "OTHER", target: { project_id: "prj_x" } }, cachePath), null, "wrong cp-session");
  });

  it("does not return an expired approval", () => {
    saveApproval(entry({ expires_at: Date.now() - 1000 }), cachePath);
    assert.equal(
      loadLiveApproval({ apiOrigin: "https://api.run402.com", cpSessionHash: "cphash1", capability: "project.deploy", target: { project_id: "prj_x" } }, cachePath),
      null,
    );
  });

  it("clearApprovals removes the cache", () => {
    saveApproval(entry(), cachePath);
    clearApprovals(cachePath);
    assert.equal(readApprovals(cachePath).length, 0);
  });

  it("writes the cache file with 0600 perms", () => {
    saveApproval(entry(), cachePath);
    if (process.platform !== "win32") {
      assert.equal(statSync(cachePath).mode & 0o777, 0o600);
    }
  });

  it("throws a fix-it on a corrupt-shape cache (object without approvals[])", () => {
    writeFileSync(cachePath, JSON.stringify({ nope: true }), { mode: 0o600 });
    assert.throws(() => readApprovals(cachePath), /approvals/);
  });

  it("approvalFromTokenResponse derives expiry from session + binds origin/session/target", () => {
    const exp = new Date(Date.now() + 120_000).toISOString();
    const a = approvalFromTokenResponse(
      { write_auth_token: "tok", token_type: "write_auth", header: "X-Run402-Write-Auth", session: { expires_at: exp } },
      { action: "project.deploy", target: { project_id: "prj_z" }, apiOrigin: "https://api.run402.com", controlPlaneSessionHash: "h", controlPlanePrincipalId: "p" },
    );
    assert.equal(a.action, "project.deploy");
    assert.equal(a.project_id, "prj_z");
    assert.equal(a.api_origin, "https://api.run402.com");
    assert.equal(a.expires_at, Date.parse(exp));
  });

  it("hashControlPlaneSession is stable and 32 hex chars", () => {
    const h = hashControlPlaneSession("a-token");
    assert.equal(h, hashControlPlaneSession("a-token"));
    assert.match(h, /^[0-9a-f]{32}$/);
    assert.notEqual(h, hashControlPlaneSession("different"));
  });
});
