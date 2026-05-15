import { allowanceAuthHeaders, saveProject } from "./config.mjs";
import { getSdk } from "./sdk.mjs";
import { reportSdkError, fail } from "./sdk-errors.mjs";
import { assertAllowedValue, assertKnownFlags, flagValue, normalizeArgv, positionalArgs } from "./argparse.mjs";

const HELP = `run402 apps — Browse and manage the app marketplace

Usage:
  run402 apps <subcommand> [args...]

Subcommands:
  browse  [--tag <tag>]                   Browse public apps
  fork    <version_id> <name> [--subdomain <name>]
                                           Fork a published app into your own project
  publish <id> [--description <desc>] [--tags <t1,t2>] [--visibility <v>] [--fork-allowed]
                                           Publish a project as an app
  versions <id>                            List published versions of a project
  inspect <version_id>                     Inspect a published app version
  update  <project_id> <version_id> [--description <desc>] [--tags <t1,t2>] [--visibility <v>] [--fork-allowed] [--no-fork]
                                           Update a published version
  delete  <project_id> <version_id>        Delete a published version

Examples:
  run402 apps browse
  run402 apps browse --tag auth
  run402 apps fork ver_abc123 my-todo
  run402 apps publish prj_abc123 --description "Todo app" --tags todo,auth --visibility public --fork-allowed
  run402 apps versions prj_abc123
  run402 apps inspect ver_abc123
  run402 apps update prj_abc123 ver_abc123 --description "Updated" --tags todo
  run402 apps delete prj_abc123 ver_abc123
`;

const SUB_HELP = {
  browse: `run402 apps browse — Browse public apps in the marketplace

Usage:
  run402 apps browse [--tag <tag>]

Options:
  --tag <tag>         Filter by tag; repeat the flag to filter on multiple tags

Examples:
  run402 apps browse
  run402 apps browse --tag auth
  run402 apps browse --tag todo --tag auth
`,
  fork: `run402 apps fork — Fork a published app into your own project

Usage:
  run402 apps fork <version_id> <name> [options]

Arguments:
  <version_id>        Published version ID (e.g. ver_abc123)
  <name>              Name for the forked project

Options:
  --subdomain <name>  Claim a subdomain for the forked project

Examples:
  run402 apps fork ver_abc123 my-todo
  run402 apps fork ver_abc123 my-todo --subdomain todo-v2
`,
  publish: `run402 apps publish — Publish a project as an app

Usage:
  run402 apps publish <id> [options]

Arguments:
  <id>                Project ID to publish

Options:
  --description <d>   Human-readable description of the app
  --tags <t1,t2>      Comma-separated list of tags
  --visibility <v>    Visibility: 'public', 'unlisted', or 'private'
  --fork-allowed      Allow other users to fork this app

Examples:
  run402 apps publish prj_abc123 --description "Todo app" --tags todo,auth
  run402 apps publish prj_abc123 --visibility public --fork-allowed
`,
  update: `run402 apps update — Update a published version's metadata

Usage:
  run402 apps update <project_id> <version_id> [options]

Arguments:
  <project_id>        Project ID that owns the version
  <version_id>        Published version ID to update

Options:
  --description <d>   New description
  --tags <t1,t2>      New comma-separated list of tags
  --visibility <v>    New visibility ('public' or 'private')
  --fork-allowed      Enable forking for this version
  --no-fork           Disable forking for this version

Examples:
  run402 apps update prj_abc123 ver_abc123 --description "Updated"
  run402 apps update prj_abc123 ver_abc123 --tags todo,auth --fork-allowed
  run402 apps update prj_abc123 ver_abc123 --no-fork
`,
  inspect: `run402 apps inspect — Inspect a published app version

Usage:
  run402 apps inspect <version_id>

Arguments:
  <version_id>        Published version ID (e.g. ver_abc123)

Examples:
  run402 apps inspect ver_abc123
`,
  versions: `run402 apps versions — List published versions of a project

Usage:
  run402 apps versions <id>

Arguments:
  <id>                Project ID (e.g. prj_abc123)

Examples:
  run402 apps versions prj_abc123
`,
  delete: `run402 apps delete — Delete a published version

Usage:
  run402 apps delete <project_id> <version_id>

Arguments:
  <project_id>        Project ID that owns the version
  <version_id>        Published version ID to delete

Examples:
  run402 apps delete prj_abc123 ver_abc123
`,
};

async function browse(args) {
  const parsedArgs = normalizeArgv(args);
  const valueFlags = ["--tag"];
  assertKnownFlags(parsedArgs, [...valueFlags, "--help", "-h"], valueFlags);
  const extra = positionalArgs(parsedArgs, valueFlags);
  if (extra.length > 0) {
    fail({ code: "BAD_USAGE", message: `Unexpected argument for apps browse: ${extra[0]}` });
  }
  const tags = [];
  for (let i = 0; i < parsedArgs.length; i++) {
    if (parsedArgs[i] === "--tag") tags.push(parsedArgs[++i]);
  }
  try {
    const data = await getSdk().apps.browse(tags.length > 0 ? tags : undefined);
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function fork(versionId, name, args) {
  const parsedArgs = normalizeArgv([versionId, name, ...args].filter((arg) => arg !== undefined));
  const valueFlags = ["--subdomain"];
  assertKnownFlags(parsedArgs, [...valueFlags, "--help", "-h"], valueFlags);
  const positionals = positionalArgs(parsedArgs, valueFlags);
  if (positionals.length < 2) {
    fail({ code: "BAD_USAGE", message: "Missing <version_id> and/or <name>." });
  }
  if (positionals.length > 2) {
    fail({ code: "BAD_USAGE", message: `Unexpected argument for apps fork: ${positionals[2]}` });
  }
  const opts = { subdomain: flagValue(parsedArgs, "--subdomain") ?? undefined };
  // Preserve the aggressive early exit when no allowance is configured.
  allowanceAuthHeaders("/fork/v1");

  try {
    const data = await getSdk().apps.fork({
      versionId: positionals[0],
      name: positionals[1],
      subdomain: opts.subdomain,
    });

    // SDK persists keys via the Node provider's saveProject; mirror that
    // here so we also capture site_url from the fork response.
    if (data.project_id) {
      saveProject(data.project_id, {
        anon_key: data.anon_key,
        service_key: data.service_key,
        site_url: data.site_url || data.subdomain_url,
      });
    }
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function publish(projectId, args) {
  const parsedArgs = normalizeArgv([projectId, ...args].filter((arg) => arg !== undefined));
  const valueFlags = ["--description", "--tags", "--visibility"];
  assertKnownFlags(parsedArgs, [...valueFlags, "--fork-allowed", "--help", "-h"], valueFlags);
  const positionals = positionalArgs(parsedArgs, valueFlags);
  if (positionals.length < 1) {
    fail({ code: "BAD_USAGE", message: "Missing <id>." });
  }
  if (positionals.length > 1) {
    fail({ code: "BAD_USAGE", message: `Unexpected argument for apps publish: ${positionals[1]}` });
  }
  const opts = { description: undefined, tags: undefined, visibility: undefined, forkAllowed: undefined };
  opts.description = flagValue(parsedArgs, "--description") ?? undefined;
  opts.tags = flagValue(parsedArgs, "--tags")?.split(",");
  opts.visibility = flagValue(parsedArgs, "--visibility") ?? undefined;
  if (opts.visibility) assertAllowedValue(opts.visibility, ["public", "unlisted", "private"], "--visibility");
  if (parsedArgs.includes("--fork-allowed")) opts.forkAllowed = true;
  try {
    const data = await getSdk().apps.publish(positionals[0], {
      description: opts.description,
      tags: opts.tags,
      visibility: opts.visibility,
      fork_allowed: opts.forkAllowed,
    });
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function versions(projectId, args = []) {
  const parsedArgs = normalizeArgv([projectId, ...args].filter((arg) => arg !== undefined));
  assertKnownFlags(parsedArgs, ["--help", "-h"]);
  const positionals = positionalArgs(parsedArgs);
  if (positionals.length !== 1) {
    fail({ code: "BAD_USAGE", message: positionals.length === 0 ? "Missing <id>." : `Unexpected argument for apps versions: ${positionals[1]}` });
  }
  try {
    const data = await getSdk().apps.listVersions(positionals[0]);
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function inspect(versionId, args = []) {
  const parsedArgs = normalizeArgv([versionId, ...args].filter((arg) => arg !== undefined));
  assertKnownFlags(parsedArgs, ["--help", "-h"]);
  const positionals = positionalArgs(parsedArgs);
  if (positionals.length !== 1) {
    fail({ code: "BAD_USAGE", message: positionals.length === 0 ? "Missing version ID" : `Unexpected argument for apps inspect: ${positionals[1]}` });
  }
  try {
    const data = await getSdk().apps.getApp(positionals[0]);
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function update(projectId, versionId, args) {
  const parsedArgs = normalizeArgv([projectId, versionId, ...args].filter((arg) => arg !== undefined));
  const valueFlags = ["--description", "--tags", "--visibility"];
  assertKnownFlags(parsedArgs, [...valueFlags, "--fork-allowed", "--no-fork", "--help", "-h"], valueFlags);
  const positionals = positionalArgs(parsedArgs, valueFlags);
  if (positionals.length < 2) {
    fail({ code: "BAD_USAGE", message: "Missing <project_id> and/or <version_id>." });
  }
  if (positionals.length > 2) {
    fail({ code: "BAD_USAGE", message: `Unexpected argument for apps update: ${positionals[2]}` });
  }
  if (parsedArgs.includes("--fork-allowed") && parsedArgs.includes("--no-fork")) {
    fail({ code: "BAD_USAGE", message: "Provide either --fork-allowed or --no-fork, not both." });
  }
  const opts = {};
  opts.description = flagValue(parsedArgs, "--description") ?? undefined;
  opts.tags = flagValue(parsedArgs, "--tags")?.split(",");
  opts.visibility = flagValue(parsedArgs, "--visibility") ?? undefined;
  if (opts.visibility) assertAllowedValue(opts.visibility, ["public", "unlisted", "private"], "--visibility");
  if (parsedArgs.includes("--fork-allowed")) opts.fork_allowed = true;
  if (parsedArgs.includes("--no-fork")) opts.fork_allowed = false;
  try {
    await getSdk().apps.updateVersion(positionals[0], positionals[1], opts);
    console.log(JSON.stringify({ status: "ok", project_id: positionals[0], version_id: positionals[1] }));
  } catch (err) {
    reportSdkError(err);
  }
}

async function deleteVersion(projectId, versionId, args = []) {
  const parsedArgs = normalizeArgv([projectId, versionId, ...args].filter((arg) => arg !== undefined));
  assertKnownFlags(parsedArgs, ["--help", "-h"]);
  const positionals = positionalArgs(parsedArgs);
  if (positionals.length < 2) {
    fail({ code: "BAD_USAGE", message: "Missing <project_id> and/or <version_id>." });
  }
  if (positionals.length > 2) {
    fail({ code: "BAD_USAGE", message: `Unexpected argument for apps delete: ${positionals[2]}` });
  }
  try {
    await getSdk().apps.deleteVersion(positionals[0], positionals[1]);
    console.log(JSON.stringify({ status: "ok", message: `Version ${positionals[1]} deleted.` }));
  } catch (err) {
    reportSdkError(err);
  }
}

export async function run(sub, args) {
  if (!sub || sub === '--help' || sub === '-h') { console.log(HELP); process.exit(0); }
  if (Array.isArray(args) && (args.includes("--help") || args.includes("-h"))) { console.log(SUB_HELP[sub] || HELP); process.exit(0); }
  switch (sub) {
    case "browse":   await browse(args); break;
    case "fork":     await fork(args[0], args[1], args.slice(2)); break;
    case "publish":  await publish(args[0], args.slice(1)); break;
    case "versions": await versions(args[0], args.slice(1)); break;
    case "inspect":  await inspect(args[0], args.slice(1)); break;
    case "update":   await update(args[0], args[1], args.slice(2)); break;
    case "delete":   await deleteVersion(args[0], args[1], args.slice(2)); break;
    default:
      console.error(`Unknown subcommand: ${sub}\n`);
      console.log(HELP);
      process.exit(1);
  }
}
