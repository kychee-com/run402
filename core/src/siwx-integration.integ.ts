/**
 * siwx-integration.test.ts — Real integration test for SIWX auth.
 *
 * Hits the LIVE Run402 API (no mocks) to verify:
 *   1. The SIWE message format is byte-for-byte correct
 *   2. The EIP-191 signature is valid and recoverable
 *   3. The payload JSON matches the server's expected schema
 *      (chainId as CAIP-2, type "eip191", statement present)
 *   4. The server accepts the SIGN-IN-WITH-X header (HTTP 200, not 402)
 *
 * Uses GET /tiers/v1/status — a read-only, free, idempotent endpoint.
 * A fresh random keypair is generated per run (no secrets needed).
 *
 * Run:
 *   node --test --import tsx core/src/siwx-integration.test.ts
 *   npm run test:integration
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes, createECDH } from "node:crypto";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { saveAllowance } from "./allowance.js";
import { getAllowanceAuthHeaders } from "./allowance-auth.js";

const API = "https://api.run402.com";

let tempDir: string;
let allowancePath: string;

/**
 * Generate a fresh random EVM keypair (same logic as allowance-create).
 */
function generateKeypair() {
  const privateKeyBytes = randomBytes(32);
  const privateKey = `0x${privateKeyBytes.toString("hex")}`;
  const ecdh = createECDH("secp256k1");
  ecdh.setPrivateKey(privateKeyBytes);
  const uncompressedPubKey = ecdh.getPublicKey();
  const pubKeyBody = uncompressedPubKey.subarray(1);
  const hash = keccak_256(pubKeyBody);
  const addressBytes = hash.slice(-20);
  const address = `0x${Buffer.from(addressBytes).toString("hex")}`;
  return { address, privateKey };
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "run402-siwx-integ-"));
  allowancePath = join(tempDir, "allowance.json");
  process.env.RUN402_CONFIG_DIR = tempDir;
  process.env.RUN402_API_BASE = API;
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.RUN402_CONFIG_DIR;
  delete process.env.RUN402_API_BASE;
});

describe("SIWX auth integration (live API)", () => {
  it("GET /tiers/v1/status accepts SIWX header and returns 200", async () => {
    // 1. Generate a fresh keypair and save it as the allowance
    const { address, privateKey } = generateKeypair();
    saveAllowance({ address, privateKey, created: new Date().toISOString(), funded: false }, allowancePath);

    // 2. Generate the SIWX auth header (the code under test)
    const headers = getAllowanceAuthHeaders("/tiers/v1/status", allowancePath);
    assert.ok(headers, "getAllowanceAuthHeaders should return headers");
    assert.ok(headers["SIGN-IN-WITH-X"], "should have SIGN-IN-WITH-X header");

    // 3. Verify payload structure before sending
    const payload = JSON.parse(Buffer.from(headers["SIGN-IN-WITH-X"], "base64").toString());
    assert.equal(payload.chainId, "eip155:84532", "chainId must be CAIP-2 format");
    assert.equal(payload.type, "eip191", "type must be eip191");
    assert.equal(payload.statement, "Sign in to Run402", "statement must be present");
    assert.ok(payload.signature.startsWith("0x"), "signature must be hex");
    assert.equal(payload.signature.length, 132, "signature must be 65 bytes (r+s+v) as hex");

    // 4. Hit the real API
    const res = await fetch(`${API}/tiers/v1/status`, {
      headers: { ...headers },
    });

    // 5. Assert the server accepted our auth — the key assertion
    assert.notEqual(res.status, 401, `Auth rejected (401). Body: ${await res.clone().text()}`);
    assert.notEqual(res.status, 403, `Auth forbidden (403). Body: ${await res.clone().text()}`);
    assert.ok(res.ok, `Expected 2xx, got ${res.status}. Body: ${await res.clone().text()}`);

    // 6. Verify the response is valid JSON with expected shape
    const data = await res.json();
    assert.ok("tier" in data || "status" in data, "response should have tier or status field");
  });

  it("server rejects a malformed SIWX header", async () => {
    // Send a garbage header to prove the server actually validates
    const res = await fetch(`${API}/tiers/v1/status`, {
      headers: { "SIGN-IN-WITH-X": Buffer.from("{}").toString("base64") },
    });

    assert.equal(res.status, 402, "server should reject empty/invalid SIWX payload (402 per x402 spec)");
  });

  it("server rejects a tampered signature", async () => {
    const { address, privateKey } = generateKeypair();
    saveAllowance({ address, privateKey, created: new Date().toISOString(), funded: false }, allowancePath);

    const headers = getAllowanceAuthHeaders("/tiers/v1/status", allowancePath);
    assert.ok(headers);

    // Tamper with the signature (flip last hex char)
    const payload = JSON.parse(Buffer.from(headers["SIGN-IN-WITH-X"], "base64").toString());
    const lastChar = payload.signature.slice(-1);
    payload.signature = payload.signature.slice(0, -1) + (lastChar === "0" ? "1" : "0");
    const tampered = Buffer.from(JSON.stringify(payload)).toString("base64");

    const res = await fetch(`${API}/tiers/v1/status`, {
      headers: { "SIGN-IN-WITH-X": tampered },
    });

    assert.equal(res.status, 402, "server should reject tampered signature (402 per x402 spec)");
  });

  it("server rejects missing required fields", async () => {
    const { address, privateKey } = generateKeypair();
    saveAllowance({ address, privateKey, created: new Date().toISOString(), funded: false }, allowancePath);

    const headers = getAllowanceAuthHeaders("/tiers/v1/status", allowancePath);
    assert.ok(headers);

    // Remove statement from payload
    const payload = JSON.parse(Buffer.from(headers["SIGN-IN-WITH-X"], "base64").toString());
    delete payload.statement;
    const modified = Buffer.from(JSON.stringify(payload)).toString("base64");

    const res = await fetch(`${API}/tiers/v1/status`, {
      headers: { "SIGN-IN-WITH-X": modified },
    });

    assert.equal(res.status, 402, "server should reject payload missing statement (402 per x402 spec)");
  });

  it("server rejects numeric chainId (must be CAIP-2)", async () => {
    const { address, privateKey } = generateKeypair();
    saveAllowance({ address, privateKey, created: new Date().toISOString(), funded: false }, allowancePath);

    const headers = getAllowanceAuthHeaders("/tiers/v1/status", allowancePath);
    assert.ok(headers);

    // Replace CAIP-2 chainId with numeric
    const payload = JSON.parse(Buffer.from(headers["SIGN-IN-WITH-X"], "base64").toString());
    payload.chainId = 84532;
    const modified = Buffer.from(JSON.stringify(payload)).toString("base64");

    const res = await fetch(`${API}/tiers/v1/status`, {
      headers: { "SIGN-IN-WITH-X": modified },
    });

    assert.equal(res.status, 402, "server should reject numeric chainId (402 per x402 spec)");
  });
});
