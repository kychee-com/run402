import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { setupRlsRefined, handleSetupRls } from "./setup-rls.js";

const originalFetch = globalThis.fetch;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "run402-setup-rls-test-"));
  process.env.RUN402_CONFIG_DIR = tempDir;
  process.env.RUN402_API_BASE = "https://test-api.run402.com";

  const store = {
    projects: {
      "proj-001": { anon_key: "ak-123", service_key: "sk-456" },
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

describe("setup_rls Zod schema", () => {
  it("rejects the deprecated `public_read` template with an enum error", () => {
    const result = setupRlsRefined.safeParse({
      project_id: "proj-001",
      template: "public_read",
      tables: [{ table: "notes" }],
    });
    assert.equal(result.success, false);
    if (!result.success) {
      const templateIssue = result.error.issues.find((i) => i.path.includes("template"));
      assert.ok(templateIssue, "expected a template enum issue");
      assert.match(templateIssue!.message, /public_read_authenticated_write/);
    }
  });

  it("rejects the deprecated `public_read_write` template with an enum error", () => {
    const result = setupRlsRefined.safeParse({
      project_id: "proj-001",
      template: "public_read_write",
      tables: [{ table: "guestbook" }],
    });
    assert.equal(result.success, false);
    if (!result.success) {
      const templateIssue = result.error.issues.find((i) => i.path.includes("template"));
      assert.ok(templateIssue, "expected a template enum issue");
      assert.match(templateIssue!.message, /public_read_write_UNRESTRICTED/);
    }
  });

  it("rejects UNRESTRICTED template without the ACK flag", () => {
    const result = setupRlsRefined.safeParse({
      project_id: "proj-001",
      template: "public_read_write_UNRESTRICTED",
      tables: [{ table: "guestbook" }],
    });
    assert.equal(result.success, false);
    if (!result.success) {
      const ackIssue = result.error.issues.find((i) =>
        i.path.includes("i_understand_this_is_unrestricted"),
      );
      assert.ok(ackIssue, "expected an ACK refinement issue");
      assert.match(ackIssue!.message, /must be true/);
    }
  });

  it("rejects UNRESTRICTED template when ACK is false", () => {
    const result = setupRlsRefined.safeParse({
      project_id: "proj-001",
      template: "public_read_write_UNRESTRICTED",
      tables: [{ table: "guestbook" }],
      i_understand_this_is_unrestricted: false,
    });
    assert.equal(result.success, false);
  });

  it("accepts UNRESTRICTED template with ACK true", () => {
    const result = setupRlsRefined.safeParse({
      project_id: "proj-001",
      template: "public_read_write_UNRESTRICTED",
      tables: [{ table: "guestbook" }],
      i_understand_this_is_unrestricted: true,
    });
    assert.equal(result.success, true);
  });

  it("accepts non-UNRESTRICTED template without the ACK flag", () => {
    const result = setupRlsRefined.safeParse({
      project_id: "proj-001",
      template: "public_read_authenticated_write",
      tables: [{ table: "announcements" }],
    });
    assert.equal(result.success, true);
  });

  it("accepts user_owns_rows with owner_column", () => {
    const result = setupRlsRefined.safeParse({
      project_id: "proj-001",
      template: "user_owns_rows",
      tables: [{ table: "todos", owner_column: "user_id" }],
    });
    assert.equal(result.success, true);
  });

  it("ignores the ACK flag when template is not UNRESTRICTED", () => {
    const result = setupRlsRefined.safeParse({
      project_id: "proj-001",
      template: "user_owns_rows",
      tables: [{ table: "todos", owner_column: "user_id" }],
      i_understand_this_is_unrestricted: true,
    });
    assert.equal(result.success, true);
  });
});

describe("handleSetupRls", () => {
  it("forwards the ACK flag in the POST body when template is UNRESTRICTED", async () => {
    let capturedBody: string | undefined;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response(
        JSON.stringify({
          status: "ok",
          template: "public_read_write_UNRESTRICTED",
          tables: ["guestbook"],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const res = await handleSetupRls({
      project_id: "proj-001",
      template: "public_read_write_UNRESTRICTED",
      tables: [{ table: "guestbook" }],
      i_understand_this_is_unrestricted: true,
    });

    assert.equal(res.isError, undefined);
    const parsed = JSON.parse(capturedBody!);
    assert.equal(parsed.i_understand_this_is_unrestricted, true);
    assert.equal(parsed.template, "public_read_write_UNRESTRICTED");
  });

  it("returns an isError result when UNRESTRICTED is requested without ACK", async () => {
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const res = await handleSetupRls({
      project_id: "proj-001",
      template: "public_read_write_UNRESTRICTED",
      tables: [{ table: "guestbook" }],
    });

    assert.equal(res.isError, true);
    assert.equal(fetchCalled, false, "must not call gateway on local validation failure");
    assert.match(res.content[0].text, /i_understand_this_is_unrestricted/);
  });

  it("does not send the ACK field when the caller omits it", async () => {
    let capturedBody: string | undefined;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response(
        JSON.stringify({
          status: "ok",
          template: "public_read_authenticated_write",
          tables: ["announcements"],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    await handleSetupRls({
      project_id: "proj-001",
      template: "public_read_authenticated_write",
      tables: [{ table: "announcements" }],
    });

    const parsed = JSON.parse(capturedBody!);
    assert.equal(Object.prototype.hasOwnProperty.call(parsed, "i_understand_this_is_unrestricted"), false);
  });
});
