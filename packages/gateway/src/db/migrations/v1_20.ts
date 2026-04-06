/**
 * v1.20 — KMS contract wallets + contract calls
 *
 * Adds two new tables under internal.* for the kms-wallet-contracts feature:
 *  - internal.contract_wallets — KMS-backed Ethereum wallets per project
 *  - internal.contract_calls   — every transaction submitted from a wallet
 *
 * Idempotent: every CREATE uses IF NOT EXISTS so a re-run is a no-op.
 *
 * The ledger `kind` column is plain TEXT with no DB-side enforcement,
 * so the new ledger kinds (`kms_wallet_rental`, `kms_sign_fee`,
 * `contract_call_gas`) require no DB migration. The application-level
 * allowlist lives in `services/billing-ledger-kinds.ts`.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type QueryFn = (text: string) => Promise<any>;

export async function applyV120(query: QueryFn): Promise<void> {
  // ---- internal.contract_wallets -----------------------------------------
  await query(`
    CREATE TABLE IF NOT EXISTS internal.contract_wallets (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      kms_key_id TEXT,
      chain TEXT NOT NULL,
      address TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      recovery_address TEXT,
      low_balance_threshold_wei NUMERIC NOT NULL DEFAULT 1000000000000000,
      last_alert_sent_at TIMESTAMPTZ,
      last_rent_debited_on DATE,
      suspended_at TIMESTAMPTZ,
      deleted_at TIMESTAMPTZ,
      last_warning_day INT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(
    `CREATE INDEX IF NOT EXISTS idx_contract_wallets_project ON internal.contract_wallets (project_id)`,
  );
  await query(
    `CREATE INDEX IF NOT EXISTS idx_contract_wallets_status ON internal.contract_wallets (status)`,
  );
  await query(
    `CREATE INDEX IF NOT EXISTS idx_contract_wallets_status_suspended ON internal.contract_wallets (status, suspended_at)`,
  );

  // ---- internal.contract_calls -------------------------------------------
  await query(`
    CREATE TABLE IF NOT EXISTS internal.contract_calls (
      id TEXT PRIMARY KEY,
      wallet_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      chain TEXT NOT NULL,
      contract_address TEXT NOT NULL,
      function_name TEXT NOT NULL,
      args_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      idempotency_key TEXT,
      tx_hash TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      gas_used_wei NUMERIC,
      gas_cost_usd_micros BIGINT,
      receipt_json JSONB,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_contract_calls_idem ON internal.contract_calls (project_id, idempotency_key) WHERE idempotency_key IS NOT NULL`,
  );
  await query(
    `CREATE INDEX IF NOT EXISTS idx_contract_calls_status_created ON internal.contract_calls (status, created_at)`,
  );
  await query(
    `CREATE INDEX IF NOT EXISTS idx_contract_calls_wallet ON internal.contract_calls (wallet_id)`,
  );
  await query(
    `CREATE INDEX IF NOT EXISTS idx_contract_calls_project ON internal.contract_calls (project_id)`,
  );
}
