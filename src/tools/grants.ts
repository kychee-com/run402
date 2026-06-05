/**
 * MCP tools for per-project capability grants (gateway `org-member-management`):
 * issue / revoke a grant to an agent or CI principal for a single project. Thin
 * shims over `r.grants.*`. Mutations require owner of the project's org.
 */

import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

// ─── create_project_grant ───────────────────────────────────────────────────

export const createProjectGrantSchema = {
  project_id: z.string().describe("Project id to grant access to."),
  wallet: z.string().describe("EVM address (or named wallet) the grant is issued to."),
  capability: z.string().describe("Capability to grant, e.g. `deploy` or `functions:write`."),
  policy: z.record(z.unknown()).optional().describe("Optional capability-scoping policy object (gateway-interpreted)."),
  expires_at: z.string().optional().describe("Optional ISO-8601 expiry. Omit for a non-expiring grant."),
};

export async function handleCreateProjectGrant(args: {
  project_id: string;
  wallet: string;
  capability: string;
  policy?: Record<string, unknown>;
  expires_at?: string;
}): Promise<ToolResult> {
  try {
    const res = await getSdk().grants.create(args.project_id, {
      wallet: args.wallet,
      capability: args.capability,
      policy: args.policy,
      expiresAt: args.expires_at,
    });
    return {
      content: [
        {
          type: "text",
          text: `Granted \`${args.capability}\` on \`${args.project_id}\` to principal \`${res.principal_id}\` (grant_id: \`${res.grant_id}\`).`,
        },
      ],
    };
  } catch (err) {
    return mapSdkError(err, "creating project grant");
  }
}

// ─── revoke_project_grant ───────────────────────────────────────────────────

export const revokeProjectGrantSchema = {
  project_id: z.string().describe("Project id the grant belongs to."),
  grant_id: z.string().describe("The grant id to revoke, e.g. `grt_...`."),
};

export async function handleRevokeProjectGrant(args: {
  project_id: string;
  grant_id: string;
}): Promise<ToolResult> {
  try {
    const res = await getSdk().grants.revoke(args.project_id, args.grant_id);
    return { content: [{ type: "text", text: `Revoked grant \`${res.grant_id}\` on \`${args.project_id}\`.` }] };
  } catch (err) {
    return mapSdkError(err, "revoking project grant");
  }
}
