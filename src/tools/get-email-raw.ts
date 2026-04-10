import { z } from "zod";
import { getProject } from "../keystore.js";
import { formatApiError, projectNotFound } from "../errors.js";
import { resolveMailboxId } from "./send-email.js";
import { getApiBase } from "../../core/dist/config.js";

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
  const project = getProject(args.project_id);
  if (!project) return projectNotFound(args.project_id);

  const mailbox = await resolveMailboxId(args.project_id, project.service_key);
  if ("error" in mailbox) return mailbox.error;

  // Use raw fetch instead of apiRequest because the response is binary
  // (message/rfc822), not JSON/text.
  const url = `${getApiBase()}/mailboxes/v1/${mailbox.id}/messages/${args.message_id}/raw`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${project.service_key}` },
    });
  } catch (err) {
    return {
      content: [{ type: "text", text: `Error fetching raw MIME: ${(err as Error).message}` }],
      isError: true,
    };
  }

  if (!res.ok) {
    // Parse the JSON error body if possible
    let body: unknown;
    try { body = await res.json(); } catch { body = await res.text().catch(() => ""); }
    return formatApiError({ status: res.status, body }, "fetching raw MIME");
  }

  const arrayBuffer = await res.arrayBuffer();
  const bytes = Buffer.from(arrayBuffer);
  const base64 = bytes.toString("base64");
  const contentType = res.headers.get("content-type") || "message/rfc822";

  const lines = [
    `## Raw MIME: \`${args.message_id}\``,
    ``,
    `- **Content-Type:** ${contentType}`,
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
}
