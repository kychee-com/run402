/**
 * `ai` namespace — project-scoped AI add-ons (translation, moderation) and
 * wallet-scoped image generation.
 */

import type { Client, PaymentSettlement } from "../kernel.js";
import { ApiError, LocalError, isRun402Error } from "../errors.js";
import type { NextAction, Run402Error } from "../errors.js";
import { requireProjectCredentials } from "../project-credentials.js";

export interface TranslateOptions {
  text: string;
  to: string;
  from?: string;
  context?: string;
}

export interface TranslateResult {
  text: string;
  from: string;
  to: string;
}

export interface ModerateResult {
  flagged: boolean;
  categories: Record<string, boolean>;
  category_scores: Record<string, number>;
}

export interface AiUsageResult {
  translation: {
    active: boolean;
    used_words: number;
    included_words: number;
    remaining_words: number;
    billing_cycle_start: string;
  };
}

export type ImageAspect = "square" | "landscape" | "portrait";
const IMAGE_ASPECTS: readonly ImageAspect[] = ["square", "landscape", "portrait"];

export interface GenerateImageOptions {
  prompt: string;
  aspect?: ImageAspect;
  /**
   * The paying organization. Needed only on the MPP Lightning rail when the
   * calling principal belongs to more than one organization; x402 ignores it.
   *
   * When omitted and the gateway answers `ORGANIZATION_SELECTION_REQUIRED`,
   * the SDK retries ONCE with the one candidate from
   * `details.organization_ids` that matches a local context — the
   * provider's active organization (`run402 orgs use`) or the active
   * project's cached owning org, else any locally stored project's owning
   * org. Zero or several matches surface the error with the candidate ids
   * and a next action naming `--org` / `orgId`. Nothing is ever inferred
   * from membership count alone.
   */
  orgId?: string;
}

/** The gateway's answer when a multi-org principal names no paying org on the Lightning rail. */
export const ORGANIZATION_SELECTION_REQUIRED = "ORGANIZATION_SELECTION_REQUIRED";

/** `details.organization_ids` off an `ORGANIZATION_SELECTION_REQUIRED` error, else `[]`. */
export function organizationCandidatesFromError(err: unknown): string[] {
  if (!isRun402Error(err) || err.code !== ORGANIZATION_SELECTION_REQUIRED) return [];
  const details = err.details;
  const ids = details && typeof details === "object" && !Array.isArray(details)
    ? (details as { organization_ids?: unknown }).organization_ids
    : undefined;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string" && id.length > 0) : [];
}

export interface GenerateImageResult {
  /** Base64-encoded bytes. */
  image: string;
  content_type: string;
  aspect: string;
  /**
   * What actually settled for THIS call, from the seller's settlement receipt.
   *
   * `null` when the response carried no receipt — meaning no payment was made
   * on this request (e.g. a prepaid allowance), NOT that one failed. Callers
   * that report a purchase to a human or an agent should surface `network`:
   * the documented quickstart faucet-funds Base Sepolia, so a caller can
   * otherwise watch a payment succeed with no way to know it was test money.
   */
  payment: PaymentSettlement | null;
}

export class Ai {
  constructor(private readonly client: Client) {}

  /** Translate text. Requires the AI Translation add-on on the project. */
  async translate(projectId: string, opts: TranslateOptions): Promise<TranslateResult> {
    const project = await requireProjectCredentials(this.client, projectId, "translating text");

    const body: Record<string, string> = { text: opts.text, to: opts.to };
    if (opts.from) body.from = opts.from;
    if (opts.context) body.context = opts.context;

    return this.client.request<TranslateResult>("/ai/v1/translate", {
      method: "POST",
      headers: { Authorization: `Bearer ${project.service_key}` },
      body,
      context: "translating text",
    });
  }

  /** Run content moderation on text. Free for all projects; requires service key. */
  async moderate(projectId: string, text: string): Promise<ModerateResult> {
    const project = await requireProjectCredentials(this.client, projectId, "moderating content");

    return this.client.request<ModerateResult>("/ai/v1/moderate", {
      method: "POST",
      headers: { Authorization: `Bearer ${project.service_key}` },
      body: { text },
      context: "moderating content",
    });
  }

  /** Get AI translation usage for the current billing cycle. */
  async usage(projectId: string): Promise<AiUsageResult> {
    const project = await requireProjectCredentials(this.client, projectId, "fetching AI usage");

    return this.client.request<AiUsageResult>("/ai/v1/usage", {
      headers: { Authorization: `Bearer ${project.service_key}` },
      context: "fetching AI usage",
    });
  }

  /**
   * Generate an image from a text prompt. Costs $0.03 via x402, MPP on
   * Tempo, or MPP Lightning. No project scope — payment flows through the
   * wallet-based fetch. See {@link GenerateImageOptions.orgId} for how a
   * multi-org principal's paying organization is chosen on Lightning.
   */
  async generateImage(opts: GenerateImageOptions): Promise<GenerateImageResult> {
    const aspect = opts.aspect ?? "square";
    if (!IMAGE_ASPECTS.includes(aspect)) {
      throw new LocalError(
        `aspect must be one of: ${IMAGE_ASPECTS.join(", ")}`,
        "generating image",
      );
    }
    try {
      return await postGenerateImage(this.client, opts.prompt, aspect, opts.orgId);
    } catch (err) {
      // Only an UNNAMED org is disambiguated: a caller-named org that the
      // gateway still refuses is the caller's answer to keep.
      const candidates = opts.orgId ? [] : organizationCandidatesFromError(err);
      if (candidates.length === 0) throw err;
      const matched = await matchKnownOrganization(this.client, candidates);
      if (matched.chosen) return postGenerateImage(this.client, opts.prompt, aspect, matched.chosen);
      throw organizationSelectionError(err as Run402Error, candidates, matched.matches);
    }
  }
}

// Module-level, not class-private: `ScopedRun402`'s drift test enumerates
// every runtime method on a namespace, and a TypeScript `private` is public
// at runtime.

async function postGenerateImage(
  client: Client,
  prompt: string,
  aspect: ImageAspect,
  orgId: string | undefined,
): Promise<GenerateImageResult> {
  // requestWithResponse, not request: the settlement receipt rides the
  // RESPONSE, and `request` discards everything but the body — which is
  // exactly how a caller could buy an image with no way to learn which
  // network the money moved on.
  const res = await client.requestWithResponse<Omit<GenerateImageResult, "payment">>(
    "/generate-image/v1",
    { method: "POST", body: { prompt, aspect, ...(orgId ? { org_id: orgId } : {}) }, context: "generating image" },
  );
  return { ...res.body, payment: res.settlement ?? null };
}

/**
 * Intersect the gateway's candidates with what this machine already knows,
 * most deliberate context first: the SELECTED pair (active org, active
 * project's cached owning org) decides when exactly one candidate matches
 * it; only when it names nothing do the STORED projects' owning orgs get a
 * say, again only when exactly one candidate matches. Every read is local
 * and best-effort — a provider without the optional methods, or a read that
 * throws, contributes nothing rather than failing the purchase.
 */
async function matchKnownOrganization(
  client: Client,
  candidates: string[],
): Promise<{ chosen: string | null; matches: string[] }> {
  const creds = client.credentials;
  const selected = new Set<string>();
  const activeOrg = await optionalRead(() => creds.getActiveOrg?.call(creds));
  if (activeOrg) selected.add(activeOrg);
  const activeProject = await optionalRead(() => creds.getActiveProject?.call(creds));
  if (activeProject) {
    const owning = orgIdOf(await optionalRead(() => client.getProjectCredentials(activeProject)));
    if (owning) selected.add(owning);
  }
  const stored = new Set<string>();
  const listed = await optionalRead(() => creds.listProjectCredentials?.call(creds));
  for (const entry of Object.values(listed ?? {})) {
    const owning = orgIdOf(entry);
    if (owning) stored.add(owning);
  }
  const inSelected = candidates.filter((id) => selected.has(id));
  if (inSelected.length === 1) return { chosen: inSelected[0]!, matches: inSelected };
  if (inSelected.length > 1) return { chosen: null, matches: inSelected };
  const inStored = candidates.filter((id) => stored.has(id));
  return { chosen: inStored.length === 1 ? inStored[0]! : null, matches: inStored };
}

async function optionalRead<T>(read: () => Promise<T> | T | undefined): Promise<T | null> {
  try {
    const value = await read();
    return value === undefined ? null : value;
  } catch {
    return null;
  }
}

function orgIdOf(entry: unknown): string | null {
  const orgId = entry && typeof entry === "object" ? (entry as { org_id?: unknown }).org_id : undefined;
  return typeof orgId === "string" && orgId.length > 0 ? orgId : null;
}

/**
 * The gateway's `ORGANIZATION_SELECTION_REQUIRED` answer, re-thrown with the
 * candidates named in the message and a next action that says how to name
 * the paying organization. Status, code, and the raw envelope are kept.
 */
function organizationSelectionError(err: Run402Error, candidates: string[], matches: string[]): ApiError {
  const envelope = err.body && typeof err.body === "object" && !Array.isArray(err.body)
    ? (err.body as Record<string, unknown>)
    : {};
  const details = envelope.details && typeof envelope.details === "object" && !Array.isArray(envelope.details)
    ? (envelope.details as Record<string, unknown>)
    : {};
  const reason = matches.length > 1
    ? `${matches.length} of them (${matches.join(", ")}) match this machine's local context, so none was chosen`
    : "none of them matches this machine's local context (run402 orgs use, the active project, or a stored project)";
  const message =
    `The paying organization is required: this principal belongs to ${candidates.length} organizations ` +
    `(${candidates.join(", ")}) and ${reason}; name one with orgId (CLI: --org <org_id>) while generating image (HTTP ${err.status ?? 400})`;
  const nextActions: NextAction[] = [
    {
      type: "edit_request",
      command: "run402 image generate \"<prompt>\" --org <org_id>",
      why: "Name the paying organization on this call (SDK: generateImage({ orgId })). Candidates are in details.organization_ids.",
    },
    {
      type: "edit_request",
      command: "run402 orgs use <org_id>",
      why: "Select a current organization for this profile so every later call inherits it.",
    },
    ...(Array.isArray(envelope.next_actions) ? (envelope.next_actions as NextAction[]) : []),
  ];
  return new ApiError(
    message,
    err.status,
    {
      ...envelope,
      message,
      code: ORGANIZATION_SELECTION_REQUIRED,
      details: { ...details, organization_ids: candidates, matched_organization_ids: matches },
      next_actions: nextActions,
    },
    "generating image",
  );
}
