import { allowanceAuthHeaders } from "./config.mjs";
import { getSdk } from "./sdk.mjs";
import { reportSdkError, fail } from "./sdk-errors.mjs";

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

const SUB_HELP = {
  contact: `run402 agent contact — Register agent contact info

Usage:
  run402 agent contact --name <name> [--email <email>] [--webhook <url>]

Options:
  --name <name>       Required: agent name (e.g. "my-agent")
  --email <email>     Optional: contact email address
  --webhook <url>     Optional: webhook URL Run402 can call to reach the
                      agent

Notes:
  - Free with allowance auth (run an 'allowance create' first)
  - Registers contact info so Run402 can reach your agent

Examples:
  run402 agent contact --name my-agent
  run402 agent contact --name my-agent --email ops@example.com \\
    --webhook https://example.com/hook
`,
};

async function contact(args) {
  let name = null, email = null, webhook = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--name" && args[i + 1]) name = args[++i];
    if (args[i] === "--email" && args[i + 1]) email = args[++i];
    if (args[i] === "--webhook" && args[i + 1]) webhook = args[++i];
  }
  if (!name) {
    fail({ code: "BAD_USAGE", message: "Missing --name <name>" });
  }
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
    console.log(SUB_HELP[sub] || HELP);
    process.exit(0);
  }
  if (sub !== "contact") {
    console.error(`Unknown subcommand: ${sub}\n`);
    console.log(HELP);
    process.exit(1);
  }
  await contact(args);
}
