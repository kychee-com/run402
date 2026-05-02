import { resolveProjectId } from "./config.mjs";
import { getSdk } from "./sdk.mjs";
import { reportSdkError, fail } from "./sdk-errors.mjs";

const HELP = `run402 sender-domain — Manage custom email sender domain

Usage:
  run402 sender-domain <subcommand> [args...]

Subcommands:
  register <domain> [--project <id>]   Register a custom sender domain (returns DNS records)
  status [--project <id>]              Check domain verification status
  remove [--project <id>]              Remove custom sender domain
  inbound-enable <domain> [--project <id>]   Enable inbound email (requires DKIM-verified)
  inbound-disable <domain> [--project <id>]  Disable inbound email

Examples:
  run402 sender-domain register kysigned.com
  run402 sender-domain status
  run402 sender-domain remove
  run402 sender-domain inbound-enable kysigned.com
  run402 sender-domain inbound-disable kysigned.com
`;

const SUB_HELP = {
  register: `run402 sender-domain register — Register a custom sender domain

Usage:
  run402 sender-domain register <domain> [--project <id>]

Arguments:
  <domain>            Custom sender domain (e.g. kysigned.com)

Options:
  --project <id>      Project ID (defaults to the active project)

Notes:
  - Returns DNS records (DKIM, SPF, DMARC) to add at your DNS provider
  - Use 'run402 sender-domain status' to poll until verified

Examples:
  run402 sender-domain register kysigned.com
  run402 sender-domain register kysigned.com --project prj_abc123
`,
  status: `run402 sender-domain status — Check verification status of the project's sender domain

Usage:
  run402 sender-domain status [--project <id>]

Options:
  --project <id>      Project ID (defaults to the active project)

Examples:
  run402 sender-domain status
  run402 sender-domain status --project prj_abc123
`,
  remove: `run402 sender-domain remove — Remove the project's custom sender domain

Usage:
  run402 sender-domain remove [--project <id>]

Options:
  --project <id>      Project ID (defaults to the active project)

Examples:
  run402 sender-domain remove
  run402 sender-domain remove --project prj_abc123
`,
  "inbound-enable": `run402 sender-domain inbound-enable — Enable inbound email for a sender domain

Usage:
  run402 sender-domain inbound-enable <domain> [--project <id>]

Arguments:
  <domain>            Custom sender domain to enable inbound on

Options:
  --project <id>      Project ID (defaults to the active project)

Notes:
  - Requires the domain to be DKIM-verified first

Examples:
  run402 sender-domain inbound-enable kysigned.com
`,
  "inbound-disable": `run402 sender-domain inbound-disable — Disable inbound email for a sender domain

Usage:
  run402 sender-domain inbound-disable <domain> [--project <id>]

Arguments:
  <domain>            Custom sender domain to disable inbound on

Options:
  --project <id>      Project ID (defaults to the active project)

Examples:
  run402 sender-domain inbound-disable kysigned.com
`,
};

function parseFlag(args, flag) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && args[i + 1]) return args[i + 1];
  }
  return null;
}

async function register(args) {
  let domain = null;
  let projectOpt = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--project" && args[i + 1]) { projectOpt = args[++i]; }
    else if (!args[i].startsWith("--") && !domain) { domain = args[i]; }
  }
  const projectId = resolveProjectId(projectOpt);

  if (!domain) {
    fail({
      code: "BAD_USAGE",
      message: "Missing domain.",
      hint: "run402 sender-domain register <domain>",
    });
  }

  try {
    const data = await getSdk().senderDomain.register(projectId, domain);
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function status(args) {
  const projectId = resolveProjectId(parseFlag(args, "--project"));
  try {
    const data = await getSdk().senderDomain.status(projectId);
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function remove(args) {
  const projectId = resolveProjectId(parseFlag(args, "--project"));
  try {
    await getSdk().senderDomain.remove(projectId);
    console.log(JSON.stringify({ status: "ok" }));
  } catch (err) {
    reportSdkError(err);
  }
}

async function inboundToggle(action, args) {
  let domain = null;
  let projectOpt = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--project" && args[i + 1]) { projectOpt = args[++i]; }
    else if (!args[i].startsWith("--") && !domain) { domain = args[i]; }
  }
  const projectId = resolveProjectId(projectOpt);

  if (!domain) {
    fail({
      code: "BAD_USAGE",
      message: "Missing domain.",
      hint: `run402 sender-domain inbound-${action} <domain>`,
    });
  }

  try {
    if (action === "enable") {
      const data = await getSdk().senderDomain.enableInbound(projectId, domain);
      console.log(JSON.stringify(data, null, 2));
    } else {
      await getSdk().senderDomain.disableInbound(projectId, domain);
      console.log(JSON.stringify({ status: "ok", domain }));
    }
  } catch (err) {
    reportSdkError(err);
  }
}

export async function run(sub, args) {
  if (!sub || sub === "--help" || sub === "-h") { console.log(HELP); process.exit(0); }
  if (Array.isArray(args) && (args.includes("--help") || args.includes("-h"))) { console.log(SUB_HELP[sub] || HELP); process.exit(0); }
  switch (sub) {
    case "register": await register(args); break;
    case "status": await status(args); break;
    case "remove": await remove(args); break;
    case "inbound-enable": await inboundToggle("enable", args); break;
    case "inbound-disable": await inboundToggle("disable", args); break;
    default:
      console.error(`Unknown subcommand: ${sub}\n`);
      console.log(HELP);
      process.exit(1);
  }
}
