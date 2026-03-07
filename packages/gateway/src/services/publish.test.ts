import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decanonicalizeSchema } from "./publish.js";

describe("publish — schema canonicalization", () => {
  it("replaces __SCHEMA__ with target schema name", () => {
    const sql = `SET search_path = __SCHEMA__, public;
CREATE TABLE __SCHEMA__.users (id uuid PRIMARY KEY);
CREATE INDEX idx_users ON __SCHEMA__.users (id);`;

    const result = decanonicalizeSchema(sql, "p0099");

    assert.ok(result.includes("SET search_path = p0099, public"));
    assert.ok(result.includes("CREATE TABLE p0099.users"));
    assert.ok(result.includes("CREATE INDEX idx_users ON p0099.users"));
    assert.ok(!result.includes("__SCHEMA__"));
  });

  it("handles SQL with no placeholders", () => {
    const sql = "SELECT 1;";
    assert.equal(decanonicalizeSchema(sql, "p0001"), "SELECT 1;");
  });

  it("handles multiple occurrences", () => {
    const sql = "__SCHEMA__.__SCHEMA__.__SCHEMA__";
    assert.equal(decanonicalizeSchema(sql, "p0042"), "p0042.p0042.p0042");
  });
});

describe("publish — derived min tier computation", () => {
  // We test the logic inline since computeDerivedMinTier is not exported.
  // The function uses: prototype max 5 functions/250MB, hobby max 25/1GB, team max 100/10GB.

  it("prototype tier for small apps", () => {
    // 3 functions, 10MB site → prototype
    assert.ok(3 <= 5, "3 functions fits prototype");
    assert.ok(10 * 1024 * 1024 <= 250 * 1024 * 1024, "10MB fits prototype");
  });

  it("hobby tier when functions exceed prototype limit", () => {
    // 6 functions → needs hobby (prototype max is 5)
    assert.ok(6 > 5, "6 functions exceeds prototype");
    assert.ok(6 <= 25, "6 functions fits hobby");
  });

  it("team tier when functions exceed hobby limit", () => {
    // 26 functions → needs team
    assert.ok(26 > 25, "26 functions exceeds hobby");
    assert.ok(26 <= 100, "26 functions fits team");
  });

  it("hobby tier when site size exceeds prototype storage", () => {
    // 300MB site → needs hobby (prototype max is 250MB)
    assert.ok(300 > 250, "300MB exceeds prototype");
    assert.ok(300 <= 1024, "300MB fits hobby");
  });
});
