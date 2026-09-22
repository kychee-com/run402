/**
 * run402 logs — Top-level shortcut for fetching function logs by request id.
 *
 * Capability `astro-ssr-runtime` (Run402 v1.52). Every function response
 * (routed and direct) carries `x-run402-request-id: req_...`; a 5xx from the
 * SSR runtime adds `x-run402-error-code: R402_SSR_RUNTIME_ERROR`. The agent
 * (or user) copies the request id and runs:
 *
 *   run402 logs --request-id req_...
 *
 * No function name needed: the SDK's `functions.logsByRequestId` fans the
 * read out across every function in the project (the gateway has no
 * project-wide logs route). `--function <name>` (or a leading positional)
 * narrows it to one; with `--function` alone the command is that function's
 * plain tail.
 *
 * App output only by default — Lambda's own INIT_START / START / END / REPORT
 * lines are `origin: "platform"` and hidden unless `--platform` / `--all`.
 */

import { getSdk } from "./sdk.mjs";
import { getActiveProjectId } from "./config.mjs";
import { reportSdkError, fail } from "./sdk-errors.mjs";
import { assertKnownFlags, flagValue, normalizeArgv, parseIntegerFlag, positionalArgs } from "./argparse.mjs";
import {
  FUNCTION_LOG_TAIL_MAX,
  assertLogRequestIdFlag,
  parseLogSinceFlag,
  platformHiddenHint,
  resolveLogOriginFlag,
} from "./functions.mjs";

const HELP = `run402 logs — Fetch function logs by request id

Usage:
  run402 logs --request-id <id> [<function> | --function <name>] [--project <id>] [options]
  run402 logs --function <name> [--project <id>] [options]

Required (one of):
  --request-id <id>       A req_... id (the x-run402-request-id response header),
                          or a fnrun_... / fnatt_... durable-run id. Without
                          --function, every function in the project is scanned.
  --function <name>       Limit to one function. Alone (no --request-id) this
                          is that function's recent tail. A leading positional
                          <function> means the same thing.

Optional:
  --project <id>          Project id (default: \$RUN402_PROJECT_ID, else the active project)
  --tail <n>              Max entries per function BEFORE the origin filter (default 100, max 1000)
  --since <ts>            ISO timestamp or epoch ms; only entries at or after this
  --app                   Only the function's own output (default). Lambda runtime
                          lines (INIT_START, START/END/REPORT RequestId, billed
                          duration) are hidden; "hidden.platform" counts them and a
                          "hint" appears when hiding them left the result empty.
  --platform              Only the Lambda runtime lines
  --all                   Both (the raw CloudWatch stream)

Output:
  Stdout is JSON { ok, request_id, project_id, scanned, entries, errors?, origin, hidden?, hint? }.
  Every entry carries "function" and "origin": "app" | "platform". "ok" is
  false only when a function's log read failed (it is named in "errors").

Auth:
  The project's cached service_key when present; otherwise your wallet /
  session / delegate, which the gateway authorizes with project.read — an org
  member or teammate agent following an error fingerprint's drill-down needs
  no project key.

Examples:
  run402 logs --request-id req_abc123
  run402 logs --request-id req_abc123 --function ssr
  run402 logs ssr --request-id req_abc123 --all
  run402 logs --request-id fnrun_abc123 --project prj_xyz
  run402 logs --function checkout --tail 20

Tip: the request id appears in:
  - The 'x-run402-request-id' response header on every function response
  - The 'requestId' field of any R402_SSR_RUNTIME_ERROR envelope
  - The 'request_id' field in deploy / cache invalidate result envelopes
  - The 'samples' of 'run402 errors list' (each sample names a runnable logs command)
`;

const VALUE_FLAGS = ["--request-id", "--function", "--project", "--tail", "--since"];
const KNOWN_FLAGS = [...VALUE_FLAGS, "--app", "--platform", "--all", "--help", "-h"];

export async function run(sub, args = []) {
  const all = normalizeArgv([sub, ...args].filter(Boolean));
  if (!all.length || all.includes("--help") || all.includes("-h")) {
    console.log(HELP);
    return;
  }
  assertKnownFlags(all, KNOWN_FLAGS, VALUE_FLAGS);

  const requestId = flagValue(all, "--request-id") ?? undefined;
  const functionFlag = flagValue(all, "--function") ?? undefined;
  const projectIdArg = flagValue(all, "--project") ?? undefined;
  const tailArg = flagValue(all, "--tail") ?? undefined;
  const sinceArg = flagValue(all, "--since") ?? undefined;
  const origin = resolveLogOriginFlag(all);

  const positionals = positionalArgs(all, VALUE_FLAGS);
  if (positionals.length > 1) {
    fail({
      code: "BAD_USAGE",
      message: `Unexpected argument: ${positionals[1]}`,
      hint: "run402 logs [<function>] --request-id <id> [--project <id>]",
      details: { argument: positionals[1] },
    });
  }
  if (positionals.length === 1 && functionFlag !== undefined && positionals[0] !== functionFlag) {
    fail({
      code: "BAD_USAGE",
      message: `Function named twice: positional '${positionals[0]}' and --function '${functionFlag}'`,
      details: { positional: positionals[0], flag: functionFlag },
    });
  }
  const fnName = functionFlag ?? positionals[0];

  if (!requestId && !fnName) {
    fail({
      code: "BAD_USAGE",
      message: "Missing --request-id <id> (or --function <name> for a plain tail).",
      hint: "Pass the request id from the 'x-run402-request-id' response header.",
    });
  }
  assertLogRequestIdFlag(requestId);

  const projectId = projectIdArg ?? process.env.RUN402_PROJECT_ID ?? getActiveProjectId() ?? undefined;
  if (!projectId) {
    fail({
      code: "BAD_USAGE",
      message: "Missing project id.",
      hint: "Pass --project <id>, set RUN402_PROJECT_ID, or 'run402 projects use <id>'.",
    });
  }

  const tail = parseIntegerFlag("--tail", tailArg, { min: 1, max: FUNCTION_LOG_TAIL_MAX, def: 100 });
  const since = parseLogSinceFlag(sinceArg);

  const sdk = getSdk();
  try {
    if (requestId) {
      const result = await sdk.functions.logsByRequestId(projectId, requestId, {
        tail,
        since,
        origin,
        ...(fnName !== undefined && { functionName: fnName }),
      });
      emit({
        ok: result.errors.length === 0,
        request_id: result.request_id,
        project_id: projectId,
        scanned: result.scanned,
        entries: result.entries,
        errors: result.errors,
        origin: result.origin,
        hidden: result.hidden,
      });
      return;
    }

    // --function alone: that function's recent tail, same envelope.
    const result = await sdk.functions.logs(projectId, fnName, { tail, since, origin });
    emit({
      ok: true,
      request_id: null,
      project_id: projectId,
      scanned: [fnName],
      entries: (result.logs ?? []).map((entry) => ({ function: fnName, ...entry })),
      errors: [],
      origin: result.origin ?? origin,
      hidden: result.hidden,
    });
  } catch (err) {
    reportSdkError(err);
  }
}

function emit({ ok, request_id, project_id, scanned, entries, errors, origin, hidden }) {
  const hint = platformHiddenHint(entries, hidden);
  console.log(
    JSON.stringify(
      {
        ok,
        request_id,
        project_id,
        scanned,
        entries,
        ...(errors.length > 0 && { errors }),
        origin,
        ...(hidden && { hidden }),
        ...(hint && { hint }),
      },
      null,
      2,
    ),
  );
}
