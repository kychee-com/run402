import { z } from "zod";
import { apiRequest } from "../client.js";
import { getProject } from "../keystore.js";
import { formatApiError, projectNotFound } from "../errors.js";

export const drainContractWalletSchema = {
  project_id: z.string().describe("The project ID"),
  wallet_id: z.string().describe("The KMS contract wallet ID"),
  destination_address: z.string().describe("Where to send the entire native-token balance. Cost: chain gas + $0.000005 KMS sign fee. Works on suspended wallets."),
};

export async function handleDrainContractWallet(args: { project_id: string; wallet_id: string; destination_address: string }): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const project = getProject(args.project_id);
  if (!project) return projectNotFound(args.project_id);
  const res = await apiRequest(`/contracts/v1/wallets/${encodeURIComponent(args.wallet_id)}/drain`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${project.service_key}`,
      "X-Confirm-Drain": args.wallet_id,
    },
    body: { destination_address: args.destination_address },
  });
  if (!res.ok) return formatApiError(res, "draining wallet");
  return { content: [{ type: "text", text: "## Drain Submitted\n\n```json\n" + JSON.stringify(res.body, null, 2) + "\n```" }] };
}
