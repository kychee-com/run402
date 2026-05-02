import { resolveProject, resolveProjectId } from "./config.mjs";
import { getSdk } from "./sdk.mjs";
import { reportSdkError, fail } from "./sdk-errors.mjs";

const HELP = `run402 subdomains — Manage custom subdomains

Usage:
  run402 subdomains <subcommand> [args...]

Subcommands:
  claim  <name> [--project <id>] [--deployment <id>]   Claim a subdomain
  delete <name> --confirm [--project <id>]              Release a subdomain. Requires --confirm.
  list   [<id>]                                         List subdomains for a project

Options default to the active project and its last deployment when omitted.
Legacy syntax 'claim <deployment_id> <name>' is still supported.

Examples:
  run402 subdomains claim myapp
  run402 subdomains claim myapp --deployment dpl_abc123 --project proj123
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
  - Legacy syntax 'claim <deployment_id> <name>' is still supported
  - Deploy a site first (or pass --deployment) so there is a target to claim

Examples:
  run402 subdomains claim myapp
  run402 subdomains claim myapp --deployment dpl_abc123 --project proj123
`,
};

async function claim(positionalArgs, flagArgs) {
  const opts = { project: null, deployment: null };
  for (let i = 0; i < flagArgs.length; i++) {
    if (flagArgs[i] === "--project" && flagArgs[i + 1]) opts.project = flagArgs[++i];
    if (flagArgs[i] === "--deployment" && flagArgs[i + 1]) opts.deployment = flagArgs[++i];
  }
  let name, deploymentId;
  if (positionalArgs.length >= 2) {
    deploymentId = positionalArgs[0];
    name = positionalArgs[1];
  } else if (positionalArgs.length === 1) {
    name = positionalArgs[0];
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
  const argList = Array.isArray(allArgs) ? allArgs : [];
  let opts = { project: null };
  let name = null;
  for (let i = 0; i < argList.length; i++) {
    if (argList[i] === "--project" && argList[i + 1]) { opts.project = argList[++i]; }
    else if (!argList[i].startsWith("--") && !name) { name = argList[i]; }
  }
  if (!name) {
    fail({
      code: "BAD_USAGE",
      message: "Missing <name>.",
      hint: "run402 subdomains delete <name> --confirm [--project <id>]",
    });
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

async function list(projectIdArg) {
  const projectId = resolveProjectId(projectIdArg);
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
    case "claim": {
      const positional = [];
      const flags = [];
      let i = 0;
      while (i < args.length) {
        if (args[i].startsWith("--")) { flags.push(args[i], args[i + 1]); i += 2; }
        else { positional.push(args[i]); i++; }
      }
      await claim(positional, flags);
      break;
    }
    case "delete": await deleteSubdomain(args); break;
    case "list":   await list(args[0]); break;
    default:
      console.error(`Unknown subcommand: ${sub}\n`);
      console.log(HELP);
      process.exit(1);
  }
}
