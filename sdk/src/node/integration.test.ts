/**
 * Integration-level tests for the Node `run402()` factory wiring.
 *
 * Section 3 validates construction only — the Node factory, its credential
 * provider, and the lazy paid-fetch wrapper compose cleanly. End-to-end
 * request/response tests live in section 4 once the `projects` namespace
 * exposes actual methods.
 *
 * Full x402 on-chain retry is exercised manually against a funded wallet
 * and is out of scope for the unit suite.
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { run402, Run402, NodeCredentialsProvider, LocalError } from "./index.js";
import { configureApiBase } from "../../core-dist/config.js";

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
  tempDir = mkdtempSync(join(tmpdir(), "run402-sdk-integ-"));
  process.env.RUN402_CONFIG_DIR = tempDir;
});

afterEach(() => {
  if (originalConfigDir !== undefined) process.env.RUN402_CONFIG_DIR = originalConfigDir;
  else delete process.env.RUN402_CONFIG_DIR;
  rmSync(tempDir, { recursive: true, force: true });
});

describe("run402() Node factory", () => {
  it("constructs a Run402 instance with no keystore and no allowance", () => {
    const r = run402({ disablePaidFetch: true });
    assert.ok(r instanceof Run402);
    assert.ok(r.projects);
  });

  it("reports no payer when automatic paid fetch is disabled", async () => {
    const r = run402({ disablePaidFetch: true });
    assert.equal(await r.paymentPayer(), null);
  });

  it("constructs with a populated keystore", () => {
    writeFileSync(
      join(tempDir, "projects.json"),
      JSON.stringify({
        projects: { prj_test: { anon_key: "anon", service_key: "service" } },
      }),
    );
    const r = run402({ disablePaidFetch: true });
    assert.ok(r instanceof Run402);
  });

  it("accepts a custom fetch override", () => {
    const customFetch = (async () =>
      new Response("test", { status: 200 })) as typeof globalThis.fetch;
    const r = run402({ fetch: customFetch });
    assert.ok(r instanceof Run402);
  });

  it("rejects ambiguous explicit payment configuration at construction", () => {
    assert.throws(
      () => run402({
        allowancePath: join(tempDir, "payer.json"),
        paymentSigner: {
          async getSigner() {
            return null;
          },
        },
      }),
      (err: unknown) => err instanceof LocalError && err.code === "PAYMENT_SOURCE_CONFLICT",
    );
  });

  it("sends Node SDK client metadata for direct SDK and CLI surfaces", async () => {
    const headersSeen: string[] = [];
    const customFetch = (async (_input, init) => {
      const headers = init?.headers as Record<string, string>;
      headersSeen.push(headers["Run402-Client"] ?? "");
      return new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch;

    await run402({
      fetch: customFetch,
      authMode: "none",
      clientVersion: "9.9.9",
      sdkVersion: "9.9.9",
    }).service.health();
    await run402({
      fetch: customFetch,
      authMode: "none",
      surface: "cli",
      clientVersion: "9.9.9",
      sdkVersion: "9.9.9",
    }).service.health();

    assert.equal(headersSeen[0], 'surface="sdk", version="9.9.9", sdk="9.9.9"');
    assert.equal(headersSeen[1], 'surface="cli", version="9.9.9", sdk="9.9.9"');
    assert.equal(headersSeen.some((value) => /RUN402_CONFIG_DIR|package_manager|wallet|project|secret/i.test(value)), false);
  });

  it("can disable Node SDK client metadata for custom transports", async () => {
    let header: string | undefined;
    const customFetch = (async (_input, init) => {
      const headers = init?.headers as Record<string, string>;
      header = headers["Run402-Client"];
      return new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch;

    await run402({ fetch: customFetch, authMode: "none", clientMetadata: false }).service.health();
    assert.equal(header, undefined);
  });

  it("uses the persisted Core API base when env override is unset", async () => {
    const prev = process.env.RUN402_API_BASE;
    delete process.env.RUN402_API_BASE;
    configureApiBase("http://core.local:4020", { target_kind: "core" });
    const calls: string[] = [];
    try {
      const customFetch = (async (input) => {
        calls.push(String(input));
        return new Response(JSON.stringify({ status: "ok", mode: "core" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof globalThis.fetch;
      const r = run402({ fetch: customFetch, authMode: "none" });
      await r.service.health();
    } finally {
      if (prev !== undefined) process.env.RUN402_API_BASE = prev;
      else delete process.env.RUN402_API_BASE;
    }
    assert.deepEqual(calls, ["http://core.local:4020/health"]);
  });

  it("treats RUN402_API_BASE as a Cloud target override for up actions", async () => {
    configureApiBase("http://core.local:4020", { target_kind: "core" });
    process.env.RUN402_API_BASE = "https://api.run402.com";
    writeFileSync(
      join(tempDir, "run402.deploy.json"),
      JSON.stringify({
        project_id: "prj_env_cloud",
        site: { replace: { "index.html": { data: "<h1>hello</h1>" } } },
      }),
    );

    const r = run402({ disablePaidFetch: true });
    const result = await r.up({ dir: tempDir, projectId: "prj_env_cloud" }, { mode: "check" });

    assert.equal(result.target, "cloud");
    assert.equal(result.result?.project_id, "prj_env_cloud");
  });

  it("exports NodeCredentialsProvider for advanced consumers", () => {
    const provider = new NodeCredentialsProvider();
    assert.ok(typeof provider.getAuth === "function");
    assert.ok(typeof provider.getProject === "function");
  });
});
