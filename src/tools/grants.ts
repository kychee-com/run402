/**
 * MCP tools for per-project capability grants and their grant keys: issue,
 * list, and revoke a grant for an agent or CI principal on a single project,
 * and revoke one grant key. Thin shims over `r.grants.*`. Every call requires
 * owner of the project's org.
 *
 * Minting and rotating a grant key are deliberately CLI/SDK-only: each returns
 * a token exactly once, and MCP renders tool output into an agent transcript,
 * where a once-printed secret must never be persisted.
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
  grant_id: z.string().describe("The grant id to revoke (from `list_project_grants`). Revokes every grant key minted against it too."),
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

// ─── list_project_grants ────────────────────────────────────────────────────

export const listProjectGrantsSchema = {
  project_id: z.string().describe("Project id whose grants to list."),
};

export async function handleListProjectGrants(args: { project_id: string }): Promise<ToolResult> {
  try {
    const res = await getSdk().grants.list(args.project_id);
    if (res.grants.length === 0) {
      return { content: [{ type: "text", text: `No grants on \`${args.project_id}\`.` }] };
    }
    const lines = [`## Grants on \`${args.project_id}\``, ""];
    for (const g of res.grants) {
      const state = g.revoked_at ? `revoked ${g.revoked_at}` : g.expires_at ? `expires ${g.expires_at}` : "no expiry";
      lines.push(`- \`${g.grant_id}\` — \`${g.capability}\` for ${g.wallet ? `\`${g.wallet}\`` : `principal \`${g.principal_id}\``} (${state})`);
      for (const k of g.keys) {
        const keyState = k.revoked_at ? `revoked ${k.revoked_at}` : k.expires_at ? `expires ${k.expires_at}` : "no expiry";
        lines.push(`  - key \`${k.key_id}\` — ${k.kind} (${keyState})`);
      }
    }
    lines.push("", "Grant keys never carry a token here; mint or rotate one with the CLI (`run402 grants create --key`, `run402 grants rotate-key`).");
    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    return mapSdkError(err, "listing project grants");
  }
}

// ─── revoke_project_grant_key ───────────────────────────────────────────────

export const revokeProjectGrantKeySchema = {
  project_id: z.string().describe("Project id the grant key belongs to."),
  key_id: z.string().describe("The grant key id to revoke (from `list_project_grants`)."),
};

export async function handleRevokeProjectGrantKey(args: {
  project_id: string;
  key_id: string;
}): Promise<ToolResult> {
  try {
    const res = await getSdk().grants.revokeKey(args.project_id, args.key_id);
    return {
      content: [{ type: "text", text: `Revoked grant key \`${res.key_id}\` on \`${args.project_id}\`. The grant and its other keys stay.` }],
    };
  } catch (err) {
    return mapSdkError(err, "revoking grant key");
  }
}
