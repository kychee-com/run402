import { resolveProjectId } from "./config.mjs";
import { getSdk } from "./sdk.mjs";
import { reportSdkError, fail } from "./sdk-errors.mjs";
import { assertKnownFlags, flagValue, normalizeArgv, positionalArgs, parseIntegerFlag, failUnknownSubcommand } from "./argparse.mjs";

const HELP = `run402 domains — Manage ProjectDomain lifecycle

Usage:
  run402 domains <subcommand> [args...]

Subcommands:
  connect      <domain> [--project <id>] [--web] [--email-send] [--email-receive] [...]
  list         [--project <id>] [--include-managed]
  status       <domain> [--project <id>]
  dns          <domain> [--project <id>] [--format json|bind]
  check        <domain> [--project <id>]
  apply        <domain> [--project <id>] [--authority auto|provider-connect|delegated-subdomain|hosted-zone]
  repair       <domain> [--project <id>]
  test-receive <domain> --to <local-part|address> [--project <id>]
  wait         <domain> [--project <id>] [--until active|safe|receive-active] [--timeout-ms <n>] [--interval-ms <n>]
  activate     <domain> [--project <id>]
  disconnect   <domain> --confirm [--project <id>]

Removed:
  add, delete. Use connect/disconnect.
`;

const SUB_HELP = {
  connect: `run402 domains connect — connect a ProjectDomain capability

Usage:
  run402 domains connect <domain> --project <id> [--web] [--email-send] [--email-receive] [options]

Examples:
  run402 domains connect kysigned.com --project prj_123 --email-send --email-receive --mailbox-addresses primary --addresses info
  run402 domains connect example.com --project prj_123 --web --web-target production
`,
  list: `run402 domains list — list project domains

Usage:
  run402 domains list --project <id>
`,
  status: `run402 domains status — show one ProjectDomain aggregate

Usage:
  run402 domains status <domain> --project <id>
`,
  dns: `run402 domains dns — print required DNS records

Usage:
  run402 domains dns <domain> --project <id> [--format json|bind]
`,
  check: `run402 domains check — refresh ProjectDomain observations and checks

Usage:
  run402 domains check <domain> --project <id>
`,
  apply: `run402 domains apply — apply safe provider-managed changes

Usage:
  run402 domains apply <domain> --project <id> [--authority auto|provider-connect|delegated-subdomain|hosted-zone]
`,
  repair: `run402 domains repair — repair Run402-owned domain infrastructure

Usage:
  run402 domains repair <domain> --project <id>
`,
  "test-receive": `run402 domains test-receive — create an inbound receive test token

Usage:
  run402 domains test-receive <domain> --project <id> --to <local-part|address>
`,
  wait: `run402 domains wait — poll until a ProjectDomain is ready

Usage:
  run402 domains wait <domain> --project <id> [--until active|safe|receive-active] [--timeout-ms <n>] [--interval-ms <n>]
`,
  activate: `run402 domains activate — activate custom mailbox addresses

Usage:
  run402 domains activate <domain> --project <id>
`,
  disconnect: `run402 domains disconnect — disconnect a ProjectDomain

Usage:
  run402 domains disconnect <domain> --project <id> --confirm
`,
};

const CONNECT_VALUE_FLAGS = [
  "--project",
  "--web-target",
  "--receive-strategy",
  "--mail-subdomain",
  "--mailbox-addresses",
  "--addresses",
  "--activation",
  "--authority",
  "--confirm-mx-takeover",
];
const COMMON_VALUE_FLAGS = ["--project"];

function print(data) {
  console.log(JSON.stringify(data, null, 2));
}

function removed(command, replacement) {
  fail({
    code: "COMMAND_REMOVED",
    message: `${command} has been removed. Use ${replacement}.`,
    details: { command, replacement },
    next_actions: [{ type: "use_replacement_command", command: replacement }],
  });
}

function parseCommon(args, extraKnown = [], valueFlags = COMMON_VALUE_FLAGS) {
  const parsed = normalizeArgv(args);
  assertKnownFlags(parsed, [...valueFlags, ...extraKnown, "--help", "-h"], valueFlags);
  return {
    parsed,
    projectId: resolveProjectId(flagValue(parsed, "--project")),
    rest: positionalArgs(parsed, valueFlags),
  };
}

function normalizeReceiveStrategy(value) {
  if (!value) return "auto";
  const map = {
    auto: "auto",
    "outbound-only": "outbound_only",
    outbound_only: "outbound_only",
    forwarding: "forwarding_mode",
    "forwarding-mode": "forwarding_mode",
    forwarding_mode: "forwarding_mode",
    subdomain: "subdomain_mode",
    "subdomain-mode": "subdomain_mode",
    subdomain_mode: "subdomain_mode",
    "full-mx": "full_receive_takeover",
    "full-receive-takeover": "full_receive_takeover",
    full_receive_takeover: "full_receive_takeover",
  };
  const normalized = map[value];
  if (!normalized) {
    fail({
      code: "BAD_FLAG",
      message: "--receive-strategy must be one of: auto, outbound-only, forwarding, subdomain, full-mx.",
      details: { flag: "--receive-strategy", value },
    });
  }
  return normalized;
}

function parseMailboxAddressMode(value) {
  if (!value) return null;
  const allowed = ["primary", "alias", "managed", "none"];
  if (value.includes(",") || !allowed.includes(value)) {
    fail({
      code: "BAD_FLAG",
      message: "--mailbox-addresses must be one of: primary, alias, managed, none.",
      hint: "Use `--mailbox-addresses primary --addresses info,legal`, not `--mailbox-addresses info,legal`.",
      details: { flag: "--mailbox-addresses", value, replacement_flag: "--addresses" },
    });
  }
  return value;
}

function parseAddresses(value) {
  if (!value) return [];
  return value.split(",").map((part) => part.trim()).filter(Boolean);
}

function desiredFromConnectFlags(domain, parsed) {
  const desired = {};
  const web = parsed.includes("--web") || flagValue(parsed, "--web-target") || parsed.includes("--primary-web") || parsed.includes("--web-alias");
  if (web) {
    desired.web = {
      enabled: true,
      target: flagValue(parsed, "--web-target") ?? "production",
      role: parsed.includes("--web-alias") ? "alias" : "primary",
    };
  }

  const emailSend = parsed.includes("--email-send");
  const emailReceive = parsed.includes("--email-receive");
  const mailboxMode = parseMailboxAddressMode(flagValue(parsed, "--mailbox-addresses"));
  if (emailSend || emailReceive || mailboxMode) {
    const email = {};
    if (emailSend) email.send = { enabled: true };
    if (emailReceive) {
      const receive = {
        enabled: true,
        strategy: normalizeReceiveStrategy(flagValue(parsed, "--receive-strategy")),
      };
      const mailSubdomain = flagValue(parsed, "--mail-subdomain");
      if (mailSubdomain) receive.mail_subdomain = mailSubdomain;
      const mxFingerprint = flagValue(parsed, "--confirm-mx-takeover");
      if (mxFingerprint) receive.observed_mx_fingerprint = mxFingerprint;
      email.receive = receive;
    }
    if (mailboxMode) {
      const locals = parseAddresses(flagValue(parsed, "--addresses"));
      if ((mailboxMode === "primary" || mailboxMode === "alias") && locals.length === 0) {
        fail({
          code: "BAD_FLAG",
          message: "--addresses is required when --mailbox-addresses is primary or alias.",
          details: { flag: "--addresses", domain },
        });
      }
      const create = parsed.includes("--create-mailboxes")
        ? true
        : parsed.includes("--no-create-mailboxes") ? false : false;
      email.mailbox_addresses = {
        mode: mailboxMode,
        addresses: locals.map((local) => ({
          local_part: local,
          mailbox_slug: local,
          create_mailbox: create,
        })),
      };
    }
    const activation = flagValue(parsed, "--activation");
    if (activation) {
      if (!["automatic_when_ready", "manual"].includes(activation)) {
        fail({
          code: "BAD_FLAG",
          message: "--activation must be automatic_when_ready or manual.",
          details: { flag: "--activation", value: activation },
        });
      }
      email.activation = activation;
    }
    desired.email = email;
  }

  if (!desired.web && !desired.email) {
    fail({
      code: "BAD_USAGE",
      message: "No desired domain capability selected.",
      hint: "Use --web, --email-send, --email-receive, and/or --mailbox-addresses.",
    });
  }
  return desired;
}

async function connect(args) {
  const parsed = normalizeArgv(args);
  assertKnownFlags(parsed, [
    ...CONNECT_VALUE_FLAGS,
    "--web",
    "--primary-web",
    "--web-alias",
    "--email-send",
    "--email-receive",
    "--create-mailboxes",
    "--no-create-mailboxes",
    "--help",
    "-h",
  ], CONNECT_VALUE_FLAGS);
  const rest = positionalArgs(parsed, CONNECT_VALUE_FLAGS);
  const domain = rest[0];
  if (!domain) fail({ code: "BAD_USAGE", message: "Missing <domain>.", hint: "run402 domains connect <domain> --project <id> --web" });
  if (rest.length > 1) fail({ code: "BAD_USAGE", message: `Unexpected argument for domains connect: ${rest[1]}` });
  if (parsed.includes("--create-mailboxes") && parsed.includes("--no-create-mailboxes")) {
    fail({ code: "BAD_FLAG", message: "Choose only one of --create-mailboxes or --no-create-mailboxes." });
  }
  const authority = flagValue(parsed, "--authority");
  if (authority && !["auto", "manual-dns", "provider-connect", "delegated-subdomain", "hosted-zone"].includes(authority)) {
    fail({ code: "BAD_FLAG", message: "--authority must be one of: auto, manual-dns, provider-connect, delegated-subdomain, hosted-zone.", details: { flag: "--authority", value: authority } });
  }
  const projectId = resolveProjectId(flagValue(parsed, "--project"));
  try {
    print(await getSdk().domains.ensure(projectId, domain, { desired: desiredFromConnectFlags(domain, parsed) }));
  } catch (err) {
    reportSdkError(err);
  }
}

async function list(args) {
  const { projectId, rest } = parseCommon(args, ["--include-managed"]);
  if (rest.length > 0) fail({ code: "BAD_USAGE", message: `Unexpected argument for domains list: ${rest[0]}` });
  try {
    print(await getSdk().domains.list(projectId));
  } catch (err) {
    reportSdkError(err);
  }
}

async function status(args) {
  const { projectId, rest } = parseCommon(args);
  const domain = rest[0];
  if (!domain) fail({ code: "BAD_USAGE", message: "Missing <domain>.", hint: "run402 domains status <domain> [--project <id>]" });
  if (rest.length > 1) fail({ code: "BAD_USAGE", message: `Unexpected argument for domains status: ${rest[1]}` });
  try {
    print(await getSdk().domains.get(projectId, domain));
  } catch (err) {
    reportSdkError(err);
  }
}

async function dns(args) {
  const parsed = normalizeArgv(args);
  const valueFlags = ["--project", "--format"];
  assertKnownFlags(parsed, [...valueFlags, "--help", "-h"], valueFlags);
  const rest = positionalArgs(parsed, valueFlags);
  const domain = rest[0];
  if (!domain) fail({ code: "BAD_USAGE", message: "Missing <domain>.", hint: "run402 domains dns <domain> [--format json|bind]" });
  const format = flagValue(parsed, "--format") ?? "json";
  if (!["json", "bind"].includes(format)) fail({ code: "BAD_FLAG", message: "--format must be json or bind.", details: { flag: "--format", value: format } });
  const projectId = resolveProjectId(flagValue(parsed, "--project"));
  try {
    const data = await getSdk().domains.get(projectId, domain);
    if (format === "bind") {
      console.log(data.dns_records.map((record) => record.bind).filter(Boolean).join("\n"));
    } else {
      print({ domain: data.domain, dns_records: data.dns_records, checks: data.checks, next_action: data.next_action });
    }
  } catch (err) {
    reportSdkError(err);
  }
}

async function action(name, args) {
  const extraValue = name === "test-receive" ? ["--to"] : name === "wait" ? ["--until", "--timeout-ms", "--interval-ms"] : name === "apply" ? ["--authority"] : [];
  const parsed = normalizeArgv(args);
  const valueFlags = ["--project", ...extraValue];
  assertKnownFlags(parsed, [...valueFlags, "--help", "-h"], valueFlags);
  const rest = positionalArgs(parsed, valueFlags);
  const domain = rest[0];
  if (!domain) fail({ code: "BAD_USAGE", message: `Missing <domain>.`, hint: `run402 domains ${name} <domain> [--project <id>]` });
  if (rest.length > 1) fail({ code: "BAD_USAGE", message: `Unexpected argument for domains ${name}: ${rest[1]}` });
  const projectId = resolveProjectId(flagValue(parsed, "--project"));
  try {
    const sdk = getSdk().domains;
    if (name === "check") return print(await sdk.check(projectId, domain));
    if (name === "apply") return print(await sdk.apply(projectId, domain));
    if (name === "repair") return print(await sdk.repair(projectId, domain));
    if (name === "activate") return print(await sdk.activate(projectId, domain));
    if (name === "test-receive") {
      const to = flagValue(parsed, "--to");
      if (!to) fail({ code: "BAD_FLAG", message: "--to is required for domains test-receive.", details: { flag: "--to" } });
      return print(await sdk.testReceive(projectId, domain, to));
    }
    if (name === "wait") {
      const until = flagValue(parsed, "--until") ?? "active";
      if (!["active", "safe", "receive-active"].includes(until)) fail({ code: "BAD_FLAG", message: "--until must be active, safe, or receive-active.", details: { flag: "--until", value: until } });
      const timeoutMs = parseIntegerFlag("--timeout-ms", flagValue(parsed, "--timeout-ms"), { min: 1, def: 120000 });
      const intervalMs = parseIntegerFlag("--interval-ms", flagValue(parsed, "--interval-ms"), { min: 1, def: 5000 });
      return print(await sdk.wait(projectId, domain, { until, timeoutMs, intervalMs }));
    }
  } catch (err) {
    reportSdkError(err);
  }
}

async function disconnect(args) {
  const parsed = normalizeArgv(args);
  const valueFlags = ["--project"];
  assertKnownFlags(parsed, [...valueFlags, "--confirm", "--help", "-h"], valueFlags);
  const rest = positionalArgs(parsed, valueFlags);
  const domain = rest[0];
  if (!domain) fail({ code: "BAD_USAGE", message: "Missing <domain>.", hint: "run402 domains disconnect <domain> --confirm [--project <id>]" });
  if (!parsed.includes("--confirm")) {
    fail({
      code: "CONFIRMATION_REQUIRED",
      message: `Disconnecting ${domain} removes the desired custom binding. Re-run with --confirm to proceed.`,
      details: { domain },
    });
  }
  const projectId = resolveProjectId(flagValue(parsed, "--project"));
  try {
    print(await getSdk().domains.disconnect(projectId, domain));
  } catch (err) {
    reportSdkError(err);
  }
}

export async function run(sub, args) {
  if (!sub || sub === "--help" || sub === "-h") { console.log(HELP); process.exit(0); }
  if ((args ?? []).includes("--help") || (args ?? []).includes("-h")) {
    const help = SUB_HELP[sub];
    if (help) {
      console.log(help);
      process.exit(0);
    }
  }
  switch (sub) {
    case "connect": await connect(args); break;
    case "list": await list(args); break;
    case "status": await status(args); break;
    case "dns": await dns(args); break;
    case "check": await action("check", args); break;
    case "apply": await action("apply", args); break;
    case "repair": await action("repair", args); break;
    case "test-receive": await action("test-receive", args); break;
    case "wait": await action("wait", args); break;
    case "activate": await action("activate", args); break;
    case "disconnect": await disconnect(args); break;
    case "add": removed("run402 domains add", "run402 domains connect <domain> --project <id> --web"); break;
    case "delete": removed("run402 domains delete", "run402 domains disconnect <domain> --project <id> --confirm"); break;
    default:
      failUnknownSubcommand("domains", sub);
  }
}
