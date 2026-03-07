import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateBundle, BundleError } from "./bundle.js";
import type { BundleRequest } from "./bundle.js";

describe("bundle validation — name", () => {
  it("rejects missing name", () => {
    assert.throws(
      () => validateBundle({} as BundleRequest),
      (err: BundleError) => err.statusCode === 400 && err.message.includes("name"),
    );
  });

  it("rejects non-string name", () => {
    assert.throws(
      () => validateBundle({ name: 123 } as unknown as BundleRequest),
      (err: BundleError) => err.statusCode === 400,
    );
  });

  it("accepts valid name", () => {
    assert.doesNotThrow(() => validateBundle({ name: "my-app" }));
  });
});

describe("bundle validation — tier", () => {
  it("rejects unknown tier", () => {
    assert.throws(
      () => validateBundle({ name: "app", tier: "mega" as "prototype" }),
      (err: BundleError) => err.statusCode === 400 && err.message.includes("Unknown tier"),
    );
  });

  it("accepts valid tiers", () => {
    for (const tier of ["prototype", "hobby", "team"] as const) {
      assert.doesNotThrow(() => validateBundle({ name: "app", tier }));
    }
  });

  it("accepts missing tier (defaults later)", () => {
    assert.doesNotThrow(() => validateBundle({ name: "app" }));
  });
});

describe("bundle validation — migrations", () => {
  it("rejects non-string migrations", () => {
    assert.throws(
      () => validateBundle({ name: "app", migrations: 42 as unknown as string }),
      (err: BundleError) => err.statusCode === 400,
    );
  });

  it("rejects oversized migrations", () => {
    assert.throws(
      () => validateBundle({ name: "app", migrations: "x".repeat(1_000_001) }),
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
        () => validateBundle({ name: "app", migrations: sql }),
        (err: BundleError) => err.statusCode === 403,
        `Should block: ${sql}`,
      );
    }
  });

  it("accepts valid SQL", () => {
    assert.doesNotThrow(() =>
      validateBundle({
        name: "app",
        migrations: "CREATE TABLE users (id uuid PRIMARY KEY, email text);",
      }),
    );
  });
});

describe("bundle validation — rls", () => {
  it("rejects missing template", () => {
    assert.throws(
      () => validateBundle({ name: "app", rls: { template: "", tables: [] } }),
      (err: BundleError) => err.statusCode === 400,
    );
  });

  it("rejects invalid template", () => {
    assert.throws(
      () => validateBundle({ name: "app", rls: { template: "evil", tables: [] } }),
      (err: BundleError) => err.statusCode === 400 && err.message.includes("Invalid RLS"),
    );
  });

  it("rejects user_owns_rows without owner_column", () => {
    assert.throws(
      () =>
        validateBundle({
          name: "app",
          rls: { template: "user_owns_rows", tables: [{ table: "posts" }] },
        }),
      (err: BundleError) => err.statusCode === 400 && err.message.includes("owner_column"),
    );
  });

  it("accepts valid RLS config", () => {
    assert.doesNotThrow(() =>
      validateBundle({
        name: "app",
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
      () => validateBundle({ name: "app", secrets: "bad" as unknown as [] }),
      (err: BundleError) => err.statusCode === 400,
    );
  });

  it("rejects invalid secret key format", () => {
    assert.throws(
      () => validateBundle({ name: "app", secrets: [{ key: "lowercase", value: "x" }] }),
      (err: BundleError) => err.statusCode === 400 && err.message.includes("uppercase"),
    );
  });

  it("rejects missing secret value", () => {
    assert.throws(
      () =>
        validateBundle({
          name: "app",
          secrets: [{ key: "MY_KEY", value: undefined as unknown as string }],
        }),
      (err: BundleError) => err.statusCode === 400 && err.message.includes("value"),
    );
  });

  it("accepts valid secrets", () => {
    assert.doesNotThrow(() =>
      validateBundle({
        name: "app",
        secrets: [{ key: "STRIPE_KEY", value: "sk_test_123" }],
      }),
    );
  });
});

describe("bundle validation — functions", () => {
  it("rejects non-array functions", () => {
    assert.throws(
      () => validateBundle({ name: "app", functions: "bad" as unknown as [] }),
      (err: BundleError) => err.statusCode === 400,
    );
  });

  it("rejects invalid function name", () => {
    const invalid = ["Hello", "-start", "my_func", ""];
    for (const name of invalid) {
      assert.throws(
        () => validateBundle({ name: "app", functions: [{ name, code: "x" }] }),
        (err: BundleError) => err.statusCode === 400,
        `Should reject function name: '${name}'`,
      );
    }
  });

  it("rejects missing code", () => {
    assert.throws(
      () =>
        validateBundle({
          name: "app",
          functions: [{ name: "hello", code: "" }],
        }),
      (err: BundleError) => err.statusCode === 400 && err.message.includes("code"),
    );
  });

  it("accepts valid functions", () => {
    assert.doesNotThrow(() =>
      validateBundle({
        name: "app",
        functions: [{ name: "checkout", code: 'export default async (req) => new Response("ok")' }],
      }),
    );
  });
});

describe("bundle validation — site", () => {
  it("rejects empty site array", () => {
    assert.throws(
      () => validateBundle({ name: "app", site: [] }),
      (err: BundleError) => err.statusCode === 400 && err.message.includes("non-empty"),
    );
  });

  it("rejects missing file path", () => {
    assert.throws(
      () => validateBundle({ name: "app", site: [{ file: "", data: "hi" }] }),
      (err: BundleError) => err.statusCode === 400,
    );
  });

  it("rejects invalid encoding", () => {
    assert.throws(
      () =>
        validateBundle({
          name: "app",
          site: [{ file: "index.html", data: "hi", encoding: "gzip" as "utf-8" }],
        }),
      (err: BundleError) => err.statusCode === 400 && err.message.includes("encoding"),
    );
  });

  it("accepts valid site files", () => {
    assert.doesNotThrow(() =>
      validateBundle({
        name: "app",
        site: [
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
      () => validateBundle({ name: "app", subdomain: "api" }),
      (err: BundleError) => err.statusCode === 400 && err.message.includes("reserved"),
    );
  });

  it("rejects too-short subdomain", () => {
    assert.throws(
      () => validateBundle({ name: "app", subdomain: "ab" }),
      (err: BundleError) => err.statusCode === 400,
    );
  });

  it("accepts valid subdomain", () => {
    assert.doesNotThrow(() => validateBundle({ name: "app", subdomain: "my-cool-app" }));
  });
});

describe("bundle validation — full bundle", () => {
  it("accepts a complete bundle with all fields", () => {
    assert.doesNotThrow(() =>
      validateBundle({
        name: "cosmic-forge",
        tier: "hobby",
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
        site: [{ file: "index.html", data: "<h1>Cosmic Forge</h1>" }],
        subdomain: "cosmic",
      }),
    );
  });

  it("accepts minimal bundle (name only)", () => {
    assert.doesNotThrow(() => validateBundle({ name: "bare-project" }));
  });
});
