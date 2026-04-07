/**
 * v1.21 — admin-wallet-breakdown (finance dashboard)
 *
 * Adds two new tables under internal.* for the admin-wallet-breakdown feature:
 *  - internal.cost_rates      — AWS pricing constants (SES, Lambda, S3, KMS)
 *  - internal.aws_cost_cache  — daily-refreshed AWS Cost Explorer response cache
 *
 * Also seeds `cost_rates` with 6 default rows on first boot. The seed uses
 * ON CONFLICT (key) DO NOTHING so it's idempotent — re-running the migration
 * never overwrites operator-updated values from the "Refresh pricing" button.
 *
 * Default seed values (all in USD-micros per the internal accounting model):
 *  - ses_per_email_usd_micros     = 100       ($0.0001 = $0.10/1k, AWS SES outbound)
 *  - lambda_request_usd_micros    = 200       ($0.0002 = $0.20/M requests)
 *  - lambda_gb_second_usd_micros  = 17        ($0.0000166667 rounded, GB-sec billing)
 *  - s3_gb_month_usd_micros       = 23000     ($0.023/GB-month standard storage)
 *  - kms_key_monthly_usd_micros   = 1000000   ($1.00/month per asymmetric key)
 *  - kms_sign_per_op_usd_micros   = 3         ($0.000003 = $0.03/10k sign ops)
 *
 * Idempotent: every CREATE uses IF NOT EXISTS; the seed uses ON CONFLICT DO NOTHING.
 *
 * This migration does NOT ALTER any existing table — per the backward-compatibility
 * requirement in the spec, it only creates new tables.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type QueryFn = (text: string) => Promise<any>;

export async function applyV121(query: QueryFn): Promise<void> {
  // ---- internal.cost_rates -----------------------------------------------
  await query(`
    CREATE TABLE IF NOT EXISTS internal.cost_rates (
      key TEXT PRIMARY KEY,
      value_usd_micros BIGINT NOT NULL,
      unit TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      source TEXT NOT NULL DEFAULT 'seed'
    )
  `);

  // Seed the 6 default rates. Each row: (key, value_usd_micros, unit, source).
  // `updated_at` defaults to NOW() via the column default.
  await query(`
    INSERT INTO internal.cost_rates (key, value_usd_micros, unit, source) VALUES
      ('ses_per_email_usd_micros', 100, 'per_email', 'seed'),
      ('lambda_request_usd_micros', 200, 'per_request', 'seed'),
      ('lambda_gb_second_usd_micros', 17, 'per_gb_second', 'seed'),
      ('s3_gb_month_usd_micros', 23000, 'per_gb_month', 'seed'),
      ('kms_key_monthly_usd_micros', 1000000, 'per_key_month', 'seed'),
      ('kms_sign_per_op_usd_micros', 3, 'per_sign_op', 'seed')
    ON CONFLICT (key) DO NOTHING
  `);

  // ---- internal.aws_cost_cache -------------------------------------------
  await query(`
    CREATE TABLE IF NOT EXISTS internal.aws_cost_cache (
      day DATE NOT NULL,
      service_category TEXT NOT NULL,
      cost_usd_micros BIGINT NOT NULL,
      fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (day, service_category)
    )
  `);
  await query(
    `CREATE INDEX IF NOT EXISTS idx_aws_cost_cache_day ON internal.aws_cost_cache (day)`,
  );
}
