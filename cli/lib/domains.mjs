import { resolveProjectId } from "./config.mjs";
import { getSdk } from "./sdk.mjs";
import { reportSdkError, fail } from "./sdk-errors.mjs";
import { assertKnownFlags, flagValue, normalizeArgv, positionalArgs } from "./argparse.mjs";

const HELP = `run402 domains — Manage custom domains

Usage:
  run402 domains <subcommand> [args...]

Subcommands:
  add    <domain> <subdomain_name> [--project <id>] [--auth principal|service-key]
  list   [--project <id>] [--auth principal|service-key]
  status <domain> [--project <id>] [--auth principal|service-key]
  delete <domain> --confirm [--project <id>] [--auth principal|service-key]

Examples:
  run402 domains add example.com myapp
	  run402 domains add example.com myapp --project prj_123
	  run402 domains list --project prj_123 --auth service-key
  run402 domains list
  run402 domains status example.com
  run402 domains delete example.com --confirm

Notes:
  - After adding a domain, configure DNS as shown in the response
  - Poll 'status' until the domain is active (DNS propagation ~60s)
  - The domain must CNAME to domains.run402.com (or ALIAS for apex domains)
`;

const SUB_HELP = {
  add: `run402 domains add — Register a custom domain for a project

Usage:
  run402 domains add <domain> <subdomain_name> [--project <id>] [--auth principal|service-key]

Arguments:
  <domain>            Custom domain (e.g. example.com)
  <subdomain_name>    Existing subdomain to map the custom domain to

Options:
  --project <id>      Project ID (defaults to the active project)
  --auth <mode>       principal (default, server-authoritative) or service-key
                      (uses local project-key cache)

Notes:
  - After adding, configure DNS as shown in the response
  - Poll 'run402 domains status <domain>' until active
  - The domain must CNAME to domains.run402.com (or ALIAS for apex domains)

Examples:
  run402 domains add example.com myapp
  run402 domains add example.com myapp --project prj_abc123
`,
  list: `run402 domains list — List custom domains for a project

Usage:
  run402 domains list [--project <id>] [--auth principal|service-key]

	Arguments:
	  <id>                Project ID (defaults to the active project)

Options:
  --auth <mode>       principal (default, server-authoritative) or service-key
                      (uses local project-key cache)

Examples:
  run402 domains list
  run402 domains list --project prj_abc123
`,
  status: `run402 domains status — Check DNS/SSL status of a custom domain

Usage:
  run402 domains status <domain> [--project <id>] [--auth principal|service-key]

Arguments:
  <domain>            Custom domain to check

Options:
  --project <id>      Project ID (defaults to the active project)
  --auth <mode>       principal (default, server-authoritative) or service-key
                      (uses local project-key cache)

Examples:
  run402 domains status example.com
  run402 domains status example.com --project prj_abc123
`,
  delete: `run402 domains delete — Release a custom domain

Usage:
  run402 domains delete <domain> --confirm [--project <id>] [--auth principal|service-key]

Arguments:
  <domain>            Custom domain to release

Options:
  --confirm           Required: releasing detaches the domain from this
                      project and clears its DNS/SSL configuration
                      (irreversible)
  --project <id>      Project ID (defaults to the active project)
  --auth <mode>       principal (default, server-authoritative) or service-key
                      (uses local project-key cache)

Examples:
  run402 domains delete example.com --confirm
`,
};

function parseProjectFlag(args, extraKnown = []) {
  const parsedArgs = normalizeArgv(args);
  const valueFlags = ["--project", "--auth"];
  assertKnownFlags(parsedArgs, [...valueFlags, ...extraKnown, "--help", "-h"], valueFlags);
  const auth = flagValue(parsedArgs, "--auth") ?? "principal";
  if (auth !== "principal" && auth !== "service-key") {
    fail({
      code: "BAD_FLAG",
      message: "--auth must be one of: principal, service-key.",
      details: { flag: "--auth", value: auth, allowed: ["principal", "service-key"] },
    });
  }
  return {
    project: flagValue(parsedArgs, "--project"),
    authMode: auth === "service-key" ? "service_key" : "principal",
    rest: positionalArgs(parsedArgs, valueFlags),
    args: parsedArgs,
  };
}

async function add(args) {
  const { project, authMode, rest } = parseProjectFlag(args);
  const domain = rest[0];
  const subdomainName = rest[1];
  if (!domain || !subdomainName) {
    fail({
      code: "BAD_USAGE",
      message: "Missing <domain> and/or <subdomain_name>.",
      hint: "run402 domains add <domain> <subdomain_name> [--project <id>]",
    });
  }
  if (rest.length > 2) {
    fail({ code: "BAD_USAGE", message: `Unexpected argument for domains add: ${rest[2]}` });
  }
  const projectId = resolveProjectId(project);
  try {
    const data = await getSdk().domains.add(projectId, { domain, subdomainName, authMode });
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function list(args) {
  const argList = Array.isArray(args) ? args : [];
  const { project, authMode, rest } = parseProjectFlag(argList);
  if (rest.length > 0) {
    fail({
      code: "BAD_USAGE",
      message: `Unexpected argument for domains list: ${rest[0]}`,
      hint: "Use `run402 domains list --project <id>`.",
    });
  }
  const projectId = resolveProjectId(project);
  try {
    const data = await getSdk().domains.list(projectId, { authMode });
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function status(args) {
  const { project, authMode, rest } = parseProjectFlag(args);
  const domain = rest[0];
  if (!domain) {
    fail({
      code: "BAD_USAGE",
      message: "Missing <domain>.",
      hint: "run402 domains status <domain> [--project <id>]",
    });
  }
  if (rest.length > 1) {
    fail({ code: "BAD_USAGE", message: `Unexpected argument for domains status: ${rest[1]}` });
  }
  const projectId = resolveProjectId(project);
  try {
    const data = await getSdk().domains.status(projectId, domain, { authMode });
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function deleteDomain(args) {
  const { project, authMode, rest, args: parsedArgs } = parseProjectFlag(args, ["--confirm"]);
  const domain = rest[0];
  if (!domain) {
    fail({
      code: "BAD_USAGE",
      message: "Missing <domain>.",
      hint: "run402 domains delete <domain> --confirm [--project <id>]",
    });
  }
  if (rest.length > 1) {
    fail({ code: "BAD_USAGE", message: `Unexpected argument for domains delete: ${rest[1]}` });
  }
  if (!parsedArgs.includes("--confirm")) {
    fail({
      code: "CONFIRMATION_REQUIRED",
      message: `Destructive: releasing custom domain '${domain}' detaches it from this project and clears its DNS/SSL configuration. This is irreversible. Re-run with --confirm to proceed.`,
      details: { domain },
    });
  }
  const projectId = resolveProjectId(project);
  try {
    await getSdk().domains.remove(domain, { projectId, authMode });
    console.log(JSON.stringify({ domain, project_id: projectId, released: true }));
  } catch (err) {
    reportSdkError(err);
  }
}

export async function run(sub, args) {
  if (!sub || sub === '--help' || sub === '-h') { console.log(HELP); process.exit(0); }
  if (Array.isArray(args) && (args.includes("--help") || args.includes("-h"))) { console.log(SUB_HELP[sub] || HELP); process.exit(0); }
  switch (sub) {
    case "add":    await add(args); break;
    case "list":   await list(args); break;
    case "status": await status(args); break;
    case "delete": await deleteDomain(args); break;
    default:
      fail({ code: "UNKNOWN_SUBCOMMAND", message: `Unknown domains subcommand: ${sub}`, hint: "Run `run402 domains --help` for usage.", details: { command: "domains", subcommand: sub } });
  }
}
