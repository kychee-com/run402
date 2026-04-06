import { z } from "zod";
import { apiRequest } from "../client.js";
import { getProject } from "../keystore.js";
import { formatApiError, projectNotFound } from "../errors.js";

export const listContractWalletsSchema = {
  project_id: z.string().describe("The project ID"),
};

export async function handleListContractWallets(args: { project_id: string }): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const project = getProject(args.project_id);
  if (!project) return projectNotFound(args.project_id);
  const res = await apiRequest("/contracts/v1/wallets", {
    method: "GET",
    headers: { Authorization: `Bearer ${project.service_key}` },
  });
  if (!res.ok) return formatApiError(res, "listing wallets");
  return { content: [{ type: "text", text: "```json\n" + JSON.stringify(res.body, null, 2) + "\n```" }] };
}
