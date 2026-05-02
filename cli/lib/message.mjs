import { allowanceAuthHeaders } from "./config.mjs";
import { getSdk } from "./sdk.mjs";
import { reportSdkError, fail } from "./sdk-errors.mjs";

const HELP = `run402 message — Send messages to Run402 developers

Usage:
  run402 message send <text>

Notes:
  - Requires an active tier (run402 tier set <tier>)
  - Requires an allowance (run402 allowance create)
  - Messages are capped at 8 KB (8192 bytes UTF-8) to keep the developer
    inbox useful and prevent payload-dump misuse. Trim or summarize long
    content (e.g. stack traces) before sending.

Examples:
  run402 message send "Hello from my agent!"
`;

// Cap message body at a Twitter-ish but engineer-generous size: enough for
// a few paragraphs and a stack-trace excerpt, small enough that a misbehaving
// agent script can't dump arbitrary content into the developer inbox in one
// call. UTF-8 bytes (not characters) — emoji and accented chars count as
// multiple bytes.
const MESSAGE_MAX_BYTES = 8192;

const SUB_HELP = {
  send: `run402 message send — Send a message to Run402 developers

Usage:
  run402 message send <text>

Arguments:
  <text>              Message body (quote it; remaining args are joined with
                      spaces if multiple positional words are provided)

Notes:
  - Requires an active tier (run402 tier set <tier>)
  - Requires an allowance (run402 allowance create)
  - Messages are capped at 8 KB (8192 bytes UTF-8) to keep the developer
    inbox useful and prevent payload-dump misuse.

Examples:
  run402 message send "Hello from my agent!"
`,
};

async function send(text) {
  if (!text || typeof text !== "string") {
    fail({ code: "BAD_USAGE", message: "Missing message text." });
  }
  // Cap check runs BEFORE the allowance check so oversized payloads surface
  // a structured size error instead of being masked by a missing-allowance
  // exit.
  const bytes = Buffer.byteLength(text, "utf-8");
  if (bytes > MESSAGE_MAX_BYTES) {
    fail({
      code: "MESSAGE_TOO_LONG",
      message: `Message is ${bytes} bytes; maximum is ${MESSAGE_MAX_BYTES} bytes (~8 KB).`,
      hint: "Trim or summarize the message.",
      details: { bytes, max_bytes: MESSAGE_MAX_BYTES },
    });
  }
  // Preserve the aggressive early exit when no allowance is configured.
  allowanceAuthHeaders("/message/v1");

  try {
    await getSdk().admin.sendMessage(text);
    console.log(JSON.stringify({
      status: "ok",
      message: "Message sent to Run402 developers.",
      bytes_sent: bytes,
    }));
  } catch (err) {
    reportSdkError(err);
  }
}

export async function run(sub, args) {
  if (!sub || sub === '--help' || sub === '-h') { console.log(HELP); process.exit(0); }
  if (Array.isArray(args) && (args.includes("--help") || args.includes("-h"))) {
    console.log(SUB_HELP[sub] || HELP);
    process.exit(0);
  }
  if (sub !== "send") {
    console.error(`Unknown subcommand: ${sub}\n`);
    console.log(HELP);
    process.exit(1);
  }
  await send(args.join(" "));
}
