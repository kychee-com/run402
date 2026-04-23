/**
 * `ai` namespace — project-scoped AI add-ons (translation, moderation) and
 * wallet-scoped image generation.
 */

import type { Client } from "../kernel.js";
import { ProjectNotFound } from "../errors.js";

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

export interface GenerateImageOptions {
  prompt: string;
  aspect?: ImageAspect;
}

export interface GenerateImageResult {
  /** Base64-encoded bytes. */
  image: string;
  content_type: string;
  aspect: string;
}

export class Ai {
  constructor(private readonly client: Client) {}

  /** Translate text. Requires the AI Translation add-on on the project. */
  async translate(projectId: string, opts: TranslateOptions): Promise<TranslateResult> {
    const project = await this.client.getProject(projectId);
    if (!project) throw new ProjectNotFound(projectId, "translating text");

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
    const project = await this.client.getProject(projectId);
    if (!project) throw new ProjectNotFound(projectId, "moderating content");

    return this.client.request<ModerateResult>("/ai/v1/moderate", {
      method: "POST",
      headers: { Authorization: `Bearer ${project.service_key}` },
      body: { text },
      context: "moderating content",
    });
  }

  /** Get AI translation usage for the current billing cycle. */
  async usage(projectId: string): Promise<AiUsageResult> {
    const project = await this.client.getProject(projectId);
    if (!project) throw new ProjectNotFound(projectId, "fetching AI usage");

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
    return this.client.request<GenerateImageResult>("/generate-image/v1", {
      method: "POST",
      body: { prompt: opts.prompt, aspect: opts.aspect ?? "square" },
      context: "generating image",
    });
  }
}
