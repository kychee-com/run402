import { fail } from "./sdk-errors.mjs";

const HELP = `run402 sender-domain — removed

Usage:
  run402 sender-domain --help

The split sender-domain workflow has been replaced by ProjectDomain:

  run402 domains connect <domain> --project <id> --email-send --email-receive --mailbox-addresses primary --addresses info
  run402 domains status <domain> --project <id>
  run402 domains repair <domain> --project <id>
`;

function replacementFor(sub) {
  if (sub === "status") return "run402 domains status <domain> --project <id>";
  if (sub === "remove") return "run402 domains disconnect <domain> --project <id> --confirm";
  if (sub === "inbound-enable") return "run402 domains connect <domain> --project <id> --email-receive";
  if (sub === "inbound-disable") return "run402 domains disconnect <domain> --project <id> --confirm";
  return "run402 domains connect <domain> --project <id> --email-send";
}

export async function run(sub) {
  if (!sub || sub === "--help" || sub === "-h") {
    console.log(HELP);
    process.exit(0);
  }
  const command = `run402 sender-domain ${sub}`;
  const replacement = replacementFor(sub);
  fail({
    code: "COMMAND_REMOVED",
    message: `${command} has been removed. Use ProjectDomain via ${replacement}.`,
    details: { command, replacement },
    next_actions: [{ type: "use_replacement_command", command: replacement }],
  });
}
