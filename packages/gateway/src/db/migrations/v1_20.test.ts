import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { applyV120 } from "./v1_20.js";

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

describe("v1.20 migration — kms wallet contracts", () => {
  it("creates internal.contract_wallets with required columns", async () => {
    const client = makeCapturingClient();
    await applyV120(client.query);
    const all = client.queries.map((q) => q.text).join("\n");
    assert.match(all, /CREATE TABLE IF NOT EXISTS internal\.contract_wallets/);
    for (const col of [
      "id ", "project_id ", "kms_key_id ", "chain ", "address ",
      "status ", "recovery_address ", "low_balance_threshold_wei ",
      "last_alert_sent_at ", "last_rent_debited_on ",
      "suspended_at ", "deleted_at ", "last_warning_day ", "created_at ",
    ]) {
      assert.ok(all.includes(col), `contract_wallets missing column: ${col}`);
    }
  });

  it("creates contract_wallets indexes (project_id, status, status+suspended_at)", async () => {
    const client = makeCapturingClient();
    await applyV120(client.query);
    const all = client.queries.map((q) => q.text).join("\n");
    assert.match(all, /CREATE INDEX IF NOT EXISTS \w+ ON internal\.contract_wallets\s*\(project_id\)/);
    assert.match(all, /CREATE INDEX IF NOT EXISTS \w+ ON internal\.contract_wallets\s*\(status\)/);
    assert.match(all, /CREATE INDEX IF NOT EXISTS \w+ ON internal\.contract_wallets\s*\(status, suspended_at\)/);
  });

  it("creates internal.contract_calls with required columns", async () => {
    const client = makeCapturingClient();
    await applyV120(client.query);
    const all = client.queries.map((q) => q.text).join("\n");
    assert.match(all, /CREATE TABLE IF NOT EXISTS internal\.contract_calls/);
    for (const col of [
      "id ", "wallet_id ", "project_id ", "chain ", "contract_address ",
      "function_name ", "args_json ", "idempotency_key ", "tx_hash ",
      "status ", "gas_used_wei ", "gas_cost_usd_micros ",
      "receipt_json ", "error ", "created_at ", "updated_at ",
    ]) {
      assert.ok(all.includes(col), `contract_calls missing column: ${col}`);
    }
  });

  it("creates contract_calls unique partial index on (project_id, idempotency_key)", async () => {
    const client = makeCapturingClient();
    await applyV120(client.query);
    const all = client.queries.map((q) => q.text).join("\n");
    assert.match(
      all,
      /CREATE UNIQUE INDEX IF NOT EXISTS \w+ ON internal\.contract_calls\s*\(project_id, idempotency_key\)\s+WHERE idempotency_key IS NOT NULL/,
    );
  });

  it("creates contract_calls (status, created_at) reconciler index", async () => {
    const client = makeCapturingClient();
    await applyV120(client.query);
    const all = client.queries.map((q) => q.text).join("\n");
    assert.match(all, /CREATE INDEX IF NOT EXISTS \w+ ON internal\.contract_calls\s*\(status, created_at\)/);
  });

  it("is idempotent (no CREATE TABLE without IF NOT EXISTS, no CREATE INDEX without IF NOT EXISTS)", async () => {
    const client = makeCapturingClient();
    await applyV120(client.query);
    for (const { text } of client.queries) {
      if (/CREATE TABLE/.test(text)) {
        assert.match(text, /CREATE TABLE IF NOT EXISTS/, `non-idempotent CREATE TABLE: ${text}`);
      }
      if (/CREATE\s+(UNIQUE\s+)?INDEX/.test(text)) {
        assert.match(text, /CREATE\s+(UNIQUE\s+)?INDEX IF NOT EXISTS/, `non-idempotent CREATE INDEX: ${text}`);
      }
    }
  });
});
