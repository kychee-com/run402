import { findProject, resolveProjectId, API } from "./config.mjs";

const HELP = `run402 ai — AI translation and moderation tools

Usage:
  run402 ai <subcommand> [args...]

Subcommands:
  translate <project_id> <text> --to <lang> [--from <lang>] [--context <hint>]
  moderate  <project_id> <text>
  usage     <project_id>

Examples:
  run402 ai translate proj-001 "Hello world" --to es
  run402 ai translate proj-001 "Hello" --to ja --from en --context "formal business email"
  run402 ai moderate proj-001 "content to check"
  run402 ai usage proj-001

Notes:
  - translate requires the AI Translation add-on on the project
  - moderate is free for all projects
  - usage shows translation word quota for the current billing period
`;

function parseFlag(args, flag) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && args[i + 1]) return args[i + 1];
  }
  return null;
}

async function translate(args) {
  let projectOpt = null;
  let text = null;
  const positional = [];
  let i = 0;
  while (i < args.length) {
    if (args[i] === "--project" && args[i + 1]) { projectOpt = args[++i]; }
    else if (args[i] === "--to" || args[i] === "--from" || args[i] === "--context") { i++; }
    else if (!args[i].startsWith("--")) { positional.push(args[i]); }
    i++;
  }

  const projectId = resolveProjectId(projectOpt || positional[0]);
  const p = findProject(projectId);
  text = positional[1] || null;

  const to = parseFlag(args, "--to");
  const from = parseFlag(args, "--from");
  const context = parseFlag(args, "--context");

  if (!text) { console.error(JSON.stringify({ status: "error", message: "Text required. Usage: run402 ai translate <project_id> <text> --to <lang>" })); process.exit(1); }
  if (!to) { console.error(JSON.stringify({ status: "error", message: "--to <lang> is required" })); process.exit(1); }

  const body = { text, to };
  if (from) body.from = from;
  if (context) body.context = context;

  const res = await fetch(`${API}/ai/v1/translate`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${p.service_key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) { console.error(JSON.stringify({ status: "error", http: res.status, ...data })); process.exit(1); }

  console.log(JSON.stringify({ status: "ok", text: data.text, from: data.from, to: data.to }));
}

async function moderate(args) {
  let projectOpt = null;
  let text = null;
  const positional = [];
  let i = 0;
  while (i < args.length) {
    if (args[i] === "--project" && args[i + 1]) { projectOpt = args[++i]; }
    else if (!args[i].startsWith("--")) { positional.push(args[i]); }
    i++;
  }

  const projectId = resolveProjectId(projectOpt || positional[0]);
  const p = findProject(projectId);
  text = positional[1] || null;

  if (!text) { console.error(JSON.stringify({ status: "error", message: "Text required. Usage: run402 ai moderate <project_id> <text>" })); process.exit(1); }

  const res = await fetch(`${API}/ai/v1/moderate`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${p.service_key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  const data = await res.json();
  if (!res.ok) { console.error(JSON.stringify({ status: "error", http: res.status, ...data })); process.exit(1); }

  console.log(JSON.stringify({ status: "ok", flagged: data.flagged, categories: data.categories, category_scores: data.category_scores }));
}

async function usage(args) {
  let projectOpt = null;
  const positional = [];
  let i = 0;
  while (i < args.length) {
    if (args[i] === "--project" && args[i + 1]) { projectOpt = args[++i]; }
    else if (!args[i].startsWith("--")) { positional.push(args[i]); }
    i++;
  }

  const projectId = resolveProjectId(projectOpt || positional[0]);
  const p = findProject(projectId);

  const res = await fetch(`${API}/ai/v1/usage`, {
    headers: { "Authorization": `Bearer ${p.service_key}` },
  });
  const data = await res.json();
  if (!res.ok) { console.error(JSON.stringify({ status: "error", http: res.status, ...data })); process.exit(1); }

  console.log(JSON.stringify({ status: "ok", ...data }));
}

export async function run(sub, args) {
  if (!sub || sub === '--help' || sub === '-h') { console.log(HELP); process.exit(0); }
  switch (sub) {
    case "translate": await translate(args); break;
    case "moderate":  await moderate(args); break;
    case "usage":     await usage(args); break;
    default:
      console.error(`Unknown subcommand: ${sub}\n`);
      console.log(HELP);
      process.exit(1);
  }
}
