/**
 * MCP tools for the v1.59 two-party project transfer flow. Each handler is
 * a thin shim over `r.admin.transfers.*` followed by markdown formatting.
 */

import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

// ─── initiate_project_transfer ──────────────────────────────────────────────

export const initiateProjectTransferSchema = {
  project_id: z
    .string()
    .describe("Project id to transfer. You must currently own it (the gateway verifies against fresh DB state)."),
  to_wallet: z
    .string()
    .describe("Recipient wallet address (any case — the gateway lowercases). Must differ from the current owner."),
  billing_policy: z
    .enum(["migrate"])
    .optional()
    .describe("Billing policy. Phase 1A supports only `migrate` (default). The project moves into the recipient's organization."),
  message: z
    .string()
    .optional()
    .describe("Optional free-text note shown to the recipient in the preview and notification emails."),
  kysigned_record_id: z
    .string()
    .optional()
    .describe("Optional KySigned record id. Phase 1A stores this verbatim (no verification). Phase 1B will verify against the canonical terms hash."),
};

export async function handleInitiateProjectTransfer(args: {
  project_id: string;
  to_wallet: string;
  billing_policy?: "migrate";
  message?: string;
  kysigned_record_id?: string;
}): Promise<ToolResult> {
  try {
    const res = await getSdk().admin.transfers.initiate({
      projectId: args.project_id,
      toWallet: args.to_wallet,
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
    .describe("Transfer id to preview. You must be either the from_wallet or the to_wallet of the transfer."),
};

export async function handlePreviewProjectTransfer(args: {
  transfer_id: string;
}): Promise<ToolResult> {
  try {
    const p = await getSdk().admin.transfers.preview(args.transfer_id);
    const lines = [
      `Preview for transfer \`${p.transfer_id}\` (status: ${p.status})`,
      `- project: \`${p.project_id}\`${p.project_name_snapshot ? ` (\`${p.project_name_snapshot}\`)` : ""}`,
      `- from: ${p.from_wallet_display} → to: ${p.to_wallet_display}`,
      `- billing_policy: ${p.billing_policy}`,
      `- initiated_at: ${p.initiated_at}`,
      `- expires_at: ${p.expires_at}`,
      `- terms_sha256: ${p.terms_sha256}`,
    ];
    if (p.kysigned_record_id) lines.push(`- kysigned_record_id: ${p.kysigned_record_id}`);
    if (p.message) lines.push(`- message: ${p.message}`);
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

// ─── accept_project_transfer ────────────────────────────────────────────────

export const acceptProjectTransferSchema = {
  transfer_id: z
    .string()
    .describe("Transfer id to accept. Your wallet must equal the transfer's to_wallet. Atomically flips ownership, revokes the previous owner's CI bindings on the project, and stamps a `secrets_rotation_advised` advisory."),
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

// ─── cancel_project_transfer ────────────────────────────────────────────────

export const cancelProjectTransferSchema = {
  transfer_id: z
    .string()
    .describe("Transfer id to cancel. You must be either the from_wallet or the to_wallet of the transfer."),
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
  offset: z.number().int().min(0).optional().describe("Pagination offset (default 0)."),
};

export async function handleListIncomingTransfers(args: {
  limit?: number;
  offset?: number;
}): Promise<ToolResult> {
  try {
    const list = await getSdk().admin.transfers.listIncoming({
      limit: args.limit,
      offset: args.offset,
    });
    if (list.length === 0) {
      return { content: [{ type: "text", text: "No pending incoming transfers." }] };
    }
    const lines = [`Pending incoming transfers (${list.length}):`];
    for (const t of list) {
      lines.push(`- \`${t.transfer_id}\` — project \`${t.project_id}\`${t.project_name_snapshot ? ` (${t.project_name_snapshot})` : ""}, from ${t.from_wallet}, billing_policy=${t.billing_policy}, expires ${t.expires_at}`);
      lines.push(`  preview: ${t.preview_path}`);
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    return mapSdkError(err, "listing incoming transfers");
  }
}

// ─── list_outgoing_transfers ────────────────────────────────────────────────

export const listOutgoingTransfersSchema = {
  limit: z.number().int().positive().optional().describe("Page size (default 50)."),
  offset: z.number().int().min(0).optional().describe("Pagination offset (default 0)."),
};

export async function handleListOutgoingTransfers(args: {
  limit?: number;
  offset?: number;
}): Promise<ToolResult> {
  try {
    const list = await getSdk().admin.transfers.listOutgoing({
      limit: args.limit,
      offset: args.offset,
    });
    if (list.length === 0) {
      return { content: [{ type: "text", text: "No pending outgoing transfers." }] };
    }
    const lines = [`Pending outgoing transfers (${list.length}):`];
    for (const t of list) {
      lines.push(`- \`${t.transfer_id}\` — project \`${t.project_id}\`${t.project_name_snapshot ? ` (${t.project_name_snapshot})` : ""}, to ${t.to_wallet}, billing_policy=${t.billing_policy}, expires ${t.expires_at}`);
      lines.push(`  preview: ${t.preview_path}`);
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    return mapSdkError(err, "listing outgoing transfers");
  }
}
