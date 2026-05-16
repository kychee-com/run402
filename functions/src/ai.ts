import { config } from "./config.js";

export interface TranslateOptions {
  from?: string;
  context?: string;
}

export interface TranslateResult {
  text: string;
  from: string;
  to: string;
  [key: string]: unknown;
}

export interface ModerateResult {
  flagged: boolean;
  categories: Record<string, boolean>;
  [key: string]: unknown;
}

export type ImageAspect = "square" | "landscape" | "portrait";

export interface GenerateImageOptions {
  prompt: string;
  aspect?: ImageAspect;
}

export interface GenerateImageResult {
  image: string;
  content_type: string;
  aspect: ImageAspect | string;
  [key: string]: unknown;
}

const IMAGE_ASPECTS = new Set<string>(["square", "landscape", "portrait"]);

async function readRuntimeError(res: Response): Promise<string> {
  const errBody = await res.text();
  try {
    const parsed = JSON.parse(errBody) as {
      code?: string;
      error?: string;
      message?: string;
    };
    const message = parsed.message || parsed.error || errBody;
    return parsed.code ? `${parsed.code}: ${message}` : message;
  } catch {
    return errBody;
  }
}

export const ai = {
  async translate(
    text: string,
    to: string,
    opts?: TranslateOptions,
  ): Promise<TranslateResult> {
    const body: Record<string, string> = { text, to };
    if (opts?.from) body.from = opts.from;
    if (opts?.context) body.context = opts.context;
    const res = await fetch(config.API_BASE + "/ai/v1/translate", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + config.SERVICE_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errBody = await res.text();
      let msg: string;
      try {
        msg = (JSON.parse(errBody) as { error?: string }).error || errBody;
      } catch {
        msg = errBody;
      }
      throw new Error("Translation failed (" + res.status + "): " + msg);
    }
    return res.json() as Promise<TranslateResult>;
  },

  async moderate(text: string): Promise<ModerateResult> {
    const res = await fetch(config.API_BASE + "/ai/v1/moderate", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + config.SERVICE_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      const errBody = await res.text();
      let msg: string;
      try {
        msg = (JSON.parse(errBody) as { error?: string }).error || errBody;
      } catch {
        msg = errBody;
      }
      throw new Error("Moderation failed (" + res.status + "): " + msg);
    }
    return res.json() as Promise<ModerateResult>;
  },

  async generateImage(options: GenerateImageOptions): Promise<GenerateImageResult> {
    if (!options || typeof options !== "object") {
      throw new Error("Image generation options are required");
    }
    if (!options.prompt || typeof options.prompt !== "string" || !options.prompt.trim()) {
      throw new Error("Image generation prompt is required");
    }
    const aspect = options.aspect ?? "square";
    if (!IMAGE_ASPECTS.has(aspect)) {
      throw new Error("Invalid image aspect: must be square, landscape, or portrait");
    }

    const res = await fetch(config.API_BASE + "/ai/v1/generate-image", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + config.SERVICE_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt: options.prompt.trim(),
        aspect,
      }),
    });
    if (!res.ok) {
      const msg = await readRuntimeError(res);
      throw new Error("Image generation failed (" + res.status + "): " + msg);
    }
    return res.json() as Promise<GenerateImageResult>;
  },
};
