import { resolveProjectId } from "./config.mjs";
import { getSdk } from "./sdk.mjs";
import { reportSdkError, fail } from "./sdk-errors.mjs";

const HELP = `run402 ai — AI translation and moderation tools

Usage:
  run402 ai <subcommand> [args...]

Subcommands:
  translate <project_id> <text> --to <lang> [--from <lang>] [--context <hint>]
  moderate  <project_id> <text>
  usage     <project_id>

Examples:
  run402 ai translate prj_abc123 "Hello world" --to es
  run402 ai translate prj_abc123 "Hello" --to ja --from en --context "formal business email"
  run402 ai moderate prj_abc123 "content to check"
  run402 ai usage prj_abc123

Notes:
  - translate requires the AI Translation add-on on the project
  - moderate is free for all projects
  - usage shows translation word quota for the current billing period
`;

const SUB_HELP = {
  translate: `run402 ai translate — Translate text to another language

Usage:
  run402 ai translate <project_id> <text> --to <lang> [--from <lang>] [--context <hint>]

Arguments:
  <project_id>        Project ID (defaults to the active project if omitted)
  <text>              Text to translate (quote it to preserve spaces)

Options:
  --to <lang>         Target language code (required, e.g. es, ja, fr)
  --from <lang>       Source language code (optional; auto-detected if omitted)
  --context <hint>    Optional translation hint (e.g. "formal business email")

Notes:
  - Requires the AI Translation add-on on the project
  - Counts against the project's translation word quota

Examples:
  run402 ai translate prj_abc123 "Hello world" --to es
  run402 ai translate prj_abc123 "Hello" --to ja --from en \\
    --context "formal business email"
`,
};

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
  text = positional[1] || null;

  const to = parseFlag(args, "--to");
  const from = parseFlag(args, "--from");
  const context = parseFlag(args, "--context");

  if (!text) {
    fail({
      code: "BAD_USAGE",
      message: "Text required.",
      hint: "run402 ai translate <project_id> <text> --to <lang>",
    });
  }
  if (!to) {
    fail({ code: "BAD_USAGE", message: "--to <lang> is required" });
  }

  try {
    const data = await getSdk().ai.translate(projectId, { text, to, from: from ?? undefined, context: context ?? undefined });
    console.log(JSON.stringify({ status: "ok", text: data.text, from: data.from, to: data.to }));
  } catch (err) {
    reportSdkError(err);
  }
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
  text = positional[1] || null;

  if (!text) {
    fail({
      code: "BAD_USAGE",
      message: "Text required.",
      hint: "run402 ai moderate <project_id> <text>",
    });
  }

  try {
    const data = await getSdk().ai.moderate(projectId, text);
    console.log(JSON.stringify({ status: "ok", flagged: data.flagged, categories: data.categories, category_scores: data.category_scores }));
  } catch (err) {
    reportSdkError(err);
  }
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

  try {
    const data = await getSdk().ai.usage(projectId);
    console.log(JSON.stringify({ status: "ok", ...data }));
  } catch (err) {
    reportSdkError(err);
  }
}

export async function run(sub, args) {
  if (!sub || sub === '--help' || sub === '-h') { console.log(HELP); process.exit(0); }
  if (Array.isArray(args) && (args.includes("--help") || args.includes("-h"))) { console.log(SUB_HELP[sub] || HELP); process.exit(0); }
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
