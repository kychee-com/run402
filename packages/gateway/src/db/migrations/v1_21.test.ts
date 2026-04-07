import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { applyV121 } from "./v1_21.js";

interface CapturedQuery { text: string }

function makeCapturingClient() {
  const queries: CapturedQuery[] = [];
  return {
    queries,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    query: async (q: any) => {
      const text = typeof q === "string" ? q : q.text;
      queries.push({ text });
      return { rows: [] };
    },
  };
}

describe("v1.21 migration — admin-wallet-breakdown (finance dashboard)", () => {
  it("creates internal.cost_rates with required columns", async () => {
    const client = makeCapturingClient();
    await applyV121(client.query);
    const all = client.queries.map((q) => q.text).join("\n");
    assert.match(all, /CREATE TABLE IF NOT EXISTS internal\.cost_rates/);
    for (const col of [
      "key ",
      "value_usd_micros ",
      "unit ",
      "updated_at ",
      "source ",
    ]) {
      assert.ok(all.includes(col), `cost_rates missing column: ${col}`);
    }
    // Primary key on key
    assert.match(all, /key TEXT PRIMARY KEY/);
  });

  it("seeds cost_rates with 6 default rows using ON CONFLICT DO NOTHING", async () => {
    const client = makeCapturingClient();
    await applyV121(client.query);
    const all = client.queries.map((q) => q.text).join("\n");
    assert.match(all, /INSERT INTO internal\.cost_rates/);
    assert.match(all, /ON CONFLICT\s*\(key\)\s*DO NOTHING/);
    // All 6 expected rate keys must appear in the seed
    for (const key of [
      "ses_per_email_usd_micros",
      "lambda_request_usd_micros",
      "lambda_gb_second_usd_micros",
      "s3_gb_month_usd_micros",
      "kms_key_monthly_usd_micros",
      "kms_sign_per_op_usd_micros",
    ]) {
      assert.ok(all.includes(key), `cost_rates seed missing key: ${key}`);
    }
  });

  it("seeds cost_rates with the correct default values", async () => {
    const client = makeCapturingClient();
    await applyV121(client.query);
    const all = client.queries.map((q) => q.text).join("\n");
    // Values per the spec scenario "Table created and seeded on first boot"
    // Each key/value pair should appear in a row like ('ses_per_email_usd_micros', 100, ...)
    assert.match(all, /'ses_per_email_usd_micros'\s*,\s*100\s*,/);
    assert.match(all, /'lambda_request_usd_micros'\s*,\s*200\s*,/);
    assert.match(all, /'lambda_gb_second_usd_micros'\s*,\s*17\s*,/);
    assert.match(all, /'s3_gb_month_usd_micros'\s*,\s*23000\s*,/);
    assert.match(all, /'kms_key_monthly_usd_micros'\s*,\s*1000000\s*,/);
    assert.match(all, /'kms_sign_per_op_usd_micros'\s*,\s*3\s*,/);
  });

  it("seeded rows are marked source='seed'", async () => {
    const client = makeCapturingClient();
    await applyV121(client.query);
    const all = client.queries.map((q) => q.text).join("\n");
    // Every seed value row should end in , 'seed')
    // We check that 'seed' appears at least 6 times (one per row)
    const seedCount = (all.match(/'seed'/g) || []).length;
    assert.ok(seedCount >= 6, `expected >=6 'seed' markers, got ${seedCount}`);
  });

  it("creates internal.aws_cost_cache with required columns and composite PK", async () => {
    const client = makeCapturingClient();
    await applyV121(client.query);
    const all = client.queries.map((q) => q.text).join("\n");
    assert.match(all, /CREATE TABLE IF NOT EXISTS internal\.aws_cost_cache/);
    for (const col of [
      "day ",
      "service_category ",
      "cost_usd_micros ",
      "fetched_at ",
    ]) {
      assert.ok(all.includes(col), `aws_cost_cache missing column: ${col}`);
    }
    assert.match(all, /PRIMARY KEY\s*\(\s*day\s*,\s*service_category\s*\)/);
  });

  it("creates idx_aws_cost_cache_day index for window range queries", async () => {
    const client = makeCapturingClient();
    await applyV121(client.query);
    const all = client.queries.map((q) => q.text).join("\n");
    assert.match(
      all,
      /CREATE INDEX IF NOT EXISTS\s+idx_aws_cost_cache_day\s+ON internal\.aws_cost_cache\s*\(day\)/,
    );
  });

  it("is idempotent — every CREATE TABLE uses IF NOT EXISTS, every CREATE INDEX uses IF NOT EXISTS, seed uses ON CONFLICT DO NOTHING", async () => {
    const client = makeCapturingClient();
    await applyV121(client.query);
    for (const { text } of client.queries) {
      if (/CREATE TABLE/.test(text)) {
        assert.match(text, /CREATE TABLE IF NOT EXISTS/, `non-idempotent CREATE TABLE: ${text}`);
      }
      if (/CREATE\s+(UNIQUE\s+)?INDEX/.test(text)) {
        assert.match(text, /CREATE\s+(UNIQUE\s+)?INDEX IF NOT EXISTS/, `non-idempotent CREATE INDEX: ${text}`);
      }
      if (/INSERT INTO internal\.cost_rates/.test(text)) {
        assert.match(text, /ON CONFLICT\s*\(key\)\s*DO NOTHING/, `non-idempotent seed INSERT: ${text}`);
      }
    }
  });

  it("does NOT modify any existing tables (no ALTER TABLE)", async () => {
    const client = makeCapturingClient();
    await applyV121(client.query);
    for (const { text } of client.queries) {
      assert.doesNotMatch(text, /ALTER TABLE/, `v1.21 must not ALTER any table, found: ${text}`);
    }
  });
});
