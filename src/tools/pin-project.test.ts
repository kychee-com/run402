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
  it("sends service_key as Bearer token", async () => {
    let capturedHeaders: Record<string, string> = {};
    let capturedUrl = "";
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedHeaders = init?.headers as Record<string, string>;
      return new Response(
        JSON.stringify({ status: "ok", project_id: "proj-001" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const result = await handlePinProject({ project_id: "proj-001" });
    assert.equal(capturedHeaders["Authorization"], "Bearer sk-the-key");
    assert.ok(capturedUrl.endsWith("/projects/v1/admin/proj-001/pin"));
    assert.equal(result.isError, undefined);
    assert.ok(result.content[0]!.text.includes("pinned successfully"));
  });

  it("returns isError when project not in keystore", async () => {
    const result = await handlePinProject({ project_id: "nonexistent" });
    assert.equal(result.isError, true);
    assert.ok(result.content[0]!.text.includes("not found in key store"));
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

  // GH-103: The server-side /projects/v1/admin/:id/pin endpoint is admin-only
  // and rejects project-owner service_key / SIWX auth with 403 admin_required.
  // The Zod project_id description must surface this constraint so the LLM
  // does not misadvertise the tool to project owners.
  it("schema describes pin as admin-only (GH-103)", () => {
    const descr = (pinProjectSchema.project_id as { description?: string })
      .description ?? "";
    assert.match(
      descr,
      /admin/i,
      `pinProjectSchema.project_id description should note admin-only; got: ${descr}`,
    );
  });
});
