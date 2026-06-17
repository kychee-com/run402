/**
 * NodeCredentialsProvider tests — uses a temp config dir so the host user's
 * real keystore/allowance is not touched.
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { NodeCredentialsProvider } from "./credentials.js";

let tempDir: string;
const originalConfigDir = process.env.RUN402_CONFIG_DIR;
const originalApiBase = process.env.RUN402_API_BASE;

before(() => {
  process.env.RUN402_API_BASE = "https://api.run402.test";
});

after(() => {
  if (originalApiBase !== undefined) process.env.RUN402_API_BASE = originalApiBase;
  else delete process.env.RUN402_API_BASE;
});

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "run402-sdk-node-creds-"));
  process.env.RUN402_CONFIG_DIR = tempDir;
});

afterEach(() => {
  if (originalConfigDir !== undefined) process.env.RUN402_CONFIG_DIR = originalConfigDir;
  else delete process.env.RUN402_CONFIG_DIR;
  rmSync(tempDir, { recursive: true, force: true });
});

describe("NodeCredentialsProvider.getProject", () => {
  it("returns keys for a populated keystore", async () => {
    writeFileSync(
      join(tempDir, "projects.json"),
      JSON.stringify({
        projects: {
          prj_abc: { anon_key: "anon_xyz", service_key: "service_xyz" },
        },
      }),
    );
    const provider = new NodeCredentialsProvider();
    const project = await provider.getProject("prj_abc");
    assert.ok(project);
    assert.equal(project.anon_key, "anon_xyz");
    assert.equal(project.service_key, "service_xyz");
  });

  it("returns null on missing project", async () => {
    writeFileSync(
      join(tempDir, "projects.json"),
      JSON.stringify({ projects: {} }),
    );
    const provider = new NodeCredentialsProvider();
    assert.equal(await provider.getProject("prj_missing"), null);
  });

  it("returns null when keystore file does not exist", async () => {
    const provider = new NodeCredentialsProvider();
    assert.equal(await provider.getProject("prj_anything"), null);
  });
});

describe("NodeCredentialsProvider.getAuth", () => {
  it("returns null when no allowance is configured", async () => {
    const provider = new NodeCredentialsProvider();
    assert.equal(await provider.getAuth("/projects/v1"), null);
  });

  it("produces SIWX headers when an allowance is present", async () => {
    // Use a well-known test key. Deterministic address:
    const privateKey = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
    const address = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
    writeFileSync(
      join(tempDir, "allowance.json"),
      JSON.stringify({ address, privateKey, rail: "x402" }),
    );
    const provider = new NodeCredentialsProvider();
    const headers = await provider.getAuth("/projects/v1");
    assert.ok(headers);
    assert.ok(typeof headers["SIGN-IN-WITH-X"] === "string");
    // Validate the payload is base64 JSON with the expected fields.
    const decoded = JSON.parse(Buffer.from(headers["SIGN-IN-WITH-X"]!, "base64").toString("utf-8"));
    assert.equal(decoded.address.toLowerCase(), address.toLowerCase());
    assert.equal(decoded.statement, "Sign in to Run402");
    assert.equal(decoded.type, "eip191");
    assert.match(decoded.uri, /\/projects\/v1$/);
    assert.ok(typeof decoded.signature === "string");
    assert.match(decoded.signature, /^0x[0-9a-fA-F]+$/);
  });
});

import { hashControlPlaneSession } from "../../core-dist/write-auth-session.js";

const ORIGIN = "https://api.run402.test";

function writeCp(token = "cp_tok"): void {
  writeFileSync(
    join(tempDir, "control-plane-session.json"),
    JSON.stringify({
      control_plane_session_token: token,
      token_type: "Bearer",
      provenance: "loopback_pkce",
      principal_id: "prn_1",
      amr: ["passkey"],
      expires_at: Date.now() + 3_600_000,
    }),
  );
}

function writeApprovalCache(over: Record<string, unknown> = {}): void {
  writeFileSync(
    join(tempDir, "write-auth-session.json"),
    JSON.stringify({
      approvals: [
        {
          write_auth_token: "wat_x",
          token_type: "write_auth",
          header: "X-Run402-Write-Auth",
          action: "project.deploy",
          project_id: "prj_x",
          expires_at: Date.now() + 3_600_000,
          control_plane_session_hash: hashControlPlaneSession("cp_tok"),
          control_plane_principal_id: "prn_1",
          api_origin: ORIGIN,
          minted_at: Date.now(),
          ...over,
        },
      ],
    }),
  );
}

const DEPLOY_META = { capability: "project.deploy" as const, target: { project_id: "prj_x" } };

describe("NodeCredentialsProvider.getAuth — surface resolution (no ambient approval)", () => {
  it("default/mcp surface never reads the control-plane session (wallet-only)", async () => {
    writeCp();
    writeApprovalCache();
    for (const surface of ["mcp", undefined] as const) {
      const p = new NodeCredentialsProvider(surface ? { surface } : {});
      assert.equal(await p.getAuth("/projects/v1", DEPLOY_META), null, `surface=${surface} must not use cp/approval`);
    }
  });

  it("cli surface falls back to the control-plane bearer when no wallet is present", async () => {
    writeCp();
    const p = new NodeCredentialsProvider({ surface: "cli" });
    const h = await p.getAuth("/projects/v1");
    assert.equal(h?.Authorization, "Bearer cp_tok");
    assert.equal(h?.["X-Run402-Write-Auth"], undefined, "no capability ⇒ no approval header");
  });

  it("cli surface attaches the approval header on a matching (capability, target)", async () => {
    writeCp();
    writeApprovalCache();
    const p = new NodeCredentialsProvider({ surface: "cli" });
    const h = await p.getAuth("/apply/v1/plans", DEPLOY_META);
    assert.equal(h?.Authorization, "Bearer cp_tok");
    assert.equal(h?.["X-Run402-Write-Auth"], "Bearer wat_x");
  });

  it("cli surface withholds the approval header on a target mismatch (fails closed)", async () => {
    writeCp();
    writeApprovalCache({ project_id: "prj_DIFFERENT" });
    const p = new NodeCredentialsProvider({ surface: "cli" });
    const h = await p.getAuth("/apply/v1/plans", DEPLOY_META);
    assert.equal(h?.Authorization, "Bearer cp_tok");
    assert.equal(h?.["X-Run402-Write-Auth"], undefined, "wrong target ⇒ no approval");
  });

  it("cli surface prefers the wallet when an allowance is present (no cp fallback)", async () => {
    const privateKey = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
    writeFileSync(join(tempDir, "allowance.json"), JSON.stringify({ address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", privateKey, rail: "x402" }));
    writeCp();
    writeApprovalCache();
    const p = new NodeCredentialsProvider({ surface: "cli" });
    const h = await p.getAuth("/apply/v1/plans", DEPLOY_META);
    assert.ok(h?.["SIGN-IN-WITH-X"], "wallet present ⇒ SIWX");
    assert.equal(h?.Authorization, undefined, "wallet present ⇒ no cp bearer");
    assert.equal(h?.["X-Run402-Write-Auth"], undefined, "wallet present ⇒ no approval");
  });
});
