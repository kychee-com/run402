import { z } from "zod";
import { apiRequest } from "../client.js";
import { getProject } from "../keystore.js";
import { formatApiError, projectNotFound } from "../errors.js";

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
  const project = getProject(args.project_id);
  if (!project) return projectNotFound(args.project_id);
  const headers: Record<string, string> = { Authorization: `Bearer ${project.service_key}` };
  if (args.idempotency_key) headers["Idempotency-Key"] = args.idempotency_key;
  const body: Record<string, unknown> = {
    wallet_id: args.wallet_id,
    chain: args.chain,
    contract_address: args.contract_address,
    abi_fragment: args.abi_fragment,
    function_name: args.function_name,
    args: args.args,
  };
  if (args.value) body.value = args.value;
  const res = await apiRequest("/contracts/v1/call", { method: "POST", headers, body });
  if (!res.ok) return formatApiError(res, "submitting contract call");
  return { content: [{ type: "text", text: "## Contract Call Submitted\n\n```json\n" + JSON.stringify(res.body, null, 2) + "\n```\n\n**Cost**: chain gas at-cost + $0.000005 KMS sign fee" }] };
}
