/**
 * Read-only contract call service — no signing, no gas, no DB writes,
 * no billing. Pure RPC convenience.
 */

import type { Abi } from "viem";
import { HttpError } from "../utils/async-handler.js";
import { isSupportedChain } from "./chain-config.js";
import { rpcReadContract } from "./contract-read-rpc.js";

export interface ReadContractInput {
  chain: string;
  contractAddress: string;
  abiFragment: Abi;
  functionName: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: any[];
}

export async function readContract(input: ReadContractInput): Promise<unknown> {
  if (!isSupportedChain(input.chain)) {
    throw new HttpError(400, "unsupported_chain");
  }
  if (!Array.isArray(input.abiFragment)) {
    throw new HttpError(400, "invalid_abi");
  }
  const fnExists = input.abiFragment.some(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (e: any) => e?.type === "function" && e?.name === input.functionName,
  );
  if (!fnExists) {
    throw new HttpError(400, "invalid_abi");
  }
  if (!/^0x[a-fA-F0-9]{40}$/.test(input.contractAddress)) {
    throw new HttpError(400, "invalid_contract_address");
  }

  try {
    return await rpcReadContract(input);
  } catch (err) {
    throw new HttpError(502, "rpc_failed", { error: "rpc_failed", detail: (err as Error).message });
  }
}
