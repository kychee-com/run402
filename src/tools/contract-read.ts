import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const contractReadSchema = {
  chain: z.enum(["base-mainnet", "base-sepolia"]).describe("EVM chain"),
  contract_address: z.string().describe("0x-prefixed contract address"),
  abi_fragment: z.array(z.unknown()).describe("ABI fragment containing the view/pure function"),
  function_name: z.string().describe("Function name"),
  args: z.array(z.unknown()).describe("Function arguments"),
};

export async function handleContractRead(args: { chain: "base-mainnet" | "base-sepolia"; contract_address: string; abi_fragment: unknown[]; function_name: string; args: unknown[] }): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const body = await getSdk().contracts.read({
      chain: args.chain,
      contractAddress: args.contract_address,
      abiFragment: args.abi_fragment,
      functionName: args.function_name,
      args: args.args,
    });
    return { content: [{ type: "text", text: "```json\n" + JSON.stringify(body, null, 2) + "\n```" }] };
  } catch (err) {
    return mapSdkError(err, "reading contract");
  }
}
