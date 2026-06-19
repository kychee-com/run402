/**
 * MCP tools for the org-owned control plane (gateway v1.77+, first-class in
 * v1.82): create/get/rename an org, resolve the principal + memberships, list
 * orgs, and manage org membership. Each handler is a thin shim over `r.orgs.*`
 * (collection) or `r.org(id).*` (scoped instance) followed by markdown
 * formatting. Mutations are owner-gated + step-up gated server-side.
 *
 * The wallet-org CLAIM flow is intentionally CLI + SDK only — it needs a
 * write-capable control-plane session (browser loopback login) + a fresh passkey
 * step-up, which does not fit the MCP tool model. Use `run402 operator
 * claim-wallet-org` or the SDK `claimWalletOrg` Node convenience.
 */

import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";
import type { OrgRole } from "../../sdk/dist/index.js";

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const ROLE = z.enum(["owner", "admin", "developer", "billing", "viewer"]);

/** Render an org id with its label when present. */
function orgLabel(orgId: string, displayName: string | null | undefined): string {
  return displayName ? `\`${orgId}\` ("${displayName}")` : `\`${orgId}\``;
}

function orgTier(tier: string | null | undefined): string {
  return tier ?? "(no active tier)";
}

function orgLeaseLines(org: {
  tier?: string | null;
  lease_started_at?: string | null;
  lease_expires_at?: string | null;
}): string[] {
  return [
    `- tier: ${orgTier(org.tier)}`,
    `- lease_started_at: ${org.lease_started_at ?? "null"}`,
    `- lease_expires_at: ${org.lease_expires_at ?? "null"}`,
  ];
}

// ─── create_org ───────────────────────────────────────────────────────────────

export const createOrgSchema = {
  display_name: z
    .string()
    .optional()
    .describe("Optional free-text label (e.g. `Kychee`). Non-unique, not an id. Omit for an unlabeled org. There is no tier input at create; the response reports the created org's prototype tier/lease state."),
};

export async function handleCreateOrg(args: { display_name?: string }): Promise<ToolResult> {
  try {
    const org = await getSdk().orgs.create({ displayName: args.display_name });
    return {
      content: [
        {
          type: "text",
          text: [
            `Created org ${orgLabel(org.org_id, org.display_name)}. You are the owner.`,
            ...orgLeaseLines(org),
          ].join("\n"),
        },
      ],
    };
  } catch (err) {
    return mapSdkError(err, "creating organization");
  }
}

// ─── get_org ────────────────────────────────────────────────────────────────

export const getOrgSchema = {
  org_id: z.string().describe("The org id, e.g. `org_...`."),
};

export async function handleGetOrg(args: { org_id: string }): Promise<ToolResult> {
  try {
    const org = await getSdk().org(args.org_id).get();
    const lines = [
      `Org ${orgLabel(org.org_id, org.display_name)}:`,
      ...orgLeaseLines(org),
      `- your role: ${org.role ?? "(admin — not a member)"}`,
    ];
    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    return mapSdkError(err, "reading org");
  }
}

// ─── rename_org ─────────────────────────────────────────────────────────────

export const renameOrgSchema = {
  org_id: z.string().describe("The org id to rename."),
  display_name: z
    .string()
    .nullable()
    .describe("New label. Pass `null` or an empty string to clear the label. Owner-only + step-up gated."),
};

export async function handleRenameOrg(args: { org_id: string; display_name: string | null }): Promise<ToolResult> {
  try {
    const org = await getSdk().org(args.org_id).rename(args.display_name);
    return {
      content: [
        {
          type: "text",
          text: [
            org.display_name
              ? `Renamed ${`\`${org.org_id}\``} to "${org.display_name}".`
              : `Cleared the label on \`${org.org_id}\`.`,
            ...orgLeaseLines(org),
          ].join("\n"),
        },
      ],
    };
  } catch (err) {
    return mapSdkError(err, "renaming org");
  }
}

// ─── whoami ─────────────────────────────────────────────────────────────────

export const whoamiSchema = {};

export async function handleWhoami(): Promise<ToolResult> {
  try {
    const me = await getSdk().orgs.whoami();
    const lines = [
      `Principal \`${me.principal.id}\` (${me.principal.type}${me.principal.display_name ? `, ${me.principal.display_name}` : ""}).`,
      `- authenticator_id: \`${me.authenticator_id}\``,
      `- memberships (${me.memberships.length}):`,
      ...me.memberships.map(
        (m) => `  - org ${orgLabel(m.org_id, m.display_name)} — role ${m.role} (${m.status})`,
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
    const orgs = await getSdk().orgs.list();
    if (orgs.length === 0) {
      return { content: [{ type: "text", text: "You are not a member of any org." }] };
    }
    const lines = [
      `Organizations (${orgs.length}):`,
      ...orgs.map((m) => `- ${orgLabel(m.org_id, m.display_name)} — role ${m.role} (${m.status})`),
    ];
    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    return mapSdkError(err, "listing organizations");
  }
}

// ─── list_org_members ───────────────────────────────────────────────────────

export const listOrgMembersSchema = {
  org_id: z.string().describe("The org id, e.g. `org_...`."),
};

export async function handleListOrgMembers(args: { org_id: string }): Promise<ToolResult> {
  try {
    const members = await getSdk().org(args.org_id).members.list();
    if (members.length === 0) {
      return { content: [{ type: "text", text: `No members in \`${args.org_id}\`.` }] };
    }
    const lines = [
      `Members of \`${args.org_id}\` (${members.length}):`,
      ...members.map((m) => `- \`${m.principal_id}\` — role ${m.role} (${m.status})`),
    ];
    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    return mapSdkError(err, "listing org members");
  }
}

// ─── add_org_member ─────────────────────────────────────────────────────────

export const addOrgMemberSchema = {
  org_id: z.string().describe("The org id to add the member to."),
  wallet: z.string().describe("EVM address (or named wallet) to add. A brand-new wallet is provisioned as a `human` principal."),
  role: ROLE.optional().describe("Initial role. Defaults to `developer` when omitted. Requires you to be an active `owner`."),
};

export async function handleAddOrgMember(args: {
  org_id: string;
  wallet: string;
  role?: OrgRole;
}): Promise<ToolResult> {
  try {
    const res = await getSdk().org(args.org_id).members.add({
      wallet: args.wallet,
      role: args.role,
    });
    return {
      content: [
        {
          type: "text",
          text: `Added principal \`${res.principal_id}\` to \`${args.org_id}\` as ${res.role}.`,
        },
      ],
    };
  } catch (err) {
    return mapSdkError(err, "adding org member");
  }
}

// ─── set_org_member_role ────────────────────────────────────────────────────

export const setOrgMemberRoleSchema = {
  org_id: z.string().describe("The org id."),
  principal_id: z.string().describe("The member principal id, e.g. `prn_...` (from `list_org_members`)."),
  role: ROLE.describe("New role: owner > admin > developer > billing > viewer. Requires you to be an active `owner`."),
};

export async function handleSetOrgMemberRole(args: {
  org_id: string;
  principal_id: string;
  role: OrgRole;
}): Promise<ToolResult> {
  try {
    const res = await getSdk().org(args.org_id).members.setRole(args.principal_id, args.role);
    return {
      content: [{ type: "text", text: `Principal \`${res.principal_id}\` is now ${res.role}.` }],
    };
  } catch (err) {
    return mapSdkError(err, "setting org member role");
  }
}

// ─── remove_org_member ──────────────────────────────────────────────────────

export const removeOrgMemberSchema = {
  org_id: z.string().describe("The org id."),
  principal_id: z.string().describe("The member principal id to remove. Removing the org's only active owner fails with `409 LAST_OWNER`."),
};

export async function handleRemoveOrgMember(args: {
  org_id: string;
  principal_id: string;
}): Promise<ToolResult> {
  try {
    const res = await getSdk().org(args.org_id).members.revoke(args.principal_id);
    return {
      content: [{ type: "text", text: `Removed principal \`${res.principal_id}\` from \`${args.org_id}\`.` }],
    };
  } catch (err) {
    return mapSdkError(err, "removing org member");
  }
}
