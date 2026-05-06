import { allowanceAuthHeaders } from "./config.mjs";
import { getSdk } from "./sdk.mjs";
import { reportSdkError, fail } from "./sdk-errors.mjs";
import { validateWebhookUrl } from "./argparse.mjs";

const HELP = `run402 agent — Manage agent identity

Usage:
  run402 agent contact --name <name> [--email <email>] [--webhook <url>]
  run402 agent status
  run402 agent verify-email
  run402 agent passkey enroll

Notes:
  - Free with allowance auth
  - Registers contact info so Run402 can reach your agent
  - Only name is required; email and webhook are optional
  - New or changed emails start reply verification
  - Passkey enrollment requires email_verified

Examples:
  run402 agent contact --name my-agent
  run402 agent contact --name my-agent --email ops@example.com --webhook https://example.com/hook
  run402 agent status
  run402 agent verify-email
  run402 agent passkey enroll
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
  - New or changed emails start a reply challenge and return
    assurance_level without exposing the challenge secret

Examples:
  run402 agent contact --name my-agent
  run402 agent contact --name my-agent --email ops@example.com \\
    --webhook https://example.com/hook
`,
  status: `run402 agent status — Get agent contact assurance status

Usage:
  run402 agent status

Returns the current contact fields plus email/passkey binding status,
assurance_level, and proof timestamps.
`,
  "verify-email": `run402 agent verify-email — Start or resend email verification

Usage:
  run402 agent verify-email

Sends or reuses a reply challenge for the active contact email. The challenge
secret is emailed and never printed.
`,
  passkey: `run402 agent passkey — Manage operator passkey binding

Usage:
  run402 agent passkey enroll

Sends a short-lived Run402 operator passkey enrollment link to the verified
contact email. Requires assurance_level=email_verified first.
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
  // GH-192: validate webhook scheme locally BEFORE the allowance check so
  // bad URLs fail fast even without an allowance configured. No-op when
  // --webhook is omitted (it's optional).
  validateWebhookUrl(webhook, "--webhook");
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

async function status() {
  allowanceAuthHeaders("/agent/v1/contact/status");

  try {
    const data = await getSdk().admin.getAgentContactStatus();
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function verifyEmail() {
  allowanceAuthHeaders("/agent/v1/contact/verify-email");

  try {
    const data = await getSdk().admin.verifyAgentContactEmail();
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function passkey(args) {
  const action = args[0];
  if (action !== "enroll") {
    fail({ code: "BAD_USAGE", message: "Usage: run402 agent passkey enroll" });
  }
  allowanceAuthHeaders("/agent/v1/contact/passkey/enroll");

  try {
    const data = await getSdk().admin.startOperatorPasskeyEnrollment();
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
  switch (sub) {
    case "contact":
      await contact(args);
      return;
    case "status":
      await status();
      return;
    case "verify-email":
      await verifyEmail();
      return;
    case "passkey":
      await passkey(args);
      return;
    default:
      console.error(`Unknown subcommand: ${sub}\n`);
      console.log(HELP);
      process.exit(1);
  }
}
