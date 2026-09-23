/**
 * `r.diagnostics.probeOrigin` and its one consumer, `r.buzz.doctor()`
 * (code-mode MCP, task 1.9): each outcome is classified — ok, http,
 * redirect (never followed), dns, tls, timeout, network — and the Buzz
 * preflight measures the Run402 origins through it rather than with a raw
 * fetch of its own. The embedded Buzz doctor contract and capability fixture
 * must stay byte-for-byte the published `buzz/fixtures` JSON.
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { BUZZ_CLI_CAPABILITIES, BUZZ_DOCTOR_CONTRACT, Diagnostics, run402 } from "./index.js";

const originalFetch = globalThis.fetch;
let responder: (url: string, init?: RequestInit) => Promise<Response> = async () => new Response("ok");
const seen: Array<{ url: string; redirect?: RequestRedirect }> = [];

before(() => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, redirect: init?.redirect });
    return responder(url, init);
  }) as typeof globalThis.fetch;
});

after(() => {
  globalThis.fetch = originalFetch;
});

function failWith(message: string, extra: Record<string, unknown> = {}): () => Promise<Response> {
  return async () => {
    throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(message), extra) });
  };
}

describe("probeOrigin", () => {
  const diagnostics = new Diagnostics();

  it("a 2xx is reachable, and the probe never follows redirects", async () => {
    responder = async () => new Response("ok", { status: 200 });
    const result = await diagnostics.probeOrigin("https://api.example.test/status");
    assert.equal(result.reachable, true);
    assert.equal(result.classification, "ok");
    assert.equal(result.status, 200);
    assert.equal(typeof result.elapsed_ms, "number");
    assert.equal(seen.at(-1)?.redirect, "manual");
  });

  it("a 3xx is a redirect naming its location; any other status is http", async () => {
    responder = async () => new Response(null, { status: 301, headers: { location: "https://elsewhere.test/" } });
    assert.deepEqual(
      { ...(await diagnostics.probeOrigin("https://a.test/")), elapsed_ms: 0 },
      { reachable: false, classification: "redirect", status: 301, redirect_to: "https://elsewhere.test/", error: "http_301", elapsed_ms: 0 },
    );
    responder = async () => new Response("down", { status: 503 });
    const http = await diagnostics.probeOrigin("https://a.test/");
    assert.equal(http.classification, "http");
    assert.equal(http.error, "http_503");
  });

  it("transport failures are classified, never thrown", async () => {
    responder = failWith("getaddrinfo ENOTFOUND a.test", { code: "ENOTFOUND" });
    assert.equal((await diagnostics.probeOrigin("https://a.test/")).classification, "dns");
    responder = failWith("unable to verify the first certificate");
    assert.equal((await diagnostics.probeOrigin("https://a.test/")).error, "tls_handshake_failed");
    responder = async () => { throw Object.assign(new Error("aborted"), { name: "AbortError" }); };
    assert.equal((await diagnostics.probeOrigin("https://a.test/")).classification, "timeout");
    responder = failWith("socket hang up");
    assert.equal((await diagnostics.probeOrigin("https://a.test/")).classification, "network");
  });

  it("aborts at its deadline", async () => {
    responder = (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    });
    const result = await diagnostics.probeOrigin("https://slow.test/", { timeoutMs: 20 });
    assert.equal(result.classification, "timeout");
  });
});

describe("r.buzz.doctor measures the Run402 origins through probeOrigin", () => {
  it("an unreachable API is BUZZ_PREFLIGHT_API_UNREACHABLE with the classified failure", async () => {
    responder = async (url) => new Response("x", { status: url.startsWith("https://api.example.test") ? 503 : 200 });
    const r = run402({ apiBase: "https://api.example.test", disablePaidFetch: true });
    const report = await r.buzz.doctor({
      apiOrigin: "https://api.example.test",
      consoleOrigin: "https://console.example.test",
      env: { PATH: "" },
      runCommand: () => ({ status: 1, stdout: "", stderr: "" }),
      lookup: async () => [],
    });
    const api = report.checks.find((c: { name: string }) => c.name === "run402_api");
    assert.equal(api.status, "blocked");
    assert.equal(api.code, "BUZZ_PREFLIGHT_API_UNREACHABLE");
    assert.equal(api.value.failure, "http_503");
    const consoleCheck = report.checks.find((c: { name: string }) => c.name === "run402_console");
    assert.equal(consoleCheck.status, "ok");
    assert.ok(seen.some((s) => s.url === "https://api.example.test/status"));
    const cli = report.checks.find((c: { name: string }) => c.name === "run402_cli");
    assert.equal(cli.code, "BUZZ_PREFLIGHT_RUN402_UNAVAILABLE", "no CLI hooks: the SDK is not the run402 CLI");
  });
});

describe("the embedded Buzz doctor fixtures", () => {
  it("are the published buzz/fixtures JSON, verbatim", () => {
    const read = (name: string) => JSON.parse(readFileSync(new URL(`../../../buzz/fixtures/${name}`, import.meta.url), "utf8"));
    assert.deepEqual(JSON.parse(JSON.stringify(BUZZ_DOCTOR_CONTRACT)), read("run402-buzz-doctor-v1-contract.json"));
    assert.deepEqual(JSON.parse(JSON.stringify(BUZZ_CLI_CAPABILITIES)), read("buzz-v0.5.2-cli-capabilities.json"));
  });
});
