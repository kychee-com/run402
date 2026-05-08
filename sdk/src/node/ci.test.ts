import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { saveAllowance } from "../../../core/src/allowance.js";
import { LocalError } from "../errors.js";
import {
  buildCiDelegationResourceUri,
  buildCiDelegationStatement,
  CI_AUDIENCE,
  CI_GITHUB_ACTIONS_ISSUER,
} from "../index.js";
import { signCiDelegation } from "./ci.js";

const TEST_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const TEST_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

let tempDir: string;
let allowancePath: string;

const CANONICAL = {
  project_id: "prj_abc",
  issuer: CI_GITHUB_ACTIONS_ISSUER,
  audience: CI_AUDIENCE,
  subject_match: "repo:tal/myapp:ref:refs/heads/main",
  allowed_actions: ["deploy"],
  allowed_events: ["push", "workflow_dispatch"],
  expires_at: "2026-07-30T00:00:00Z",
  github_repository_id: "892341",
  nonce: "deadbeef00112233aabbccdd44556677",
} as const;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "run402-ci-sign-test-"));
  allowancePath = join(tempDir, "allowance.json");
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("signCiDelegation", () => {
  it("signs the canonical CI delegation with one Resource URI", () => {
    saveAllowance({ address: TEST_ADDRESS, privateKey: TEST_PRIVATE_KEY }, allowancePath);

    const signed = signCiDelegation(CANONICAL, {
      allowancePath,
      apiBase: "https://api.run402.com",
      issuedAt: "2026-05-03T00:00:00.000Z",
      expirationTime: "2026-05-03T00:05:00.000Z",
    });
    const decoded = JSON.parse(Buffer.from(signed, "base64").toString("utf-8"));

    assert.equal(decoded.uri, "https://api.run402.com/ci/v1/bindings");
    assert.equal(decoded.statement, buildCiDelegationStatement(CANONICAL));
    assert.deepEqual(decoded.resources, [buildCiDelegationResourceUri(CANONICAL)]);
    assert.equal(decoded.chainId, "eip155:84532");
    assert.equal(decoded.nonce, CANONICAL.nonce.slice(0, 16));
    assert.equal(decoded.signature.startsWith("0x"), true);
  });

  it("signs scoped route delegations with the scoped canonical bytes", () => {
    saveAllowance({ address: TEST_ADDRESS, privateKey: TEST_PRIVATE_KEY }, allowancePath);
    const values = { ...CANONICAL, route_scopes: ["/admin/*", "/admin"] };

    const signed = signCiDelegation(values, {
      allowancePath,
      apiBase: "https://api.run402.com",
      issuedAt: "2026-05-03T00:00:00.000Z",
      expirationTime: "2026-05-03T00:05:00.000Z",
    });
    const decoded = JSON.parse(Buffer.from(signed, "base64").toString("utf-8"));

    assert.equal(decoded.statement, buildCiDelegationStatement(values));
    assert.deepEqual(decoded.resources, [buildCiDelegationResourceUri(values)]);
    assert.match(decoded.statement, /^Route scopes: \/admin,\/admin\/\*$/m);
  });

  it("fails actionably when no allowance exists", () => {
    assert.throws(
      () => signCiDelegation(CANONICAL, { allowancePath }),
      (err: unknown) =>
        err instanceof LocalError &&
        /run402 init|run402 allowance create/.test(err.message),
    );
  });
});
