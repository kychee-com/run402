/**
 * Billing account identifier resolver.
 *
 * Auto-detects whether an identifier string is a wallet address or email.
 * Used by billing routes that accept both types in URL/body parameters.
 */

import { validateEmail, validateWalletAddress } from "../utils/validate.js";
import { HttpError } from "../utils/async-handler.js";

export type AccountIdentifier =
  | { type: "wallet"; value: string }
  | { type: "email"; value: string };

/**
 * Resolve a raw identifier string to a typed account identifier.
 * - Wallet addresses: 0x + 40 hex chars → lowercased
 * - Emails: contains @ → lowercased + trimmed
 * - Invalid: throws HttpError(400)
 */
export function resolveAccountIdentifier(id: unknown): AccountIdentifier {
  if (typeof id !== "string" || id.length === 0) {
    throw new HttpError(400, "Invalid identifier: must be a wallet address or email");
  }

  const trimmed = id.trim();

  // Wallet detection: starts with 0x, 42 chars total
  if (trimmed.startsWith("0x") && trimmed.length === 42) {
    const normalized = validateWalletAddress(trimmed, "identifier");
    return { type: "wallet", value: normalized };
  }

  // Email detection: contains @
  if (trimmed.includes("@")) {
    const normalized = validateEmail(trimmed, "identifier");
    return { type: "email", value: normalized };
  }

  throw new HttpError(400, "Invalid identifier: must be a wallet address (0x...) or email (user@example.com)");
}
