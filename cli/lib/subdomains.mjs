import { resolveProject, resolveProjectId } from "./config.mjs";
import { getSdk } from "./sdk.mjs";
import { reportSdkError, fail } from "./sdk-errors.mjs";
import { assertKnownFlags, flagValue, normalizeArgv, positionalArgs } from "./argparse.mjs";

const HELP = `run402 subdomains — Manage custom subdomains

Usage:
  run402 subdomains <subcommand> [args...]

Subcommands:
  claim  <name> [--project <id>] [--deployment <id>]   Claim a subdomain
  delete <name> --confirm [--project <id>]              Release a subdomain. Requires --confirm.
  list   [--project <id>]                               List subdomains for a project

Options default to the active project and its last deployment when omitted.

Examples:
  run402 subdomains claim myapp
  run402 subdomains claim myapp --deployment dpl_abc123 --project prj_abc123
  run402 subdomains delete myapp --confirm
  run402 subdomains list

Notes:
  - Subdomain names: 3-63 chars, lowercase alphanumeric + hyphens
  - Creates <name>.run402.com pointing to the deployment
`;

const SUB_HELP = {
  claim: `run402 subdomains claim — Claim a custom subdomain for a deployment

Usage:
  run402 subdomains claim <name> [--project <id>] [--deployment <id>]

Arguments:
  <name>              Subdomain name (3-63 chars, lowercase alphanumeric +
                      hyphens). Creates <name>.run402.com.

Options:
  --project <id>      Project ID (defaults to the active project)
  --deployment <id>   Deployment ID to point at (defaults to the project's
                      last deployment)

Notes:
  - Deploy a site first (or pass --deployment) so there is a target to claim

Examples:
  run402 subdomains claim myapp
  run402 subdomains claim myapp --deployment dpl_abc123 --project prj_abc123
`,
  list: `run402 subdomains list — List subdomains claimed by a project

Usage:
  run402 subdomains list [--project <id>]

Options:
  --project <id>      Project ID (defaults to the active project)

Examples:
  run402 subdomains list
  run402 subdomains list --project prj_abc123
`,
  delete: `run402 subdomains delete — Release a claimed subdomain

Usage:
  run402 subdomains delete <name> --confirm [--project <id>]

Arguments:
  <name>              Subdomain name to release

Options:
  --confirm           Required: releasing a subdomain is irreversible and
                      makes it available for any other project to claim
  --project <id>      Project ID (defaults to the active project)

Examples:
  run402 subdomains delete myapp --confirm
  run402 subdomains delete myapp --confirm --project prj_abc123
`,
};

async function claim(args) {
  const parsedArgs = normalizeArgv(args);
  const valueFlags = ["--project", "--deployment"];
  assertKnownFlags(parsedArgs, [...valueFlags, "--help", "-h"], valueFlags);
  const opts = {
    project: flagValue(parsedArgs, "--project"),
    deployment: flagValue(parsedArgs, "--deployment"),
  };
  let name, deploymentId;
  const positionals = positionalArgs(parsedArgs, valueFlags);
  if (positionals.length > 1) {
    fail({
      code: "BAD_USAGE",
      message: `Unexpected argument for subdomains claim: ${positionals[1]}`,
      hint: "Use `run402 subdomains claim <name> --deployment <deployment_id>`.",
    });
  }
  if (positionals.length === 1) {
    name = positionals[0];
  }
  if (!name) {
    fail({
      code: "BAD_USAGE",
      message: "Missing <name>.",
      hint: "run402 subdomains claim <name> [--project <id>] [--deployment <id>]",
    });
  }
  const projectId = resolveProjectId(opts.project);
  const p = resolveProject(opts.project);
  deploymentId = opts.deployment || deploymentId || p.last_deployment_id;
  if (!deploymentId) {
    fail({
      code: "NO_DEPLOYMENT",
      message: "no deployment_id specified and no recent deployment found.",
      hint: "Deploy a site first or pass --deployment <id>.",
      details: { project_id: projectId },
      next_actions: [{ action: "deploy_site_first" }],
    });
  }
  try {
    const data = await getSdk().subdomains.claim(name, deploymentId, { projectId });
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function deleteSubdomain(allArgs) {
  const argList = normalizeArgv(Array.isArray(allArgs) ? allArgs : []);
  const valueFlags = ["--project"];
  assertKnownFlags(argList, [...valueFlags, "--confirm", "--help", "-h"], valueFlags);
  const opts = { project: flagValue(argList, "--project") };
  const positionals = positionalArgs(argList, valueFlags);
  let name = positionals[0] ?? null;
  if (!name) {
    fail({
      code: "BAD_USAGE",
      message: "Missing <name>.",
      hint: "run402 subdomains delete <name> --confirm [--project <id>]",
    });
  }
  if (positionals.length > 1) {
    fail({ code: "BAD_USAGE", message: `Unexpected argument for subdomains delete: ${positionals[1]}` });
  }
  if (!argList.includes("--confirm")) {
    fail({
      code: "CONFIRMATION_REQUIRED",
      message: `Destructive: releasing subdomain '${name}' makes it available for any other project to claim. This is irreversible. Re-run with --confirm to proceed.`,
      details: { name },
    });
  }
  const projectId = resolveProjectId(opts.project);
  try {
    await getSdk().subdomains.delete(name, { projectId });
    console.log(JSON.stringify({ status: "ok", message: `Subdomain '${name}' released.` }));
  } catch (err) {
    reportSdkError(err);
  }
}

function parseProjectFlag(args) {
  const parsedArgs = normalizeArgv(args);
  const valueFlags = ["--project"];
  assertKnownFlags(parsedArgs, [...valueFlags, "--help", "-h"], valueFlags);
  return {
    project: flagValue(parsedArgs, "--project"),
    rest: positionalArgs(parsedArgs, valueFlags),
  };
}

async function list(args) {
  const argList = Array.isArray(args) ? args : [];
  const { project, rest } = parseProjectFlag(argList);
  if (rest.length > 0) {
    fail({
      code: "BAD_USAGE",
      message: `Unexpected argument for subdomains list: ${rest[0]}`,
      hint: "Use `run402 subdomains list --project <id>`.",
    });
  }
  const projectId = resolveProjectId(project);
  try {
    const data = await getSdk().subdomains.list(projectId);
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

export async function run(sub, args) {
  if (!sub || sub === '--help' || sub === '-h') { console.log(HELP); process.exit(0); }
  if (Array.isArray(args) && (args.includes("--help") || args.includes("-h"))) { console.log(SUB_HELP[sub] || HELP); process.exit(0); }
  switch (sub) {
    case "claim": await claim(args); break;
    case "delete": await deleteSubdomain(args); break;
    case "list":   await list(args); break;
    default:
      console.error(`Unknown subcommand: ${sub}\n`);
      console.log(HELP);
      process.exit(1);
  }
}
