import { walletAuthHeaders } from "./config.mjs";
import { getSdk } from "./sdk.mjs";
import { reportSdkError, fail } from "./sdk-errors.mjs";
import { assertKnownFlags, flagValue, normalizeArgv, positionalArgs, validateWebhookUrl, failUnknownSubcommand } from "./argparse.mjs";

const HELP = `run402 agent — Manage agent identity

Usage:
  run402 agent contact --name <name> [--email <email>] [--webhook <url>]
  run402 agent status
  run402 agent verify-email
  run402 agent passkey enroll

Notes:
  - Free with SIWX auth
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
  - Free with SIWX auth (run 'run402 init' first)
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
  passkey: `run402 agent passkey — Bind a passkey to the contact

Usage:
  run402 agent passkey enroll

Sends a short-lived Run402 passkey enrollment link to the verified
contact email. Requires assurance_level=email_verified first. A person
signed in with 'run402 login' already has passkey assurance for a contact
whose verified email their principal holds.
`,
};

async function contact(args) {
  const parsedArgs = normalizeArgv(args);
  const valueFlags = ["--name", "--email", "--webhook"];
  assertKnownFlags(parsedArgs, [...valueFlags, "--help", "-h"], valueFlags);
  const extra = positionalArgs(parsedArgs, valueFlags);
  if (extra.length > 0) {
    fail({
      code: "BAD_USAGE",
      message: `Unexpected argument for agent contact: ${extra[0]}`,
      hint: "Use `run402 agent contact --name <name> [--email <email>] [--webhook <url>]`.",
    });
  }
  const name = flagValue(parsedArgs, "--name");
  const email = flagValue(parsedArgs, "--email");
  const webhook = flagValue(parsedArgs, "--webhook");
  if (!name) {
    fail({ code: "BAD_USAGE", message: "Missing --name <name>" });
  }
  // validate webhook scheme locally BEFORE the wallet check so
  // bad URLs fail fast even without a wallet configured. No-op when
  // --webhook is omitted (it's optional).
  validateWebhookUrl(webhook, "--webhook");
  // Preserve the aggressive early exit when no local wallet is configured.
  walletAuthHeaders("/agent/v1/contact");

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

async function status(args = []) {
  const parsedArgs = normalizeArgv(args);
  assertKnownFlags(parsedArgs, ["--help", "-h"]);
  const extra = positionalArgs(parsedArgs);
  if (extra.length > 0) {
    fail({ code: "BAD_USAGE", message: `Unexpected argument for agent status: ${extra[0]}` });
  }
  walletAuthHeaders("/agent/v1/contact/status");

  try {
    const sdk = getSdk();
    const data = await sdk.admin.getAgentContactStatus();
    // v1.56: augment the response with email_verification.last_challenge from
    // /agent/v1/me/status so the reader sees per-attempt status
    // (trust_rejected with which verdicts, attempts remaining, hint) without
    // a second command. Best-effort — older gateways without the v1.55+ route
    // skip the augment silently.
    try {
      const meStatus = await sdk.me.status();
      if (meStatus && meStatus.email_verification) {
        data.email_verification = meStatus.email_verification;
      }
    } catch {
      // Older gateway — keep the original response shape.
    }
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function verifyEmail(args = []) {
  const parsedArgs = normalizeArgv(args);
  assertKnownFlags(parsedArgs, ["--help", "-h"]);
  const extra = positionalArgs(parsedArgs);
  if (extra.length > 0) {
    fail({ code: "BAD_USAGE", message: `Unexpected argument for agent verify-email: ${extra[0]}` });
  }
  walletAuthHeaders("/agent/v1/contact/verify-email");

  try {
    const data = await getSdk().admin.verifyAgentContactEmail();
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function passkey(args) {
  const parsedArgs = normalizeArgv(args);
  assertKnownFlags(parsedArgs, ["--help", "-h"]);
  const positionals = positionalArgs(parsedArgs);
  const action = positionals[0];
  if (positionals.length > 1) {
    fail({ code: "BAD_USAGE", message: `Unexpected argument for agent passkey: ${positionals[1]}` });
  }
  if (action !== "enroll") {
    fail({ code: "BAD_USAGE", message: "Usage: run402 agent passkey enroll" });
  }
  walletAuthHeaders("/agent/v1/contact/passkey/enroll");

  try {
    const data = await getSdk().admin.startContactPasskeyEnrollment();
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
      await status(args);
      return;
    case "verify-email":
      await verifyEmail(args);
      return;
    case "passkey":
      await passkey(args);
      return;
    default:
      failUnknownSubcommand("agent", sub);
  }
}
