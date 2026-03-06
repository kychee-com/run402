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
    const [width, height] = size.split("x").map(Number);
    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash-image",
        messages: [{ role: "user", content: prompt }],
        modalities: ["image"],
        image_config: {
          width,
          height,
        },
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

    interface ImagePart {
      type: string;
      image_url?: { url: string };
    }
    interface OpenRouterResponse {
      choices?: Array<{
        message?: {
          content?: ImagePart[] | null;
          images?: ImagePart[];
        };
      }>;
    }
    const json = (await resp.json()) as OpenRouterResponse;
    const msg = json.choices?.[0]?.message;
    const parts = msg?.images ?? msg?.content ?? [];
    const imageContent = parts.find((c) => c.type === "image_url");
    const dataUrl = imageContent?.image_url?.url;
    if (!dataUrl) {
      throw new ImageGenerationError(502, "image generation failed");
    }

    // Extract base64 from data URI: "data:image/png;base64,..."
    const b64Match = dataUrl.match(/^data:image\/[^;]+;base64,(.+)$/);
    if (!b64Match) {
      throw new ImageGenerationError(502, "image generation failed");
    }

    return { image: b64Match[1], content_type: "image/png", size };
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
