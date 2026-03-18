/** Shared error formatting for MCP tool handlers. */

/** Standard return shape for all MCP tool handlers. */
export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/**
 * Format an API error response into an agent-friendly MCP tool result.
 *
 * Always includes: HTTP status, API error message, and actionable next-step guidance.
 * Extracts optional fields: hint, retry_after, renew_url, usage, expires_at.
 *
 * @param res  The response from apiRequest() — needs `status` and `body`.
 * @param context  Short verb phrase: "running SQL", "deploying function", etc.
 */
export function formatApiError(
  res: { status: number; body: unknown },
  context: string,
): ToolResult {
  const body =
    res.body && typeof res.body === "object"
      ? (res.body as Record<string, unknown>)
      : null;

  // Primary message — try message (PostgREST), then error, then fallback
  const primary = body
    ? (body.message as string) || (body.error as string) || "Unknown error"
    : typeof res.body === "string"
      ? (res.body as string)
      : "Unknown error";

  const lines: string[] = [
    `Error ${context}: ${primary} (HTTP ${res.status})`,
  ];

  // Supplementary fields from the API response
  if (body) {
    if (body.hint) lines.push(`Hint: ${body.hint}`);
    if (body.retry_after)
      lines.push(`Retry after: ${body.retry_after} seconds`);
    if (body.expires_at) lines.push(`Expires: ${body.expires_at}`);
    if (body.renew_url) lines.push(`Renew URL: ${body.renew_url}`);
    if (body.usage) {
      const u = body.usage as Record<string, unknown>;
      const parts: string[] = [];
      if (u.api_calls !== undefined)
        parts.push(`API calls: ${u.api_calls}/${u.limit || "?"}`);
      if (u.storage_bytes !== undefined)
        parts.push(
          `Storage: ${u.storage_bytes}/${u.storage_limit || "?"} bytes`,
        );
      if (parts.length > 0) lines.push(`Usage: ${parts.join(", ")}`);
    }
  }

  // Actionable guidance based on HTTP status
  switch (res.status) {
    case 401:
      lines.push(
        `\nNext step: Re-provision the project with \`provision_postgres_project\`, or check that your service key is correct.`,
      );
      break;
    case 403:
      if (body && body.admin_required) {
        lines.push(`\nThis command requires admin access.`);
      } else {
        lines.push(
          `\nNext step: The project lease may have expired. Use \`get_usage\` to check status, or \`set_tier\` to renew the lease.`,
        );
      }
      break;
    case 404:
      lines.push(
        `\nNext step: Check that the resource name and project ID are correct.`,
      );
      break;
    case 429:
      lines.push(`\nNext step: Rate limit hit. Wait and retry.`);
      break;
    default:
      if (res.status >= 500) {
        lines.push(`\nNext step: Server error. Try again in a moment.`);
      }
  }

  return { content: [{ type: "text", text: lines.join("\n") }], isError: true };
}

/**
 * Consistent "project not found in key store" error.
 */
export function projectNotFound(projectId: string): ToolResult {
  return {
    content: [
      {
        type: "text",
        text:
          `Error: Project \`${projectId}\` not found in key store. ` +
          `Use \`provision_postgres_project\` to create a project first.`,
      },
    ],
    isError: true,
  };
}
