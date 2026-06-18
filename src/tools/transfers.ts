/**
 * MCP tools for the unified project-transfer flow (v1.93+). Each handler is a
 * thin shim over `r.admin.transfers.*` followed by markdown formatting. One
 * noun, two recipient kinds: a wallet recipient (`to_wallet`, completed via
 * `accept_project_transfer`) or an email recipient (`to_email`, completed via
 * `claim_project_transfer`).
 */

import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

// ─── initiate_project_transfer ──────────────────────────────────────────────

export const initiateProjectTransferSchema = {
  project_id: z
    .string()
    .describe("Project id to transfer. You must currently own or admin it (the gateway verifies against fresh DB state)."),
  to_wallet: z
    .string()
    .optional()
    .describe("Recipient WALLET address (any case — the gateway lowercases). Provide EXACTLY ONE of `to_wallet` or `to_email`. A wallet recipient completes the transfer via `accept_project_transfer`."),
  to_email: z
    .string()
    .optional()
    .describe("Recipient EMAIL. Provide EXACTLY ONE of `to_wallet` or `to_email`. An email recipient completes the transfer via `claim_project_transfer` (they claim it into an org they own)."),
  billing_policy: z
    .enum(["migrate"])
    .optional()
    .describe("Wallet rail only. Phase 1A supports only `migrate` (default). The project moves into the recipient's organization."),
  message: z
    .string()
    .optional()
    .describe("Optional free-text note shown to the recipient in the preview and notification emails."),
  kysigned_record_id: z
    .string()
    .optional()
    .describe("Wallet rail only. Optional KySigned record id. Phase 1A stores this verbatim (no verification)."),
  retain_collaborator_role: z
    .enum(["developer"])
    .optional()
    .describe("Email rail only (v1.91): keep a `developer` membership in the recipient's org after the transfer completes. The recipient must accept it at claim time (`accept_retained_collaborator`). Omit for a full severance."),
};

export async function handleInitiateProjectTransfer(args: {
  project_id: string;
  to_wallet?: string;
  to_email?: string;
  billing_policy?: "migrate";
  message?: string;
  kysigned_record_id?: string;
  retain_collaborator_role?: "developer";
}): Promise<ToolResult> {
  const hasWallet = typeof args.to_wallet === "string" && args.to_wallet.length > 0;
  const hasEmail = typeof args.to_email === "string" && args.to_email.length > 0;
  if (hasWallet === hasEmail) {
    return {
      content: [{ type: "text", text: "Provide exactly one of `to_wallet` or `to_email`." }],
      isError: true,
    };
  }
  try {
    if (hasEmail) {
      const res = await getSdk().admin.transfers.initiate({
        projectId: args.project_id,
        toEmail: args.to_email as string,
        message: args.message,
        retainCollaborator: args.retain_collaborator_role
          ? { role: args.retain_collaborator_role }
          : undefined,
      });
      const lines = [
        `Email transfer initiated for project \`${args.project_id}\`.`,
        `- transfer_id: \`${res.transfer_id}\``,
        `- to_email: ${res.to_email}`,
        `- expires_at: ${res.expires_at} (72h)`,
        ``,
        `The recipient completes by verifying ${res.to_email} and claiming the project into an org (the email analog of accept). Owner-side mutations on this project are blocked until it is claimed, cancelled, or expires. Use \`cancel_project_transfer\` with the transfer id to reverse.`,
      ];
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
    const res = await getSdk().admin.transfers.initiate({
      projectId: args.project_id,
      toWallet: args.to_wallet as string,
      billingPolicy: args.billing_policy,
      message: args.message,
      kysignedRecordId: args.kysigned_record_id,
    });
    const lines = [
      `Transfer initiated for project \`${res.project_summary.project_id}\`.`,
      `- transfer_id: \`${res.transfer_id}\``,
      `- to_wallet: ${res.project_summary.to_wallet}`,
      `- billing_policy: ${res.project_summary.billing_policy}`,
      `- expires_at: ${res.expires_at} (72h)`,
      `- terms_sha256: ${res.terms_sha256}`,
      `- your_unused_lease_days: ${res.your_unused_lease_days} (lease stays with your organization; not refunded)`,
      ``,
      `Owner-side mutations on this project are now blocked until the transfer is accepted, cancelled, or expires. Use \`cancel_project_transfer\` with the transfer id to reverse.`,
    ];
    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    return mapSdkError(err, "initiating project transfer");
  }
}

// ─── preview_project_transfer ───────────────────────────────────────────────

export const previewProjectTransferSchema = {
  transfer_id: z
    .string()
    .describe("Transfer id to preview. You must be a party to it (wallet signer, the addressed-email principal, or an offering-org member). Kind-agnostic — works for wallet and email transfers."),
};

export async function handlePreviewProjectTransfer(args: {
  transfer_id: string;
}): Promise<ToolResult> {
  try {
    const p = await getSdk().admin.transfers.preview(args.transfer_id);
    const lines = [
      `Preview for transfer \`${p.transfer_id}\` (status: ${p.status}, kind: ${p.recipient_kind})`,
      `- project: \`${p.project_id}\`${p.project_name_snapshot ? ` (\`${p.project_name_snapshot}\`)` : ""}`,
    ];
    if (p.recipient_kind === "email") {
      lines.push(`- to_email: ${p.to_email ?? "(unknown)"}`);
    } else {
      lines.push(`- from: ${p.from_wallet_display} → to: ${p.to_wallet_display}`);
    }
    lines.push(`- billing_policy: ${p.billing_policy}`);
    lines.push(`- initiated_at: ${p.initiated_at}`);
    lines.push(`- expires_at: ${p.expires_at}`);
    lines.push(`- terms_sha256: ${p.terms_sha256}`);
    if (p.kysigned_record_id) lines.push(`- kysigned_record_id: ${p.kysigned_record_id}`);
    if (p.message) lines.push(`- message: ${p.message}`);
    if (p.retain_collaborator) {
      lines.push(`- retain_collaborator: ${p.retain_collaborator.sender_label} keeps \`${p.retain_collaborator.role}\` (accept with claim's accept_retained_collaborator)`);
    }
    lines.push(``, `What transfers:`);
    lines.push(`- custom_domains: ${p.custom_domains.length}`);
    lines.push(`- subdomains: ${p.subdomains.length}`);
    lines.push(`- functions: ${p.functions.length}`);
    lines.push(`- secrets: ${p.secret_names.length} (names only — values are NEVER returned)`);
    if (p.secret_names.length > 0) {
      lines.push(`  secret names: ${p.secret_names.map((n) => `\`${n}\``).join(", ")}`);
    }
    lines.push(`- mailboxes: ${p.mailbox_summary.count}`);
    lines.push(`- ci_bindings_to_be_revoked: ${p.ci_bindings_to_be_revoked.length}`);
    lines.push(``, `Note: ${p.github_repo_note}`);
    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    return mapSdkError(err, "previewing project transfer");
  }
}

// ─── accept_project_transfer (WALLET completion) ────────────────────────────

export const acceptProjectTransferSchema = {
  transfer_id: z
    .string()
    .describe("WALLET transfer id to accept. Your wallet must equal the transfer's to_wallet. Atomically flips ownership, revokes the previous owner's CI bindings on the project, and stamps a `secrets_rotation_advised` advisory. (Email transfers complete via `claim_project_transfer`.)"),
};

export async function handleAcceptProjectTransfer(args: {
  transfer_id: string;
}): Promise<ToolResult> {
  try {
    const res = await getSdk().admin.transfers.accept(args.transfer_id);
    const lines = [
      `Transfer accepted. Project \`${res.project_id}\` is now owned by ${res.to_wallet}.`,
      `- completed_at: ${res.completed_at}`,
      `- new_organization_id: ${res.new_organization_id ?? "null"}`,
      `- secrets inherited: ${res.secrets_count_inherited}`,
    ];
    if (res.secret_names_inherited.length > 0) {
      lines.push(`  names: ${res.secret_names_inherited.map((n) => `\`${n}\``).join(", ")}`);
    }
    lines.push(``, `Rotation advised: the project carries inherited secret VALUES from the previous owner. The \`secrets_rotation_advised\` flag stays set until you rotate every inherited secret. Update via \`set_secret\`.`);
    lines.push(``, `Note: ${res.github_repo_note}`);
    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    return mapSdkError(err, "accepting project transfer");
  }
}

// ─── claim_project_transfer (EMAIL completion) ──────────────────────────────

export const claimProjectTransferSchema = {
  transfer_id: z
    .string()
    .describe("EMAIL transfer id to claim. The transfer's addressed email must match your verified email. The email analog of `accept_project_transfer`."),
  org_id: z
    .string()
    .optional()
    .describe("Organization to claim the project into (you must own/admin it). Omit to claim into a brand-new org."),
  accept_retained_collaborator: z
    .boolean()
    .optional()
    .describe("Accept the sender's v1.91 retained-`developer`-membership offer (see the preview's retain_collaborator). Omit (the default) for a full severance."),
};

export async function handleClaimProjectTransfer(args: {
  transfer_id: string;
  org_id?: string;
  accept_retained_collaborator?: boolean;
}): Promise<ToolResult> {
  try {
    const res = await getSdk().admin.transfers.claim(args.transfer_id, {
      organizationId: args.org_id,
      acceptRetainedCollaborator: args.accept_retained_collaborator,
    });
    const lines = [
      `Transfer \`${args.transfer_id}\` claimed. Project \`${res.project_id}\` is now in org \`${res.to_organization_id}\`${res.created_new_org ? " (new org created)" : ""}.`,
      `- status: ${res.status}`,
    ];
    if (res.retained_collaborator_principal_id) {
      lines.push(`- retained_collaborator_principal_id: ${res.retained_collaborator_principal_id}`);
    }
    lines.push(``, `The new owner's project keys were returned and persisted to the local keystore (mirroring accept) — you can deploy / set secrets / run SQL on the project immediately. The service_key JWT is not printed here.`);
    lines.push(``, `Rotation advised: project keys are \`project_id\`-derived and do not rotate on transfer, so the former owner still knows them — the project carries a \`secrets_rotation_advised\` advisory. Rotate inherited secret VALUES via \`set_secret\`.`);
    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    return mapSdkError(err, "claiming project transfer");
  }
}

// ─── cancel_project_transfer ────────────────────────────────────────────────

export const cancelProjectTransferSchema = {
  transfer_id: z
    .string()
    .describe("Transfer id to cancel. You must be authorized for the row's kind (a wallet signing party, or an owner/admin of the offering org / the addressed-email principal). Kind-agnostic."),
  reason: z
    .string()
    .optional()
    .describe("Optional free-text cancellation reason recorded on the audit row."),
};

export async function handleCancelProjectTransfer(args: {
  transfer_id: string;
  reason?: string;
}): Promise<ToolResult> {
  try {
    const res = await getSdk().admin.transfers.cancel(args.transfer_id, args.reason);
    const lines = [
      `Transfer \`${res.transfer_id}\` cancelled.`,
      `- cancelled_by: ${res.cancelled_by}`,
      `- cancelled_at: ${res.cancelled_at}`,
    ];
    if (res.cancellation_reason) lines.push(`- reason: ${res.cancellation_reason}`);
    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    return mapSdkError(err, "cancelling project transfer");
  }
}

// ─── list_incoming_transfers ────────────────────────────────────────────────

export const listIncomingTransfersSchema = {
  limit: z.number().int().positive().optional().describe("Page size (default 50)."),
  after: z.string().optional().describe("Opaque pagination cursor (next_cursor from a prior page)."),
};

export async function handleListIncomingTransfers(args: {
  limit?: number;
  after?: string;
}): Promise<ToolResult> {
  try {
    const res = await getSdk().admin.transfers.listIncoming({
      limit: args.limit,
      after: args.after,
    });
    if (res.transfers.length === 0) {
      return { content: [{ type: "text", text: "No pending incoming transfers." }] };
    }
    const lines = [`Pending incoming transfers (${res.transfers.length}):`];
    for (const t of res.transfers) {
      const who = t.recipient_kind === "email" ? `to_email ${t.to_email}` : `from ${t.from_wallet}`;
      lines.push(`- \`${t.transfer_id}\` [${t.recipient_kind}] — project \`${t.project_id}\`${t.project_name_snapshot ? ` (${t.project_name_snapshot})` : ""}, ${who}, billing_policy=${t.billing_policy}, expires ${t.expires_at}`);
      lines.push(`  preview: ${t.preview_path}`);
    }
    if (res.has_more) {
      lines.push(`More available (next_cursor: ${res.next_cursor}). Re-run with after=<cursor>.`);
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    return mapSdkError(err, "listing incoming transfers");
  }
}

// ─── list_outgoing_transfers ────────────────────────────────────────────────

export const listOutgoingTransfersSchema = {
  limit: z.number().int().positive().optional().describe("Page size (default 50)."),
  after: z.string().optional().describe("Opaque pagination cursor (next_cursor from a prior page)."),
};

export async function handleListOutgoingTransfers(args: {
  limit?: number;
  after?: string;
}): Promise<ToolResult> {
  try {
    const res = await getSdk().admin.transfers.listOutgoing({
      limit: args.limit,
      after: args.after,
    });
    if (res.transfers.length === 0) {
      return { content: [{ type: "text", text: "No pending outgoing transfers." }] };
    }
    const lines = [`Pending outgoing transfers (${res.transfers.length}):`];
    for (const t of res.transfers) {
      const who = t.recipient_kind === "email" ? `to_email ${t.to_email}` : `to ${t.to_wallet}`;
      lines.push(`- \`${t.transfer_id}\` [${t.recipient_kind}] — project \`${t.project_id}\`${t.project_name_snapshot ? ` (${t.project_name_snapshot})` : ""}, ${who}, billing_policy=${t.billing_policy}, expires ${t.expires_at}`);
      lines.push(`  preview: ${t.preview_path}`);
    }
    if (res.has_more) {
      lines.push(`More available (next_cursor: ${res.next_cursor}). Re-run with after=<cursor>.`);
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    return mapSdkError(err, "listing outgoing transfers");
  }
}
