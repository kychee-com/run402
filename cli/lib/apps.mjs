import { findProject, API, walletAuthHeaders, saveProject } from "./config.mjs";

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

async function browse(args) {
  let url = `${API}/apps/v1`;
  const tags = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--tag" && args[i + 1]) tags.push(args[++i]);
  }
  if (tags.length > 0) url += "?" + tags.map(t => `tag=${encodeURIComponent(t)}`).join("&");
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok) { console.error(JSON.stringify({ status: "error", http: res.status, ...data })); process.exit(1); }
  console.log(JSON.stringify(data, null, 2));
}

async function fork(versionId, name, args) {
  const opts = { tier: "prototype", subdomain: undefined };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--tier" && args[i + 1]) opts.tier = args[++i];
    if (args[i] === "--subdomain" && args[i + 1]) opts.subdomain = args[++i];
  }
  const authHeaders = await walletAuthHeaders();

  const body = { version_id: versionId, name };
  if (opts.subdomain) body.subdomain = opts.subdomain;

  const res = await fetch(`${API}/fork/v1`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) { console.error(JSON.stringify({ status: "error", http: res.status, ...data })); process.exit(1); }

  // Save project credentials locally
  if (data.project_id) {
    saveProject(data.project_id, {
      anon_key: data.anon_key, service_key: data.service_key,
      tier: data.tier, lease_expires_at: data.lease_expires_at,
      site_url: data.site_url || data.subdomain_url,
      deployed_at: new Date().toISOString(),
    });
  }
  console.log(JSON.stringify(data, null, 2));
}

async function publish(projectId, args) {
  const p = findProject(projectId);
  const opts = { description: undefined, tags: undefined, visibility: undefined, forkAllowed: undefined };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--description" && args[i + 1]) opts.description = args[++i];
    if (args[i] === "--tags" && args[i + 1]) opts.tags = args[++i].split(",");
    if (args[i] === "--visibility" && args[i + 1]) opts.visibility = args[++i];
    if (args[i] === "--fork-allowed") opts.forkAllowed = true;
  }
  const body = {};
  if (opts.description) body.description = opts.description;
  if (opts.tags) body.tags = opts.tags;
  if (opts.visibility) body.visibility = opts.visibility;
  if (opts.forkAllowed !== undefined) body.fork_allowed = opts.forkAllowed;

  const res = await fetch(`${API}/projects/v1/admin/${projectId}/publish`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${p.service_key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) { console.error(JSON.stringify({ status: "error", http: res.status, ...data })); process.exit(1); }
  console.log(JSON.stringify(data, null, 2));
}

async function versions(projectId) {
  const p = findProject(projectId);
  const res = await fetch(`${API}/projects/v1/admin/${projectId}/versions`, {
    headers: { "Authorization": `Bearer ${p.service_key}` },
  });
  const data = await res.json();
  if (!res.ok) { console.error(JSON.stringify({ status: "error", http: res.status, ...data })); process.exit(1); }
  console.log(JSON.stringify(data, null, 2));
}

async function inspect(versionId) {
  if (!versionId) { console.error(JSON.stringify({ status: "error", message: "Missing version ID" })); process.exit(1); }
  const res = await fetch(`${API}/apps/v1/${versionId}`);
  const data = await res.json();
  if (!res.ok) { console.error(JSON.stringify({ status: "error", http: res.status, ...data })); process.exit(1); }
  console.log(JSON.stringify(data, null, 2));
}

async function update(projectId, versionId, args) {
  const p = findProject(projectId);
  const body = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--description" && args[i + 1]) body.description = args[++i];
    if (args[i] === "--tags" && args[i + 1]) body.tags = args[++i].split(",");
    if (args[i] === "--visibility" && args[i + 1]) body.visibility = args[++i];
    if (args[i] === "--fork-allowed") body.fork_allowed = true;
    if (args[i] === "--no-fork") body.fork_allowed = false;
  }
  const res = await fetch(`${API}/projects/v1/admin/${projectId}/versions/${versionId}`, {
    method: "PATCH",
    headers: { "Authorization": `Bearer ${p.service_key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) { console.error(JSON.stringify({ status: "error", http: res.status, ...data })); process.exit(1); }
  console.log(JSON.stringify(data, null, 2));
}

async function deleteVersion(projectId, versionId) {
  const p = findProject(projectId);
  const res = await fetch(`${API}/projects/v1/admin/${projectId}/versions/${versionId}`, {
    method: "DELETE",
    headers: { "Authorization": `Bearer ${p.service_key}` },
  });
  if (res.status === 204 || res.ok) {
    console.log(JSON.stringify({ status: "ok", message: `Version ${versionId} deleted.` }));
  } else {
    const data = await res.json();
    console.error(JSON.stringify({ status: "error", http: res.status, ...data }));
    process.exit(1);
  }
}

export async function run(sub, args) {
  if (!sub || sub === '--help' || sub === '-h') { console.log(HELP); process.exit(0); }
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
