import { resolveProjectId } from "./config.mjs";
import { getSdk } from "./sdk.mjs";
import { reportSdkError, fail } from "./sdk-errors.mjs";
import { assertKnownFlags, flagValue, normalizeArgv, positionalArgs } from "./argparse.mjs";

const HELP = `run402 domains — Manage custom domains

Usage:
  run402 domains <subcommand> [args...]

Subcommands:
  add    <domain> <subdomain_name> [--project <id>]   Register a custom domain
  list   [--project <id>]                              List custom domains for a project
  status <domain> [--project <id>]                     Check domain DNS/SSL status
  delete <domain> --confirm [--project <id>]           Release a custom domain. Requires --confirm.

Examples:
  run402 domains add example.com myapp
  run402 domains add example.com myapp --project prj_123
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
  run402 domains add <domain> <subdomain_name> [--project <id>]

Arguments:
  <domain>            Custom domain (e.g. example.com)
  <subdomain_name>    Existing subdomain to map the custom domain to

Options:
  --project <id>      Project ID (defaults to the active project)

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
  run402 domains list [--project <id>]

Arguments:
  <id>                Project ID (defaults to the active project)

Examples:
  run402 domains list
  run402 domains list --project prj_abc123
`,
  status: `run402 domains status — Check DNS/SSL status of a custom domain

Usage:
  run402 domains status <domain> [--project <id>]

Arguments:
  <domain>            Custom domain to check

Options:
  --project <id>      Project ID (defaults to the active project)

Examples:
  run402 domains status example.com
  run402 domains status example.com --project prj_abc123
`,
  delete: `run402 domains delete — Release a custom domain

Usage:
  run402 domains delete <domain> --confirm [--project <id>]

Arguments:
  <domain>            Custom domain to release

Options:
  --confirm           Required: releasing detaches the domain from this
                      project and clears its DNS/SSL configuration
                      (irreversible)
  --project <id>      Project ID (defaults to the active project)

Examples:
  run402 domains delete example.com --confirm
`,
};

function parseProjectFlag(args, extraKnown = []) {
  const parsedArgs = normalizeArgv(args);
  const valueFlags = ["--project"];
  assertKnownFlags(parsedArgs, [...valueFlags, ...extraKnown, "--help", "-h"], valueFlags);
  return {
    project: flagValue(parsedArgs, "--project"),
    rest: positionalArgs(parsedArgs, valueFlags),
    args: parsedArgs,
  };
}

async function add(args) {
  const { project, rest } = parseProjectFlag(args);
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
    const data = await getSdk().domains.add(projectId, domain, subdomainName);
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function list(args) {
  const argList = Array.isArray(args) ? args : [];
  const { project, rest } = parseProjectFlag(argList);
  if (rest.length > 0) {
    fail({
      code: "BAD_USAGE",
      message: `Unexpected argument for domains list: ${rest[0]}`,
      hint: "Use `run402 domains list --project <id>`.",
    });
  }
  const projectId = resolveProjectId(project);
  try {
    const data = await getSdk().domains.list(projectId);
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function status(args) {
  const { project, rest } = parseProjectFlag(args);
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
    const data = await getSdk().domains.status(projectId, domain);
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function deleteDomain(args) {
  const { project, rest, args: parsedArgs } = parseProjectFlag(args, ["--confirm"]);
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
    await getSdk().domains.remove(domain, { projectId });
    console.log(JSON.stringify({ status: "ok", message: `Domain '${domain}' released.` }));
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
      console.error(`Unknown subcommand: ${sub}\n`);
      console.log(HELP);
      process.exit(1);
  }
}
