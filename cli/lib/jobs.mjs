import { readFileSync } from "node:fs";

import { getSdk } from "./sdk.mjs";
import { resolveProjectId } from "./config.mjs";
import { reportSdkError, fail } from "./sdk-errors.mjs";
import {
  assertKnownFlags,
  flagValue,
  normalizeArgv,
  parseIntegerFlag,
  requirePositionalCount,
  validateRegularFile,
} from "./argparse.mjs";

const HELP = `run402 jobs — Submit and inspect fixed platform-managed jobs

Usage:
  run402 jobs <subcommand> [args...] [options]

Subcommands:
  submit   --file <path>|--stdin   Submit a managed job request
  get      <job_id>                Get a job run
  logs     <job_id>                Read job logs
  cancel   <job_id>                Cancel a queued or running job

Examples:
  run402 jobs submit --file job.json
  cat job.json | run402 jobs submit --stdin --project prj_abc123
  run402 jobs get job_abc123
  run402 jobs logs job_abc123 --tail 100
  run402 jobs cancel job_abc123

Notes:
  - --project defaults to the active project from 'run402 projects use'
  - Submit requests must match the gateway jobs API shape
`;

const SUB_HELP = {
  submit: `run402 jobs submit — Submit a managed job request

Usage:
  run402 jobs submit --file <path> [--project <id>]
  run402 jobs submit --stdin [--project <id>]

Options:
  --file <path>     Read the JSON submit request from a file
  --stdin           Read the JSON submit request from stdin
  --project <id>    Project ID (defaults to the active project)

Example request:
  {
    "job_type": "kysigned.fflonk_prove.v0_17_0",
    "input": { "input.json": {} },
    "max_cost_usd_micros": 50000,
    "callback_url": "https://hooks.example.com/jobs"
  }

  callback_url (optional) is an HTTPS URL pushed once on terminal state
  (completed/failed/cancelled), so you need not poll. Durable + unsigned:
  dedupe on the Run402-Webhook-Id header and re-fetch with 'jobs get'
  before acting.
`,
  get: `run402 jobs get — Get a managed job run

Usage:
  run402 jobs get <job_id> [--project <id>]

Options:
  --project <id>    Project ID (defaults to the active project)
`,
  logs: `run402 jobs logs — Read managed job logs

Usage:
  run402 jobs logs <job_id> [--project <id>] [--tail <n>] [--since <epoch_ms>]

Options:
  --project <id>    Project ID (defaults to the active project)
  --tail <n>        Maximum entries to return (gateway max: 1000)
  --since <ms>      Only include logs at or after this epoch millisecond timestamp
`,
  cancel: `run402 jobs cancel — Cancel a managed job run

Usage:
  run402 jobs cancel <job_id> [--project <id>]

Options:
  --project <id>    Project ID (defaults to the active project)
`,
};

const PROJECT_FLAGS = ["--project"];

function parseJsonRequest(raw, source) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    fail({
      code: "BAD_JSON",
      message: `${source} is not valid JSON`,
      details: {
        source,
        parse_error: err instanceof Error ? err.message : String(err),
      },
    });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail({
      code: "BAD_JSON",
      message: `${source} must contain a JSON object`,
      details: { source },
    });
  }
  return parsed;
}

async function readStdinText() {
  if (process.stdin?.isTTY) {
    fail({
      code: "BAD_USAGE",
      message: "Missing JSON request on stdin.",
      hint: "Pipe a job request JSON object, or use --file <path>.",
    });
  }
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  if (chunks.length === 0) {
    fail({
      code: "BAD_USAGE",
      message: "Missing JSON request on stdin.",
      hint: "Pipe a job request JSON object, or use --file <path>.",
    });
  }
  return Buffer.concat(chunks).toString("utf-8");
}

async function readSubmitRequest(args) {
  const file = flagValue(args, "--file");
  const stdin = args.includes("--stdin");
  if (file && stdin) {
    fail({
      code: "BAD_USAGE",
      message: "Provide exactly one request source.",
      hint: "Use either --file <path> or --stdin.",
    });
  }
  if (!file && !stdin) {
    fail({
      code: "BAD_USAGE",
      message: "Missing job request source.",
      hint: "Use --file <path> or --stdin.",
    });
  }
  if (file) {
    validateRegularFile(file, "--file");
    return parseJsonRequest(readFileSync(file, "utf-8"), file);
  }
  return parseJsonRequest(await readStdinText(), "stdin");
}

async function submit(args = []) {
  const parsed = normalizeArgv(args);
  const valueFlags = ["--file", "--project"];
  assertKnownFlags(parsed, ["--file", "--stdin", "--project", "--help", "-h"], valueFlags);
  requirePositionalCount(parsed, valueFlags, {
    max: 0,
    command: "run402 jobs submit",
  });
  const projectId = resolveProjectId(flagValue(parsed, "--project"));
  const request = await readSubmitRequest(parsed);

  try {
    const result = await getSdk().jobs.submit(projectId, request);
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function get(jobId, args = []) {
  const parsed = normalizeArgv(args);
  assertKnownFlags(parsed, ["--project", "--help", "-h"], PROJECT_FLAGS);
  if (!jobId) {
    fail({
      code: "BAD_USAGE",
      message: "Missing job_id.",
      hint: "Use `run402 jobs get <job_id>`.",
    });
  }
  requirePositionalCount(parsed, PROJECT_FLAGS, {
    max: 0,
    command: "run402 jobs get <job_id>",
  });
  const projectId = resolveProjectId(flagValue(parsed, "--project"));

  try {
    const result = await getSdk().jobs.get(projectId, jobId);
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function logs(jobId, args = []) {
  const parsed = normalizeArgv(args);
  const valueFlags = ["--project", "--tail", "--since"];
  assertKnownFlags(parsed, ["--project", "--tail", "--since", "--help", "-h"], valueFlags);
  if (!jobId) {
    fail({
      code: "BAD_USAGE",
      message: "Missing job_id.",
      hint: "Use `run402 jobs logs <job_id>`.",
    });
  }
  requirePositionalCount(parsed, valueFlags, {
    max: 0,
    command: "run402 jobs logs <job_id>",
  });
  const projectId = resolveProjectId(flagValue(parsed, "--project"));
  const opts = {};
  const tail = flagValue(parsed, "--tail");
  const since = flagValue(parsed, "--since");
  if (tail !== null) opts.tail = parseIntegerFlag("--tail", tail, { min: 1, max: 1000 });
  if (since !== null) opts.since = parseIntegerFlag("--since", since, { min: 0 });

  try {
    const result = await getSdk().jobs.logs(projectId, jobId, opts);
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function cancel(jobId, args = []) {
  const parsed = normalizeArgv(args);
  assertKnownFlags(parsed, ["--project", "--help", "-h"], PROJECT_FLAGS);
  if (!jobId) {
    fail({
      code: "BAD_USAGE",
      message: "Missing job_id.",
      hint: "Use `run402 jobs cancel <job_id>`.",
    });
  }
  requirePositionalCount(parsed, PROJECT_FLAGS, {
    max: 0,
    command: "run402 jobs cancel <job_id>",
  });
  const projectId = resolveProjectId(flagValue(parsed, "--project"));

  try {
    const result = await getSdk().jobs.cancel(projectId, jobId);
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

function splitJobIdArg(args = [], valueFlags = []) {
  const flagsWithValues = new Set(valueFlags);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (flagsWithValues.has(arg)) {
      i += 1;
      continue;
    }
    if (typeof arg === "string" && arg.startsWith("-")) continue;
    return {
      jobId: arg,
      rest: [...args.slice(0, i), ...args.slice(i + 1)],
    };
  }
  return { jobId: undefined, rest: args };
}

export async function run(sub, args = []) {
  if (!sub || sub === "--help" || sub === "-h") {
    console.log(HELP);
    process.exit(0);
  }
  if (Array.isArray(args) && (args.includes("--help") || args.includes("-h"))) {
    console.log(SUB_HELP[sub] || HELP);
    process.exit(0);
  }

  switch (sub) {
    case "submit":
      await submit(args);
      break;
    case "get": {
      const parsed = normalizeArgv(args);
      const { jobId, rest } = splitJobIdArg(parsed, PROJECT_FLAGS);
      await get(jobId, rest);
      break;
    }
    case "logs": {
      const parsed = normalizeArgv(args);
      const { jobId, rest } = splitJobIdArg(parsed, ["--project", "--tail", "--since"]);
      await logs(jobId, rest);
      break;
    }
    case "cancel": {
      const parsed = normalizeArgv(args);
      const { jobId, rest } = splitJobIdArg(parsed, PROJECT_FLAGS);
      await cancel(jobId, rest);
      break;
    }
    default:
      console.error(`Unknown subcommand: ${sub}\n`);
      console.log(HELP);
      process.exit(1);
  }
}
