import { resolveProject, resolveProjectId } from "./config.mjs";
import { getSdk } from "./sdk.mjs";
import { reportSdkError, fail } from "./sdk-errors.mjs";
import { assertKnownFlags, flagValue, normalizeArgv, positionalArgs, failUnknownSubcommand } from "./argparse.mjs";

const HELP = `run402 subdomains — Manage custom subdomains

Usage:
  run402 subdomains <subcommand> [args...]

Subcommands:
  claim  <name> [--project <id>] [--release <id> | --deployment <id>]   Claim a subdomain
  delete <name> --confirm [--project <id>]                              Release a subdomain. Requires --confirm.
  list   [--project <id>]                                               List subdomains for a project

Options default to the active project. With neither --release nor
--deployment, claim binds the project's live release.

Examples:
  run402 subdomains claim myapp
  run402 subdomains claim myapp --release rel_abc123 --project prj_abc123
  run402 subdomains delete myapp --confirm
  run402 subdomains list

Notes:
  - Subdomain names: 3-63 chars, lowercase alphanumeric + hyphens
  - Creates <name>.run402.com pointing to the bound release
  - Or declare it in the deploy manifest: "subdomains": { "set": ["myapp"] }
`;

const SUB_HELP = {
  claim: `run402 subdomains claim — Claim a custom subdomain for a release

Usage:
  run402 subdomains claim <name> [--project <id>] [--release <id> | --deployment <id>]

Arguments:
  <name>              Subdomain name (3-63 chars, lowercase alphanumeric +
                      hyphens). Creates <name>.run402.com.

Options:
  --project <id>      Project ID (defaults to the active project)
  --release <id>      Release ID (rel_...) to point at. With neither flag,
                      the project's live release is bound.
  --deployment <id>   Legacy deployment ID (dpl_...); rel_.../op_... ids are
                      accepted too.

Notes:
  - With no flag the gateway binds the project's live (active) release; a
    project with no live site answers 404.
  - A deploy manifest can declare the same thing: "subdomains": { "set": ["<name>"] }

Examples:
  run402 subdomains claim myapp
  run402 subdomains claim myapp --release rel_abc123 --project prj_abc123
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
  const valueFlags = ["--project", "--deployment", "--release"];
  assertKnownFlags(parsedArgs, [...valueFlags, "--help", "-h"], valueFlags);
  const opts = {
    project: flagValue(parsedArgs, "--project"),
    deployment: flagValue(parsedArgs, "--deployment"),
    release: flagValue(parsedArgs, "--release"),
  };
  let name;
  const positionals = positionalArgs(parsedArgs, valueFlags);
  if (positionals.length > 1) {
    fail({
      code: "BAD_USAGE",
      message: `Unexpected argument for subdomains claim: ${positionals[1]}`,
      hint: "Use `run402 subdomains claim <name> [--release <rel_id>]`.",
    });
  }
  if (positionals.length === 1) {
    name = positionals[0];
  }
  if (!name) {
    fail({
      code: "BAD_USAGE",
      message: "Missing <name>.",
      hint: "run402 subdomains claim <name> [--project <id>] [--release <id> | --deployment <id>]",
    });
  }
  if (opts.deployment && opts.release) {
    fail({
      code: "BAD_USAGE",
      message: "Pass either --release or --deployment, not both.",
      hint: "run402 subdomains claim <name> [--release <id> | --deployment <id>]",
    });
  }
  const projectId = resolveProjectId(opts.project);
  const p = resolveProject(opts.project);
  // With neither flag, the keystore's cached `last_deployment_id` is only an
  // optimization; absent one, the gateway resolves the project's live
  // release itself. Never fail client-side here — a unified-apply deploy
  // may never have written the cache.
  const deploymentId = opts.deployment || (opts.release ? undefined : p.last_deployment_id) || undefined;
  const releaseId = opts.release || undefined;
  try {
    const data = await getSdk().subdomains.claim({ name, deploymentId, releaseId, projectId });
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
    console.log(JSON.stringify({ name, project_id: projectId, released: true }));
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
      failUnknownSubcommand("subdomains", sub);
  }
}
