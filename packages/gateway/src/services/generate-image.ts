import { OPENROUTER_API_KEY } from "../config.js";

export const ALLOWED_SIZES = new Set([
  "512x512",
  "1024x1024",
  "1536x1536",
  "1792x1024",
  "1024x1792",
]);

export class ImageGenerationError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "ImageGenerationError";
  }
}

interface GenerateImageResult {
  image: string;
  content_type: string;
  size: string;
}

export async function generateImage(
  prompt: string,
  size: string = "1024x1024",
): Promise<GenerateImageResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  try {
    const resp = await fetch("https://openrouter.ai/api/v1/images/generations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      },
      body: JSON.stringify({
        model: "black-forest-labs/flux-schnell",
        prompt,
        size,
        response_format: "b64_json",
      }),
      signal: controller.signal,
    });

    if (!resp.ok) {
      const body = await resp.text();
      if (resp.status === 400 || resp.status === 422) {
        throw new ImageGenerationError(422, "image generation refused by model");
      }
      console.error(`OpenRouter error ${resp.status}: ${body}`);
      throw new ImageGenerationError(502, "image generation failed");
    }

    const json = (await resp.json()) as { data?: Array<{ b64_json?: string }> };
    const b64 = json.data?.[0]?.b64_json;
    if (!b64) {
      throw new ImageGenerationError(502, "image generation failed");
    }

    return { image: b64, content_type: "image/png", size };
  } catch (err) {
    if (err instanceof ImageGenerationError) throw err;
    if ((err as Error).name === "AbortError") {
      throw new ImageGenerationError(504, "image generation timed out");
    }
    console.error("OpenRouter request failed:", err);
    throw new ImageGenerationError(502, "image generation failed");
  } finally {
    clearTimeout(timeout);
  }
}
