import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const getEmailRawSchema = {
  project_id: z.string().describe("The project ID"),
  message_id: z.string().describe("The message ID to retrieve raw bytes for (must be an inbound message)"),
};

/**
 * Fetch the raw RFC-822 bytes of an inbound email message.
 *
 * Returns base64-encoded bytes in a code block. The decoded bytes are
 * bit-identical to the S3 object — no parsing, normalization, or CRLF
 * cleanup has been applied. Use this for cryptographic verification
 * (DKIM signature checks, zk-email proofs). For display / threading,
 * use `get_email` instead — it returns the parsed body_text.
 *
 * Inbound messages only; outbound messages return 404.
 */
export async function handleGetEmailRaw(args: {
  project_id: string;
  message_id: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const result = await getSdk().email.getRaw(args.project_id, args.message_id);
    const bytes = Buffer.from(result.bytes);
    const base64 = bytes.toString("base64");

    const lines = [
      `## Raw MIME: \`${args.message_id}\``,
      ``,
      `- **Content-Type:** ${result.content_type}`,
      `- **Size:** ${bytes.length} bytes`,
      `- **Encoding:** base64 (decode to get the exact RFC-822 bytes — bit-identical to the DKIM-signed original)`,
      ``,
      "```",
      base64,
      "```",
      ``,
      `**Note:** The decoded bytes preserve the original DKIM signature, CRLF line endings, and all headers verbatim. For display/threading, use \`get_email\` instead.`,
    ];

    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    const msg = (err as Error)?.message ?? "";
    if (/No mailbox found/.test(msg)) {
      return {
        content: [{ type: "text", text: "Error: No mailbox found for this project. Use `create_mailbox` to create one first." }],
        isError: true,
      };
    }
    return mapSdkError(err, "fetching raw MIME");
  }
}
