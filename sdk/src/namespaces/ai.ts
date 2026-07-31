/**
 * `ai` namespace — project-scoped AI add-ons (translation, moderation) and
 * wallet-scoped image generation.
 */

import type { Client, PaymentSettlement } from "../kernel.js";
import { LocalError } from "../errors.js";
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
   * Generate an image from a text prompt. Costs $0.03 USDC via x402.
   * No project scope — payment flows through the allowance-based fetch.
   */
  async generateImage(opts: GenerateImageOptions): Promise<GenerateImageResult> {
    const aspect = opts.aspect ?? "square";
    if (!IMAGE_ASPECTS.includes(aspect)) {
      throw new LocalError(
        `aspect must be one of: ${IMAGE_ASPECTS.join(", ")}`,
        "generating image",
      );
    }
    // requestWithResponse, not request: the settlement receipt rides the
    // RESPONSE, and `request` discards everything but the body — which is
    // exactly how a caller could buy an image with no way to learn which
    // network the money moved on.
    const res = await this.client.requestWithResponse<Omit<GenerateImageResult, "payment">>(
      "/generate-image/v1",
      { method: "POST", body: { prompt: opts.prompt, aspect }, context: "generating image" },
    );
    return { ...res.body, payment: res.settlement ?? null };
  }
}
