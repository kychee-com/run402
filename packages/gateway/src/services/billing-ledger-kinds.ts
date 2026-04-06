/**
 * Allowlist of `kind` values for `internal.allowance_ledger` rows.
 *
 * The DB column is plain TEXT with no CHECK constraint, so this allowlist
 * is enforced at the application layer. Any service inserting a ledger
 * row should call assertAllowedLedgerKind() before INSERT.
 */

export const ALLOWED_LEDGER_KINDS: ReadonlySet<string> = Object.freeze(
  new Set<string>([
    // Admin
    "admin_credit",
    "admin_debit",
    // Cash topup / spend
    "purchase_debit",
    "stripe_topup",
    // Email packs
    "email_pack_purchase",
    "email_pack_auto_recharge",
    // Tier subscriptions
    "tier_subscribe",
    "tier_renew",
    "tier_upgrade",
    "tier_upgrade_refund",
    // KMS contract wallets (v1.20)
    "kms_wallet_rental",
    "kms_sign_fee",
    "contract_call_gas",
  ]),
);

export function isAllowedLedgerKind(kind: string): boolean {
  return ALLOWED_LEDGER_KINDS.has(kind);
}

export function assertAllowedLedgerKind(kind: string): void {
  if (!ALLOWED_LEDGER_KINDS.has(kind)) {
    throw new Error(`unknown ledger kind: ${kind}`);
  }
}
