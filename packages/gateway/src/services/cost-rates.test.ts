import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  getCostRate,
  getAllCostRates,
  updateCostRates,
  __resetCostRatesCacheForTest,
  __setCostRatesQueryForTest,
  type CostRatesQueryFn,
} from "./cost-rates.js";

/**
 * Capturing query mock — lets tests observe what SQL was run and inject
 * canned responses without touching a real DB.
 */
function makeMockQuery(responses: Array<{ rows: unknown[] }>): {
  query: CostRatesQueryFn;
  calls: Array<{ sql: string; params?: unknown[] }>;
} {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  let callIndex = 0;
  const query: CostRatesQueryFn = async (sql: string, params?: unknown[]) => {
    calls.push({ sql, params });
    const r = responses[callIndex++];
    if (!r) throw new Error(`mock query exhausted at call ${callIndex}, sql=${sql}`);
    return r;
  };
  return { query, calls };
}

describe("cost-rates service", () => {
  beforeEach(() => {
    __resetCostRatesCacheForTest();
  });

  describe("getCostRate", () => {
    it("reads a single rate from the DB on cache miss", async () => {
      const { query, calls } = makeMockQuery([
        { rows: [{ key: "ses_per_email_usd_micros", value_usd_micros: "100", unit: "per_email", source: "seed", updated_at: new Date() }] },
      ]);
      __setCostRatesQueryForTest(query);
      const value = await getCostRate("ses_per_email_usd_micros");
      assert.equal(value, 100);
      assert.equal(calls.length, 1);
      assert.match(calls[0].sql, /SELECT .* FROM internal\.cost_rates/i);
    });

    it("returns cached value on cache hit (no DB call)", async () => {
      const { query, calls } = makeMockQuery([
        { rows: [{ key: "ses_per_email_usd_micros", value_usd_micros: "100", unit: "per_email", source: "seed", updated_at: new Date() }] },
      ]);
      __setCostRatesQueryForTest(query);
      await getCostRate("ses_per_email_usd_micros");
      await getCostRate("ses_per_email_usd_micros");
      assert.equal(calls.length, 1, "second call should hit the cache, not the DB");
    });

    it("throws on unknown key", async () => {
      const { query } = makeMockQuery([{ rows: [] }]);
      __setCostRatesQueryForTest(query);
      await assert.rejects(
        () => getCostRate("no_such_rate"),
        /unknown cost rate/i,
      );
    });

    it("handles BIGINT returned as string", async () => {
      const { query } = makeMockQuery([
        { rows: [{ key: "kms_key_monthly_usd_micros", value_usd_micros: "1000000", unit: "per_key_month", source: "seed", updated_at: new Date() }] },
      ]);
      __setCostRatesQueryForTest(query);
      const value = await getCostRate("kms_key_monthly_usd_micros");
      assert.equal(value, 1000000);
      assert.equal(typeof value, "number");
    });
  });

  describe("getAllCostRates", () => {
    it("returns all rates as a keyed object", async () => {
      const { query } = makeMockQuery([
        {
          rows: [
            { key: "ses_per_email_usd_micros", value_usd_micros: "100", unit: "per_email", source: "seed", updated_at: new Date("2026-04-01") },
            { key: "lambda_request_usd_micros", value_usd_micros: "200", unit: "per_request", source: "seed", updated_at: new Date("2026-04-01") },
          ],
        },
      ]);
      __setCostRatesQueryForTest(query);
      const all = await getAllCostRates();
      assert.equal(all["ses_per_email_usd_micros"]?.value, 100);
      assert.equal(all["ses_per_email_usd_micros"]?.unit, "per_email");
      assert.equal(all["ses_per_email_usd_micros"]?.source, "seed");
      assert.ok(all["ses_per_email_usd_micros"]?.updated_at instanceof Date);
      assert.equal(all["lambda_request_usd_micros"]?.value, 200);
    });

    it("returns empty object when table is empty", async () => {
      const { query } = makeMockQuery([{ rows: [] }]);
      __setCostRatesQueryForTest(query);
      const all = await getAllCostRates();
      assert.deepEqual(all, {});
    });
  });

  describe("updateCostRates", () => {
    it("updates multiple rates atomically in a single UPDATE per key", async () => {
      const { query, calls } = makeMockQuery([
        // pre-load into cache
        { rows: [
          { key: "ses_per_email_usd_micros", value_usd_micros: "100", unit: "per_email", source: "seed", updated_at: new Date() },
          { key: "lambda_request_usd_micros", value_usd_micros: "200", unit: "per_request", source: "seed", updated_at: new Date() },
        ] },
        // updates
        { rows: [] },
        { rows: [] },
      ]);
      __setCostRatesQueryForTest(query);
      await getAllCostRates();
      await updateCostRates(
        { ses_per_email_usd_micros: 110, lambda_request_usd_micros: 210 },
        "aws-pricing-api",
      );
      const updateCalls = calls.filter((c) => /UPDATE internal\.cost_rates/i.test(c.sql));
      assert.equal(updateCalls.length, 2);
      for (const c of updateCalls) {
        assert.match(c.sql, /SET value_usd_micros/);
        assert.match(c.sql, /source\s*=/);
        assert.match(c.sql, /updated_at\s*=\s*NOW\(\)/);
      }
    });

    it("invalidates the in-process cache after update", async () => {
      const { query, calls } = makeMockQuery([
        // first read
        { rows: [{ key: "ses_per_email_usd_micros", value_usd_micros: "100", unit: "per_email", source: "seed", updated_at: new Date() }] },
        // update
        { rows: [] },
        // re-read after invalidation
        { rows: [{ key: "ses_per_email_usd_micros", value_usd_micros: "110", unit: "per_email", source: "aws-pricing-api", updated_at: new Date() }] },
      ]);
      __setCostRatesQueryForTest(query);
      const before = await getCostRate("ses_per_email_usd_micros");
      assert.equal(before, 100);
      await updateCostRates({ ses_per_email_usd_micros: 110 }, "aws-pricing-api");
      const after = await getCostRate("ses_per_email_usd_micros");
      assert.equal(after, 110, "cache should have been invalidated so the new value is read");
      // 3 calls: initial read, update, re-read
      assert.equal(calls.length, 3);
    });

    it("records source on update", async () => {
      const { query, calls } = makeMockQuery([
        { rows: [] },
      ]);
      __setCostRatesQueryForTest(query);
      await updateCostRates({ ses_per_email_usd_micros: 150 }, "manual");
      const updateCall = calls.find((c) => /UPDATE internal\.cost_rates/i.test(c.sql));
      assert.ok(updateCall);
      // source should be in the params, not inlined into SQL
      assert.ok(updateCall.params?.includes("manual"), "source should be passed as a param");
    });

    it("no-op on empty updates object", async () => {
      const { query, calls } = makeMockQuery([]);
      __setCostRatesQueryForTest(query);
      await updateCostRates({}, "noop");
      assert.equal(calls.length, 0);
    });
  });
});
