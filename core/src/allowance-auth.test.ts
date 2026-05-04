import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { toChecksumAddress, formatSIWEMessage, buildSIWxAuthHeaders, getAllowanceAuthHeaders } from "./allowance-auth.js";
import { saveAllowance } from "./allowance.js";

// Known test private key and derived address (do NOT use in production)
const TEST_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const TEST_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

let tempDir: string;
let allowancePath: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "run402-siwx-test-"));
  allowancePath = join(tempDir, "allowance.json");
  process.env.RUN402_CONFIG_DIR = tempDir;
  process.env.RUN402_API_BASE = "https://api.run402.com";
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.RUN402_CONFIG_DIR;
  delete process.env.RUN402_API_BASE;
});

describe("toChecksumAddress", () => {
  it("checksums a known address correctly", () => {
    const input = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
    assert.equal(toChecksumAddress(input), TEST_ADDRESS);
  });

  it("handles already-checksummed address", () => {
    assert.equal(toChecksumAddress(TEST_ADDRESS), TEST_ADDRESS);
  });

  it("checksums all-lowercase address", () => {
    const result = toChecksumAddress("0xd8da6bf26964af9d7eed9e03e53415d37aa96045");
    assert.equal(result, "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045");
  });
});

describe("formatSIWEMessage", () => {
  it("produces correct EIP-4361 format", () => {
    const msg = formatSIWEMessage(
      {
        domain: "api.run402.com",
        uri: "https://api.run402.com/projects/v1",
        statement: "Sign in to Run402",
        version: "1",
        chainId: 84532,
        nonce: "abc123def456abcd",
        issuedAt: "2026-03-17T00:00:00.000Z",
      },
      TEST_ADDRESS,
    );

    assert.ok(msg.startsWith("api.run402.com wants you to sign in with your Ethereum account:"));
    assert.ok(msg.includes(TEST_ADDRESS));
    assert.ok(msg.includes("Sign in to Run402"));
    assert.ok(msg.includes("URI: https://api.run402.com/projects/v1"));
    assert.ok(msg.includes("Version: 1"));
    assert.ok(msg.includes("Chain ID: 84532"));
    assert.ok(msg.includes("Nonce: abc123def456abcd"));
    assert.ok(msg.includes("Issued At: 2026-03-17T00:00:00.000Z"));
    assert.ok(!msg.includes("Expiration Time:"));
  });

  it("includes expiration time when provided", () => {
    const msg = formatSIWEMessage(
      {
        domain: "api.run402.com",
        uri: "https://api.run402.com/projects/v1",
        statement: "Sign in to Run402",
        version: "1",
        chainId: 84532,
        nonce: "abc123def456abcd",
        issuedAt: "2026-03-17T00:00:00.000Z",
        expirationTime: "2026-03-17T00:05:00.000Z",
      },
      TEST_ADDRESS,
    );

    assert.ok(msg.includes("Expiration Time: 2026-03-17T00:05:00.000Z"));
  });

  it("renders CAIP-2 chain ids and Resources in SIWE message format", () => {
    const msg = formatSIWEMessage(
      {
        domain: "api.run402.com",
        uri: "https://api.run402.com/ci/v1/bindings",
        statement: "Authorize CI",
        chainId: "eip155:84532",
        nonce: "abc123def456abcd",
        issuedAt: "2026-03-17T00:00:00.000Z",
        expirationTime: "2026-03-17T00:05:00.000Z",
        resources: ["run402-ci-delegation:v1?project_id=prj_abc"],
      },
      TEST_ADDRESS,
    );

    assert.ok(msg.includes("Chain ID: 84532"));
    assert.ok(msg.includes("Resources:\n- run402-ci-delegation:v1?project_id=prj_abc"));
  });
});

describe("buildSIWxAuthHeaders", () => {
  it("signs a custom SIWX payload with Resources", () => {
    const headers = buildSIWxAuthHeaders({
      allowance: { address: TEST_ADDRESS, privateKey: TEST_PRIVATE_KEY },
      domain: "api.run402.com",
      uri: "https://api.run402.com/ci/v1/bindings",
      statement: "Authorize CI",
      chainId: "eip155:84532",
      nonce: "abc123def456abcd",
      issuedAt: "2026-03-17T00:00:00.000Z",
      expirationTime: "2026-03-17T00:05:00.000Z",
      resources: ["run402-ci-delegation:v1?project_id=prj_abc"],
    });

    const decoded = JSON.parse(Buffer.from(headers["SIGN-IN-WITH-X"], "base64").toString());
    assert.equal(decoded.statement, "Authorize CI");
    assert.equal(decoded.uri, "https://api.run402.com/ci/v1/bindings");
    assert.equal(decoded.chainId, "eip155:84532");
    assert.deepEqual(decoded.resources, ["run402-ci-delegation:v1?project_id=prj_abc"]);
    assert.ok(decoded.signature.startsWith("0x"));
  });
});

describe("getAllowanceAuthHeaders", () => {
  it("returns null when no allowance exists", () => {
    const result = getAllowanceAuthHeaders("/projects/v1", allowancePath);
    assert.equal(result, null);
  });

  it("returns SIGN-IN-WITH-X header with valid base64 JSON", () => {
    saveAllowance({ address: TEST_ADDRESS, privateKey: TEST_PRIVATE_KEY }, allowancePath);

    const result = getAllowanceAuthHeaders("/projects/v1", allowancePath);
    assert.ok(result);
    assert.ok(result["SIGN-IN-WITH-X"]);

    const decoded = JSON.parse(Buffer.from(result["SIGN-IN-WITH-X"], "base64").toString());
    assert.equal(decoded.domain, "api.run402.com");
    assert.equal(decoded.address, TEST_ADDRESS);
    assert.equal(decoded.uri, "https://api.run402.com/projects/v1");
    assert.equal(decoded.version, "1");
    assert.equal(decoded.statement, "Sign in to Run402");
    assert.equal(decoded.chainId, "eip155:84532");
    assert.equal(decoded.type, "eip191");
    assert.ok(decoded.nonce);
    assert.ok(decoded.issuedAt);
    assert.ok(decoded.expirationTime);
    assert.ok(decoded.signature);
    assert.ok(decoded.signature.startsWith("0x"));
  });

  it("generates alphanumeric hex nonce (no hyphens)", () => {
    saveAllowance({ address: TEST_ADDRESS, privateKey: TEST_PRIVATE_KEY }, allowancePath);

    const result = getAllowanceAuthHeaders("/projects/v1", allowancePath);
    assert.ok(result);
    const decoded = JSON.parse(Buffer.from(result["SIGN-IN-WITH-X"], "base64").toString());
    assert.match(decoded.nonce, /^[0-9a-f]{32}$/);
  });

  it("uses checksummed address in payload", () => {
    saveAllowance({ address: TEST_ADDRESS.toLowerCase(), privateKey: TEST_PRIVATE_KEY }, allowancePath);

    const result = getAllowanceAuthHeaders("/projects/v1", allowancePath);
    assert.ok(result);
    const decoded = JSON.parse(Buffer.from(result["SIGN-IN-WITH-X"], "base64").toString());
    assert.equal(decoded.address, TEST_ADDRESS);
  });
});
