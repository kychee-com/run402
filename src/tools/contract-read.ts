import { z } from "zod";
import { apiRequest } from "../client.js";
import { getProject } from "../keystore.js";
import { formatApiError, projectNotFound } from "../errors.js";

export const contractReadSchema = {
  chain: z.enum(["base-mainnet", "base-sepolia"]).describe("EVM chain"),
  contract_address: z.string().describe("0x-prefixed contract address"),
  abi_fragment: z.array(z.unknown()).describe("ABI fragment containing the view/pure function"),
  function_name: z.string().describe("Function name"),
  args: z.array(z.unknown()).describe("Function arguments"),
};

export async function handleContractRead(args: { chain: "base-mainnet" | "base-sepolia"; contract_address: string; abi_fragment: unknown[]; function_name: string; args: unknown[] }): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const res = await apiRequest("/contracts/v1/read", {
    method: "POST",
    headers: {},
    body: {
      chain: args.chain,
      contract_address: args.contract_address,
      abi_fragment: args.abi_fragment,
      function_name: args.function_name,
      args: args.args,
    },
  });
  if (!res.ok) return formatApiError(res, "reading contract");
  return { content: [{ type: "text", text: "```json\n" + JSON.stringify(res.body, null, 2) + "\n```" }] };
}
