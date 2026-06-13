import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleGetSchema } from "./get-schema.js";
import { saveProject } from "../keystore.js";
import { _resetSdk } from "../sdk.js";

const originalFetch = globalThis.fetch;
let tempDir: string;
let storePath: string;

beforeEach(() => {
  _resetSdk();
  tempDir = mkdtempSync(join(tmpdir(), "run402-schema-test-"));
  storePath = join(tempDir, "projects.json");
  process.env.RUN402_CONFIG_DIR = tempDir;
  process.env.RUN402_API_BASE = "https://test-api.run402.com";
});

afterEach(() => {
  _resetSdk();
  globalThis.fetch = originalFetch;
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.RUN402_CONFIG_DIR;
  delete process.env.RUN402_API_BASE;
});

describe("get_schema tool", () => {
  // Save a project and stub fetch to return a fixed schema body.
  function stub(body: unknown) {
    saveProject(
      "proj-1",
      { anon_key: "ak", service_key: "sk", tier: "prototype", lease_expires_at: "2026-03-06T00:00:00Z" },
      storePath,
    );
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;
  }

  it("renders FK targets (constraint definition), not just type + name", async () => {
    // Anticipatory: an agent needs the REFERENCES target to reason about joins
    // without a follow-up query. The old formatter showed only `FOREIGN KEY(name)`.
    stub({
      schema: "p0001",
      tables: [
        {
          name: "orders",
          columns: [
            { name: "id", type: "uuid", nullable: false, default_value: null },
            { name: "user_id", type: "uuid", nullable: false, default_value: null },
          ],
          constraints: [
            { name: "orders_user_fk", type: "FOREIGN KEY", definition: "FOREIGN KEY (user_id) REFERENCES users(id)" },
          ],
          rls_enabled: false,
          policies: [],
        },
      ],
    });

    const result = await handleGetSchema({ project_id: "proj-1" });
    const text = result.content[0]!.text;
    assert.ok(text.includes("orders_user_fk"));
    assert.ok(text.includes("REFERENCES users(id)"), "FK target must be visible for join reasoning");
  });

  it("renders RLS policy USING / WITH CHECK predicates, not just the name", async () => {
    // Anticipatory: the predicate is what determines which rows are visible/writable.
    stub({
      schema: "p0001",
      tables: [
        {
          name: "docs",
          columns: [{ name: "id", type: "uuid", nullable: false, default_value: null }],
          constraints: [],
          rls_enabled: true,
          policies: [
            {
              name: "owner_only",
              command: "ALL",
              using_expression: "(owner_id = auth.uid())",
              check_expression: "(owner_id = auth.uid())",
            },
          ],
        },
      ],
    });

    const result = await handleGetSchema({ project_id: "proj-1" });
    const text = result.content[0]!.text;
    assert.ok(text.includes("🔒 RLS"));
    assert.ok(text.includes("owner_only"));
    assert.ok(text.includes("USING (owner_id = auth.uid())"), "RLS USING predicate must be visible");
    assert.ok(text.includes("WITH CHECK (owner_id = auth.uid())"), "RLS WITH CHECK predicate must be visible");
  });

  it("omits a null check_expression cleanly", async () => {
    stub({
      schema: "p0001",
      tables: [
        {
          name: "logs",
          columns: [{ name: "id", type: "uuid", nullable: false, default_value: null }],
          constraints: [],
          rls_enabled: true,
          policies: [{ name: "read_all", command: "SELECT", using_expression: "true", check_expression: null }],
        },
      ],
    });

    const result = await handleGetSchema({ project_id: "proj-1" });
    const text = result.content[0]!.text;
    assert.ok(text.includes("USING true"));
    assert.ok(!text.includes("WITH CHECK"), "a null check_expression must not render");
  });
});
