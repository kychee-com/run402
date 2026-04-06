import { z } from "zod";
import { apiRequest } from "../client.js";
import { getProject } from "../keystore.js";
import { formatApiError, projectNotFound } from "../errors.js";

export const setRecoveryAddressSchema = {
  project_id: z.string().describe("The project ID"),
  wallet_id: z.string().describe("The KMS contract wallet ID"),
  recovery_address: z.string().nullable().describe("0x-prefixed address (or null to clear). Used for auto-drain on day-90 deletion."),
};

export async function handleSetRecoveryAddress(args: { project_id: string; wallet_id: string; recovery_address: string | null }): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const project = getProject(args.project_id);
  if (!project) return projectNotFound(args.project_id);
  const res = await apiRequest(`/contracts/v1/wallets/${encodeURIComponent(args.wallet_id)}/recovery-address`, {
    method: "POST",
    headers: { Authorization: `Bearer ${project.service_key}` },
    body: { recovery_address: args.recovery_address },
  });
  if (!res.ok) return formatApiError(res, "setting recovery address");
  return { content: [{ type: "text", text: "Recovery address " + (args.recovery_address ? "set to " + args.recovery_address : "cleared") }] };
}
