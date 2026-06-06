/**
 * MCP tools for the org-owned control plane (gateway v1.77+ /
 * `org-member-management`): resolve the principal + memberships, list orgs, and
 * manage org membership. Each handler is a thin shim over `r.org.*` followed by
 * markdown formatting. Member mutations require an active `owner` membership.
 */

import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";
import type { OrgRole } from "../../sdk/dist/index.js";

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const ROLE = z.enum(["owner", "admin", "developer", "billing", "viewer"]);

// ─── whoami ─────────────────────────────────────────────────────────────────

export const whoamiSchema = {};

export async function handleWhoami(): Promise<ToolResult> {
  try {
    const me = await getSdk().org.whoami();
    const lines = [
      `Principal \`${me.principal.id}\` (${me.principal.type}${me.principal.displayName ? `, ${me.principal.displayName}` : ""}).`,
      `- authenticator_id: \`${me.authenticator_id}\``,
      `- memberships (${me.memberships.length}):`,
      ...me.memberships.map(
        (m) => `  - org \`${m.billing_account_id}\` — role ${m.role} (${m.status})`,
      ),
    ];
    if (me.memberships.length === 0) lines[lines.length - 1] = `- memberships: none`;
    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    return mapSdkError(err, "resolving principal identity");
  }
}

// ─── list_orgs ──────────────────────────────────────────────────────────────

export const listOrgsSchema = {};

export async function handleListOrgs(): Promise<ToolResult> {
  try {
    const orgs = await getSdk().org.list();
    if (orgs.length === 0) {
      return { content: [{ type: "text", text: "You are not a member of any org." }] };
    }
    const lines = [
      `Organizations (${orgs.length}):`,
      ...orgs.map((m) => `- \`${m.billing_account_id}\` — role ${m.role} (${m.status})`),
    ];
    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    return mapSdkError(err, "listing organizations");
  }
}

// ─── list_org_members ───────────────────────────────────────────────────────

export const listOrgMembersSchema = {
  billing_account_id: z.string().describe("The org (billing account) id, e.g. `ba_...`."),
};

export async function handleListOrgMembers(args: { billing_account_id: string }): Promise<ToolResult> {
  try {
    const members = await getSdk().org.members(args.billing_account_id);
    if (members.length === 0) {
      return { content: [{ type: "text", text: `No members in \`${args.billing_account_id}\`.` }] };
    }
    const lines = [
      `Members of \`${args.billing_account_id}\` (${members.length}):`,
      ...members.map((m) => `- \`${m.principal_id}\` — role ${m.role} (${m.status})`),
    ];
    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    return mapSdkError(err, "listing org members");
  }
}

// ─── add_org_member ─────────────────────────────────────────────────────────

export const addOrgMemberSchema = {
  billing_account_id: z.string().describe("The org (billing account) id to add the member to."),
  wallet: z.string().describe("EVM address (or named wallet) to add. A brand-new wallet is provisioned as a `human` principal."),
  role: ROLE.optional().describe("Initial role. Defaults to `developer` when omitted. Requires you to be an active `owner`."),
};

export async function handleAddOrgMember(args: {
  billing_account_id: string;
  wallet: string;
  role?: OrgRole;
}): Promise<ToolResult> {
  try {
    const res = await getSdk().org.addMember(args.billing_account_id, {
      wallet: args.wallet,
      role: args.role,
    });
    return {
      content: [
        {
          type: "text",
          text: `Added principal \`${res.principal_id}\` to \`${args.billing_account_id}\` as ${res.role}.`,
        },
      ],
    };
  } catch (err) {
    return mapSdkError(err, "adding org member");
  }
}

// ─── set_org_member_role ────────────────────────────────────────────────────

export const setOrgMemberRoleSchema = {
  billing_account_id: z.string().describe("The org (billing account) id."),
  principal_id: z.string().describe("The member principal id, e.g. `prn_...` (from `list_org_members`)."),
  role: ROLE.describe("New role: owner > admin > developer > billing > viewer. Requires you to be an active `owner`."),
};

export async function handleSetOrgMemberRole(args: {
  billing_account_id: string;
  principal_id: string;
  role: OrgRole;
}): Promise<ToolResult> {
  try {
    const res = await getSdk().org.setRole(args.billing_account_id, args.principal_id, args.role);
    return {
      content: [{ type: "text", text: `Principal \`${res.principal_id}\` is now ${res.role}.` }],
    };
  } catch (err) {
    return mapSdkError(err, "setting org member role");
  }
}

// ─── remove_org_member ──────────────────────────────────────────────────────

export const removeOrgMemberSchema = {
  billing_account_id: z.string().describe("The org (billing account) id."),
  principal_id: z.string().describe("The member principal id to remove. Removing the org's only active owner fails with `409 LAST_OWNER`."),
};

export async function handleRemoveOrgMember(args: {
  billing_account_id: string;
  principal_id: string;
}): Promise<ToolResult> {
  try {
    const res = await getSdk().org.removeMember(args.billing_account_id, args.principal_id);
    return {
      content: [{ type: "text", text: `Removed principal \`${res.principal_id}\` from \`${args.billing_account_id}\`.` }],
    };
  } catch (err) {
    return mapSdkError(err, "removing org member");
  }
}
