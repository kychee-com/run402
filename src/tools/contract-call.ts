import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const contractCallSchema = {
  project_id: z.string().describe("The project ID"),
  wallet_id: z.string().describe("The KMS contract wallet ID"),
  chain: z.enum(["base-mainnet", "base-sepolia"]).describe("EVM chain"),
  contract_address: z.string().describe("0x-prefixed contract address"),
  abi_fragment: z.array(z.unknown()).describe("ABI fragment containing the function definition"),
  function_name: z.string().describe("Function name to invoke"),
  args: z.array(z.unknown()).describe("Function arguments (must match ABI)"),
  value: z.string().optional().describe("Optional native-token value in wei (decimal string)"),
  idempotency_key: z.string().optional().describe("Optional idempotency key — same key returns same call_id without re-broadcasting"),
};

export async function handleContractCall(args: { project_id: string; wallet_id: string; chain: "base-mainnet" | "base-sepolia"; contract_address: string; abi_fragment: unknown[]; function_name: string; args: unknown[]; value?: string; idempotency_key?: string }): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const body = await getSdk().contracts.call(args.project_id, {
      walletId: args.wallet_id,
      chain: args.chain,
      contractAddress: args.contract_address,
      abiFragment: args.abi_fragment,
      functionName: args.function_name,
      args: args.args,
      value: args.value,
      idempotencyKey: args.idempotency_key,
    });
    return { content: [{ type: "text", text: "## Contract Call Submitted\n\n```json\n" + JSON.stringify(body, null, 2) + "\n```\n\n**Cost**: chain gas at-cost + $0.000005 KMS sign fee" }] };
  } catch (err) {
    return mapSdkError(err, "submitting contract call");
  }
}
