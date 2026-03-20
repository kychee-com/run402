import { z } from "zod";
import { getProject, setActiveProjectId } from "../keystore.js";
import { projectNotFound } from "../errors.js";

export const projectUseSchema = {
  project_id: z.string().describe("Project ID to set as active"),
};

type McpResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

export async function handleProjectUse(args: {
  project_id: string;
}): Promise<McpResult> {
  const project = getProject(args.project_id);
  if (!project) return projectNotFound(args.project_id);

  setActiveProjectId(args.project_id);

  return {
    content: [
      {
        type: "text",
        text: `Active project set to \`${args.project_id}\`.`,
      },
    ],
  };
}
