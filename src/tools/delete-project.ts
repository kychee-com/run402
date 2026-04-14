import { z } from "zod";
import { apiRequest } from "../client.js";
import { getProject, loadKeyStore, saveKeyStore } from "../keystore.js";
import { formatApiError, projectNotFound } from "../errors.js";

export const deleteProjectSchema = {
  project_id: z
    .string()
    .describe("The project ID to delete (irreversible cascade purge)"),
};

export async function handleDeleteProject(args: {
  project_id: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const project = getProject(args.project_id);
  if (!project) return projectNotFound(args.project_id);

  const res = await apiRequest(`/projects/v1/${args.project_id}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${project.service_key}`,
    },
  });

  if (!res.ok) return formatApiError(res, "deleting project");

  const store = loadKeyStore();
  delete store.projects[args.project_id];
  saveKeyStore(store);

  return {
    content: [
      {
        type: "text",
        text: `Project \`${args.project_id}\` deleted (status: purged). Schema dropped, functions deleted, subdomains released, mailbox tombstoned. Removed from local key store. This action is irreversible.`,
      },
    ],
  };
}
