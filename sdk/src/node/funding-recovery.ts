/** Shared recovery facts for init adapters. A faucet marker is not a balance. */
export interface FundingRecovery {
  status: "blocked" | "pending" | "unavailable";
  code: string;
  retry_after?: number;
  retry_at?: string;
  limit_scope?: "ip" | "wallet";
  transaction_hash?: string;
  next_actions: Array<{ type: string; why: string; retry_after?: number; retry_at?: string }>;
}

export function fundingBlocksBootstrap(recovery: FundingRecovery | null, evidence: {
  activeTier: boolean; onChainBalance?: number | null; allowanceBalance?: number | null; lightningBalance?: number | null;
}): boolean {
  return recovery !== null && !evidence.activeTier && !(Number(evidence.onChainBalance) > 0)
    && !(Number(evidence.allowanceBalance) > 0) && !(Number(evidence.lightningBalance) > 0);
}

export function fundingRecovery(error: unknown, pending = false): FundingRecovery | null {
  if (!error && !pending) return null;
  const e = error as { code?: string; body?: Record<string, unknown> } | undefined;
  const body = e?.body ?? {};
  const details = (body.details && typeof body.details === "object" ? body.details : body) as Record<string, unknown>;
  const candidate = body.code ?? e?.code;
  const code = typeof candidate === "string" && /^[A-Z][A-Z0-9_]{0,80}$/.test(candidate)
    ? candidate : pending ? "FAUCET_CONFIRMATION_PENDING" : "FUNDING_UNAVAILABLE";
  const retry_after = typeof details.retry_after === "number" && Number.isFinite(details.retry_after) && details.retry_after >= 0 ? details.retry_after : undefined;
  const retry_at = typeof details.retry_at === "string" && Number.isFinite(Date.parse(details.retry_at)) ? details.retry_at : undefined;
  const limit_scope = details.limit_scope === "ip" || details.limit_scope === "wallet" ? details.limit_scope : undefined;
  const transaction_hash = typeof details.transaction_hash === "string" && /^0x[0-9a-f]{64}$/i.test(details.transaction_hash) ? details.transaction_hash : undefined;
  const timing = { ...(retry_after !== undefined ? { retry_after } : {}), ...(retry_at ? { retry_at } : {}) };
  if (code === "RATE_LIMITED") {
    const when = retry_at ? ` until ${retry_at}` : retry_after !== undefined ? ` for ${retry_after} seconds` : " until the faucet cooldown expires";
    return { status: "blocked", code, ...timing, ...(limit_scope ? { limit_scope } : {}), next_actions: [
      { type: "retry", ...timing, why: `Identity setup is complete, but faucet funding is blocked${when}. Retry funding after the cooldown; deployment is not ready.` },
    ] };
  }
  if (code === "FAUCET_CONFIRMATION_PENDING" || pending) {
    return { status: "pending", code, ...(transaction_hash ? { transaction_hash } : {}), next_actions: [
      { type: "check_balance", why: "Funding was broadcast but is not confirmed. Check the transaction or wallet balance before deploying; do not request another drip while its outcome is unknown." },
    ] };
  }
  if (code === "FAUCET_TRANSFER_REVERTED") {
    return { status: "unavailable", code, ...(transaction_hash ? { transaction_hash } : {}), next_actions: [
      { type: "contact_support", why: "The faucet transfer reverted. No funds were delivered and the cooldown still applies. Report the transaction hash to support." },
    ] };
  }
  return { status: "unavailable", code, next_actions: [
    { type: "check_balance", why: "Identity setup is complete, but funding could not be confirmed. Check the wallet balance and resolve the funding failure before deploying." },
  ] };
}
