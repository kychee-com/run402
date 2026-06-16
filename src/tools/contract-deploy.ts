import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const contractDeploySchema = {
  project_id: z.string().describe("The project ID"),
  signer_id: z.string().describe("The KMS signer ID (cwlt_...) that will sign + own the new contract"),
  chain: z.enum(["base-mainnet", "base-sepolia"]).describe("EVM chain (must match the signer's chain)"),
  bytecode: z.string().describe("Full creation calldata as 0x-prefixed hex (creation bytecode + ABI-encoded constructor args, concatenated client-side). Non-empty, even-length, ≤ 128 KB. run402 does NOT compile Solidity."),
  value: z.string().optional().describe("Optional native-token value in wei to attach to the deploy (decimal string)"),
  idempotency_key: z.string().optional().describe("Optional idempotency key — same key + same bytecode returns same call_id without re-broadcasting"),
};

export async function handleContractDeploy(args: { project_id: string; signer_id: string; chain: "base-mainnet" | "base-sepolia"; bytecode: string; value?: string; idempotency_key?: string }): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const body = await getSdk().contracts.deploy(args.project_id, {
      signerId: args.signer_id,
      chain: args.chain,
      bytecode: args.bytecode,
      value: args.value,
      idempotencyKey: args.idempotency_key,
    });
    return {
      content: [{
        type: "text",
        text:
          "## Contract Deploy Submitted\n\n" +
          "```json\n" + JSON.stringify(body, null, 2) + "\n```\n\n" +
          "**Deployed contract address (deterministic CREATE)**: `" + body.contract_address + "` — returned synchronously from `(signer.address, nonce)`. Verified against the on-chain receipt on confirmation.\n\n" +
          "**Cost**: chain gas at-cost + $0.000005 KMS sign fee (same as `contract_call`).\n\n" +
          "Poll `get_contract_call_status` with `call_id` to confirm. On `status: confirmed`, the deployed contract is callable via `contract_call` at the address above.",
      }],
    };
  } catch (err) {
    return mapSdkError(err, "deploying contract");
  }
}
