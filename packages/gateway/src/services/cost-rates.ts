/**
 * cost-rates service
 *
 * Reads and updates AWS pricing constants stored in `internal.cost_rates`.
 * Used by the admin finance dashboard to compute counter-derived direct
 * costs (SES $/email, Lambda $/request, etc.) without redeploying when
 * AWS changes prices.
 *
 * Caching: a 5-minute in-process cache keyed by rate key. The cache is
 * invalidated on any `updateCostRates` call. Tests can reset via
 * `__resetCostRatesCacheForTest()` and inject a mock query via
 * `__setCostRatesQueryForTest()`.
 */

import { pool } from "../db/pool.js";
import { sql } from "../db/sql.js";

export type CostRatesQueryFn = (sqlText: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;

export interface CostRateRow {
  value: number;
  unit: string;
  source: string;
  updated_at: Date;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface CacheEntry {
  rows: Record<string, CostRateRow>;
  expires_at: number;
}

let cache: CacheEntry | null = null;

// Default query fn uses the real pool. Tests override via __setCostRatesQueryForTest.
let queryFn: CostRatesQueryFn = async (sqlText, params) => {
  return pool.query(sql(sqlText), params) as unknown as { rows: unknown[] };
};

/** Test hook: reset the module cache between tests. */
export function __resetCostRatesCacheForTest(): void {
  cache = null;
}

/** Test hook: inject a mock query function. Call with `null` to restore the default pool-backed one. */
export function __setCostRatesQueryForTest(fn: CostRatesQueryFn | null): void {
  if (fn === null) {
    queryFn = async (sqlText, params) => {
      return pool.query(sql(sqlText), params) as unknown as { rows: unknown[] };
    };
  } else {
    queryFn = fn;
  }
}

interface CostRateDbRow {
  key: string;
  value_usd_micros: string | number;
  unit: string;
  source: string;
  updated_at: Date | string;
}

/**
 * Load all rates from the DB and populate the cache. Called on cache miss.
 */
async function loadAllRatesIntoCache(): Promise<Record<string, CostRateRow>> {
  const result = await queryFn(
    `SELECT key, value_usd_micros, unit, source, updated_at FROM internal.cost_rates`,
  );
  const rows: Record<string, CostRateRow> = {};
  for (const rRaw of result.rows as CostRateDbRow[]) {
    // BIGINT is returned as string by node-postgres; coerce to number.
    // Safe because cost rates are small (< 2^53).
    const raw = rRaw.value_usd_micros;
    const value = typeof raw === "string" ? Number(raw) : Number(raw);
    rows[rRaw.key] = {
      value,
      unit: rRaw.unit,
      source: rRaw.source,
      updated_at: rRaw.updated_at instanceof Date ? rRaw.updated_at : new Date(rRaw.updated_at),
    };
  }
  cache = { rows, expires_at: Date.now() + CACHE_TTL_MS };
  return rows;
}

/**
 * Get a single cost rate in USD-micros. Throws if the key is unknown.
 */
export async function getCostRate(key: string): Promise<number> {
  if (!cache || cache.expires_at < Date.now()) {
    await loadAllRatesIntoCache();
  }
  const row = cache!.rows[key];
  if (!row) {
    throw new Error(`unknown cost rate: ${key}`);
  }
  return row.value;
}

/**
 * Get all cost rates as a keyed object. Populated from cache if fresh,
 * otherwise reads from DB.
 */
export async function getAllCostRates(): Promise<Record<string, CostRateRow>> {
  if (!cache || cache.expires_at < Date.now()) {
    return loadAllRatesIntoCache();
  }
  return cache.rows;
}

/**
 * Update one or more cost rates. Each key is updated atomically with a
 * single UPDATE statement. `source` is recorded on every updated row
 * (e.g., 'aws-pricing-api', 'manual'). The in-process cache is invalidated
 * after a successful update.
 *
 * Empty `updates` object is a no-op.
 */
export async function updateCostRates(
  updates: Record<string, number>,
  source: string,
): Promise<void> {
  const keys = Object.keys(updates);
  if (keys.length === 0) return;

  for (const key of keys) {
    const value = updates[key];
    await queryFn(
      `UPDATE internal.cost_rates
       SET value_usd_micros = $1, source = $2, updated_at = NOW()
       WHERE key = $3`,
      [value, source, key],
    );
  }

  // Invalidate the in-process cache so the next read fetches fresh values.
  cache = null;
}
