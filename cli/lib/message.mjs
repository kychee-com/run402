import { allowanceAuthHeaders } from "./config.mjs";
import { getSdk } from "./sdk.mjs";
import { reportSdkError } from "./sdk-errors.mjs";

const HELP = `run402 message — Send messages to Run402 developers

Usage:
  run402 message send <text>

Notes:
  - Requires an active tier (run402 tier set <tier>)
  - Requires an allowance (run402 allowance create)

Examples:
  run402 message send "Hello from my agent!"
`;

async function send(text) {
  if (!text) { console.error(JSON.stringify({ status: "error", message: "Missing message text" })); process.exit(1); }
  // Preserve the aggressive early exit when no allowance is configured.
  allowanceAuthHeaders("/message/v1");

  try {
    await getSdk().admin.sendMessage(text);
    console.log(JSON.stringify({ status: "ok", message: "Message sent to Run402 developers." }));
  } catch (err) {
    reportSdkError(err);
  }
}

export async function run(sub, args) {
  if (!sub || sub === '--help' || sub === '-h') { console.log(HELP); process.exit(0); }
  if (Array.isArray(args) && (args.includes("--help") || args.includes("-h"))) {
    console.log(HELP);
    process.exit(0);
  }
  if (sub !== "send") {
    console.error(`Unknown subcommand: ${sub}\n`);
    console.log(HELP);
    process.exit(1);
  }
  await send(args.join(" "));
}
