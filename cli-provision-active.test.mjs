/**
 * cli-provision-active.test.mjs — GH-183 regression.
 *
 * `run402 projects provision` silently overwrites the active project pointer.
 * The CLI must surface this in its JSON output as `note` + `previous_active_project_id`
 * so callers can branch on it without scraping logs.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = mkdtempSync(join(tmpdir(), "run402-provision-active-"));
const API = "https://test-api.run402.com";
process.env.RUN402_CONFIG_DIR = tempDir;
process.env.RUN402_API_BASE = API;

const originalFetch = globalThis.fetch;
const originalLog = console.log;
const originalError = console.error;
const originalExit = process.exit;
let stdoutLines = [];
let stderrLines = [];

let nextProjectId = "prj_fresh";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const USDC_BALANCE_HEX = "0x" + "0".repeat(58) + "03d090";

function mockFetch(input, init) {
  let url, method, rawBody;
  if (typeof input === "string") {
    url = input;
    method = (init?.method || "GET").toUpperCase();
    rawBody = init?.body;
  } else if (input instanceof Request) {
    url = input.url;
    method = (init?.method || input.method || "GET").toUpperCase();
    rawBody = init?.body !== undefined ? init.body : undefined;
  } else {
    url = String(input);
    method = (init?.method || "GET").toUpperCase();
    rawBody = init?.body;
  }
  let body = null;
  if (rawBody && typeof rawBody === "string") {
    try { body = JSON.parse(rawBody); } catch { body = rawBody; }
  } else if (rawBody) {
    body = rawBody;
  }

  if (body?.jsonrpc === "2.0") {
    if (body.method === "eth_call") {
      return Promise.resolve(json({ jsonrpc: "2.0", result: USDC_BALANCE_HEX, id: body.id }));
    }
    if (body.method === "eth_chainId") {
      return Promise.resolve(json({ jsonrpc: "2.0", result: "0x14a34", id: body.id }));
    }
    return Promise.resolve(json({ jsonrpc: "2.0", result: "0x0", id: body.id }));
  }

  const allowedOrigins = new Set([new URL(API).origin, "https://api.run402.com"]);
  let path = url;
  try {
    const parsed = new URL(url);
    if (allowedOrigins.has(parsed.origin)) {
      path = parsed.pathname + parsed.search;
    } else {
      return Promise.resolve(new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }));
    }
  } catch {
    if (!url.startsWith("/")) {
      return Promise.resolve(new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }));
    }
  }

  if (path === "/projects/v1" && method === "POST") {
    return Promise.resolve(json({
      project_id: nextProjectId,
      anon_key: `anon-${nextProjectId}`,
      service_key: `svc-${nextProjectId}`,
      schema_slot: "p0001",
    }));
  }
  if (path.startsWith("/tiers/v1/") && method === "GET") {
    return Promise.resolve(json({ price: "$0.10", network: "base-sepolia" }));
  }
  return Promise.resolve(new Response("Not Found", { status: 404 }));
}

function captureStart() {
  stdoutLines = [];
  stderrLines = [];
  console.log = (...args) => {
    const line = args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ");
    stdoutLines.push(line);
  };
  console.error = (...args) => {
    const line = args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ");
    stderrLines.push(line);
  };
}

function captureStop() {
  console.log = originalLog;
  console.error = originalError;
}

function capturedStdout() {
  return stdoutLines.join("\n");
}

function parseStdoutJson() {
  const text = capturedStdout();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < 0) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

before(async () => {
  globalThis.fetch = mockFetch;
  process.exit = (code) => { throw new Error(`process.exit(${code})`); };
  const { run } = await import("./cli/lib/allowance.mjs");
  captureStart();
  await run("create", []);
  captureStop();
});

after(async () => {
  globalThis.fetch = originalFetch;
  console.log = originalLog;
  console.error = originalError;
  process.exit = originalExit;
  delete process.env.RUN402_CONFIG_DIR;
  delete process.env.RUN402_API_BASE;
  rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  captureStop();
});

describe("CLI projects provision active-project banner (GH-183)", () => {
  it("first provision: no note when there was no prior active project", async () => {
    nextProjectId = "prj_first";
    const { run } = await import("./cli/lib/projects.mjs");
    captureStart();
    await run("provision", ["--tier", "prototype"]);
    captureStop();

    const parsed = parseStdoutJson();
    assert.ok(parsed, `expected JSON output, got: ${capturedStdout()}`);
    assert.equal(parsed.project_id, "prj_first");
    assert.equal(parsed.note, undefined, "no note expected on first provision");
    assert.equal(parsed.previous_active_project_id, undefined);
  });

  it("subsequent provision: emits note + previous_active_project_id when active project changes", async () => {
    nextProjectId = "prj_second";
    const { run } = await import("./cli/lib/projects.mjs");
    captureStart();
    await run("provision", ["--tier", "prototype"]);
    captureStop();

    const parsed = parseStdoutJson();
    assert.ok(parsed, `expected JSON output, got: ${capturedStdout()}`);
    assert.equal(parsed.project_id, "prj_second");
    assert.equal(
      parsed.note,
      "active project changed: prj_first -> prj_second",
      `expected change note, got: ${parsed.note}`,
    );
    assert.equal(parsed.previous_active_project_id, "prj_first");
  });

  it("subsequent provision keystore reflects previous_active_project_id for safe revert", async () => {
    const { loadKeyStore } = await import("./cli/lib/config.mjs");
    const store = loadKeyStore();
    assert.equal(store.active_project_id, "prj_second");
    assert.equal(store.previous_active_project_id, "prj_first");
  });
});
