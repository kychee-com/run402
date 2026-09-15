import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleGetFunctionLogs } from "./get-function-logs.js";

const originalFetch = globalThis.fetch;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "run402-logs-fn-test-"));
  process.env.RUN402_CONFIG_DIR = tempDir;
  process.env.RUN402_API_BASE = "https://test-api.run402.com";

  const store = {
    projects: {
      "proj-001": {
        anon_key: "ak-123",
        service_key: "sk-456",
        tier: "prototype",
        lease_expires_at: "2030-01-01T00:00:00Z",
      },
    },
  };
  writeFileSync(join(tempDir, "projects.json"), JSON.stringify(store));
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.RUN402_CONFIG_DIR;
  delete process.env.RUN402_API_BASE;
});

describe("get_function_logs tool", () => {
  it("returns formatted logs on 200", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          logs: [
            {
              timestamp: "2026-03-05T12:00:00Z",
              message: "Processing webhook",
              event_id: "evt-1",
              log_stream_name: "stream-a",
              ingestion_time: "2026-03-05T12:00:01Z",
              request_id: "req_abc123",
            },
            { timestamp: "2026-03-05T12:00:01Z", message: "Done" },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const result = await handleGetFunctionLogs({
      project_id: "proj-001",
      name: "my-func",
    });

    assert.equal(result.isError, undefined);
    assert.ok(result.content[0]!.text.includes("Function Logs: my-func"));
    assert.ok(result.content[0]!.text.includes("Processing webhook"));
    assert.ok(result.content[0]!.text.includes("request_id=req_abc123"));
    assert.ok(result.content[0]!.text.includes("event_id=evt-1"));
    assert.ok(result.content[0]!.text.includes("stream=stream-a"));
    assert.ok(result.content[0]!.text.includes("2 log entries"));
    assert.ok(result.content[0]!.text.includes("[app]"), "every rendered line is tagged with its origin");
  });

  const MIXED = [
    { timestamp: "2026-03-05T12:00:00Z", message: "INIT_START Runtime Version: nodejs:22.v20" },
    { timestamp: "2026-03-05T12:00:01Z", message: "START RequestId: 4d1f2c3a-0000-4000-8000-000000000001 Version: $LATEST" },
    { timestamp: "2026-03-05T12:00:02Z", message: "2026-03-05T12:00:02.000Z\t4d1f2c3a\tINFO\tProcessing webhook", request_id: "req_abc123" },
    { timestamp: "2026-03-05T12:00:03Z", message: "REPORT RequestId: 4d1f2c3a-0000-4000-8000-000000000001\tDuration: 12.34 ms\tBilled Duration: 13 ms" },
  ];

  function mixedFetch(onUrl?: (url: string) => void): typeof fetch {
    return (async (url: string) => {
      onUrl?.(url);
      return new Response(JSON.stringify({ logs: MIXED }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
  }

  it("defaults to origin all: platform lines stay, tagged [platform]", async () => {
    let capturedUrl = "";
    globalThis.fetch = mixedFetch((u) => { capturedUrl = u; });
    const result = await handleGetFunctionLogs({ project_id: "proj-001", name: "my-func" });
    const text = result.content[0]!.text;
    assert.equal(result.isError, undefined);
    assert.ok(text.includes("[platform]"));
    assert.ok(text.includes("REPORT RequestId"));
    assert.ok(text.includes("[app]"));
    assert.ok(text.includes("4 log entries"));
    assert.ok(!text.includes("hidden by origin"), "no footer when nothing was hidden");
    assert.equal(new URL(capturedUrl).searchParams.has("origin"), false, "origin never reaches the wire");
  });

  it("origin: app hides INIT_START/REPORT lines and says how many", async () => {
    globalThis.fetch = mixedFetch();
    const result = await handleGetFunctionLogs({ project_id: "proj-001", name: "my-func", origin: "app" });
    const text = result.content[0]!.text;
    assert.ok(text.includes("Processing webhook"));
    assert.ok(!text.includes("REPORT RequestId"));
    assert.ok(!text.includes("INIT_START Runtime"));
    assert.ok(text.includes("1 log entries"));
    assert.ok(text.includes('3 platform (INIT_START/REPORT) lines hidden by origin: "app"'), text);
  });

  it("origin: app on a function that wrote nothing explains the hidden platform lines instead of 'no logs'", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ logs: MIXED.filter((e) => !e.message.includes("INFO")) }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;
    const result = await handleGetFunctionLogs({ project_id: "proj-001", name: "my-func", origin: "app" });
    const text = result.content[0]!.text;
    assert.equal(result.isError, undefined);
    assert.ok(text.includes("No app output; 3 platform lines (INIT_START/REPORT) hidden"), text);
    assert.ok(!text.includes("may not have been invoked"));
  });

  it("origin: platform keeps only the runtime lines", async () => {
    globalThis.fetch = mixedFetch();
    const result = await handleGetFunctionLogs({ project_id: "proj-001", name: "my-func", origin: "platform" });
    const text = result.content[0]!.text;
    assert.ok(!text.includes("Processing webhook"));
    assert.ok(text.includes("3 log entries"));
    assert.ok(text.includes('1 app line hidden by origin: "platform"'), text);
  });

  it("request_id without name fans out across every function in the project", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      urls.push(url);
      const u = new URL(url);
      if (u.pathname === "/projects/v1/admin/proj-001/functions") {
        return new Response(JSON.stringify({ functions: [{ name: "ssr" }, { name: "checkout" }] }), {
          status: 200, headers: { "Content-Type": "application/json" },
        });
      }
      const fn = u.pathname.includes("/functions/ssr/") ? "ssr" : "checkout";
      return new Response(JSON.stringify({ logs: [
        { timestamp: fn === "ssr" ? "2026-03-05T12:00:02Z" : "2026-03-05T12:00:01Z", message: `${fn} handled it`, request_id: "req_abc123" },
      ] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;

    const result = await handleGetFunctionLogs({ project_id: "proj-001", request_id: "req_abc123" });
    const text = result.content[0]!.text;
    assert.equal(result.isError, undefined, text);
    assert.ok(text.includes("Function Logs: request req_abc123"));
    assert.ok(text.includes("Scanned: ssr, checkout"));
    assert.ok(text.indexOf("[checkout]") < text.indexOf("[ssr]"), "merged oldest-first across functions");
    assert.ok(text.includes("[checkout] [app]"));
    assert.ok(text.includes("2 log entries"));
    const logUrls = urls.filter((u) => u.includes("/logs?"));
    assert.equal(logUrls.length, 2);
    assert.ok(logUrls.every((u) => new URL(u).searchParams.get("request_id") === "req_abc123"));
  });

  it("request_id fan-out names a function whose read failed", async () => {
    globalThis.fetch = (async (url: string) => {
      const u = new URL(url);
      if (u.pathname === "/projects/v1/admin/proj-001/functions") {
        return new Response(JSON.stringify({ functions: [{ name: "ssr" }, { name: "broken" }] }), {
          status: 200, headers: { "Content-Type": "application/json" },
        });
      }
      if (u.pathname.includes("/functions/broken/")) {
        return new Response(JSON.stringify({ error: "CloudWatch unavailable", code: "FUNCTION_LOGS_UNAVAILABLE" }), {
          status: 503, headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ logs: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;

    const result = await handleGetFunctionLogs({ project_id: "proj-001", request_id: "req_abc123" });
    const text = result.content[0]!.text;
    assert.equal(result.isError, undefined);
    assert.ok(text.includes("No log lines correlated to req_abc123"));
    assert.ok(text.includes("Log reads that failed:"));
    assert.match(text, /- broken: CloudWatch unavailable.*\(FUNCTION_LOGS_UNAVAILABLE\)/, text);
  });

  it("refuses a call with neither name nor request_id before any fetch", async () => {
    let fetchCalled = false;
    globalThis.fetch = (async () => { fetchCalled = true; return new Response("{}"); }) as typeof fetch;
    const result = await handleGetFunctionLogs({ project_id: "proj-001" });
    assert.equal(result.isError, true);
    assert.ok(result.content[0]!.text.includes("request_id"));
    assert.equal(fetchCalled, false);
  });

  it("returns empty message when no logs", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ logs: [] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const result = await handleGetFunctionLogs({
      project_id: "proj-001",
      name: "my-func",
    });

    assert.equal(result.isError, undefined);
    assert.ok(result.content[0]!.text.includes("No logs found"));
  });

  it("returns isError on 404", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ error: "Function not found" }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const result = await handleGetFunctionLogs({
      project_id: "proj-001",
      name: "nonexistent",
    });

    assert.equal(result.isError, true);
  });

  it("a project not in the keystore is read on the principal credential, and the gateway's verdict is forwarded", async () => {
    // The agent a Buzz page addresses holds no project key: the tool no
    // longer fails locally, it asks the gateway with the wallet and forwards
    // the answer — here a project.read refusal.
    let sawServiceKeyBearer = false;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const auth = new Headers(init?.headers ?? {}).get("authorization") ?? "";
      if (auth.startsWith("Bearer ")) sawServiceKeyBearer = true;
      return new Response(
        JSON.stringify({ code: "FORBIDDEN", message: "not a member of this project's organization" }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const result = await handleGetFunctionLogs({
      project_id: "nonexistent",
      name: "my-func",
    });

    assert.equal(sawServiceKeyBearer, false, "no project key to send");
    assert.equal(result.isError, true);
    assert.ok(result.content[0]!.text.includes("FORBIDDEN") || result.content[0]!.text.includes("not a member"), result.content[0]!.text);
  });

  it("passes since as epoch ms query param", async () => {
    let capturedUrl = "";
    globalThis.fetch = (async (url: string) => {
      capturedUrl = url;
      return new Response(
        JSON.stringify({ logs: [] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    await handleGetFunctionLogs({
      project_id: "proj-001",
      name: "my-func",
      since: "2026-03-29T14:00:00.001Z",
    });

    assert.ok(capturedUrl.includes("since="), "URL should contain since param");
    const sinceMs = new URL(capturedUrl).searchParams.get("since");
    assert.equal(sinceMs, String(new Date("2026-03-29T14:00:00.001Z").getTime()));
  });

  it("passes request_id as requestId query param", async () => {
    let capturedUrl = "";
    globalThis.fetch = (async (url: string) => {
      capturedUrl = url;
      return new Response(
        JSON.stringify({ logs: [] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    await handleGetFunctionLogs({
      project_id: "proj-001",
      name: "my-func",
      request_id: "req_abc123",
    });

    assert.equal(new URL(capturedUrl).searchParams.get("request_id"), "req_abc123");
  });

  it("accepts function run ids as request_id filters", async () => {
    let capturedUrl = "";
    globalThis.fetch = (async (url: string) => {
      capturedUrl = url;
      return new Response(
        JSON.stringify({ logs: [] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    await handleGetFunctionLogs({
      project_id: "proj-001",
      name: "my-func",
      request_id: "fnrun_abc123",
    });

    assert.equal(new URL(capturedUrl).searchParams.get("request_id"), "fnrun_abc123");
  });

  it("rejects invalid since before fetch", async () => {
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response(JSON.stringify({ logs: [] }), { status: 200 });
    }) as typeof fetch;

    const result = await handleGetFunctionLogs({
      project_id: "proj-001",
      name: "my-func",
      since: "June 19, 2026 12:00:00 UTC",
    });

    assert.equal(result.isError, true);
    assert.equal(fetchCalled, false);
    assert.ok(result.content[0]!.text.includes("Invalid functions.logs since timestamp"));
  });

  it("omits since param when not provided", async () => {
    let capturedUrl = "";
    globalThis.fetch = (async (url: string) => {
      capturedUrl = url;
      return new Response(
        JSON.stringify({ logs: [] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    await handleGetFunctionLogs({
      project_id: "proj-001",
      name: "my-func",
    });

    assert.ok(!capturedUrl.includes("since="), "URL should not contain since param");
  });
});
