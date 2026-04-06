/**
 * Boot guards for the KMS contract-wallet chain registry.
 *
 * On gateway startup we must guarantee:
 *   1. Every chain in the static registry has its RPC URL secret available.
 *   2. No `internal.contract_wallets` row references a chain that has been
 *      removed from the registry.
 *
 * Both failures are treated as fatal — refusing to boot is much safer than
 * silently signing transactions on the wrong chain or returning HTTP 500
 * forever for affected wallets.
 */

import { listChains, isSupportedChain } from "./chain-config.js";
import { sql } from "../db/sql.js";

export interface ChainBootDeps {
  loadSecret: (key: string) => Promise<string | null>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query: (text: string, params?: any[]) => Promise<{ rows: any[] }>;
}

export type LoadedRpcMap = Record<string, string>;

export async function runChainBootGuards(deps: ChainBootDeps): Promise<LoadedRpcMap> {
  const rpcMap: LoadedRpcMap = {};

  // Guard 1: every chain has an RPC URL secret
  for (const chain of listChains()) {
    const url = await deps.loadSecret(chain.rpc_url_secret_key);
    if (!url) {
      throw new Error(
        `[chain-boot] ${chain.name}: missing RPC URL secret ${chain.rpc_url_secret_key}`,
      );
    }
    rpcMap[chain.name] = url;
  }

  // Guard 2: no orphaned wallet rows pointing at chains that are not in the registry
  const result = await deps.query(
    sql(`SELECT DISTINCT chain FROM internal.contract_wallets WHERE status != 'deleted'`),
  );
  for (const row of result.rows) {
    const chain = row.chain as string;
    if (!isSupportedChain(chain)) {
      throw new Error(
        `[chain-boot] orphaned contract_wallet row references unregistered chain: ${chain}`,
      );
    }
  }

  return rpcMap;
}
