import { z } from "zod";
import { apiRequest } from "../client.js";
import { getProject } from "../keystore.js";
import { formatApiError, projectNotFound } from "../errors.js";

export const getContractCallStatusSchema = {
  project_id: z.string().describe("The project ID"),
  call_id: z.string().describe("The contract call ID (ccall_...)"),
};

export async function handleGetContractCallStatus(args: { project_id: string; call_id: string }): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const project = getProject(args.project_id);
  if (!project) return projectNotFound(args.project_id);
  const res = await apiRequest(`/contracts/v1/calls/${encodeURIComponent(args.call_id)}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${project.service_key}` },
  });
  if (!res.ok) return formatApiError(res, "fetching call status");
  return { content: [{ type: "text", text: "```json\n" + JSON.stringify(res.body, null, 2) + "\n```" }] };
}
