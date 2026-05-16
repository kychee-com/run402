import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handlePinProject, pinProjectSchema } from "./pin-project.js";

const originalFetch = globalThis.fetch;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "run402-pin-test-"));
  process.env.RUN402_CONFIG_DIR = tempDir;
  process.env.RUN402_API_BASE = "https://test-api.run402.com";

  const store = {
    projects: {
      "proj-001": {
        anon_key: "ak-123",
        service_key: "sk-the-key",
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

describe("pin_project tool", () => {
  it("uses service_key bearer auth when the project is local", async () => {
    let capturedHeaders: Record<string, string> = {};
    let capturedUrl = "";
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = url instanceof Request ? url.url : String(url);
      if (url instanceof Request) {
        capturedHeaders = Object.fromEntries(url.headers.entries());
      } else {
        capturedHeaders = init?.headers as Record<string, string>;
      }
      return new Response(
        JSON.stringify({ status: "ok", project_id: "proj-001", pinned: true, was_pinned: false }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const result = await handlePinProject({ project_id: "proj-001" });
    assert.equal(capturedHeaders["Authorization"] ?? capturedHeaders.authorization, "Bearer sk-the-key");
    assert.equal(capturedHeaders["SIGN-IN-WITH-X"] ?? capturedHeaders["sign-in-with-x"], undefined);
    assert.equal(capturedHeaders["X-Admin-Mode"] ?? capturedHeaders["x-admin-mode"], undefined);
    assert.ok(capturedUrl.endsWith("/projects/v1/admin/proj-001/pin"));
    assert.equal(result.isError, undefined);
    assert.ok(result.content[0]!.text.includes("pinned=true"));
    assert.ok(result.content[0]!.text.includes("was_pinned=false"));
  });

  it("falls back to allowance admin auth when the project is not local", async () => {
    writeFileSync(join(tempDir, "allowance.json"), JSON.stringify({
      address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      privateKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
      created: "2026-01-01T00:00:00.000Z",
      funded: true,
      rail: "x402",
    }));
    let capturedHeaders: Record<string, string> = {};
    let capturedUrl = "";
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = url instanceof Request ? url.url : String(url);
      if (url instanceof Request) {
        capturedHeaders = Object.fromEntries(url.headers.entries());
      } else {
        capturedHeaders = init?.headers as Record<string, string>;
      }
      return new Response(
        JSON.stringify({ status: "ok", project_id: "proj-001", pinned: true, was_pinned: false }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const result = await handlePinProject({ project_id: "prj_external" });
    assert.equal(
      typeof (capturedHeaders["SIGN-IN-WITH-X"] ?? capturedHeaders["sign-in-with-x"]),
      "string",
    );
    assert.equal(capturedHeaders["Authorization"] ?? capturedHeaders.authorization, undefined);
    assert.equal(capturedHeaders["X-Admin-Mode"] ?? capturedHeaders["x-admin-mode"], "1");
    assert.ok(capturedUrl.endsWith("/projects/v1/admin/prj_external/pin"));
    assert.equal(result.isError, undefined);
    assert.ok(result.content[0]!.text.includes("pinned successfully"));
    assert.ok(result.content[0]!.text.includes("pinned=true"));
    assert.ok(result.content[0]!.text.includes("was_pinned=false"));
  });

  it("returns isError on API error", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ error: "Something went wrong" }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const result = await handlePinProject({ project_id: "proj-001" });
    assert.equal(result.isError, true);
    assert.ok(result.content[0]!.text.includes("500"));
  });

  it("schema describes owner service-key and admin fallback auth", () => {
    const descr = (pinProjectSchema.project_id as { description?: string })
      .description ?? "";
    assert.match(
      descr,
      /service key/i,
      `pinProjectSchema.project_id description should mention local service-key auth; got: ${descr}`,
    );
    assert.match(
      descr,
      /admin/i,
      `pinProjectSchema.project_id description should mention admin fallback auth; got: ${descr}`,
    );
  });
});
