import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleDoctor } from "./doctor.js";
import { doctorOutputSchema } from "../structured.js";
import { _resetSdk } from "../sdk.js";

const originalFetch = globalThis.fetch;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "run402-doctor-test-"));
  process.env.RUN402_CONFIG_DIR = tempDir;
  process.env.RUN402_API_BASE = "https://test-api.run402.com";
  globalThis.fetch = (async () => new Response(JSON.stringify({ status: "ok" }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;
  _resetSdk();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  _resetSdk();
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.RUN402_CONFIG_DIR;
  delete process.env.RUN402_API_BASE;
});

describe("doctor tool", () => {
  it("returns r.doctor()'s { ok, blocking, warnings, checks }", async () => {
    const result = await handleDoctor({});
    assert.equal(result.isError, undefined);
    const text = result.content[0]!.text;
    assert.match(text, /^## Doctor: /);
    const structured = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(text)![1]!) as { status: string; result: { ok: boolean; blocking: unknown[]; warnings: unknown[]; checks: Array<{ id?: string; severity?: string }> } };
    assert.equal(structured.status, "ok");
    assert.deepEqual(result.structuredContent, structured, "the fenced JSON is the structured object");
    doctorOutputSchema.parse(result.structuredContent);
    const report = structured.result;
    assert.equal(typeof report.ok, "boolean");
    assert.ok(Array.isArray(report.blocking));
    assert.ok(Array.isArray(report.warnings));
    assert.ok(report.checks.length > 0);
    assert.equal(report.ok, report.blocking.length === 0);
  });
});
