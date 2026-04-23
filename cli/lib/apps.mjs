import { allowanceAuthHeaders, saveProject } from "./config.mjs";
import { getSdk } from "./sdk.mjs";
import { reportSdkError } from "./sdk-errors.mjs";

const HELP = `run402 apps — Browse and manage the app marketplace

Usage:
  run402 apps <subcommand> [args...]

Subcommands:
  browse  [--tag <tag>]                   Browse public apps
  fork    <version_id> <name> [--tier <tier>] [--subdomain <name>]
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
  run402 apps fork ver_abc123 my-todo --tier prototype
  run402 apps publish proj123 --description "Todo app" --tags todo,auth --visibility public --fork-allowed
  run402 apps versions proj123
  run402 apps inspect ver_abc123
  run402 apps update proj123 ver_abc123 --description "Updated" --tags todo
  run402 apps delete proj123 ver_abc123
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
  --tier <tier>       Tier for the new project (default: prototype)
  --subdomain <name>  Claim a subdomain for the forked project

Examples:
  run402 apps fork ver_abc123 my-todo
  run402 apps fork ver_abc123 my-todo --tier hobby --subdomain todo-v2
`,
  publish: `run402 apps publish — Publish a project as an app

Usage:
  run402 apps publish <id> [options]

Arguments:
  <id>                Project ID to publish

Options:
  --description <d>   Human-readable description of the app
  --tags <t1,t2>      Comma-separated list of tags
  --visibility <v>    Visibility: 'public' or 'private'
  --fork-allowed      Allow other users to fork this app

Examples:
  run402 apps publish proj123 --description "Todo app" --tags todo,auth
  run402 apps publish proj123 --visibility public --fork-allowed
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
  run402 apps update proj123 ver_abc123 --description "Updated"
  run402 apps update proj123 ver_abc123 --tags todo,auth --fork-allowed
  run402 apps update proj123 ver_abc123 --no-fork
`,
};

async function browse(args) {
  const tags = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--tag" && args[i + 1]) tags.push(args[++i]);
  }
  try {
    const data = await getSdk().apps.browse(tags.length > 0 ? tags : undefined);
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function fork(versionId, name, args) {
  const opts = { tier: "prototype", subdomain: undefined };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--tier" && args[i + 1]) opts.tier = args[++i];
    if (args[i] === "--subdomain" && args[i + 1]) opts.subdomain = args[++i];
  }
  // Preserve the aggressive early exit when no allowance is configured.
  allowanceAuthHeaders("/fork/v1");

  try {
    const data = await getSdk().apps.fork({
      versionId,
      name,
      subdomain: opts.subdomain,
    });

    // SDK persists via the Node provider's saveProject/setActiveProject; we
    // mirror the old CLI behavior here (deployed_at + site_url surfaced from
    // the fork response) with a follow-up updateProject for the extra fields.
    if (data.project_id) {
      saveProject(data.project_id, {
        anon_key: data.anon_key,
        service_key: data.service_key,
        site_url: data.site_url || data.subdomain_url,
        deployed_at: new Date().toISOString(),
      });
    }
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function publish(projectId, args) {
  const opts = { description: undefined, tags: undefined, visibility: undefined, forkAllowed: undefined };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--description" && args[i + 1]) opts.description = args[++i];
    if (args[i] === "--tags" && args[i + 1]) opts.tags = args[++i].split(",");
    if (args[i] === "--visibility" && args[i + 1]) opts.visibility = args[++i];
    if (args[i] === "--fork-allowed") opts.forkAllowed = true;
  }
  try {
    const data = await getSdk().apps.publish(projectId, {
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

async function versions(projectId) {
  try {
    const data = await getSdk().apps.listVersions(projectId);
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function inspect(versionId) {
  if (!versionId) { console.error(JSON.stringify({ status: "error", message: "Missing version ID" })); process.exit(1); }
  try {
    const data = await getSdk().apps.getApp(versionId);
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function update(projectId, versionId, args) {
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--description" && args[i + 1]) opts.description = args[++i];
    if (args[i] === "--tags" && args[i + 1]) opts.tags = args[++i].split(",");
    if (args[i] === "--visibility" && args[i + 1]) opts.visibility = args[++i];
    if (args[i] === "--fork-allowed") opts.fork_allowed = true;
    if (args[i] === "--no-fork") opts.fork_allowed = false;
  }
  try {
    await getSdk().apps.updateVersion(projectId, versionId, opts);
    console.log(JSON.stringify({ status: "ok", project_id: projectId, version_id: versionId }));
  } catch (err) {
    reportSdkError(err);
  }
}

async function deleteVersion(projectId, versionId) {
  try {
    await getSdk().apps.deleteVersion(projectId, versionId);
    console.log(JSON.stringify({ status: "ok", message: `Version ${versionId} deleted.` }));
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
    case "versions": await versions(args[0]); break;
    case "inspect":  await inspect(args[0]); break;
    case "update":   await update(args[0], args[1], args.slice(2)); break;
    case "delete":   await deleteVersion(args[0], args[1]); break;
    default:
      console.error(`Unknown subcommand: ${sub}\n`);
      console.log(HELP);
      process.exit(1);
  }
}
