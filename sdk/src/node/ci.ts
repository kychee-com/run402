/** Node-only CI/OIDC helpers. */

import { readWallet } from "../../core-dist/wallet.js";
import { buildSIWxAuthHeaders } from "../../core-dist/wallet-auth.js";
import { getApiBase } from "../../core-dist/config.js";
import { LocalError } from "../errors.js";
import {
  buildCiDelegationResourceUri,
  buildCiDelegationStatement,
  normalizeCiDelegationValues,
} from "../namespaces/ci.js";
import {
  DEFAULT_CI_DELEGATION_CHAIN_ID,
  type CiDelegationValues,
} from "../namespaces/ci.types.js";

export interface SignCiDelegationOptions {
  apiBase?: string;
  walletPath?: string;
  chainId?: string;
  issuedAt?: string;
  expirationTime?: string;
  nonce?: string;
}

export function signCiDelegation(
  values: CiDelegationValues,
  opts: SignCiDelegationOptions = {},
): string {
  const localWallet = readWallet(opts.walletPath);
  if (!localWallet || !localWallet.address || !localWallet.privateKey) {
    throw new LocalError(
      "No local wallet configured. Run `run402 init` or `run402 init` before linking CI.",
      "signing CI delegation",
    );
  }

  const canonical = normalizeCiDelegationValues(values);
  const apiBase = opts.apiBase ?? getApiBase();
  const bindingUrl = new URL("/ci/v1/bindings", apiBase);
  const now = new Date();
  const headers = buildSIWxAuthHeaders({
    wallet: localWallet,
    domain: bindingUrl.hostname,
    uri: bindingUrl.toString(),
    statement: buildCiDelegationStatement(canonical),
    chainId: opts.chainId ?? DEFAULT_CI_DELEGATION_CHAIN_ID,
    nonce: opts.nonce ?? canonical.nonce.slice(0, 16),
    issuedAt: opts.issuedAt ?? now.toISOString(),
    expirationTime:
      opts.expirationTime ?? new Date(now.getTime() + 5 * 60 * 1000).toISOString(),
    resources: [buildCiDelegationResourceUri(canonical)],
  });
  return headers["SIGN-IN-WITH-X"];
}
