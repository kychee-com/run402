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
