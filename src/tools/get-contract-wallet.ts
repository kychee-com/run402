import { z } from "zod";
import { apiRequest } from "../client.js";
import { getProject } from "../keystore.js";
import { formatApiError, projectNotFound } from "../errors.js";

export const getContractWalletSchema = {
  project_id: z.string().describe("The project ID"),
  wallet_id: z.string().describe("The KMS contract wallet ID (cwlt_...)"),
};

export async function handleGetContractWallet(args: { project_id: string; wallet_id: string }): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const project = getProject(args.project_id);
  if (!project) return projectNotFound(args.project_id);
  const res = await apiRequest(`/contracts/v1/wallets/${encodeURIComponent(args.wallet_id)}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${project.service_key}` },
  });
  if (!res.ok) return formatApiError(res, "fetching wallet");
  return { content: [{ type: "text", text: "```json\n" + JSON.stringify(res.body, null, 2) + "\n```" }] };
}
