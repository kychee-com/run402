import { z } from "zod";
import { paidApiRequest } from "../paid-fetch.js";
import { formatApiError } from "../errors.js";

export const generateImageSchema = {
  prompt: z
    .string()
    .describe("Image description. Max 1000 characters."),
  aspect: z
    .enum(["square", "landscape", "portrait"])
    .default("square")
    .describe("Aspect ratio: square (1:1), landscape (16:9), portrait (9:16)"),
};

export async function handleGenerateImage(args: {
  prompt: string;
  aspect?: string;
}): Promise<{
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  isError?: boolean;
}> {
  const aspect = args.aspect || "square";

  const res = await paidApiRequest("/generate-image/v1", {
    method: "POST",
    body: { prompt: args.prompt, aspect },
  });

  if (res.is402) {
    const body = res.body as Record<string, unknown>;
    const lines = [
      `## Payment Required`,
      ``,
      `To generate an image, an x402 payment of **$0.03 USDC** is needed.`,
      ``,
    ];
    if (body.x402) {
      lines.push(`**Payment details:**`);
      lines.push("```json");
      lines.push(JSON.stringify(body.x402, null, 2));
      lines.push("```");
    } else {
      lines.push(`**Server response:**`);
      lines.push("```json");
      lines.push(JSON.stringify(body, null, 2));
      lines.push("```");
    }
    lines.push(``);
    lines.push(
      `The user's agent allowance or payment agent must send the required amount. ` +
        `Once payment is confirmed, retry this tool call.`,
    );
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  if (!res.ok) return formatApiError(res, "generating image");

  const body = res.body as {
    image: string;
    content_type: string;
    aspect: string;
  };

  return {
    content: [
      {
        type: "text",
        text: `Generated ${body.aspect} image (${body.content_type})`,
      },
      {
        type: "image",
        data: body.image,
        mimeType: body.content_type || "image/png",
      },
    ],
  };
}
