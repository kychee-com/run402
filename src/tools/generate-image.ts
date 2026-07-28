import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";
import { PaymentRequired } from "../../sdk/dist/index.js";

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
  try {
    const body = await getSdk().ai.generateImage({
      prompt: args.prompt,
      aspect: (args.aspect as "square" | "landscape" | "portrait") ?? "square",
    });

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
  } catch (err) {
    if (err instanceof PaymentRequired) {
      const body = (err.body ?? {}) as Record<string, unknown>;
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
      // This is the moment of intent: the agent wants the image and now knows
      // it costs three cents. The previous text — "the user's agent allowance or
      // payment agent must send the required amount" — named no mechanism, so a
      // cold agent had nothing it could execute. Verified 2026-07-28 by running
      // the published server from a clean config: it is a dead end at exactly
      // the step that converts.
      //
      // The remedy ships in this same server, so name the tools. `init` funds on
      // Base SEPOLIA (testnet) — say so plainly rather than letting an agent
      // discover after the fact that its payment was play money.
      lines.push(`**Next steps — tools on this same server:**`);
      lines.push(``);
      lines.push(
        `1. \`allowance_status\` — check whether this agent already has a wallet and funds.`,
      );
      lines.push(
        `2. \`init\` — one-call bootstrap: creates a local allowance wallet and requests ` +
          `faucet USDC. **This funds Base Sepolia (testnet)**, so the payment settles in ` +
          `test money — good for trying the endpoint, but it is not a real purchase.`,
      );
      lines.push(
        `3. To pay for real, fund the address from \`allowance_export\` with USDC on ` +
          `**Base mainnet**, then retry.`,
      );
      lines.push(``);
      lines.push(`Once the wallet has funds, retry this tool call unchanged — the payment is automatic.`);
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
    return mapSdkError(err, "generating image");
  }
}
