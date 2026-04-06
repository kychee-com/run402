import { z } from "zod";
import { apiRequest } from "../client.js";
import { getProject } from "../keystore.js";
import { formatApiError, projectNotFound } from "../errors.js";

export const deleteContractWalletSchema = {
  project_id: z.string().describe("The project ID"),
  wallet_id: z.string().describe("The KMS contract wallet ID. Schedules KMS key deletion (7-day window). Refused if balance >= dust — drain first."),
};

export async function handleDeleteContractWallet(args: { project_id: string; wallet_id: string }): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const project = getProject(args.project_id);
  if (!project) return projectNotFound(args.project_id);
  const res = await apiRequest(`/contracts/v1/wallets/${encodeURIComponent(args.wallet_id)}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${project.service_key}`,
      "X-Confirm-Delete": args.wallet_id,
    },
  });
  if (!res.ok) return formatApiError(res, "deleting wallet");
  return { content: [{ type: "text", text: "## Wallet Deleted\n\n```json\n" + JSON.stringify(res.body, null, 2) + "\n```" }] };
}
