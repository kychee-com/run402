import { allowanceAuthHeaders } from "./config.mjs";
import { getSdk } from "./sdk.mjs";
import { reportSdkError } from "./sdk-errors.mjs";

const HELP = `run402 agent — Manage agent identity

Usage:
  run402 agent contact --name <name> [--email <email>] [--webhook <url>]

Notes:
  - Free with allowance auth
  - Registers contact info so Run402 can reach your agent
  - Only name is required; email and webhook are optional

Examples:
  run402 agent contact --name my-agent
  run402 agent contact --name my-agent --email ops@example.com --webhook https://example.com/hook
`;

async function contact(args) {
  let name = null, email = null, webhook = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--name" && args[i + 1]) name = args[++i];
    if (args[i] === "--email" && args[i + 1]) email = args[++i];
    if (args[i] === "--webhook" && args[i + 1]) webhook = args[++i];
  }
  if (!name) { console.error(JSON.stringify({ status: "error", message: "Missing --name <name>" })); process.exit(1); }
  // Preserve the aggressive early exit when no allowance is configured.
  allowanceAuthHeaders("/agent/v1/contact");

  try {
    const data = await getSdk().admin.setAgentContact({
      name,
      email: email ?? undefined,
      webhook: webhook ?? undefined,
    });
    console.log(JSON.stringify(data, null, 2));
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
  if (sub !== "contact") {
    console.error(`Unknown subcommand: ${sub}\n`);
    console.log(HELP);
    process.exit(1);
  }
  await contact(args);
}
