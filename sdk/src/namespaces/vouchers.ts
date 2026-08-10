/**
 * `vouchers` namespace — redeem a promo code for platform credit.
 *
 * A promo code credits your organization with run402 prepaid credit. That
 * credit spends like any other prepaid balance: a tier purchase settles from
 * it with no on-chain payment.
 *
 * Two properties make this safe to call from anywhere in an agent's lifecycle:
 *
 * - **Order does not matter.** Redemption works as the very first authenticated
 *   call a brand-new wallet makes (the organization is provisioned on demand),
 *   or long after `run402 init`. There is no init-before-redeem requirement.
 * - **Retrying is safe.** A repeat by the same organization returns the ORIGINAL
 *   result with `already_redeemed: true` and never credits twice, so a call that
 *   times out client-side can simply be re-issued.
 *
 * This namespace is deliberately thin and semantically blind: it forwards an
 * opaque code string to one gateway route. It does not know what a code means,
 * where it came from, or who issued it. Minting is not an agent operation —
 * it needs a registered issuer key that no tenant holds.
 */

import type { Client } from "../kernel.js";
import { assertNonEmptyString } from "../validation.js";

/**
 * A follow-up the gateway suggests after a redemption — most often buying the
 * tier the new balance now covers.
 */
export interface VoucherNextAction {
  type: string;
  method?: string;
  path?: string;
  /** Ready-to-run CLI equivalent, when the action has one. */
  cli?: string;
  why?: string;
  [key: string]: unknown;
}

export interface RedeemVoucherResult {
  voucher_id: string;
  /** Credit applied by this voucher. */
  amount_usd_micros: number;
  /** The organization's available prepaid balance AFTER the credit. */
  balance_usd_micros: number;
  organization_id: string;
  redeemed_at: string;
  /**
   * True when THIS organization had already redeemed this code. The original
   * result is returned unchanged and no second credit was made — a replay is
   * reported honestly rather than dressed up as a fresh redemption.
   */
  already_redeemed: boolean;
  /** Lifetime promo-credit ceiling for one organization. */
  promo_lifetime_ceiling_usd_micros: number;
  next_actions: VoucherNextAction[];
}

export class Vouchers {
  /** Alias of {@link redeem}. */
  readonly redeemCode: (code: string) => Promise<RedeemVoucherResult>;

  constructor(private readonly client: Client) {
    this.redeemCode = this.redeem.bind(this);
  }

  /**
   * Redeem a promo code into the authenticated wallet's organization.
   *
   * The code is sent verbatim — the gateway owns the grammar and is forgiving
   * about it (case-insensitive, hyphens optional, and the Crockford
   * confusables `O`→`0` / `I`,`L`→`1` are mapped), so a client-side format
   * check would only invent ways to reject a code the server would have
   * accepted.
   *
   * Requires wallet (SIWX) auth. Errors carry the canonical envelope:
   * `VOUCHER_NOT_FOUND` (404 — unknown *or* malformed, deliberately
   * indistinguishable), `VOUCHER_EXPIRED` (410), `VOUCHER_ALREADY_REDEEMED`
   * (409 — a different organization got there first), `PROMO_LIMIT_REACHED`
   * (403), `RATE_LIMITED` (429).
   */
  async redeem(code: string): Promise<RedeemVoucherResult> {
    assertNonEmptyString(code, "code", "redeeming a promo code");
    return this.client.request<RedeemVoucherResult>("/vouchers/v1/redemptions", {
      method: "POST",
      body: { code },
      context: "redeeming a promo code",
    });
  }
}
