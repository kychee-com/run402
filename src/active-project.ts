/**
 * Resolve the project id for a DB tool call.
 *
 * MCP DB tools (`run_sql`, `get_schema`, `rest_query`) accept an optional
 * `project_id`. When omitted, we fall back to the active project tracked in
 * local state (set by provisioning or `run402 projects use <id>`), so an agent
 * working against a single project doesn't have to thread the id through every
 * call. Returns the resolved id, or an error ToolResult when neither an explicit
 * id nor an active project is available.
 */
import { getSdk } from "./sdk.js";
import type { ToolResult } from "./errors.js";

export async function resolveProjectId(
  projectId?: string,
): Promise<string | ToolResult> {
  const explicit = projectId?.trim();
  if (explicit) return explicit;

  let active: string | null = null;
  try {
    active = await getSdk().projects.active();
  } catch {
    active = null;
  }
  if (active) return active;

  return {
    isError: true,
    content: [
      {
        type: "text",
        text:
          "No project_id provided and no active project is set. Pass project_id explicitly, " +
          "or set an active project first (provision one, or `run402 projects use <id>`).",
      },
    ],
  };
}
