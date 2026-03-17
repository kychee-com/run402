import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateBundle, BundleError } from "./bundle.js";
import type { BundleRequest } from "./bundle.js";

describe("bundle validation — project_id", () => {
  it("rejects missing project_id", () => {
    assert.throws(
      () => validateBundle({} as BundleRequest),
      (err: BundleError) => err.statusCode === 400 && err.message.includes("project_id"),
    );
  });

  it("rejects non-string project_id", () => {
    assert.throws(
      () => validateBundle({ project_id: 123 } as unknown as BundleRequest),
      (err: BundleError) => err.statusCode === 400,
    );
  });

  it("rejects invalid project_id format", () => {
    assert.throws(
      () => validateBundle({ project_id: "bad_format" }),
      (err: BundleError) => err.statusCode === 400 && err.message.includes("format"),
    );
  });

  it("rejects project_id without prj_ prefix", () => {
    assert.throws(
      () => validateBundle({ project_id: "123_456" }),
      (err: BundleError) => err.statusCode === 400,
    );
  });

  it("accepts valid project_id", () => {
    assert.doesNotThrow(() => validateBundle({ project_id: "prj_123_1" }));
  });
});

describe("bundle validation — migrations", () => {
  it("rejects non-string migrations", () => {
    assert.throws(
      () => validateBundle({ project_id: "prj_123_1", migrations: 42 as unknown as string }),
      (err: BundleError) => err.statusCode === 400,
    );
  });

  it("rejects oversized migrations", () => {
    assert.throws(
      () => validateBundle({ project_id: "prj_123_1", migrations: "x".repeat(1_000_001) }),
      (err: BundleError) => err.statusCode === 400 && err.message.includes("1MB"),
    );
  });

  it("rejects blocked SQL patterns", () => {
    const blocked = [
      "CREATE EXTENSION pgcrypto",
      "ALTER SYSTEM SET work_mem",
      "SET search_path TO public",
      "CREATE SCHEMA evil",
      "DROP SCHEMA p0001",
      "GRANT ALL ON TABLE foo TO evil",
      "REVOKE SELECT ON TABLE foo FROM anon",
      "CREATE ROLE hacker",
    ];
    for (const sql of blocked) {
      assert.throws(
        () => validateBundle({ project_id: "prj_123_1", migrations: sql }),
        (err: BundleError) => err.statusCode === 403,
        `Should block: ${sql}`,
      );
    }
  });

  it("accepts valid SQL", () => {
    assert.doesNotThrow(() =>
      validateBundle({
        project_id: "prj_123_1",
        migrations: "CREATE TABLE users (id uuid PRIMARY KEY, email text);",
      }),
    );
  });
});

describe("bundle validation — rls", () => {
  it("rejects missing template", () => {
    assert.throws(
      () => validateBundle({ project_id: "prj_123_1", rls: { template: "", tables: [] } }),
      (err: BundleError) => err.statusCode === 400,
    );
  });

  it("rejects invalid template", () => {
    assert.throws(
      () => validateBundle({ project_id: "prj_123_1", rls: { template: "evil", tables: [] } }),
      (err: BundleError) => err.statusCode === 400 && err.message.includes("Invalid RLS"),
    );
  });

  it("rejects user_owns_rows without owner_column", () => {
    assert.throws(
      () =>
        validateBundle({
          project_id: "prj_123_1",
          rls: { template: "user_owns_rows", tables: [{ table: "posts" }] },
        }),
      (err: BundleError) => err.statusCode === 400 && err.message.includes("owner_column"),
    );
  });

  it("accepts valid RLS config", () => {
    assert.doesNotThrow(() =>
      validateBundle({
        project_id: "prj_123_1",
        rls: {
          template: "user_owns_rows",
          tables: [{ table: "posts", owner_column: "user_id" }],
        },
      }),
    );
  });
});

describe("bundle validation — secrets", () => {
  it("rejects non-array secrets", () => {
    assert.throws(
      () => validateBundle({ project_id: "prj_123_1", secrets: "bad" as unknown as [] }),
      (err: BundleError) => err.statusCode === 400,
    );
  });

  it("rejects invalid secret key format", () => {
    assert.throws(
      () => validateBundle({ project_id: "prj_123_1", secrets: [{ key: "lowercase", value: "x" }] }),
      (err: BundleError) => err.statusCode === 400 && err.message.includes("uppercase"),
    );
  });

  it("rejects missing secret value", () => {
    assert.throws(
      () =>
        validateBundle({
          project_id: "prj_123_1",
          secrets: [{ key: "MY_KEY", value: undefined as unknown as string }],
        }),
      (err: BundleError) => err.statusCode === 400 && err.message.includes("value"),
    );
  });

  it("accepts valid secrets", () => {
    assert.doesNotThrow(() =>
      validateBundle({
        project_id: "prj_123_1",
        secrets: [{ key: "STRIPE_KEY", value: "sk_test_123" }],
      }),
    );
  });
});

describe("bundle validation — functions", () => {
  it("rejects non-array functions", () => {
    assert.throws(
      () => validateBundle({ project_id: "prj_123_1", functions: "bad" as unknown as [] }),
      (err: BundleError) => err.statusCode === 400,
    );
  });

  it("rejects invalid function name", () => {
    const invalid = ["Hello", "-start", "my_func", ""];
    for (const name of invalid) {
      assert.throws(
        () => validateBundle({ project_id: "prj_123_1", functions: [{ name, code: "x" }] }),
        (err: BundleError) => err.statusCode === 400,
        `Should reject function name: '${name}'`,
      );
    }
  });

  it("rejects missing code", () => {
    assert.throws(
      () =>
        validateBundle({
          project_id: "prj_123_1",
          functions: [{ name: "hello", code: "" }],
        }),
      (err: BundleError) => err.statusCode === 400 && err.message.includes("code"),
    );
  });

  it("accepts valid functions", () => {
    assert.doesNotThrow(() =>
      validateBundle({
        project_id: "prj_123_1",
        functions: [{ name: "checkout", code: 'export default async (req) => new Response("ok")' }],
      }),
    );
  });
});

describe("bundle validation — files", () => {
  it("rejects empty files array", () => {
    assert.throws(
      () => validateBundle({ project_id: "prj_123_1", files: [] }),
      (err: BundleError) => err.statusCode === 400 && err.message.includes("non-empty"),
    );
  });

  it("rejects missing file path", () => {
    assert.throws(
      () => validateBundle({ project_id: "prj_123_1", files: [{ file: "", data: "hi" }] }),
      (err: BundleError) => err.statusCode === 400,
    );
  });

  it("rejects invalid encoding", () => {
    assert.throws(
      () =>
        validateBundle({
          project_id: "prj_123_1",
          files: [{ file: "index.html", data: "hi", encoding: "gzip" as "utf-8" }],
        }),
      (err: BundleError) => err.statusCode === 400 && err.message.includes("encoding"),
    );
  });

  it("accepts valid site files", () => {
    assert.doesNotThrow(() =>
      validateBundle({
        project_id: "prj_123_1",
        files: [
          { file: "index.html", data: "<h1>hello</h1>" },
          { file: "style.css", data: "body { color: red; }" },
        ],
      }),
    );
  });
});

describe("bundle validation — subdomain", () => {
  it("rejects reserved subdomain", () => {
    assert.throws(
      () => validateBundle({ project_id: "prj_123_1", subdomain: "api" }),
      (err: BundleError) => err.statusCode === 400 && err.message.includes("reserved"),
    );
  });

  it("rejects too-short subdomain", () => {
    assert.throws(
      () => validateBundle({ project_id: "prj_123_1", subdomain: "ab" }),
      (err: BundleError) => err.statusCode === 400,
    );
  });

  it("accepts valid subdomain", () => {
    assert.doesNotThrow(() => validateBundle({ project_id: "prj_123_1", subdomain: "my-cool-app" }));
  });
});

describe("bundle validation — full bundle", () => {
  it("accepts a complete bundle with all fields", () => {
    assert.doesNotThrow(() =>
      validateBundle({
        project_id: "prj_1741340000_42",
        migrations:
          "CREATE TABLE concepts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text);",
        rls: {
          template: "public_read",
          tables: [{ table: "concepts" }],
        },
        secrets: [{ key: "OPENAI_API_KEY", value: "sk-test" }],
        functions: [
          {
            name: "embed",
            code: 'export default async (req) => new Response("ok")',
          },
        ],
        files: [{ file: "index.html", data: "<h1>Cosmic Forge</h1>" }],
        subdomain: "cosmic",
      }),
    );
  });

  it("accepts minimal bundle (project_id only)", () => {
    assert.doesNotThrow(() => validateBundle({ project_id: "prj_123_1" }));
  });
});
