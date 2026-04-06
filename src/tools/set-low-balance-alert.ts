import { z } from "zod";
import { apiRequest } from "../client.js";
import { getProject } from "../keystore.js";
import { formatApiError, projectNotFound } from "../errors.js";

export const setLowBalanceAlertSchema = {
  project_id: z.string().describe("The project ID"),
  wallet_id: z.string().describe("The KMS contract wallet ID"),
  threshold_wei: z.string().describe("Low-balance threshold in wei (decimal string)"),
};

export async function handleSetLowBalanceAlert(args: { project_id: string; wallet_id: string; threshold_wei: string }): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const project = getProject(args.project_id);
  if (!project) return projectNotFound(args.project_id);
  const res = await apiRequest(`/contracts/v1/wallets/${encodeURIComponent(args.wallet_id)}/alert`, {
    method: "POST",
    headers: { Authorization: `Bearer ${project.service_key}` },
    body: { threshold_wei: args.threshold_wei },
  });
  if (!res.ok) return formatApiError(res, "setting low-balance threshold");
  return { content: [{ type: "text", text: "Low-balance threshold set to " + args.threshold_wei + " wei" }] };
}
