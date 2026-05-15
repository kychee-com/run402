/**
 * Regression tests for CLI argv parsing.
 *
 * These stay separate from cli-e2e.test.mjs so parser failures are fast and
 * focused: no command should reach the network when argv itself is invalid.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = mkdtempSync(join(tmpdir(), "run402-argv-"));
const API = "https://test-api.run402.com";
process.env.RUN402_CONFIG_DIR = tempDir;
process.env.RUN402_API_BASE = API;

const originalFetch = globalThis.fetch;
const originalLog = console.log;
const originalError = console.error;
const originalExit = process.exit;
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
  const line = stderr.find((s) => s.trim().startsWith("{"));
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
  delete process.env.RUN402_CONFIG_DIR;
  delete process.env.RUN402_API_BASE;
  rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  calls = [];
  captureStop();
});

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

describe("--flag=value", () => {
  it("blob ls accepts equals-form flags (GH-189)", async () => {
    const { run } = await import("./cli/lib/blob.mjs");
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
      run("logs", ["prj_test123", "hello", "--since", "not-a-date"]));

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

describe("numeric flag validation", () => {
  it("blob ls validates --limit before network (GH-186)", async () => {
    const { run } = await import("./cli/lib/blob.mjs");
    for (const value of ["notanumber", "0", "999999"]) {
      calls = [];
      const err = await expectExit1(() => run("ls", ["--project", "prj_test123", "--limit", value]));
      assert.equal(err.code, "BAD_FLAG");
      assert.match(err.message, /--limit/);
      assert.equal(calls.length, 0, `bad --limit ${value} must not hit network`);
    }
  });

  it("blob sign validates --ttl before network (GH-186)", async () => {
    const { run } = await import("./cli/lib/blob.mjs");
    for (const value of ["abc", "-1", "99999999"]) {
      calls = [];
      const err = await expectExit1(() => run("sign", ["reports/a.pdf", "--project", "prj_test123", "--ttl", value]));
      assert.equal(err.code, "BAD_FLAG");
      assert.match(err.message, /--ttl/);
      assert.equal(calls.length, 0, `bad --ttl ${value} must not hit network`);
    }
  });

  it("blob put validates --concurrency before upload init (GH-186)", async () => {
    const { run } = await import("./cli/lib/blob.mjs");
    const file = join(tempDir, "upload.txt");
    writeFileSync(file, "hello");
    const err = await expectExit1(() =>
      run("put", [file, "--project", "prj_test123", "--concurrency", "0"]));

    assert.equal(err.code, "BAD_FLAG");
    assert.match(err.message, /--concurrency/);
    assert.equal(calls.length, 0, "bad --concurrency must not init an upload");
  });

  it("blob put validates --content-type before upload init (GH-237)", async () => {
    const { run } = await import("./cli/lib/blob.mjs");
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

  it("blob put sends explicit --content-type to upload init (GH-237)", async () => {
    const { run } = await import("./cli/lib/blob.mjs");
    const file = join(tempDir, "extensionless-asset");
    writeFileSync(file, "<svg></svg>");
    let initBody = null;
    const prevFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const info = requestInfo(input, init);
      calls.push(info);
      if (info.path === "/storage/v1/uploads" && info.method === "POST") {
        initBody = JSON.parse(String(info.init.body));
        return Promise.resolve(json({
          upload_id: "upload_mime",
          mode: "single",
          part_count: 1,
          parts: [{ part_number: 1, url: "https://s3.example.test/upload_mime/p1", byte_start: 0, byte_end: 10 }],
        }, 201));
      }
      if (info.url === "https://s3.example.test/upload_mime/p1" && info.method === "PUT") {
        return Promise.resolve(new Response("", { status: 200, headers: { etag: "\"etag-1\"" } }));
      }
      if (info.path === "/storage/v1/uploads/upload_mime/complete" && info.method === "POST") {
        return Promise.resolve(json({
          key: "assets/logo",
          size_bytes: 11,
          sha256: null,
          visibility: "public",
          content_type: "image/svg+xml",
          url: "https://pr-test.run402.com/_blob/assets/logo",
          immutable_url: null,
        }));
      }
      return mockFetch(input, init);
    };
    captureStart();
    try {
      await run("put", [
        file,
        "--project", "prj_test123",
        "--key", "assets/logo",
        "--content-type", "image/svg+xml",
        "--no-resume",
      ]);
    } finally {
      captureStop();
      globalThis.fetch = prevFetch;
    }

    assert.equal(initBody?.content_type, "image/svg+xml");
    assert.equal(initBody?.key, "assets/logo");
  });

  it("blob put surfaces upload-init gateway errors as structured JSON (GH-186)", async () => {
    const { run } = await import("./cli/lib/blob.mjs");
    const file = join(tempDir, "upload-init-fails.txt");
    writeFileSync(file, "hello");
    const prevFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const info = requestInfo(input, init);
      calls.push(info);
      if (info.path === "/storage/v1/uploads" && info.method === "POST") {
        return Promise.resolve(json({
          error: "Invalid apikey",
          message: "Invalid apikey",
          code: "INVALID_AUTH",
          trace_id: "trc_init",
        }, 401));
      }
      return mockFetch(input, init);
    };
    const err = await expectExit1(() =>
      run("put", [file, "--project", "prj_test123", "--concurrency", "1"]));
    globalThis.fetch = prevFetch;

    assert.equal(err.http, 401);
    assert.equal(err.code, "INVALID_AUTH");
    assert.equal(err.trace_id, "trc_init");
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
