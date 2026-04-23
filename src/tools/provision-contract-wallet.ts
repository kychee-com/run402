import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const provisionContractWalletSchema = {
  project_id: z.string().describe("The project ID"),
  chain: z.enum(["base-mainnet", "base-sepolia"]).describe("Which EVM chain. Cost: $0.04/day rental, requires $1.20 in cash credit at creation."),
  recovery_address: z.string().optional().describe("Optional 0x-prefixed address for auto-drain on day-90 deletion"),
};

export async function handleProvisionContractWallet(args: { project_id: string; chain: "base-mainnet" | "base-sepolia"; recovery_address?: string }): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const body = await getSdk().contracts.provisionWallet(args.project_id, {
      chain: args.chain,
      recoveryAddress: args.recovery_address,
    });
    return { content: [{ type: "text", text: "## KMS Contract Wallet Provisioned\n\n```json\n" + JSON.stringify(body, null, 2) + "\n```\n\n**Cost**: $0.04/day rental ($1.20/month) + $0.000005 per contract call. **Non-custodial** — see https://run402.com/humans/terms.html#non-custodial-kms-wallets" }] };
  } catch (err) {
    return mapSdkError(err, "provisioning KMS contract wallet");
  }
}
