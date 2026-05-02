import { resolveProjectId } from "./config.mjs";
import { getSdk } from "./sdk.mjs";
import { reportSdkError, fail } from "./sdk-errors.mjs";
import { resolvePositionalProject } from "./argparse.mjs";

const HELP = `run402 ai — AI translation and moderation tools

Usage:
  run402 ai <subcommand> [args...]

Subcommands:
  translate [project_id] <text> --to <lang> [--from <lang>] [--context <hint>]
  moderate  [project_id] <text>
  usage     [project_id]

Examples:
  run402 ai translate "Hello world" --to es                  # uses active project
  run402 ai translate prj_abc123 "Hello world" --to es
  run402 ai translate prj_abc123 "Hello" --to ja --from en --context "formal business email"
  run402 ai moderate "content to check"                      # uses active project
  run402 ai moderate prj_abc123 "content to check"
  run402 ai usage                                            # uses active project
  run402 ai usage prj_abc123

Notes:
  - [project_id] defaults to the active project when omitted (set with
    'run402 projects use <id>'). Project IDs start with 'prj_'; any first
    positional that doesn't is treated as the next argument instead.
  - translate requires the AI Translation add-on on the project
  - moderate is free for all projects
  - usage shows translation word quota for the current billing period
`;

const SUB_HELP = {
  translate: `run402 ai translate — Translate text to another language

Usage:
  run402 ai translate [project_id] <text> --to <lang> [--from <lang>] [--context <hint>]

Arguments:
  [project_id]        Project ID (defaults to the active project if omitted).
                      Project IDs start with 'prj_'; any first positional that
                      doesn't is treated as the <text> argument instead.
  <text>              Text to translate (quote it to preserve spaces)

Options:
  --to <lang>         Target language code (required, e.g. es, ja, fr)
  --from <lang>       Source language code (optional; auto-detected if omitted)
  --context <hint>    Optional translation hint (e.g. "formal business email")
  --project <id>      Project ID (alternative to the positional argument)

Notes:
  - Requires the AI Translation add-on on the project
  - Counts against the project's translation word quota

Examples:
  run402 ai translate "Hello world" --to es                  # uses active project
  run402 ai translate prj_abc123 "Hello world" --to es
  run402 ai translate prj_abc123 "Hello" --to ja --from en \\
    --context "formal business email"
`,
  moderate: `run402 ai moderate — Run content moderation on text

Usage:
  run402 ai moderate [project_id] <text>

Arguments:
  [project_id]        Project ID (defaults to the active project if omitted).
                      Project IDs start with 'prj_'; any first positional that
                      doesn't is treated as the <text> argument instead.
  <text>              Text to check (quote it to preserve spaces)

Options:
  --project <id>      Project ID (alternative to the positional argument)

Notes:
  - Free for all projects; uses the project's service key
  - Returns a JSON object with 'flagged' (boolean), 'categories' and 'category_scores'

Examples:
  run402 ai moderate "content to check"          # uses active project
  run402 ai moderate prj_abc123 "content to check"
`,
  usage: `run402 ai usage — Show AI translation word usage for the current billing cycle

Usage:
  run402 ai usage [project_id]

Arguments:
  [project_id]        Project ID (defaults to the active project if omitted).
                      Must start with 'prj_'; any other first positional is an error.

Options:
  --project <id>      Project ID (alternative to the positional argument)

Notes:
  - Reports translation word quota and usage; only meaningful with the
    AI Translation add-on enabled on the project.

Examples:
  run402 ai usage                  # uses active project
  run402 ai usage prj_abc123
`,
};

function parseFlag(args, flag) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && args[i + 1]) return args[i + 1];
  }
  return null;
}

// translate has value-bearing flags (--to, --from, --context, --project) that
// must not be mistaken for positional bare args when prefix-matching.
const TRANSLATE_VALUE_FLAGS = ["--to", "--from", "--context", "--project"];

async function translate(args) {
  // --project <id> wins over positional, mirroring previous behavior.
  const projectOpt = parseFlag(args, "--project");
  let projectId;
  let rest;
  if (projectOpt) {
    projectId = resolveProjectId(projectOpt);
    rest = args;
  } else {
    ({ projectId, rest } = resolvePositionalProject(args, {
      valueFlags: TRANSLATE_VALUE_FLAGS,
    }));
  }

  // Walk `rest` as the post-project argv, collecting bare positionals while
  // skipping value-flag pairs. The first bare positional becomes <text>.
  let text = null;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (TRANSLATE_VALUE_FLAGS.includes(arg)) { i++; continue; }
    if (typeof arg === "string" && arg.startsWith("--")) continue;
    text = arg;
    break;
  }

  const to = parseFlag(args, "--to");
  const from = parseFlag(args, "--from");
  const context = parseFlag(args, "--context");

  if (!text) {
    fail({
      code: "BAD_USAGE",
      message: "Text required.",
      hint: "run402 ai translate [project_id] <text> --to <lang>",
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

const MODERATE_VALUE_FLAGS = ["--project"];

async function moderate(args) {
  const projectOpt = parseFlag(args, "--project");
  let projectId;
  let rest;
  if (projectOpt) {
    projectId = resolveProjectId(projectOpt);
    rest = args;
  } else {
    ({ projectId, rest } = resolvePositionalProject(args, {
      valueFlags: MODERATE_VALUE_FLAGS,
    }));
  }

  let text = null;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (MODERATE_VALUE_FLAGS.includes(arg)) { i++; continue; }
    if (typeof arg === "string" && arg.startsWith("--")) continue;
    text = arg;
    break;
  }

  if (!text) {
    fail({
      code: "BAD_USAGE",
      message: "Text required.",
      hint: "run402 ai moderate [project_id] <text>",
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
  const projectOpt = parseFlag(args, "--project");
  let projectId;
  if (projectOpt) {
    projectId = resolveProjectId(projectOpt);
  } else {
    // No bare-text positional is meaningful here, so reject any non-prj first
    // positional with a clear error.
    ({ projectId } = resolvePositionalProject(args, { rejectBareFirst: true }));
  }

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
