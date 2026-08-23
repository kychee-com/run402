/**
 * gitvault MCP tools — `get_gitvault_status`, `list_gitvault_heads`,
 * `verify_gitvault`.
 *
 * READ-ONLY BY DESIGN. The vault's mutating verbs are deliberately CLI-only:
 *
 *   - `push` / `init` write an IMMUTABLE generation. There is no undo for a
 *     head that was signed and admitted, so the operation wants a human-visible
 *     command with a working tree in front of it, not a tool call whose
 *     arguments an agent inferred.
 *   - `init` also mints the ONE-SHOT recovery receipt. It is printed once,
 *     never re-derivable, and an MCP transcript is the wrong place for the only
 *     copy of it to exist.
 *   - `compact` holds a maintenance lease whose `holder_token` is returned
 *     exactly once and is the liveness instrument for heartbeat and release: a
 *     dropped MCP session strands the lease with nothing able to release it.
 *   - `prune` is destructive by contract (it is what removes retained roots),
 *     and `deploy` couples the vault lane to an activation that can change what
 *     production serves.
 *   - `setPolicy` needs an active OWNER membership plus step-up auth, which the
 *     MCP credential path does not carry — offering it here would only produce
 *     confident 403s.
 *
 * Every one of them is reachable as `run402 gitvault …`. These three tools are
 * what an agent needs to ANSWER questions — is there a vault, is my chain
 * intact, what has been admitted — which is the half that composes safely with
 * an autonomous loop.
 */

import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";
import { resolveProjectId } from "../active-project.js";
import { storeResult } from "../result-store.js";

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

/**
 * The scoped confidentiality sentence — the ONLY permitted form (protocol D57 /
 * D168). The unqualified variants of this claim are on the banned-copy list
 * because they drop the scope; `gitvault-copy.test.ts` holds that list verbatim
 * and fails the build if one appears here.
 */
const SCOPED_CONFIDENTIALITY =
  "source payload and repository-history content are ciphertext-only; the substrate retains only enumerated plaintext metadata and holds zero vault keys";

/** The keystore-qualified durability sentence (protocol §0). Durability without this qualifier is banned copy. */
const KEYSTORE_QUALIFIED_DURABILITY =
  "The vault protects source history from host-side loss while a principal keystore survives.";

/** Where a vault verb should act. `repo_id` wins; otherwise the project resolves it. */
interface VaultTargetArgs {
  repo_id?: string;
  project_id?: string;
}

type ResolvedTarget = { repo_id: string; project_id: null } | { repo_id: null; project_id: string };

/**
 * Resolve which vault to act on, falling back to the active project so a
 * single-project agent does not thread ids through every call.
 */
async function resolveVaultTarget(args: VaultTargetArgs): Promise<ResolvedTarget | ToolResult> {
  const repoId = args.repo_id?.trim();
  if (repoId) return { repo_id: repoId, project_id: null };
  const projectId = await resolveProjectId(args.project_id);
  if (typeof projectId !== "string") return projectId;
  return { repo_id: null, project_id: projectId };
}

function isToolResult(value: unknown): value is ToolResult {
  return typeof value === "object" && value !== null && Array.isArray((value as ToolResult).content);
}

/** `{repo_id}` or `{project_id}`, in the shape the SDK's vault-handle options take. */
function targetOptions(target: ResolvedTarget): { repo_id?: string; project_id?: string } {
  return target.repo_id !== null ? { repo_id: target.repo_id } : { project_id: target.project_id };
}

// ─── get_gitvault_status ─────────────────────────────────────────────────────

/** What this machine and the control plane each believe about the vault. */
export const getGitvaultStatusSchema = {
  project_id: z
    .string()
    .optional()
    .describe("The project whose vault to report. Defaults to the active project. The cold-restart entry point: it resolves repo_id with no local state."),
  repo_id: z.string().optional().describe("Address the vault directly when you already know its id. Wins over project_id."),
};

export async function handleGetGitvaultStatus(args: { project_id?: string; repo_id?: string }): Promise<ToolResult> {
  const target = await resolveVaultTarget(args);
  if (isToolResult(target)) return target;

  try {
    const status = await getSdk().gitvault.status(targetOptions(target));
    const v = status.vault;
    const lines: string[] = [];

    lines.push(
      status.repo_id
        ? `gitvault ${status.repo_id}${status.project_id ? ` — project ${status.project_id}` : ""}`
        : `No vault is allocated${status.project_id ? ` for project ${status.project_id}` : ""}.`,
    );

    if (v) {
      lines.push(
        "",
        "Vault",
        `  policy                 ${v.gitvault_policy ?? "(unset)"} (version ${v.gitvault_policy_version})`,
        `  allocation generation  ${v.allocation_generation}`,
        `  newest generation      ${v.newest_generation ?? "(none admitted)"}`,
        `  admitted generations   ${v.admitted_generations}`,
        `  genesis admitted at    ${v.genesis_admitted_at ?? "(not yet)"}`,
        `  source bytes           ${v.storage.source_bytes}`,
        `  repair fence           ${v.repair_fence_state} (version ${v.repair_version})`,
      );
      if (v.maintenance.lease) {
        lines.push(
          `  maintenance lease      ${v.maintenance.lease.maintenance_lease_id} (expires ${v.maintenance.lease.expires_at ?? "unknown"})`,
          "                         a compact/prune cycle holds the reservation; run402 gitvault compact owns it.",
        );
      }
      if (v.maintenance.open_cycle) {
        lines.push(`  open cycle             ${v.maintenance.open_cycle.maintenance_cycle_id} (${v.maintenance.open_cycle.state})`);
      }
    }

    lines.push(
      "",
      "Keystore (this machine)",
      `  present                ${status.keystore.present ? "yes" : "no"}`,
      `  identity fingerprint   ${status.keystore.identity_fingerprint ?? "(none)"}`,
      `  can sign               ${status.keystore.can_sign ? "yes" : "no — read-only: this principal can decrypt and verify but cannot publish a new head"}`,
      `  holds repo key         ${status.keystore.holds_repo_key ? "yes" : "no"}`,
      // The directory to back up. The terminal-loss statement below is stated
      // on every gitvault surface; until 5.13 the path it implicitly refers to
      // was printed on none of them, which made the warning unactionable
      // (dogfood #1, finding D2). A filesystem path is not key material.
      `  keystore directory     ${status.keystore.root}  (back this up)`,
      "",
      "Pins",
      `  highest authenticated  ${status.pins.highest_authenticated ?? "(none)"}`,
      `  highest materialized   ${status.pins.highest_materialized ?? "(none)"}`,
      "",
      `Pending unvaulted-override journals: ${status.pending_overrides}`,
    );

    if (status.warnings.length > 0) {
      lines.push("", "Warnings");
      for (const w of status.warnings) lines.push(`  - ${w.kind}: ${w.message}`);
    }
    if (status.next_actions.length > 0) {
      lines.push("", "Next");
      for (const a of status.next_actions) lines.push(`  - ${a.action}${a.command ? `  (${a.command})` : ""}`);
    }

    // Normative copy, printed verbatim. The sentences come from the SDK's own
    // constants, so this surface cannot paraphrase them by drifting.
    lines.push(
      "",
      status.terminal_loss_statement,
      "",
      status.terminal_loss_detail,
      "",
      `Confidentiality: ${SCOPED_CONFIDENTIALITY}.`,
    );

    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    return mapSdkError(err, "reading the gitvault status");
  }
}

// ─── list_gitvault_heads ─────────────────────────────────────────────────────

/** One page of the heads listing, above a fixed verification anchor. */
export const listGitvaultHeadsSchema = {
  repo_id: z.string().optional().describe("The vault to list. Wins over project_id."),
  project_id: z.string().optional().describe("Resolves repo_id from the project. Defaults to the active project."),
  after_generation: z
    .string()
    .describe(
      "The VERIFICATION ANCHOR — 16 lowercase hex, required. It is not a paging knob: it fixes the generation the whole listing is verified above, and it MUST stay identical across every page of one sequence. Change it and you have started a different listing.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .describe("How many heads the server may return in this page, 1..1000. Required."),
  cursor: z
    .string()
    .optional()
    .describe(
      "Omit on the first request. Afterwards pass the prior page's next_cursor UNCHANGED — it is opaque: store and echo it, never parse or construct one. A malformed or stale cursor is INVALID_CURSOR; recover by restarting from after_generation with no cursor.",
    ),
};

export async function handleListGitvaultHeads(args: {
  repo_id?: string;
  project_id?: string;
  after_generation: string;
  limit: number;
  cursor?: string;
}): Promise<ToolResult> {
  const target = await resolveVaultTarget(args);
  if (isToolResult(target)) return target;

  try {
    const sdk = getSdk();
    const repoId = target.repo_id ?? (await sdk.gitvault.forProject(target.project_id)).repo_id;
    const page = await sdk.gitvault.heads(repoId, {
      after_generation: args.after_generation,
      limit: String(args.limit),
      ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
    });

    // The full page is persisted; only the window is rendered. A vault with a
    // thousand admitted generations must not spend an agent's context on rows
    // it did not ask to read.
    const view = storeResult("gitvault_heads", page.heads);

    const lines = [
      `gitvault ${page.repo_id} — heads above anchor ${page.after_generation}.`,
      `Showing ${view.shown} of ${view.total} in this page${page.total !== null ? `; ${page.total} heads above the anchor in total` : ""}.`,
    ];
    if (view.ref && view.shown < view.total) {
      lines.push(`The rest of this page: expand_result with ref ${view.ref}.`);
    }
    lines.push("");
    for (const h of view.items) lines.push(`  ${h.generation}  ${h.stored_bytes_sha256}`);
    if (view.total === 0) lines.push("  (no heads above the anchor)");

    lines.push("");
    if (page.has_more && page.next_cursor !== null) {
      lines.push(
        `More pages: call again with the SAME after_generation (${page.after_generation}) and cursor ${page.next_cursor}.`,
        "Echo that cursor unchanged — it is opaque. A malformed or stale one is INVALID_CURSOR; restart from after_generation with no cursor.",
      );
    } else {
      lines.push("has_more is false — this is the last page of the sequence.");
    }
    lines.push(
      "",
      "Listing a head is not verifying it. Run verify_gitvault to check the chain links and advance the local authenticated pin.",
    );

    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    return mapSdkError(err, "listing gitvault heads");
  }
}

// ─── verify_gitvault ─────────────────────────────────────────────────────────

/** Verify the chain from the authenticated pin upward, then advance the pin. */
export const verifyGitvaultSchema = {
  project_id: z.string().optional().describe("The project whose vault to verify. Defaults to the active project."),
  repo_id: z.string().optional().describe("Address the vault directly. Wins over project_id."),
};

/** Plain-language recovery for the refusals verification is designed to produce. */
const VERIFY_FAILURE_GUIDANCE: Record<string, string> = {
  GENERATION_REGRESSION:
    "The vault offered a generation at or below your authenticated pin — a rollback. Verification fails closed and the pin is NOT moved backwards; nothing local was rewritten. Treat this as a serious integrity signal about the remote, not a local problem to clear.",
  CHAIN_BROKEN:
    "A link is missing or does not match: a listed head absent from storage, a gap in the sequence, or a head whose previous-hash does not chain. Verification stops at the last good generation and the pin stays there.",
  UPGRADE_REQUIRED:
    "The chain contains a transition this client cannot validate. It is read-only past that point and the transition is never skipped — upgrade the client (npx run402@latest) and verify again.",
  VERIFICATION_BUDGET_EXCEEDED:
    "The per-call head budget ran out. The verified prefix is persisted, so this is a pause, not a failure: call verify_gitvault again and it resumes from where it stopped.",
};

export async function handleVerifyGitvault(args: { project_id?: string; repo_id?: string }): Promise<ToolResult> {
  const target = await resolveVaultTarget(args);
  if (isToolResult(target)) return target;

  try {
    const state = await getSdk().gitvault.verify(targetOptions(target));
    const lines = [
      `Verified to generation ${state.generation} (head ${state.head_sha256}).`,
      "",
      "The local authenticated pin now sits at that generation. The pin only ever moves forward: verification is monotonic and non-destructive — it rewrites no history and can never lower the pin.",
      "",
      `Vault ${state.genesis.repo_id} — project ${state.genesis.project_id}, org ${state.genesis.org_id}.`,
      `Writer key ${state.genesis.writer_key_id}, genesis created ${state.genesis.created_at}.`,
    ];
    if (state.head === null) {
      lines.push("", "Nothing has been admitted above genesis yet: the chain is a single genesis object.");
    } else {
      lines.push(
        "",
        `Newest head: generation ${state.head.generation}, epoch ${state.head.epoch}${state.head.checkpoint ? ", checkpoint-bearing" : ""}.`,
      );
    }
    lines.push("", KEYSTORE_QUALIFIED_DURABILITY);
    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    const code = typeof (err as { code?: unknown })?.code === "string" ? ((err as { code: string }).code) : null;
    const mapped = mapSdkError(err, "verifying the gitvault chain");
    const guidance = code ? VERIFY_FAILURE_GUIDANCE[code] : undefined;
    if (!guidance) return mapped;
    return {
      ...mapped,
      content: [...mapped.content, { type: "text" as const, text: guidance }],
    };
  }
}
