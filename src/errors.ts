/** Shared error formatting for MCP tool handlers. */

import {
  Run402Error,
  NetworkError,
  ProjectNotFound as SdkProjectNotFound,
} from "../sdk/dist/index.js";

/** Standard return shape for all MCP tool handlers. */
export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/**
 * Format an API error response into an agent-friendly MCP tool result.
 *
 * Always includes: HTTP status, API error message, and actionable next-step guidance.
 * Extracts optional fields: hint, retry_after, renew_url, usage, expires_at,
 * and lifecycle signals (lifecycle_state, entered_state_at, next_transition_at,
 * scheduled_purge_at) when the gateway returns them on grace-state 402s.
 *
 * @param res  A response-like object with `status` and `body`.
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

  // Primary message — try canonical/human message, then legacy string error.
  const primary = body
    ? stringField(body, "message") ?? stringField(body, "error") ?? "Unknown error"
    : typeof res.body === "string"
      ? (res.body as string)
      : "Unknown error";

  const lines: string[] = [
    `Error ${context}: ${primary} (HTTP ${res.status})`,
  ];
  lines.push(...formatCanonicalErrorContext(body));

  const inGrace = Boolean(body && body.lifecycle_state);

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
    if (body.lifecycle_state) {
      const lc: string[] = [`state=${body.lifecycle_state}`];
      if (body.entered_state_at) lc.push(`entered=${body.entered_state_at}`);
      if (body.next_transition_at)
        lc.push(`next=${body.next_transition_at}`);
      if (body.scheduled_purge_at)
        lc.push(`purge_at=${body.scheduled_purge_at}`);
      lines.push(`Lifecycle: ${lc.join(", ")}`);
    }
  }

  const code = stringField(body, "code");
  const usedCodeGuidance = addCodeGuidance(lines, code);

  // Actionable guidance based on HTTP status when no canonical code-specific
  // guidance applied, or when legacy lifecycle fields need their old text.
  if (!usedCodeGuidance) {
    switch (res.status) {
      case 401:
        lines.push(
          `\nNext step: Re-provision the project with \`provision_postgres_project\`, or check that your service key is correct.`,
        );
        break;
      case 402:
        if (inGrace) {
          lines.push(
            `\nNext step: Project is in the soft-delete grace window — control-plane mutations are blocked. Use \`set_tier\` to renew/upgrade and reactivate the project in one transaction.`,
          );
        }
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
      case 409:
        lines.push(
          `\nNext step: The requested name or resource is already in use or reserved (e.g., held for an original owner during a grace window). Wait for the reservation to lapse or try a different name.`,
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
  } else if (res.status === 402 && inGrace) {
    lines.push(
      `\nNext step: Project is in the soft-delete grace window — control-plane mutations are blocked. Use \`set_tier\` to renew/upgrade and reactivate the project in one transaction.`,
    );
  }

  return { content: [{ type: "text", text: lines.join("\n") }], isError: true };
}

export function formatCanonicalErrorContext(
  source: unknown,
  opts: { includeDetails?: boolean } = {},
): string[] {
  const lines: string[] = [];
  const code = canonicalString(source, "code");
  const category = canonicalString(source, "category");
  const mutationState = canonicalString(source, "mutation_state", "mutationState");
  const traceId = canonicalString(source, "trace_id", "traceId");
  const retryable = canonicalBoolean(source, "retryable", "retryable");
  const safeToRetry = canonicalBoolean(source, "safe_to_retry", "safeToRetry");
  const attempts = canonicalNumber(source, "attempts", "attempts");
  const maxRetries = canonicalNumber(source, "max_retries", "maxRetries");
  const lastRetryCode = canonicalString(source, "last_retry_code", "lastRetryCode");
  const details = canonicalValue(source, "details", "details");
  const nextActions = canonicalValue(source, "next_actions", "nextActions");

  if (code) lines.push(`Code: \`${code}\``);
  if (category) lines.push(`Category: ${category}`);
  if (retryable !== undefined) lines.push(`Retryable: ${retryable}`);
  if (safeToRetry !== undefined) lines.push(`Safe to retry: ${safeToRetry}`);
  if (attempts !== undefined) lines.push(`Attempts: ${attempts}`);
  if (maxRetries !== undefined) lines.push(`Max retries: ${maxRetries}`);
  if (lastRetryCode) lines.push(`Last retry code: \`${lastRetryCode}\``);
  if (mutationState) lines.push(`Mutation state: ${mutationState}`);
  if (traceId) lines.push(`Trace: ${traceId}`);
  if (opts.includeDetails && isNonEmptyRecord(details)) {
    lines.push(`Details:`);
    lines.push("```json", JSON.stringify(details, null, 2), "```");
  }
  if (Array.isArray(nextActions) && nextActions.length > 0) {
    lines.push(...formatNextActions(nextActions));
  }
  return lines;
}

function addCodeGuidance(lines: string[], code: string | undefined): boolean {
  switch (code) {
    case "AUTHENTICATION_REQUIRED":
    case "UNAUTHORIZED":
      lines.push(`\nNext step: Authenticate again or check the project key used for this request.`);
      return true;
    case "PAYMENT_REQUIRED":
    case "INSUFFICIENT_FUNDS":
      lines.push(`\nNext step: Submit payment or fund the allowance, then retry the request.`);
      return true;
    case "PROJECT_FROZEN":
    case "PROJECT_DORMANT":
    case "PROJECT_PAST_DUE":
      lines.push(`\nNext step: Use \`get_usage\` to inspect lifecycle state, or \`set_tier\` to renew/reactivate the project.`);
      return true;
    case "RATE_LIMITED":
      lines.push(`\nNext step: Rate limit hit. Wait and retry.`);
      return true;
    case "MIGRATE_GATE_ACTIVE":
      lines.push(`\nNext step: A deploy migration gate is active. Wait for the retry window or inspect the deploy operation before retrying.`);
      return true;
    case "MIGRATION_FAILED":
    case "MIGRATION_CHECKSUM_MISMATCH":
      lines.push(`\nNext step: Inspect and edit the migration, then submit a corrected deploy request.`);
      return true;
    case "PLAN_NOT_FOUND":
    case "OPERATION_NOT_FOUND":
      lines.push(`\nNext step: Check the deploy plan/operation id, or list recent deploy operations for the project.`);
      return true;
    case "CI_ROUTE_SCOPE_DENIED":
      lines.push(
        `\nNext step: Re-link the GitHub Actions binding with covering \`--route-scope\` patterns, or run the route-changing deploy locally with allowance-backed authority.`,
      );
      return true;
    default:
      return false;
  }
}

function formatNextActions(actions: unknown[]): string[] {
  const lines = ["Next actions:"];
  for (const action of actions) {
    if (action && typeof action === "object" && !Array.isArray(action)) {
      const obj = action as Record<string, unknown>;
      const name =
        stringField(obj, "action") ??
        stringField(obj, "type") ??
        stringField(obj, "name") ??
        stringField(obj, "kind");
      const description =
        stringField(obj, "label") ??
        stringField(obj, "description") ??
        stringField(obj, "message") ??
        stringField(obj, "hint");
      if (name) {
        lines.push(`- ${name}${description ? `: ${description}` : ""}`);
        continue;
      }
    }
    lines.push(`- ${JSON.stringify(action)}`);
  }
  return lines;
}

function canonicalString(source: unknown, snake: string, camel = snake): string | undefined {
  const value = canonicalValue(source, snake, camel);
  return typeof value === "string" ? value : undefined;
}

function canonicalBoolean(source: unknown, snake: string, camel = snake): boolean | undefined {
  const value = canonicalValue(source, snake, camel);
  return typeof value === "boolean" ? value : undefined;
}

function canonicalNumber(source: unknown, snake: string, camel = snake): number | undefined {
  const value = canonicalValue(source, snake, camel);
  return typeof value === "number" ? value : undefined;
}

function canonicalValue(source: unknown, snake: string, camel = snake): unknown {
  const sourceObj = source && typeof source === "object" ? (source as Record<string, unknown>) : null;
  const body =
    source instanceof Run402Error && source.body && typeof source.body === "object"
      ? (source.body as Record<string, unknown>)
      : sourceObj;
  if (body && body[snake] !== undefined) return body[snake];
  if (sourceObj && sourceObj[camel] !== undefined) return sourceObj[camel];
  if (sourceObj && sourceObj[snake] !== undefined) return sourceObj[snake];
  return undefined;
}

function stringField(obj: Record<string, unknown> | null | undefined, key: string): string | undefined {
  return typeof obj?.[key] === "string" ? (obj[key] as string) : undefined;
}

function isNonEmptyRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value as Record<string, unknown>).length > 0,
  );
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

/**
 * Translate an SDK error into the MCP tool-result shape.
 *
 * Routing:
 *   - `ProjectNotFound` → {@link projectNotFound} (preserves existing text)
 *   - HTTP-backed errors (status !== null) → {@link formatApiError}
 *   - `NetworkError` / other `Run402Error` with no status → plain isError text
 *   - Unknown throwables → plain isError text
 *
 * Call this in the catch branch of a thin MCP shim that otherwise does
 * nothing but delegate to an SDK method and format the successful result.
 */
export function mapSdkError(err: unknown, context: string): ToolResult {
  if (err instanceof SdkProjectNotFound) {
    return projectNotFound(err.projectId);
  }
  if (err instanceof Run402Error) {
    if (err.status !== null) {
      return formatApiError({ status: err.status, body: err.body }, context);
    }
    if (err instanceof NetworkError) {
      return {
        content: [{ type: "text", text: `Error ${context}: ${err.message}` }],
        isError: true,
      };
    }
    return {
      content: [{ type: "text", text: `Error ${context}: ${err.message}` }],
      isError: true,
    };
  }
  return {
    content: [
      {
        type: "text",
        text: `Error ${context}: ${(err as Error)?.message ?? String(err)}`,
      },
    ],
    isError: true,
  };
}
