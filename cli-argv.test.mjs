/**
 * Regression tests for CLI argv parsing.
 *
 * These stay separate from cli-e2e.test.mjs so parser failures are fast and
 * focused: no command should reach the network when argv itself is invalid.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";

const tempDir = mkdtempSync(join(tmpdir(), "run402-argv-"));
const API = "https://test-api.run402.com";
process.env.RUN402_CONFIG_DIR = tempDir;
process.env.RUN402_API_BASE = API;

const originalFetch = globalThis.fetch;
const originalLog = console.log;
const originalError = console.error;
const originalExit = process.exit;
const originalStdin = process.stdin;
let stdout = [];
let stderr = [];
let calls = [];

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function requestInfo(input, init) {
  const url = typeof input === "string" ? input : (input instanceof Request ? input.url : String(input));
  const method = (init?.method || (input instanceof Request ? input.method : "GET") || "GET").toUpperCase();
  const parsed = new URL(url);
  const path = parsed.origin === API ? `${parsed.pathname}${parsed.search}` : url;
  return { url, method, path, init };
}

function requestJsonBody(init) {
  if (typeof init?.body !== "string") return {};
  return JSON.parse(init.body);
}

function mockFetch(input, init) {
  const info = requestInfo(input, init);
  calls.push(info);
  const pathNoQuery = info.path.split("?")[0];

  if (pathNoQuery === "/storage/v1/blobs" && info.method === "GET") {
    return Promise.resolve(json({ blobs: [{ key: "file.txt" }] }));
  }
  if (/\/functions\/hello\/logs$/.test(pathNoQuery) && info.method === "GET") {
    return Promise.resolve(json({ logs: [{ timestamp: "2026-05-01T00:00:00Z", message: "ok" }] }));
  }
  if (/\/functions\/v1\/hello\/runs$/.test(pathNoQuery) && info.method === "POST") {
    const body = requestJsonBody(info.init);
    return Promise.resolve(json({
      run_id: "fnrun_cli123",
      project_id: "prj_test123",
      function_name: "hello",
      event_type: body.event_type,
      payload: body.payload ?? {},
      status: "queued",
      terminal: false,
      created_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-01T00:00:00.000Z",
      scheduled_at: "2026-07-01T00:10:00.000Z",
      attempts: 0,
    }));
  }
  if (/\/functions\/v1\/hello\/runs$/.test(pathNoQuery) && info.method === "GET") {
    return Promise.resolve(json({
      runs: [{
        run_id: "fnrun_cli123",
        project_id: "prj_test123",
        function_name: "hello",
        event_type: "reminder.send",
        payload: { id: "msg_1" },
        status: "queued",
        terminal: false,
        created_at: "2026-07-01T00:00:00.000Z",
        updated_at: "2026-07-01T00:00:00.000Z",
        scheduled_at: "2026-07-01T00:10:00.000Z",
        attempts: 0,
      }],
      next_cursor: null,
    }));
  }
  if (/\/functions\/v1\/runs\/fnrun_cli123$/.test(pathNoQuery) && info.method === "GET") {
    return Promise.resolve(json({
      run_id: "fnrun_cli123",
      project_id: "prj_test123",
      function_name: "hello",
      event_type: "reminder.send",
      payload: { id: "msg_1" },
      status: "succeeded",
      terminal: true,
      created_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-01T00:00:01.000Z",
      scheduled_at: "2026-07-01T00:00:00.000Z",
      attempts: 1,
    }));
  }
  if (/\/functions\/v1\/runs\/fnrun_cli123\/logs$/.test(pathNoQuery) && info.method === "GET") {
    return Promise.resolve(json({ logs: [{ timestamp: "2026-07-01T00:00:01.000Z", message: "run ok" }] }));
  }
  if (/\/functions\/v1\/runs\/fnrun_cli123\/cancel$/.test(pathNoQuery) && info.method === "POST") {
    return Promise.resolve(json({
      run_id: "fnrun_cli123",
      status: "cancelled",
      terminal: true,
      updated_at: "2026-07-01T00:00:02.000Z",
    }));
  }
  if (/\/functions\/v1\/runs\/fnrun_cli123\/redrive$/.test(pathNoQuery) && info.method === "POST") {
    return Promise.resolve(json({
      run_id: "fnrun_redriven",
      status: "queued",
      terminal: false,
      updated_at: "2026-07-01T00:00:03.000Z",
    }));
  }
  if (/\/functions\/hello$/.test(pathNoQuery) && info.method === "PATCH") {
    return Promise.resolve(json({ name: "hello", status: "updated" }));
  }

  return Promise.resolve(json({ ok: true }));
}

function captureStart() {
  stdout = [];
  stderr = [];
  console.log = (...args) => stdout.push(args.map(String).join(" "));
  console.error = (...args) => stderr.push(args.map(String).join(" "));
}

function captureStop() {
  console.log = originalLog;
  console.error = originalError;
}

function stderrJson() {
  const jsonLines = stderr.filter((s) => s.trim().startsWith("{"));
  const line = jsonLines.find((s) => {
    try {
      return JSON.parse(s).status === "error";
    } catch {
      return false;
    }
  }) ?? jsonLines[0];
  assert.ok(line, `expected JSON stderr, got: ${stderr.join("\n")}`);
  return JSON.parse(line);
}

async function expectExit1(fn) {
  let threw = null;
  captureStart();
  try {
    await fn();
  } catch (err) {
    threw = err;
  } finally {
    captureStop();
  }
  assert.equal(threw?.message, "process.exit(1)");
  return stderrJson();
}

async function withMockStdin(chunks, fn, { isTTY = false } = {}) {
  const stream = Readable.from(chunks);
  stream.isTTY = isTTY;
  Object.defineProperty(process, "stdin", { value: stream, configurable: true });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, "stdin", { value: originalStdin, configurable: true });
  }
}

before(async () => {
  globalThis.fetch = mockFetch;
  process.exit = (code) => { throw new Error(`process.exit(${code})`); };
  const { saveProject, setActiveProjectId } = await import("./cli/core-dist/keystore.js");
  saveProject("prj_test123", {
    anon_key: "anon_test_key",
    service_key: "svc_test_key",
  });
  setActiveProjectId("prj_test123");
});

after(() => {
  globalThis.fetch = originalFetch;
  console.log = originalLog;
  console.error = originalError;
  process.exit = originalExit;
  Object.defineProperty(process, "stdin", { value: originalStdin, configurable: true });
  delete process.env.RUN402_CONFIG_DIR;
  delete process.env.RUN402_API_BASE;
  rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  calls = [];
  captureStop();
});

// v2.1.0 unified-apply mock: handles /apply/v1/plans + /apply/v1/plans/:id/commit.
// Returns a minimal happy-path plan response derived from the request body so tests
// don't have to precompute SHAs. Accepts an optional onPlanBody callback for assertions.
function applyMockFetch({ onPlanBody } = {}) {
  return (input, init) => {
    const info = requestInfo(input, init);
    calls.push(info);
    if (info.path === "/apply/v1/plans" && info.method === "POST") {
      const body = JSON.parse(String(info.init.body));
      if (onPlanBody) onPlanBody(body);
      const e = body.spec?.assets?.put?.[0] ?? {};
      const sha = e.sha256 ?? "a".repeat(64);
      const key = e.key ?? "file.bin";
      const size = e.size_bytes ?? 5;
      const ct = e.content_type ?? "application/octet-stream";
      const vis = e.visibility ?? "public";
      const url = vis === "public" ? `https://pr-test.run402.com/_blob/${key}` : null;
      const ref = { key, sha256: sha, size_bytes: size, content_type: ct, visibility: vis,
        immutable: e.immutable ?? true, url, immutable_url: url, cdn_url: url,
        cdn_immutable_url: url, sri: null, etag: `"${sha.slice(0, 8)}"`,
        content_digest: `sha-256=:${sha.slice(0, 8)}:` };
      return Promise.resolve(json({
        plan_id: "plan_x", operation_id: "op_x", base_release_id: null,
        manifest_digest: "digest_x", missing_content: [], diff: { resources: {} },
        warnings: [], asset_entries: [{ ...ref, status: "present", asset_ref: ref }],
      }));
    }
    if (/\/apply\/v1\/plans\/[^/]+\/commit$/.test(info.path) && info.method === "POST") {
      return Promise.resolve(json({
        operation_id: "op_x", status: "ready", release_id: "rel_x",
        urls: { project: "https://prj.run402.test", project_public_id: "abc" },
      }));
    }
    return mockFetch(input, init);
  };
}


describe("unknown flags", () => {
  it("status rejects unknown flags before doing any work (GH-190)", async () => {
    const { run } = await import("./cli/lib/status.mjs");
    const err = await expectExit1(() => run(["--unknownflag"]));

    assert.equal(err.code, "UNKNOWN_FLAG");
    assert.equal(err.details.flag, "--unknownflag");
    assert.equal(calls.length, 0, "invalid argv must not hit the network");
  });

  it("functions logs rejects unknown flags before fetching logs (GH-190)", async () => {
    const { run } = await import("./cli/lib/functions.mjs");
    const err = await expectExit1(() =>
      run("logs", ["prj_test123", "hello", "--no-such-flag", "value"]));

    assert.equal(err.code, "UNKNOWN_FLAG");
    assert.equal(err.details.flag, "--no-such-flag");
    assert.equal(calls.length, 0, "invalid argv must not hit the network");
  });
});

describe("email argv validation", () => {
  it("email list rejects unknown --projct before network (GH-277)", async () => {
    const { run } = await import("./cli/lib/email.mjs");
    const err = await expectExit1(() => run("list", ["--projct", "prj_test123"]));

    assert.equal(err.code, "UNKNOWN_FLAG");
    assert.equal(err.details.flag, "--projct");
    assert.equal(calls.length, 0, "invalid argv must not hit the network");
  });

  it("email get rejects missing --project value before network (GH-277)", async () => {
    const { run } = await import("./cli/lib/email.mjs");
    const err = await expectExit1(() => run("get", ["msg_1", "--project"]));

    assert.equal(err.code, "BAD_FLAG");
    assert.equal(err.details.flag, "--project");
    assert.equal(calls.length, 0, "invalid argv must not hit the network");
  });

  it("email get-raw rejects missing --output value before network (GH-277)", async () => {
    const { run } = await import("./cli/lib/email.mjs");
    const err = await expectExit1(() => run("get-raw", ["msg_1", "--output"]));

    assert.equal(err.code, "BAD_FLAG");
    assert.equal(err.details.flag, "--output");
    assert.equal(calls.length, 0, "invalid argv must not hit the network");
  });

  it("email get-raw requires --output entirely (no binary on stdout)", async () => {
    const { run } = await import("./cli/lib/email.mjs");
    const err = await expectExit1(() => run("get-raw", ["msg_1"]));

    assert.equal(err.code, "BAD_USAGE");
    assert.equal(err.details.flag, "--output");
    assert.match(err.message, /Missing --output/);
    assert.equal(calls.length, 0, "missing --output must not hit the network");
  });

  it("email reply rejects missing --html value before network (GH-277)", async () => {
    const { run } = await import("./cli/lib/email.mjs");
    const err = await expectExit1(() => run("reply", ["msg_1", "--html"]));

    assert.equal(err.code, "BAD_FLAG");
    assert.equal(err.details.flag, "--html");
    assert.equal(calls.length, 0, "invalid argv must not hit the network");
  });

  it("email delete rejects missing --project value before network (GH-277)", async () => {
    const { run } = await import("./cli/lib/email.mjs");
    const err = await expectExit1(() => run("delete", ["--confirm", "--project"]));

    assert.equal(err.code, "BAD_FLAG");
    assert.equal(err.details.flag, "--project");
    assert.equal(calls.length, 0, "invalid argv must not hit the network");
  });
});

describe("email webhooks argv validation", () => {
  it("webhooks list rejects unknown --projct before network (GH-278)", async () => {
    const { run } = await import("./cli/lib/webhooks.mjs");
    const err = await expectExit1(() => run("list", ["--projct", "prj_test123"]));

    assert.equal(err.code, "UNKNOWN_FLAG");
    assert.equal(err.details.flag, "--projct");
    assert.equal(calls.length, 0, "invalid argv must not hit the network");
  });

  it("webhooks register rejects missing --url value before network (GH-278)", async () => {
    const { run } = await import("./cli/lib/webhooks.mjs");
    const err = await expectExit1(() => run("register", ["--url"]));

    assert.equal(err.code, "BAD_FLAG");
    assert.equal(err.details.flag, "--url");
    assert.equal(calls.length, 0, "invalid argv must not hit the network");
  });

  it("webhooks register rejects missing --events value before network (GH-278)", async () => {
    const { run } = await import("./cli/lib/webhooks.mjs");
    const err = await expectExit1(() =>
      run("register", ["--url", "https://example.com/hook", "--events"]));

    assert.equal(err.code, "BAD_FLAG");
    assert.equal(err.details.flag, "--events");
    assert.equal(calls.length, 0, "invalid argv must not hit the network");
  });

  it("webhooks update rejects missing --events value before network (GH-278)", async () => {
    const { run } = await import("./cli/lib/webhooks.mjs");
    const err = await expectExit1(() => run("update", ["whk_1", "--events"]));

    assert.equal(err.code, "BAD_FLAG");
    assert.equal(err.details.flag, "--events");
    assert.equal(calls.length, 0, "invalid argv must not hit the network");
  });

  it("webhooks update rejects missing --url value before network (GH-278)", async () => {
    const { run } = await import("./cli/lib/webhooks.mjs");
    const err = await expectExit1(() => run("update", ["whk_1", "--url"]));

    assert.equal(err.code, "BAD_FLAG");
    assert.equal(err.details.flag, "--url");
    assert.equal(calls.length, 0, "invalid argv must not hit the network");
  });

  it("webhooks redrive rejects missing delivery_id before network", async () => {
    const { run } = await import("./cli/lib/webhooks.mjs");
    const err = await expectExit1(() => run("redrive", ["--project", "prj_test123"]));

    assert.equal(err.code, "BAD_USAGE");
    assert.equal(calls.length, 0, "invalid argv must not hit the network");
  });

  it("webhooks deliveries rejects unknown flag before network", async () => {
    const { run } = await import("./cli/lib/webhooks.mjs");
    const err = await expectExit1(() => run("deliveries", ["--statuz", "pending"]));

    assert.equal(err.code, "UNKNOWN_FLAG");
    assert.equal(err.details.flag, "--statuz");
    assert.equal(calls.length, 0, "invalid argv must not hit the network");
  });

  it("webhooks deliveries rejects missing --status value before network", async () => {
    const { run } = await import("./cli/lib/webhooks.mjs");
    const err = await expectExit1(() => run("deliveries", ["--status"]));

    assert.equal(err.code, "BAD_FLAG");
    assert.equal(err.details.flag, "--status");
    assert.equal(calls.length, 0, "invalid argv must not hit the network");
  });
});

describe("ai argv validation (GH-280)", () => {
  it("ai translate rejects typoed flags before SDK/network", async () => {
    const { run } = await import("./cli/lib/ai.mjs");
    const err = await expectExit1(() =>
      run("translate", ["text", "--too", "fr"]));

    assert.equal(err.code, "UNKNOWN_FLAG");
    assert.equal(err.details.flag, "--too");
    assert.equal(calls.length, 0, "invalid argv must not hit the network");
  });

  it("ai translate rejects missing --to value before SDK/network", async () => {
    const { run } = await import("./cli/lib/ai.mjs");
    const err = await expectExit1(() =>
      run("translate", ["text", "--to"]));

    assert.equal(err.code, "BAD_FLAG");
    assert.equal(err.details.flag, "--to");
    assert.equal(calls.length, 0, "invalid argv must not hit the network");
  });

  it("ai moderate rejects typoed flags before SDK/network", async () => {
    const { run } = await import("./cli/lib/ai.mjs");
    const err = await expectExit1(() =>
      run("moderate", ["text", "--projct", "prj_x"]));

    assert.equal(err.code, "UNKNOWN_FLAG");
    assert.equal(err.details.flag, "--projct");
    assert.equal(calls.length, 0, "invalid argv must not hit the network");
  });

  it("ai usage rejects typoed flags before SDK/network", async () => {
    const { run } = await import("./cli/lib/ai.mjs");
    const err = await expectExit1(() =>
      run("usage", ["--projct", "prj_x"]));

    assert.equal(err.code, "UNKNOWN_FLAG");
    assert.equal(err.details.flag, "--projct");
    assert.equal(calls.length, 0, "invalid argv must not hit the network");
  });
});

describe("projects costs argv validation", () => {
  it("rejects invalid --window before network", async () => {
    const { run } = await import("./cli/lib/projects.mjs");
    const err = await expectExit1(() => run("costs", ["--window", "1y"]));

    assert.equal(err.code, "BAD_FLAG");
    assert.equal(err.details.flag, "--window");
    assert.equal(calls.length, 0, "bad --window must not hit the network");
  });
});

describe("contracts wei argv validation", () => {
  for (const thresholdWei of ["abc", "1.5", "-1", "1e18"]) {
    it(`set-alert rejects malformed --threshold-wei ${JSON.stringify(thresholdWei)} before network`, async () => {
      const { run } = await import("./cli/lib/contracts.mjs");
      const err = await expectExit1(() =>
        run("set-alert", ["prj_test123", "cwlt_test", "--threshold-wei", thresholdWei]));

      assert.equal(err.code, "BAD_FLAG");
      assert.equal(err.details.flag, "--threshold-wei");
      assert.equal(calls.length, 0, "bad --threshold-wei must not hit the network");
    });
  }

  for (const valueWei of ["abc", "1.5", "-1", "1e18"]) {
    it(`call rejects malformed --value-wei ${JSON.stringify(valueWei)} before network`, async () => {
      const { run } = await import("./cli/lib/contracts.mjs");
      const err = await expectExit1(() =>
        run("call", [
          "prj_test123",
          "cwlt_test",
          "--to",
          "0x4444444444444444444444444444444444444444",
          "--abi",
          "[]",
          "--fn",
          "noop",
          "--args",
          "[]",
          "--value-wei",
          valueWei,
        ]));

      assert.equal(err.code, "BAD_FLAG");
      assert.equal(err.details.flag, "--value-wei");
      assert.equal(calls.length, 0, "bad --value-wei must not hit the network");
    });
  }
});

describe("2026-05 CLI bug backlog argv validation", () => {
  const invalidCases = [
    {
      issue: "GH-319",
      name: "blob sign rejects TTL below signed URL minimum",
      module: "./cli/lib/assets.mjs",
      call: (run) => run("sign", ["reports/a.pdf", "--project", "prj_test123", "--ttl", "59"]),
      code: "BAD_FLAG",
    },
    {
      issue: "GH-318",
      name: "blob get rejects extra positional keys",
      module: "./cli/lib/assets.mjs",
      call: (run) => run("get", ["a.txt", "b.txt", "--output", join(tempDir, "blob-extra.txt"), "--project", "prj_test123"]),
      code: "BAD_USAGE",
    },
    {
      issue: "GH-318",
      name: "blob rm rejects extra positional keys",
      module: "./cli/lib/assets.mjs",
      call: (run) => run("rm", ["a.txt", "b.txt", "--project", "prj_test123"]),
      code: "BAD_USAGE",
    },
    {
      issue: "GH-318",
      name: "blob sign rejects extra positional keys",
      module: "./cli/lib/assets.mjs",
      call: (run) => run("sign", ["a.txt", "b.txt", "--project", "prj_test123"]),
      code: "BAD_USAGE",
    },
    {
      issue: "GH-318",
      name: "blob diagnose rejects extra positional URLs",
      module: "./cli/lib/assets.mjs",
      call: (run) => run("diagnose", ["https://app.run402.com/_blob/a.txt", "https://app.run402.com/_blob/b.txt", "--project", "prj_test123"]),
      code: "BAD_USAGE",
    },
    {
      issue: "GH-306",
      name: "blob put rejects multi-file uploads with a fixed --key",
      module: "./cli/lib/assets.mjs",
      call: (run) => run("put", ["./a.txt", "./b.txt", "--key", "release/current.txt"]),
      code: "BAD_USAGE",
    },
    {
      issue: "GH-305",
      name: "cdn wait-fresh rejects invalid SHA values",
      module: "./cli/lib/cdn.mjs",
      call: (run) => run("wait-fresh", ["https://example.com/a.png", "--sha", "not-a-sha"]),
      code: "BAD_FLAG",
    },
    {
      issue: "GH-305",
      name: "cdn wait-fresh rejects non-integer timeout values",
      module: "./cli/lib/cdn.mjs",
      call: (run) => run("wait-fresh", ["https://example.com/a.png", "--sha", "a".repeat(64), "--timeout", "NaN"]),
      code: "BAD_FLAG",
    },
    {
      issue: "GH-304",
      name: "sites deploy rejects unknown flags",
      module: "./cli/lib/sites.mjs",
      call: (run) => run("deploy", ["--manifest", "site.json", "--manfiest", "typo.json"]),
      code: "UNKNOWN_FLAG",
    },
    {
      issue: "GH-304",
      name: "sites deploy-dir rejects extra paths",
      module: "./cli/lib/sites.mjs",
      call: (run) => run("deploy-dir", ["dist", "dist-copy", "--project", "prj_test123"]),
      code: "BAD_USAGE",
    },
    {
      issue: "GH-303",
      name: "tier set rejects extra positional arguments",
      module: "./cli/lib/tier.mjs",
      call: (run) => run("set", ["prototype", "team"]),
      code: "BAD_USAGE",
    },
    {
      issue: "GH-302",
      name: "message send rejects option-looking tokens",
      module: "./cli/lib/message.mjs",
      call: (run) => run("send", ["--file", "./message.txt"]),
      code: "UNKNOWN_FLAG",
    },
    {
      issue: "GH-301",
      name: "agent contact rejects unknown flags",
      module: "./cli/lib/agent.mjs",
      call: (run) => run("contact", ["--name", "agent", "--emali", "a@example.com"]),
      code: "UNKNOWN_FLAG",
    },
    {
      issue: "GH-300",
      name: "apps publish rejects missing flag values",
      module: "./cli/lib/apps.mjs",
      call: (run) => run("publish", ["prj_test123", "--description"]),
      code: "BAD_FLAG",
    },
    {
      issue: "GH-299",
      name: "apps update rejects conflicting fork policy flags",
      module: "./cli/lib/apps.mjs",
      call: (run) => run("update", ["prj_test123", "ver_1", "--fork-allowed", "--no-fork"]),
      code: "BAD_USAGE",
    },
    {
      issue: "GH-298",
      name: "apps fork rejects unsupported --tier",
      module: "./cli/lib/apps.mjs",
      call: (run) => run("fork", ["ver_1", "copy", "--tier", "hobby"]),
      code: "UNKNOWN_FLAG",
    },
    {
      issue: "GH-297",
      name: "secrets delete rejects extra arguments",
      module: "./cli/lib/secrets.mjs",
      call: (run) => run("delete", ["prj_test123", "API_KEY", "OTHER_KEY"]),
      code: "BAD_USAGE",
    },
    {
      issue: "GH-295",
      name: "secrets set rejects inline value plus --file",
      module: "./cli/lib/secrets.mjs",
      call: (run) => run("set", ["prj_test123", "API_KEY", "inline", "--file", "./prod-secret.txt"]),
      code: "BAD_USAGE",
    },
    {
      issue: "GH-294",
      name: "image generate rejects invalid aspect values",
      module: "./cli/lib/image.mjs",
      call: (run) => run("generate", ["prompt", "--aspect", "panorama"]),
      code: "BAD_FLAG",
    },
    {
      issue: "GH-293",
      name: "image generate rejects extra prompt words",
      module: "./cli/lib/image.mjs",
      call: (run) => run("generate", ["a", "cyberpunk", "eagle"]),
      code: "BAD_USAGE",
    },
    {
      issue: "GH-292",
      name: "domains delete rejects extra positional domains",
      module: "./cli/lib/domains.mjs",
      call: (run) => run("delete", ["example.com", "extra.com", "--confirm"]),
      code: "BAD_USAGE",
    },
    {
      issue: "GH-291",
      name: "subdomains delete rejects extra positional names",
      module: "./cli/lib/subdomains.mjs",
      call: (run) => run("delete", ["site-a", "site-b", "--confirm"]),
      code: "BAD_USAGE",
    },
    {
      issue: "GH-290",
      name: "subdomains claim rejects missing flag values",
      module: "./cli/lib/subdomains.mjs",
      call: (run) => run("claim", ["site-a", "--deployment"]),
      code: "BAD_FLAG",
    },
    {
      issue: "GH-289",
      name: "sender-domain register rejects extra domains",
      module: "./cli/lib/sender-domain.mjs",
      call: (run) => run("register", ["example.com", "typo.com", "--project", "prj_test123"]),
      code: "BAD_USAGE",
    },
    {
      issue: "GH-288",
      name: "sender-domain status rejects missing --project values",
      module: "./cli/lib/sender-domain.mjs",
      call: (run) => run("status", ["--project"]),
      code: "BAD_FLAG",
    },
    {
      issue: "GH-287",
      name: "contracts drain rejects malformed destination addresses",
      module: "./cli/lib/contracts.mjs",
      call: (run) => run("drain", ["prj_test123", "cwlt_1", "--to", "0xabc", "--confirm"]),
      code: "BAD_FLAG",
    },
    {
      issue: "GH-286",
      name: "contracts provision-signer rejects unsupported chains",
      module: "./cli/lib/contracts.mjs",
      call: (run) => run("provision-signer", ["prj_test123", "--chain", "polygon"]),
      code: "BAD_FLAG",
    },
    {
      issue: "GH-285",
      name: "contracts set-recovery rejects --clear and --address together",
      module: "./cli/lib/contracts.mjs",
      call: (run) => run("set-recovery", ["prj_test123", "cwlt_1", "--clear", "--address", "0x1111111111111111111111111111111111111111"]),
      code: "BAD_USAGE",
    },
    {
      issue: "GH-284",
      name: "contracts call rejects unknown flags",
      module: "./cli/lib/contracts.mjs",
      call: (run) => run("call", [
        "prj_test123",
        "cwlt_1",
        "--to",
        "0x4444444444444444444444444444444444444444",
        "--abi",
        "[]",
        "--fn",
        "noop",
        "--args",
        "[]",
        "--chaim",
        "base-sepolia",
      ]),
      code: "UNKNOWN_FLAG",
    },
    {
      issue: "GH-283",
      name: "billing history rejects fractional limits",
      module: "./cli/lib/billing.mjs",
      call: (run) => run("history", ["user@example.com", "--limit", "1.5"]),
      code: "BAD_FLAG",
    },
    {
      issue: "GH-282",
      name: "billing checkout rejects missing flag values",
      module: "./cli/lib/billing.mjs",
      call: (run) => run("checkout", ["00000000-0000-4000-8000-000000000001", "--product"]),
      code: "BAD_FLAG",
    },
  ];

  for (const testCase of invalidCases) {
    it(`${testCase.issue}: ${testCase.name}`, async () => {
      const { run } = await import(testCase.module);
      const err = await expectExit1(() => testCase.call(run));

      assert.equal(err.code, testCase.code);
      assert.equal(calls.length, 0, "invalid argv must not hit the network");
    });
  }

  it("GH-296: secrets set allows an intentional empty-string value", async () => {
    const { run } = await import("./cli/lib/secrets.mjs");
    captureStart();
    await run("set", ["prj_test123", "EMPTY_SECRET", ""]);
    captureStop();

    const call = calls.find((c) => c.path === "/projects/v1/admin/prj_test123/secrets");
    assert.ok(call, `expected secrets set request, got ${JSON.stringify(calls)}`);
    assert.equal(JSON.parse(call.init.body).value, "");
  });

  it("GH-336: secrets set --stdin reads the secret from stdin", async () => {
    const { readSecretValueForSet } = await import("./cli/lib/secrets.mjs");
    const value = readSecretValueForSet(["--stdin"], [], {
      readStdin: () => "pipe_secret",
    });

    assert.equal(value, "pipe_secret");
    assert.equal(calls.length, 0, "stdin value resolution must not hit the network");
  });

  it("GH-336: secrets set --file stdin aliases read stdin", async () => {
    const { readSecretValueForSet } = await import("./cli/lib/secrets.mjs");
    const seen = [];
    const readers = {
      readStdin: () => "pipe_secret",
      readFile: (path) => {
        seen.push(["readFile", path]);
        return "file_secret";
      },
      validateFile: (path) => {
        seen.push(["validateFile", path]);
      },
    };

    assert.equal(readSecretValueForSet(["--file", "/dev/stdin"], [], readers), "pipe_secret");
    assert.equal(readSecretValueForSet(["--file", "-"], [], readers), "pipe_secret");
    assert.deepEqual(seen, []);
    assert.equal(calls.length, 0, "stdin value resolution must not hit the network");
  });

  it("GH-336: secrets set normal --file still validates and reads the file", async () => {
    const { readSecretValueForSet } = await import("./cli/lib/secrets.mjs");
    const seen = [];
    const value = readSecretValueForSet(["--file", "./secret.txt"], [], {
      validateFile: (path, flag) => seen.push(["validateFile", path, flag]),
      readFile: (path) => {
        seen.push(["readFile", path]);
        return "file_secret";
      },
    });

    assert.equal(value, "file_secret");
    assert.deepEqual(seen, [
      ["validateFile", "./secret.txt", "--file"],
      ["readFile", "./secret.txt"],
    ]);
    assert.equal(calls.length, 0, "file value resolution must not hit the network");
  });

  it("GH-336: secrets set rejects inline values combined with --stdin", async () => {
    const { readSecretValueForSet } = await import("./cli/lib/secrets.mjs");
    const err = await expectExit1(() =>
      readSecretValueForSet(["--stdin"], ["inline"], { readStdin: () => "pipe_secret" }));

    assert.equal(err.code, "BAD_USAGE");
    assert.match(err.message, /exactly one secret value source/);
    assert.equal(calls.length, 0, "invalid value source selection must not hit the network");
  });

  it("secrets set --stdin reads piped values without echoing them", async () => {
    const { run } = await import("./cli/lib/secrets.mjs");
    await withMockStdin(["stdin-secret-value"], async () => {
      captureStart();
      await run("set", ["prj_test123", "STDIN_SECRET", "--stdin"]);
      captureStop();
    });

    const call = calls.find((c) => c.path === "/projects/v1/admin/prj_test123/secrets");
    assert.ok(call, `expected secrets set request, got ${JSON.stringify(calls)}`);
    assert.equal(JSON.parse(call.init.body).value, "stdin-secret-value");
    assert.doesNotMatch(stdout.join("\n"), /stdin-secret-value/);
    assert.doesNotMatch(stderr.join("\n"), /stdin-secret-value/);
  });

  it("secrets set --file - reads stdin as a POSIX alias", async () => {
    const { run } = await import("./cli/lib/secrets.mjs");
    await withMockStdin(["dash-stdin-secret"], async () => {
      captureStart();
      await run("set", ["prj_test123", "DASH_SECRET", "--file", "-"]);
      captureStop();
    });

    const call = calls.find((c) => c.path === "/projects/v1/admin/prj_test123/secrets");
    assert.ok(call, `expected secrets set request, got ${JSON.stringify(calls)}`);
    assert.equal(JSON.parse(call.init.body).value, "dash-stdin-secret");
  });

  it("secrets set --file /dev/stdin reads stdin without regular-file validation", async () => {
    const { run } = await import("./cli/lib/secrets.mjs");
    await withMockStdin(["dev-stdin-secret"], async () => {
      captureStart();
      await run("set", ["prj_test123", "DEV_STDIN_SECRET", "--file", "/dev/stdin"]);
      captureStop();
    });

    const call = calls.find((c) => c.path === "/projects/v1/admin/prj_test123/secrets");
    assert.ok(call, `expected secrets set request, got ${JSON.stringify(calls)}`);
    assert.equal(JSON.parse(call.init.body).value, "dev-stdin-secret");
  });

  it("secrets set rejects inline value plus --stdin without leaking the value", async () => {
    const { run } = await import("./cli/lib/secrets.mjs");
    const err = await expectExit1(() =>
      run("set", ["prj_test123", "API_KEY", "super-secret-inline", "--stdin"]));

    assert.equal(err.code, "BAD_USAGE");
    assert.deepEqual(err.details.sources, ["inline", "--stdin"]);
    assert.equal(calls.length, 0, "conflicting sources must not hit the network");
    assert.doesNotMatch(JSON.stringify(err), /super-secret-inline/);
  });

  it("secrets set --stdin rejects empty stdin before network", async () => {
    const { run } = await import("./cli/lib/secrets.mjs");
    const err = await withMockStdin([], () =>
      expectExit1(() => run("set", ["prj_test123", "EMPTY_STDIN_SECRET", "--stdin"])));

    assert.equal(err.code, "BAD_USAGE");
    assert.match(err.message, /stdin/i);
    assert.equal(calls.length, 0, "empty stdin must not hit the network");
  });
});

describe("--flag=value", () => {
  it("blob ls accepts equals-form flags (GH-189)", async () => {
    const { run } = await import("./cli/lib/assets.mjs");
    captureStart();
    await run("ls", ["--project=prj_test123", "--limit=500"]);
    captureStop();

    const call = calls.find((c) => c.path.startsWith("/storage/v1/blobs?"));
    assert.ok(call, `expected blob list request, got ${JSON.stringify(calls)}`);
    assert.match(call.url, /limit=500/);
    assert.ok(stdout.join("\n").includes("file.txt"));
  });

  it("functions logs accepts equals-form numeric flags (GH-189)", async () => {
    const { run } = await import("./cli/lib/functions.mjs");
    captureStart();
    await run("logs", ["prj_test123", "hello", "--tail=10"]);
    captureStop();

    const call = calls.find((c) => /\/logs\?/.test(c.path));
    assert.ok(call, `expected logs request, got ${JSON.stringify(calls)}`);
    assert.match(call.url, /tail=10/);
  });

  it("functions logs accepts equals-form request-id filters", async () => {
    const { run } = await import("./cli/lib/functions.mjs");
    captureStart();
    await run("logs", ["prj_test123", "hello", "--request-id=req_abc123"]);
    captureStop();

    const call = calls.find((c) => /\/logs\?/.test(c.path));
    assert.ok(call, `expected logs request, got ${JSON.stringify(calls)}`);
    assert.equal(new URL(call.url).searchParams.get("request_id"), "req_abc123");
  });
});

describe("function log filter validation", () => {
  it("functions logs rejects invalid --since before network", async () => {
    const { run } = await import("./cli/lib/functions.mjs");
    const err = await expectExit1(() =>
      run("logs", ["prj_test123", "hello", "--since", "June 19, 2026 12:00:00 UTC"]));

    assert.equal(err.code, "BAD_USAGE");
    assert.equal(err.details.flag, "--since");
    assert.equal(calls.length, 0, "bad --since must not hit the network");
  });

  it("functions logs rejects invalid --request-id before network", async () => {
    const { run } = await import("./cli/lib/functions.mjs");
    const err = await expectExit1(() =>
      run("logs", ["prj_test123", "hello", "--request-id", "trace_abc"]));

    assert.equal(err.code, "BAD_USAGE");
    assert.equal(err.details.flag, "--request-id");
    assert.equal(calls.length, 0, "bad --request-id must not hit the network");
  });

  it("functions logs rejects --tail above the gateway bound before network", async () => {
    const { run } = await import("./cli/lib/functions.mjs");
    const err = await expectExit1(() =>
      run("logs", ["prj_test123", "hello", "--tail", "1001"]));

    assert.equal(err.code, "BAD_FLAG");
    assert.equal(err.details.flag, "--tail");
    assert.equal(calls.length, 0, "bad --tail must not hit the network");
  });

  it("functions logs follow dedupes same-millisecond entries by event identity", async () => {
    const { run } = await import("./cli/lib/functions.mjs");
    const prevFetch = globalThis.fetch;
    const prevSetTimeout = globalThis.setTimeout;
    const timestamp = "2026-05-01T00:00:00.000Z";
    let logFetches = 0;
    let sleeps = 0;
    globalThis.fetch = (input, init) => {
      const info = requestInfo(input, init);
      calls.push(info);
      const pathNoQuery = info.path.split("?")[0];
      if (/\/functions\/hello\/logs$/.test(pathNoQuery) && info.method === "GET") {
        logFetches += 1;
        const logs = logFetches === 1
          ? [
              { timestamp, message: "first", event_id: "evt-1", log_stream_name: "stream-a" },
              { timestamp, message: "second", event_id: "evt-2", log_stream_name: "stream-a" },
            ]
          : [
              { timestamp, message: "first", event_id: "evt-1", log_stream_name: "stream-a" },
              { timestamp, message: "second", event_id: "evt-2", log_stream_name: "stream-a" },
              { timestamp, message: "third", event_id: "evt-3", log_stream_name: "stream-a" },
            ];
        return Promise.resolve(json({ logs }));
      }
      return mockFetch(input, init);
    };
    globalThis.setTimeout = (fn, _ms, ...args) => {
      sleeps += 1;
      queueMicrotask(() => {
        if (sleeps >= 2) process.emit("SIGINT");
        fn(...args);
      });
      return 0;
    };

    try {
      captureStart();
      await run("logs", ["prj_test123", "hello", "--follow"]);
      captureStop();
    } finally {
      captureStop();
      globalThis.fetch = prevFetch;
      globalThis.setTimeout = prevSetTimeout;
    }

    const output = stdout.join("\n");
    assert.equal((output.match(/first/g) || []).length, 1);
    assert.equal((output.match(/second/g) || []).length, 1);
    assert.equal((output.match(/third/g) || []).length, 1);
    const logCalls = calls.filter((c) => /\/logs\?/.test(c.path));
    assert.ok(logCalls.length >= 2, `expected at least two log polls, got ${JSON.stringify(logCalls)}`);
    assert.equal(
      new URL(logCalls[1].url).searchParams.get("since"),
      String(new Date(timestamp).getTime()),
    );
  });
});

describe("durable function runs CLI", () => {
  it("creates a delayed run with JSON-only stdout", async () => {
    const { run } = await import("./cli/lib/functions.mjs");
    captureStart();
    await run("runs", [
      "create",
      "prj_test123",
      "hello",
      "--event-type=reminder.send",
      "--payload-json",
      "{\"id\":\"msg_1\"}",
      "--idempotency-key=reminder:msg_1",
      "--delay=10m",
      "--max-attempts=3",
    ]);
    captureStop();

    const call = calls.find((c) => c.path === "/functions/v1/hello/runs" && c.method === "POST");
    assert.ok(call, `expected create run request, got ${JSON.stringify(calls)}`);
    const body = requestJsonBody(call.init);
    assert.equal(body.event_type, "reminder.send");
    assert.deepEqual(body.payload, { id: "msg_1" });
    assert.equal(body.idempotency_key, "reminder:msg_1");
    assert.equal(body.delay_seconds, 600);
    assert.deepEqual(body.retry, { preset: "standard", max_attempts: 3 });
    assert.equal(new Headers(call.init.headers).get("Idempotency-Key"), "reminder:msg_1");

    const out = JSON.parse(stdout.join("\n"));
    assert.equal(out.run_id, "fnrun_cli123");
    assert.equal(out.status, "queued");
  });

  it("lists, fetches logs, cancels, and redrives runs", async () => {
    const { run } = await import("./cli/lib/functions.mjs");

    captureStart();
    await run("runs", ["list", "prj_test123", "hello", "--status=queued", "--limit=5"]);
    await run("runs", ["logs", "prj_test123", "fnrun_cli123", "--tail=10"]);
    await run("runs", ["cancel", "prj_test123", "fnrun_cli123"]);
    await run("runs", ["redrive", "prj_test123", "fnrun_cli123", "--max-attempts=2"]);
    captureStop();

    assert.ok(calls.some((c) => c.path === "/functions/v1/hello/runs?status=queued&limit=5" && c.method === "GET"));
    assert.ok(calls.some((c) => c.path === "/functions/v1/runs/fnrun_cli123/logs?tail=10" && c.method === "GET"));
    assert.ok(calls.some((c) => c.path === "/functions/v1/runs/fnrun_cli123/cancel" && c.method === "POST"));
    const redriveCall = calls.find((c) => c.path === "/functions/v1/runs/fnrun_cli123/redrive" && c.method === "POST");
    assert.ok(redriveCall, `expected redrive request, got ${JSON.stringify(calls)}`);
    assert.deepEqual(requestJsonBody(redriveCall.init), { retry: { preset: "standard", max_attempts: 2 } });
  });

  it("gets a run by id", async () => {
    const { run } = await import("./cli/lib/functions.mjs");
    captureStart();
    await run("runs", ["get", "prj_test123", "fnrun_cli123"]);
    captureStop();

    const call = calls.find((c) => c.path === "/functions/v1/runs/fnrun_cli123" && c.method === "GET");
    assert.ok(call, `expected get run request, got ${JSON.stringify(calls)}`);
    assert.equal(JSON.parse(stdout.join("\n")).status, "succeeded");
  });

  it("rejects invalid payload JSON before network", async () => {
    const { run } = await import("./cli/lib/functions.mjs");
    const err = await expectExit1(() =>
      run("runs", [
        "create",
        "prj_test123",
        "hello",
        "--event-type",
        "reminder.send",
        "--idempotency-key",
        "reminder:msg_1",
        "--payload-json",
        "[]",
      ]));

    assert.equal(err.code, "BAD_USAGE");
    assert.equal(err.details.flag, "--payload-json");
    assert.equal(calls.length, 0, "invalid payload JSON must not hit the network");
  });

  it("rejects ambiguous scheduling and extra positionals before network", async () => {
    const { run } = await import("./cli/lib/functions.mjs");

    let err = await expectExit1(() =>
      run("runs", [
        "create",
        "prj_test123",
        "hello",
        "--event-type",
        "reminder.send",
        "--idempotency-key",
        "reminder:msg_1",
        "--delay",
        "10m",
        "--run-at",
        "2026-07-01T00:10:00.000Z",
      ]));

    assert.equal(err.status, "error");
    assert.equal(calls.length, 0, "ambiguous scheduling must not hit the network");

    calls = [];
    err = await expectExit1(() =>
      run("runs", ["list", "prj_test123", "hello", "surprise"]));

    assert.equal(err.code, "BAD_USAGE");
    assert.equal(err.details.argument, "surprise");
    assert.equal(calls.length, 0, "extra list args must not hit the network");
  });
});

describe("function deploy argv validation", () => {
  it("functions deploy rejects empty dependency entries before network", async () => {
    const { run } = await import("./cli/lib/functions.mjs");
    const codePath = join(tempDir, "handler-deps.mjs");
    writeFileSync(codePath, "export default async () => new Response('ok')");

    for (const deps of ["axios,", "axios,,date-fns", "axios,   "]) {
      calls = [];
      const err = await expectExit1(() =>
        run("deploy", ["prj_test123", "hello", "--file", codePath, "--deps", deps]));

      assert.equal(err.code, "BAD_USAGE");
      assert.equal(err.details.flag, "--deps");
      assert.equal(calls.length, 0, `bad --deps ${JSON.stringify(deps)} must not hit the network`);
    }
  });
});

describe("function update argv validation", () => {
  it("functions update rejects --schedule with --schedule-remove before network", async () => {
    const { run } = await import("./cli/lib/functions.mjs");
    const err = await expectExit1(() =>
      run("update", ["prj_test123", "hello", "--schedule", "0 * * * *", "--schedule-remove"]));

    assert.equal(err.code, "BAD_USAGE");
    assert.match(err.message, /mutually exclusive/);
    assert.equal(calls.length, 0, "conflicting schedule flags must not hit the network");
  });
});

describe("function list/delete argv validation", () => {
  it("functions list rejects extra args and flags before network", async () => {
    const { run } = await import("./cli/lib/functions.mjs");

    let err = await expectExit1(() => run("list", ["prj_test123", "extra"]));
    assert.equal(err.code, "BAD_USAGE");
    assert.equal(calls.length, 0, "extra list arg must not hit the network");

    calls = [];
    err = await expectExit1(() => run("list", ["prj_test123", "--json"]));
    assert.equal(err.code, "UNKNOWN_FLAG");
    assert.equal(err.details.flag, "--json");
    assert.equal(calls.length, 0, "unknown list flag must not hit the network");
  });

  it("functions delete rejects extra args and flags before network", async () => {
    const { run } = await import("./cli/lib/functions.mjs");

    let err = await expectExit1(() => run("delete", ["prj_test123", "hello", "extra"]));
    assert.equal(err.code, "BAD_USAGE");
    assert.equal(calls.length, 0, "extra delete arg must not hit the network");

    calls = [];
    err = await expectExit1(() => run("delete", ["prj_test123", "hello", "--force"]));
    assert.equal(err.code, "UNKNOWN_FLAG");
    assert.equal(err.details.flag, "--force");
    assert.equal(calls.length, 0, "unknown delete flag must not hit the network");
  });
});

describe("numeric flag validation", () => {
  it("blob ls validates --limit before network (GH-186)", async () => {
    const { run } = await import("./cli/lib/assets.mjs");
    for (const value of ["notanumber", "0", "999999"]) {
      calls = [];
      const err = await expectExit1(() => run("ls", ["--project", "prj_test123", "--limit", value]));
      assert.equal(err.code, "BAD_FLAG");
      assert.match(err.message, /--limit/);
      assert.equal(calls.length, 0, `bad --limit ${value} must not hit network`);
    }
  });

  it("blob sign validates --ttl before network (GH-186)", async () => {
    const { run } = await import("./cli/lib/assets.mjs");
    for (const value of ["abc", "-1", "99999999"]) {
      calls = [];
      const err = await expectExit1(() => run("sign", ["reports/a.pdf", "--project", "prj_test123", "--ttl", value]));
      assert.equal(err.code, "BAD_FLAG");
      assert.match(err.message, /--ttl/);
      assert.equal(calls.length, 0, `bad --ttl ${value} must not hit network`);
    }
  });

  it("blob put validates --concurrency before upload init (GH-186)", async () => {
    const { run } = await import("./cli/lib/assets.mjs");
    const file = join(tempDir, "upload.txt");
    writeFileSync(file, "hello");
    const err = await expectExit1(() =>
      run("put", [file, "--project", "prj_test123", "--concurrency", "0"]));

    assert.equal(err.code, "BAD_FLAG");
    assert.match(err.message, /--concurrency/);
    assert.equal(calls.length, 0, "bad --concurrency must not init an upload");
  });

  it("blob put validates --content-type before upload init (GH-237)", async () => {
    const { run } = await import("./cli/lib/assets.mjs");
    const file = join(tempDir, "bad-mime.txt");
    writeFileSync(file, "hello");
    for (const value of ["", "image", "/svg", "image/"]) {
      calls = [];
      const argv = value === ""
        ? [file, "--project", "prj_test123", "--content-type"]
        : [file, "--project", "prj_test123", "--content-type", value];
      const err = await expectExit1(() => run("put", argv));
      assert.equal(err.code, "BAD_FLAG");
      assert.match(err.message, /--content-type/);
      assert.equal(calls.length, 0, `bad --content-type ${JSON.stringify(value)} must not init an upload`);
    }
  });

  it("blob put sends explicit --content-type to apply plan (GH-237)", async () => {
    const { run } = await import("./cli/lib/assets.mjs");
    const file = join(tempDir, "extensionless-asset");
    writeFileSync(file, "<svg></svg>");
    let planBody = null;
    const prevFetch = globalThis.fetch;
    globalThis.fetch = applyMockFetch({ onPlanBody: (b) => { planBody = b; } });
    captureStart();
    try {
      await run("put", [file, "--project", "prj_test123", "--key", "assets/logo", "--content-type", "image/svg+xml"]);
    } finally {
      captureStop();
      globalThis.fetch = prevFetch;
    }
    const entry = planBody?.spec?.assets?.put?.[0];
    assert.equal(entry?.content_type, "image/svg+xml");
    assert.equal(entry?.key, "assets/logo");
  });

  it("blob put sends SHA-256 digest in the apply plan body (GH-308)", async () => {
    const { run } = await import("./cli/lib/assets.mjs");
    const file = join(tempDir, "checksum-upload.txt");
    writeFileSync(file, "hello world");
    const expectedSha = createHash("sha256").update("hello world").digest("hex");
    let planBody = null;
    const prevFetch = globalThis.fetch;
    globalThis.fetch = applyMockFetch({ onPlanBody: (b) => { planBody = b; } });
    captureStart();
    try {
      await run("put", [file, "--project", "prj_test123"]);
    } finally {
      captureStop();
      globalThis.fetch = prevFetch;
    }
    const entry = planBody?.spec?.assets?.put?.[0];
    assert.equal(entry?.sha256, expectedSha);
  });

  it("blob put routes through /apply/v1/plans, not legacy /storage/v1/uploads (v2.1.0)", async () => {
    const { run } = await import("./cli/lib/assets.mjs");
    const file = join(tempDir, "route-check.txt");
    writeFileSync(file, "abcdefghi");
    const prevFetch = globalThis.fetch;
    globalThis.fetch = applyMockFetch();
    captureStart();
    try {
      await run("put", [file, "--project", "prj_test123", "--concurrency", "2"]);
    } finally {
      captureStop();
      globalThis.fetch = prevFetch;
    }
    const paths = calls.map((c) => c.path);
    assert.ok(paths.some((p) => p === "/apply/v1/plans"), "must call /apply/v1/plans");
    assert.ok(!paths.some((p) => p.startsWith("/storage/v1/uploads")), "must not call legacy /storage/v1/uploads");
  });

  it("blob put does not create resume state files (v2.1.0 substrate change)", async () => {
    const stateHome = mkdtempSync(join(tmpdir(), "run402-blob-home-"));
    const prevHome = process.env.HOME;
    process.env.HOME = stateHome;
    const { run } = await import("./cli/lib/assets.mjs?no-state");
    const file = join(tempDir, "state-upload.txt");
    writeFileSync(file, "hello state");
    const prevFetch = globalThis.fetch;
    globalThis.fetch = applyMockFetch();
    captureStart();
    try {
      await run("put", [file, "--project", "prj_test123"]);
    } finally {
      captureStop();
      globalThis.fetch = prevFetch;
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      rmSync(stateHome, { recursive: true, force: true });
    }
    const stateDir = join(stateHome, ".run402", "uploads");
    assert.equal(existsSync(stateDir), false, "v2.1.0 must not create ~/.run402/uploads state files");
  });

  it("blob put accepts --no-resume without error (backward compatibility)", async () => {
    const { run } = await import("./cli/lib/assets.mjs");
    const file = join(tempDir, "compat-upload.txt");
    writeFileSync(file, "compat");
    const prevFetch = globalThis.fetch;
    globalThis.fetch = applyMockFetch();
    captureStart();
    try {
      await run("put", [file, "--project", "prj_test123", "--no-resume"]);
    } finally {
      captureStop();
      globalThis.fetch = prevFetch;
    }
    assert.ok(calls.some((c) => c.path === "/apply/v1/plans"), "--no-resume is ignored; apply route is still used");
  });

  it("blob put surfaces apply-plan gateway errors as structured JSON (v2.1.0)", async () => {
    const { run } = await import("./cli/lib/assets.mjs");
    const file = join(tempDir, "apply-fails.txt");
    writeFileSync(file, "hello");
    const prevFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const info = requestInfo(input, init);
      calls.push(info);
      if (info.path === "/apply/v1/plans" && info.method === "POST") {
        return Promise.resolve(json({
          error: "Invalid apikey",
          message: "Invalid apikey",
          code: "INVALID_AUTH",
          trace_id: "trc_plan",
        }, 401));
      }
      return mockFetch(input, init);
    };
    const err = await expectExit1(() => run("put", [file, "--project", "prj_test123"]));
    globalThis.fetch = prevFetch;

    assert.equal(err.http, 401);
    assert.equal(err.code, "INVALID_AUTH");
    assert.equal(err.trace_id, "trc_plan");
    assert.ok(!/\\\"code\\\"/.test(err.message ?? ""), `message should not contain stringified JSON: ${err.message}`);
  });

  it("functions update validates --memory before network (GH-186)", async () => {
    const { run } = await import("./cli/lib/functions.mjs");
    const err = await expectExit1(() =>
      run("update", ["prj_test123", "hello", "--memory", "abc"]));

    assert.equal(err.code, "BAD_FLAG");
    assert.match(err.message, /--memory/);
    assert.equal(calls.length, 0, "bad --memory must not hit network");
  });
});

describe("project-id heuristic", () => {
  it("projects info refuses non-prj first positional instead of using active project (GH-184)", async () => {
    const { run } = await import("./cli/lib/projects.mjs");
    const err = await expectExit1(() => run("info", ["proj-001"]));

    assert.equal(err.code, "BAD_PROJECT_ID");
    assert.match(err.message, /proj-001/);
    assert.equal(calls.length, 0);
  });

  it("projects sql keeps one-arg query active-project shorthand but rejects bad-id plus extra query (GH-184)", async () => {
    const { run } = await import("./cli/lib/projects.mjs");

    captureStart();
    await run("sql", ["SELECT 1"]);
    captureStop();
    assert.equal(calls.some((c) => /\/projects\/v1\/admin\/prj_test123\/sql$/.test(c.path)), true);

    calls = [];
    const err = await expectExit1(() => run("sql", ["badly-typed-id", "DELETE FROM users"]));
    assert.equal(err.code, "BAD_PROJECT_ID");
    assert.match(err.message, /badly-typed-id/);
    assert.equal(calls.length, 0);
  });

  it("projects sql refuses a non-prj positional before --file (GH-184)", async () => {
    const { run } = await import("./cli/lib/projects.mjs");
    const sqlFile = join(tempDir, "danger.sql");
    writeFileSync(sqlFile, "SELECT 1");

    const err = await expectExit1(() => run("sql", ["proj-001", "--file", sqlFile]));
    assert.equal(err.code, "BAD_PROJECT_ID");
    assert.match(err.message, /proj-001/);
    assert.equal(calls.length, 0);
  });
});

describe("v1.50 assets — --meta / --exif-policy / --sort / --filter argv (issue #393)", () => {
  it("blob put threads --meta + --exif-policy onto the apply plan entry", async () => {
    const { run } = await import("./cli/lib/assets.mjs");
    const file = join(tempDir, "v150-hero.jpg");
    writeFileSync(file, "fake-jpeg-bytes");
    let planBody = null;
    const prevFetch = globalThis.fetch;
    globalThis.fetch = applyMockFetch({ onPlanBody: (b) => { planBody = b; } });
    captureStart();
    try {
      await run("put", [
        file,
        "--project", "prj_test123",
        "--meta", "uploaded_by=agent_abc",
        "--meta", "version=3",
        "--meta", "published=true",
        "--meta", "tags=hero,banner",
        "--exif-policy", "strip",
      ]);
    } finally {
      captureStop();
      globalThis.fetch = prevFetch;
    }
    const entry = planBody?.spec?.assets?.put?.[0];
    assert.deepEqual(entry?.metadata, {
      uploaded_by: "agent_abc",
      version: 3,
      published: true,
      tags: ["hero", "banner"],
    }, "metadata coercion: string + number + boolean + string[]");
    assert.equal(entry?.exif_policy, "strip");
    assert.equal(entry?.exifPolicy, undefined, "camelCase SDK-input field must not leak to wire");
  });

  it("blob put rejects nested --meta value form before any network call", async () => {
    const { run } = await import("./cli/lib/assets.mjs");
    const file = join(tempDir, "v150-bad-meta.txt");
    writeFileSync(file, "irrelevant");
    // The CLI does not allow nested objects in --meta — only scalar / string[].
    // Passing a key with no value (`--meta key=`) is allowed but coerces to
    // empty string; an outright nested object can only be smuggled in via
    // the SDK (which the SDK validator catches with INVALID_ASSET_METADATA).
    // What we can verify here: bad form (no '=') is rejected with BAD_FLAG.
    const err = await expectExit1(() => run("put", [
      file, "--project", "prj_test123", "--meta", "uploaded_by_only",
    ]));
    assert.equal(err.code, "BAD_FLAG");
    assert.match(err.message, /--meta requires key=value/);
    assert.equal(calls.length, 0);
  });

  it("blob put rejects invalid --exif-policy before any network call", async () => {
    const { run } = await import("./cli/lib/assets.mjs");
    const file = join(tempDir, "v150-bad-exif.txt");
    writeFileSync(file, "x");
    const err = await expectExit1(() => run("put", [
      file, "--project", "prj_test123", "--exif-policy", "drop",
    ]));
    assert.equal(err.code, "BAD_FLAG");
    assert.match(err.message, /--exif-policy must be 'keep' or 'strip'/);
    assert.equal(calls.length, 0);
  });

  it("assets ls --sort + --filter serialize into the request query", async () => {
    const { run } = await import("./cli/lib/assets.mjs");
    const prevFetch = globalThis.fetch;
    globalThis.fetch = mockFetch;
    captureStart();
    try {
      await run("ls", [
        "--project", "prj_test123",
        "--sort", "createdAt:desc",
        "--filter", "is_image=true",
        "--filter", "min_width=320",
        "--filter", "format=webp",
      ]);
    } finally {
      captureStop();
      globalThis.fetch = prevFetch;
    }
    const lsCall = calls.find((c) => c.path.startsWith("/storage/v1/blobs"));
    assert.ok(lsCall, "ls call should hit /storage/v1/blobs");
    const u = new URL(lsCall.url);
    assert.equal(u.searchParams.get("sort"), "createdAt:desc");
    assert.equal(u.searchParams.get("filter[is_image]"), "true");
    assert.equal(u.searchParams.get("filter[min_width]"), "320");
    assert.equal(u.searchParams.get("filter[format]"), "webp");
  });

  it("assets ls rejects invalid --sort before any network call", async () => {
    const { run } = await import("./cli/lib/assets.mjs");
    const err = await expectExit1(() => run("ls", [
      "--project", "prj_test123", "--sort", "size:asc",
    ]));
    assert.equal(err.code, "BAD_FLAG");
    assert.match(err.message, /--sort must be one of/);
    assert.equal(calls.length, 0);
  });

  it("assets ls rejects unknown --filter key before any network call", async () => {
    const { run } = await import("./cli/lib/assets.mjs");
    const err = await expectExit1(() => run("ls", [
      "--project", "prj_test123", "--filter", "uploadedBy=agent_abc",
    ]));
    assert.equal(err.code, "BAD_FLAG");
    assert.match(err.message, /uploadedBy/);
    assert.equal(calls.length, 0);
  });

  it("assets ls rejects non-boolean --filter is_image before network", async () => {
    const { run } = await import("./cli/lib/assets.mjs");
    const err = await expectExit1(() => run("ls", [
      "--project", "prj_test123", "--filter", "is_image=yes",
    ]));
    assert.equal(err.code, "BAD_FLAG");
    assert.match(err.message, /is_image must be 'true' or 'false'/);
    assert.equal(calls.length, 0);
  });
});

describe("CLI JSON-only output contract (v3.x cleanup)", () => {
  it("functions invoke default emits {http_status, body, duration_ms} envelope (no top-level status)", async () => {
    const { run } = await import("./cli/lib/functions.mjs");
    const prevFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const info = requestInfo(input, init);
      calls.push(info);
      if (info.path.startsWith("/functions/v1/") && info.method === "POST") {
        return Promise.resolve(json({ hello: "world" }));
      }
      return mockFetch(input, init);
    };
    captureStart();
    try {
      await run("invoke", ["prj_test123", "hello"]);
    } finally {
      captureStop();
      globalThis.fetch = prevFetch;
    }
    const out = stdout.join("\n");
    const parsed = JSON.parse(out);
    assert.equal(typeof parsed.http_status, "number", "must expose HTTP status as http_status");
    assert.equal(parsed.status, undefined, "must NOT have top-level status (reserved for stderr error envelope)");
    assert.deepEqual(parsed.body, { hello: "world" });
    assert.equal(typeof parsed.duration_ms, "number");
  });

  it("functions invoke --raw emits the body verbatim (object → JSON, string → text+newline)", async () => {
    const { run } = await import("./cli/lib/functions.mjs");
    const prevFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const info = requestInfo(input, init);
      calls.push(info);
      if (info.path.startsWith("/functions/v1/") && info.method === "POST") {
        return Promise.resolve(json({ hello: "world" }));
      }
      return mockFetch(input, init);
    };
    captureStart();
    try {
      await run("invoke", ["prj_test123", "hello", "--raw"]);
    } finally {
      captureStop();
      globalThis.fetch = prevFetch;
    }
    const out = stdout.join("\n");
    const parsed = JSON.parse(out);
    assert.deepEqual(parsed, { hello: "world" }, "--raw should print the body directly with no envelope");
  });

  it("functions logs --follow emits NDJSON (one JSON entry per line, no wrapping envelope)", async () => {
    const { run } = await import("./cli/lib/functions.mjs");
    const prevFetch = globalThis.fetch;
    const prevSetTimeout = globalThis.setTimeout;
    globalThis.fetch = (input, init) => {
      const info = requestInfo(input, init);
      calls.push(info);
      if (/\/logs\?/.test(info.path) && info.method === "GET") {
        return Promise.resolve(json({
          logs: [
            { timestamp: "2026-05-01T00:00:00Z", message: "alpha", event_id: "e1" },
            { timestamp: "2026-05-01T00:00:01Z", message: "beta",  event_id: "e2" },
          ],
        }));
      }
      return mockFetch(input, init);
    };
    let sleeps = 0;
    globalThis.setTimeout = (fn, _ms, ...args) => {
      sleeps += 1;
      queueMicrotask(() => {
        if (sleeps >= 1) process.emit("SIGINT");
        fn(...args);
      });
      return 0;
    };

    try {
      captureStart();
      await run("logs", ["prj_test123", "hello", "--follow"]);
      captureStop();
    } finally {
      captureStop();
      globalThis.fetch = prevFetch;
      globalThis.setTimeout = prevSetTimeout;
    }

    const lines = stdout.join("\n").split("\n").filter(Boolean);
    assert.ok(lines.length >= 2, `expected >= 2 NDJSON lines, got ${lines.length}: ${lines.join(" | ")}`);
    for (const line of lines) {
      const parsed = JSON.parse(line);
      assert.equal(typeof parsed.message, "string", `every NDJSON line must be a log entry, got: ${line}`);
      assert.equal(typeof parsed.timestamp, "string");
    }
    const messages = lines.map((l) => JSON.parse(l).message);
    assert.ok(messages.includes("alpha"));
    assert.ok(messages.includes("beta"));
  });

  it("email get-raw success path emits {message_id, bytes, output} envelope (no binary on stdout)", async () => {
    const { run } = await import("./cli/lib/email.mjs");
    const prevFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const info = requestInfo(input, init);
      calls.push(info);
      if (/\/mailboxes\/v1\/mbx_test1\/messages\/[^/]+\/raw$/.test(info.path) && info.method === "GET") {
        return Promise.resolve(new Response(Buffer.from("From: a@b\r\n\r\nbody"), {
          status: 200,
          headers: { "Content-Type": "message/rfc822" },
        }));
      }
      return mockFetch(input, init);
    };
    const outFile = join(tempDir, "raw-msg.eml");
    captureStart();
    try {
      await run("get-raw", ["msg_1", "--output", outFile, "--project", "prj_test123", "--mailbox", "mbx_test1"]);
    } finally {
      captureStop();
      globalThis.fetch = prevFetch;
    }
    const out = stdout.join("\n").trim();
    const parsed = JSON.parse(out);
    assert.equal(parsed.message_id, "msg_1");
    assert.equal(parsed.output, outFile);
    assert.equal(typeof parsed.bytes, "number");
    assert.equal(parsed.status, undefined, "no top-level status field");
    assert.ok(existsSync(outFile), "MIME bytes must land in --output, never stdout");
  });

  it("assets put --json is a deprecated alias for --stream (warns on stderr, still streams NDJSON)", async () => {
    const { run } = await import("./cli/lib/assets.mjs");
    const file = join(tempDir, "deprecated-json.txt");
    writeFileSync(file, "hi");
    const prevFetch = globalThis.fetch;
    const prevStderrWrite = process.stderr.write.bind(process.stderr);
    let stderrCapture = "";
    process.stderr.write = (chunk) => { stderrCapture += String(chunk); return true; };
    globalThis.fetch = applyMockFetch();
    captureStart();
    try {
      await run("put", [file, "--project", "prj_test123", "--json"]);
    } finally {
      captureStop();
      process.stderr.write = prevStderrWrite;
      globalThis.fetch = prevFetch;
    }
    assert.match(stderrCapture, /--json.*deprecated/i,
      `expected deprecation warning on stderr, got: ${JSON.stringify(stderrCapture)}`);
    const lines = stdout.join("\n").split("\n").filter(Boolean);
    assert.ok(lines.length >= 1, "should emit at least one NDJSON event");
    for (const line of lines) {
      const parsed = JSON.parse(line);
      assert.equal(typeof parsed.event, "string", `each NDJSON line must have event field, got: ${line}`);
    }
  });

  it("assets put --stream emits NDJSON without a deprecation warning", async () => {
    const { run } = await import("./cli/lib/assets.mjs");
    const file = join(tempDir, "stream-flag.txt");
    writeFileSync(file, "hi");
    const prevFetch = globalThis.fetch;
    const prevStderrWrite = process.stderr.write.bind(process.stderr);
    let stderrCapture = "";
    process.stderr.write = (chunk) => { stderrCapture += String(chunk); return true; };
    globalThis.fetch = applyMockFetch();
    captureStart();
    try {
      await run("put", [file, "--project", "prj_test123", "--stream"]);
    } finally {
      captureStop();
      process.stderr.write = prevStderrWrite;
      globalThis.fetch = prevFetch;
    }
    assert.doesNotMatch(stderrCapture, /deprecated/i,
      `--stream should not warn, got: ${JSON.stringify(stderrCapture)}`);
    const lines = stdout.join("\n").split("\n").filter(Boolean);
    assert.ok(lines.length >= 1);
    for (const line of lines) {
      JSON.parse(line);
    }
  });

  // Bucket-1 cleanup: 6 commands previously defaulted to human text with --json
  // opt-in. They now emit JSON by default; --json is removed (no users yet —
  // pre-launch cleanup). Informational lines on init / init astro go to stderr.

  it("cache inspect --json is now UNKNOWN_FLAG (default is JSON)", async () => {
    const { run } = await import("./cli/lib/cache.mjs");
    const err = await expectExit1(() => run("inspect", ["https://example.run402.com/x", "--json"]));
    assert.equal(err.code, "UNKNOWN_FLAG");
    assert.equal(err.details.flag, "--json");
  });

  it("cache invalidate --json is now UNKNOWN_FLAG (default is JSON)", async () => {
    const { run } = await import("./cli/lib/cache.mjs");
    const err = await expectExit1(() => run("invalidate", ["https://example.run402.com/x", "--json"]));
    assert.equal(err.code, "UNKNOWN_FLAG");
    assert.equal(err.details.flag, "--json");
  });

  it("logs default emits JSON on stdout (no [ts] [fn] msg text lines)", async () => {
    const { run } = await import("./cli/lib/logs.mjs");
    const prevFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const info = requestInfo(input, init);
      calls.push(info);
      if (info.path.startsWith("/projects/v1/admin/prj_test123/functions") && /\/logs\?/.test(info.path)) {
        return Promise.resolve(json({ logs: [{ timestamp: "2026-05-28T00:00:00Z", message: "hello" }] }));
      }
      if (info.path === "/projects/v1/admin/prj_test123/functions" && info.method === "GET") {
        return Promise.resolve(json({ functions: [{ name: "ssr" }] }));
      }
      return mockFetch(input, init);
    };
    captureStart();
    try {
      await run("--request-id", ["req_abc123def", "--project", "prj_test123"]);
    } finally {
      captureStop();
      globalThis.fetch = prevFetch;
    }
    const out = stdout.join("\n");
    const parsed = JSON.parse(out);
    assert.equal(parsed.request_id, "req_abc123def");
    assert.equal(parsed.project_id, "prj_test123");
    assert.ok(Array.isArray(parsed.entries), `entries should be a flat array (unwrap regression), got: ${JSON.stringify(parsed.entries).slice(0, 100)}`);
    assert.equal(parsed.entries[0]?.message, "hello");
    assert.equal(parsed.entries[0]?.function, "ssr");
    assert.ok(Array.isArray(parsed.scanned));
    assert.equal(parsed.status, undefined, "no top-level status field");
    assert.doesNotMatch(out, /\[\d{4}-\d{2}-\d{2}T.+\] \[ssr\]/,
      `stdout must not have legacy [ts] [fn] msg text lines, got: ${out.slice(0, 200)}`);
  });

  it("init emits JSON on stdout and human banner on stderr (no --json flag)", async () => {
    const { run } = await import("./cli/lib/init.mjs");
    // Seed allowance so init takes the same-rail idempotent path (no faucet).
    const { saveAllowance } = await import("./cli/core-dist/allowance.js");
    saveAllowance({ address: "0x0000000000000000000000000000000000000001", privateKey: "0x" + "00".repeat(32), rail: "x402", funded: true, created: new Date().toISOString() });
    const prevFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const info = requestInfo(input, init);
      calls.push(info);
      // The fresh init path reads viem balance via createPublicClient; the
      // mock fetch only catches HTTP. Return a benign payload for anything
      // that does hit fetch (tier, etc).
      return Promise.resolve(json({ tier: "prototype", active: true, lease_expires_at: "2099-01-01T00:00:00Z" }));
    };
    captureStart();
    try {
      await run([]);
    } catch (_e) { /* init may exit when balance read fails; we only test output shape */ }
    finally {
      captureStop();
      globalThis.fetch = prevFetch;
    }
    const out = stdout.join("\n").trim();
    if (out.length > 0) {
      const parsed = JSON.parse(out);
      assert.equal(typeof parsed.config_dir, "string", "stdout JSON should include config_dir");
      assert.equal(typeof parsed.wallet, "object", "stdout JSON should include wallet object");
    }
    const err = stderr.join("\n");
    assert.match(err, /\bConfig\b/, `human banner should be on stderr, got: ${err.slice(0, 300)}`);
  });

  it("init astro emits JSON on stdout and progress on stderr; scaffold uses current deps and drops stale getUser", async () => {
    const { runInitAstro } = await import("./cli/lib/init-astro.mjs");
    const scaffoldDir = join(tempDir, "scaffold-test");
    captureStart();
    try {
      await runInitAstro([scaffoldDir]);
    } finally {
      captureStop();
    }
    const out = stdout.join("\n").trim();
    const parsed = JSON.parse(out);
    assert.equal(parsed.created, true);
    assert.equal(parsed.dir, scaffoldDir);
    assert.ok(Array.isArray(parsed.files_created));
    assert.equal(parsed.status, undefined, "no top-level status field");
    const err = stderr.join("\n");
    assert.match(err, /Scaffolded Astro project/, "progress lines should be on stderr");

    const pkg = JSON.parse(readFileSync(join(scaffoldDir, "package.json"), "utf8"));
    assert.equal(pkg.dependencies.astro, "^7.0.0");
    assert.equal(pkg.dependencies["@run402/astro"], "^2.4.2");
    assert.equal(pkg.dependencies["@run402/functions"], "^3.0.0");
    assert.notEqual(pkg.dependencies.astro, "^5.0.0");
    assert.notEqual(pkg.dependencies["@run402/astro"], "^1.0.0");
    assert.notEqual(pkg.dependencies["@run402/functions"], "^2.5.0");

    // Scaffold-template regression: [slug].astro must NOT import the retired
    // getUser bare export from @run402/functions@3.0+ — it would throw
    // R402_AUTH_UNKNOWN_EXPORT at runtime under v3.0.
    const slugAstro = readFileSync(join(scaffoldDir, "src/pages/[slug].astro"), "utf8");
    assert.doesNotMatch(slugAstro, /\bgetUser\b/, "scaffold template must not import legacy getUser");
  });

  it("doctor --json is now UNKNOWN_FLAG (default is JSON)", async () => {
    // doctor's HELP includes --json in its old form, but the runtime arg parser
    // ignores unknown flags rather than throwing. Verify by running and asserting
    // stdout is JSON regardless of whether --json is present.
    const { run } = await import("./cli/lib/doctor.mjs");
    captureStart();
    let threw = null;
    try {
      await run(undefined, ["--no-scan"]);
    } catch (e) { threw = e; }
    finally {
      captureStop();
    }
    // doctor calls process.exit(0|1) — the stub throws.
    assert.ok(threw, "doctor should call process.exit");
    const out = stdout.join("\n").trim();
    const parsed = JSON.parse(out);
    assert.equal(typeof parsed.ok, "boolean", "doctor stdout should be { ok, checks }");
    assert.ok(Array.isArray(parsed.checks), "doctor stdout should have checks array");
  });
});

describe("email --attach parsing", () => {
  let attachDir;
  before(() => {
    attachDir = mkdtempSync(join(tmpdir(), "run402-attach-test-"));
  });
  after(() => {
    rmSync(attachDir, { recursive: true, force: true });
  });

  it("parses a single --attach and infers content-type from the extension", async () => {
    const { parseAttachments } = await import("./cli/lib/email.mjs");
    const p = join(attachDir, "foo.pdf");
    writeFileSync(p, "PDFDATA");
    const out = parseAttachments(["--attach", p]);
    assert.deepEqual(out, [
      { filename: "foo.pdf", content_base64: Buffer.from("PDFDATA").toString("base64"), content_type: "application/pdf" },
    ]);
  });

  it("parses repeated --attach flags into multiple entries", async () => {
    const { parseAttachments } = await import("./cli/lib/email.mjs");
    const a = join(attachDir, "a.csv");
    const b = join(attachDir, "b.png");
    writeFileSync(a, "x,y");
    writeFileSync(b, "PNG");
    const out = parseAttachments(["--attach", a, "--attach", b]);
    assert.equal(out.length, 2);
    assert.equal(out[0].content_type, "text/csv");
    assert.equal(out[1].content_type, "image/png");
  });

  it("honors an explicit :content-type suffix over the extension", async () => {
    const { parseAttachments } = await import("./cli/lib/email.mjs");
    const p = join(attachDir, "data.bin");
    writeFileSync(p, "raw");
    const out = parseAttachments(["--attach", `${p}:text/csv`]);
    assert.equal(out[0].filename, "data.bin");
    assert.equal(out[0].content_type, "text/csv");
  });

  it("rejects an unreadable attachment path before sending", async () => {
    const { parseAttachments } = await import("./cli/lib/email.mjs");
    const env = await expectExit1(() => parseAttachments(["--attach", join(attachDir, "nope.pdf")]));
    assert.equal(env.code, "BAD_USAGE");
    assert.match(env.message, /Cannot read attachment file/);
  });

  it("rejects --attach with no value", async () => {
    const { parseAttachments } = await import("./cli/lib/email.mjs");
    const env = await expectExit1(() => parseAttachments(["--attach"]));
    assert.equal(env.code, "BAD_USAGE");
  });
});

describe("deploy apply manifest source precedence", () => {
  // Regression: `run402 ci link github` workflows run `deploy apply --manifest`
  // in GitHub Actions, where the runner's stdin is a FIFO/file. An explicit
  // source flag must win over that incidental stdin (else BAD_USAGE: "Only one
  // deploy manifest source").
  it("explicit --manifest wins over incidental stdin (CI FIFO)", async () => {
    const { resolveApplySource } = await import("./cli/lib/deploy-v2.mjs");
    assert.deepEqual(
      resolveApplySource({ manifest: "m.json", spec: null, dir: null }, true),
      { source: "manifest" },
    );
  });

  it("--dir wins over incidental stdin (CI)", async () => {
    const { resolveApplySource } = await import("./cli/lib/deploy-v2.mjs");
    assert.deepEqual(
      resolveApplySource({ manifest: null, spec: null, dir: "dist" }, true),
      { source: "dir" },
    );
  });

  it("--manifest + --spec is a genuine conflict", async () => {
    const { resolveApplySource } = await import("./cli/lib/deploy-v2.mjs");
    const r = resolveApplySource({ manifest: "m.json", spec: "{}", dir: null }, false);
    assert.equal(r.source, undefined);
    assert.equal(r.error.code, "BAD_USAGE");
    assert.match(r.error.message, /Only one deploy manifest source/);
  });

  it("piped stdin with no source flag resolves to stdin", async () => {
    const { resolveApplySource } = await import("./cli/lib/deploy-v2.mjs");
    assert.deepEqual(
      resolveApplySource({ manifest: null, spec: null, dir: null }, true),
      { source: "stdin" },
    );
  });

  it("no source flag and no stdin is a clear error, not a hang", async () => {
    const { resolveApplySource } = await import("./cli/lib/deploy-v2.mjs");
    const r = resolveApplySource({ manifest: null, spec: null, dir: null }, false);
    assert.equal(r.error.code, "BAD_USAGE");
    assert.match(r.error.message, /No deploy manifest provided/);
  });
});

describe("transfer retain-collaborator argv validation (v1.91)", () => {
  it("transfer init rejects an invalid --retain-collaborator role before network", async () => {
    const { run } = await import("./cli/lib/transfer.mjs");
    const err = await expectExit1(() =>
      run("init", ["--to", "alice@example.com", "--retain-collaborator", "owner"]),
    );
    assert.equal(err.code, "BAD_FLAG");
    assert.match(err.message, /retain-collaborator/);
  });

  it("transfer init rejects --retain-collaborator on the wallet rail before network", async () => {
    const { run } = await import("./cli/lib/transfer.mjs");
    const err = await expectExit1(() =>
      run("init", [
        "--to",
        "0xC0ffee0000000000000000000000000000000000",
        "--retain-collaborator",
        "developer",
      ]),
    );
    assert.equal(err.code, "BAD_FLAG");
    assert.match(err.message, /email recipients/);
  });

  it("transfer init rejects --retain-collaborator on the owned-org rail before network", async () => {
    const { run } = await import("./cli/lib/transfer.mjs");
    const err = await expectExit1(() =>
      run("init", ["--to-org", "org_123", "--retain-collaborator", "developer"]),
    );
    assert.equal(err.code, "BAD_FLAG");
    assert.match(err.message, /email recipients/);
    assert.equal(calls.length, 0, "invalid argv must not hit the network");
  });
});

describe("transfer owned-org init argv plumbing (GH-469)", () => {
  it("transfer init maps --to-org to the SDK/wire to_org_id body", async () => {
    const { saveAllowance } = await import("./cli/core-dist/allowance.js");
    saveAllowance({
      address: "0x0000000000000000000000000000000000000001",
      privateKey: "0x" + "11".repeat(32),
      rail: "x402",
      funded: true,
      created: new Date().toISOString(),
    });
    const { run } = await import("./cli/lib/transfer.mjs");
    const prevFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const info = requestInfo(input, init);
      const body =
        input instanceof Request
          ? await input.clone().text()
          : (init?.body ?? null);
      calls.push({ ...info, body });
      return json({
        status: "accepted",
        project_id: "prj_test123",
        to_organization_id: "org_123",
        anon_key: "anon_new",
        service_key: "svc_new",
      });
    };

    captureStart();
    try {
      await run("init", ["--to-org", "org_123", "--project", "prj_test123", "--message", "move"]);
    } finally {
      captureStop();
      globalThis.fetch = prevFetch;
    }

    const call = calls.find((c) => c.path === "/projects/v1/prj_test123/transfers");
    assert.ok(call, `expected transfer init request, got ${JSON.stringify(calls)}`);
    assert.equal(call.method, "POST");
    assert.deepEqual(JSON.parse(String(call.body)), { to_org_id: "org_123", message: "move" });
  });

  it("transfer init rejects conflicting --to and --to-org before network", async () => {
    const { run } = await import("./cli/lib/transfer.mjs");
    const err = await expectExit1(() =>
      run("init", ["--to", "alice@example.com", "--to-org", "org_123"]),
    );
    assert.equal(err.code, "BAD_USAGE");
    assert.match(err.message, /exactly one recipient/);
    assert.equal(calls.length, 0, "invalid argv must not hit the network");
  });

  it("transfer init rejects wallet-only flags on non-wallet rails before network", async () => {
    const { run } = await import("./cli/lib/transfer.mjs");
    let err = await expectExit1(() =>
      run("init", ["--to-org", "org_123", "--kysigned", "ks_1"]),
    );
    assert.equal(err.code, "BAD_FLAG");
    assert.match(err.message, /wallet recipients/);
    assert.equal(calls.length, 0, "invalid argv must not hit the network");

    calls = [];
    err = await expectExit1(() =>
      run("init", ["--to", "alice@example.com", "--billing-policy", "migrate"]),
    );
    assert.equal(err.code, "BAD_FLAG");
    assert.match(err.message, /wallet recipients/);
    assert.equal(calls.length, 0, "invalid argv must not hit the network");
  });
});

describe("transfer unified surface — obsolete kind flags rejected (unify-transfer-client-surface)", () => {
  it("preview rejects the obsolete --handoff flag before network", async () => {
    const { run } = await import("./cli/lib/transfer.mjs");
    const err = await expectExit1(() => run("preview", ["ptx_1", "--handoff"]));
    assert.equal(err.code, "UNKNOWN_FLAG");
    assert.equal(err.details.flag, "--handoff");
    assert.equal(calls.length, 0, "invalid argv must not hit the network");
  });

  it("list rejects the obsolete --handoffs flag before network", async () => {
    const { run } = await import("./cli/lib/transfer.mjs");
    const err = await expectExit1(() => run("list", ["--handoffs"]));
    assert.equal(err.code, "UNKNOWN_FLAG");
    assert.equal(err.details.flag, "--handoffs");
    assert.equal(calls.length, 0, "invalid argv must not hit the network");
  });

  it("cancel rejects the obsolete --handoff flag before network", async () => {
    const { run } = await import("./cli/lib/transfer.mjs");
    const err = await expectExit1(() => run("cancel", ["ptx_1", "--handoff"]));
    assert.equal(err.code, "UNKNOWN_FLAG");
    assert.equal(err.details.flag, "--handoff");
    assert.equal(calls.length, 0, "invalid argv must not hit the network");
  });
});

describe("operator approve argv validation (v1.85/v1.87)", () => {
  it("rejects an unknown --action before any network/ceremony", async () => {
    const { run } = await import("./cli/lib/operator.mjs");
    const err = await expectExit1(() => run("approve", ["--action", "bogus"]));
    assert.equal(err.code, "BAD_FLAG");
    assert.match(err.message, /action/);
  });
  it("requires --project for a project-scoped action", async () => {
    const { run } = await import("./cli/lib/operator.mjs");
    const err = await expectExit1(() => run("approve", ["--action", "project.deploy"]));
    assert.equal(err.code, "BAD_FLAG");
    assert.match(err.message, /project/);
  });
  it("requires --org for org.project.create", async () => {
    const { run } = await import("./cli/lib/operator.mjs");
    const err = await expectExit1(() => run("approve", ["--action", "org.project.create"]));
    assert.equal(err.code, "BAD_FLAG");
    assert.match(err.message, /org/);
  });
});
