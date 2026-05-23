/**
 * run402 logs — Top-level shortcut for fetching function logs by request id.
 *
 * Capability `astro-ssr-runtime` (Run402 v1.52). When an SSR response
 * returns 5xx, the response includes `x-run402-request-id: req_...` and
 * `x-run402-error-code: R402_SSR_RUNTIME_ERROR`. The agent (or user)
 * copies the request id and runs:
 *
 *   run402 logs --request-id req_...
 *
 * Resolves project + function from env (RUN402_PROJECT_ID + --function)
 * OR explicit flags. For multi-function projects, you can omit --function
 * and the command scans every function in the project.
 *
 * Delegates to `run402 functions logs` for single-function lookups.
 */

import { getSdk } from "./sdk.mjs";
import { reportSdkError, fail } from "./sdk-errors.mjs";

const HELP = `run402 logs — Fetch function logs by request id

Usage:
  run402 logs --request-id <req_id> [--function <name>] [--project <id>] [--json] [--tail <n>]

Required:
  --request-id <req_id>   The req_... id (from x-run402-request-id header)

Optional:
  --function <name>       Limit to one function (default: scan all functions in the project)
  --project <id>          Project id (default: \$RUN402_PROJECT_ID)
  --tail <n>              Max entries per function (default 100)
  --json                  Machine-readable output

Examples:
  run402 logs --request-id req_abc123
  run402 logs --request-id req_abc123 --function ssr
  run402 logs --request-id req_abc123 --project prj_xyz --json

Tip: the request id appears in:
  - The 'x-run402-request-id' response header on every SSR response
  - The 'requestId' field of any R402_SSR_RUNTIME_ERROR envelope
  - The 'request_id' field in deploy / cache invalidate result envelopes
`;

export async function run(sub, args = []) {
  const all = [sub, ...args].filter(Boolean);
  if (!all.length || all.includes("--help") || all.includes("-h")) {
    console.log(HELP);
    return;
  }

  const json = all.includes("--json");
  const requestId = pickFlagValue(all, "--request-id");
  const fnName = pickFlagValue(all, "--function");
  const projectIdArg = pickFlagValue(all, "--project");
  const tailArg = pickFlagValue(all, "--tail");

  if (!requestId) {
    fail({
      code: "BAD_USAGE",
      message: "Missing --request-id <req_id>.",
      hint: "Pass the request id from the 'x-run402-request-id' response header.",
    });
  }
  if (!requestId.startsWith("req_")) {
    fail({
      code: "BAD_USAGE",
      message: `--request-id must look like 'req_...' (got: ${requestId})`,
    });
  }

  const projectId = projectIdArg ?? process.env.RUN402_PROJECT_ID;
  if (!projectId) {
    fail({
      code: "BAD_USAGE",
      message: "Missing project id.",
      hint: "Pass --project <id> or set RUN402_PROJECT_ID env var.",
    });
  }

  const tail = tailArg ? parseInt(tailArg, 10) : 100;
  if (Number.isNaN(tail) || tail < 1 || tail > 5000) {
    fail({
      code: "BAD_USAGE",
      message: `--tail must be an integer between 1 and 5000 (got: ${tailArg})`,
    });
  }

  const sdk = getSdk();

  try {
    let fnNames;
    if (fnName) {
      fnNames = [fnName];
    } else {
      // Scan every function in the project.
      const list = await sdk.functions.list(projectId);
      fnNames = (list?.functions ?? []).map((f) => f.name);
      if (fnNames.length === 0) {
        if (json) console.log(JSON.stringify({ ok: true, entries: [], scanned: [] }));
        else console.log("No functions in project " + projectId);
        return;
      }
    }

    // Query each function in parallel; aggregate entries.
    const results = await Promise.allSettled(
      fnNames.map((name) =>
        sdk.functions
          .logs(projectId, name, { requestId, tail })
          .then((entries) => ({ name, entries: entries ?? [] })),
      ),
    );

    const allEntries = [];
    const scanned = [];
    const errors = [];
    for (const r of results) {
      if (r.status === "fulfilled") {
        scanned.push(r.value.name);
        for (const e of r.value.entries) {
          allEntries.push({ function: r.value.name, ...e });
        }
      } else {
        errors.push({ name: "?", error: r.reason?.message ?? String(r.reason) });
      }
    }

    // Sort by timestamp ascending.
    allEntries.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));

    if (json) {
      console.log(
        JSON.stringify(
          {
            ok: errors.length === 0,
            request_id: requestId,
            project_id: projectId,
            scanned,
            entries: allEntries,
            ...(errors.length > 0 && { errors }),
          },
          null,
          2,
        ),
      );
    } else {
      if (allEntries.length === 0) {
        console.log(`No log entries found for ${requestId} across ${scanned.length} function(s).`);
      } else {
        for (const e of allEntries) {
          const t = e.ts ? new Date(e.ts).toISOString() : "";
          console.log(`[${t}] [${e.function}] ${e.message ?? ""}`);
        }
        console.log(`\n${allEntries.length} entries across ${scanned.length} function(s) for ${requestId}.`);
      }
    }
  } catch (err) {
    reportSdkError(err);
  }
}

function pickFlagValue(args, flag) {
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  return args[idx + 1];
}
