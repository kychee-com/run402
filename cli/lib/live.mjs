/**
 * `run402 live` — change hints for live tables, as NDJSON on stdout.
 *
 * tenant-live-changes: tables that declare `live: true` in the expose
 * manifest emit a hint on every committed write (table, op, primary keys,
 * never row data). This command streams them over the SDK's reconnecting
 * SSE subscription (`r.live.subscribe`), one JSON object per line, or with
 * `--once` performs a single held read (`r.live.changes`) and prints the page.
 */
import { resolveProjectId } from "./config.mjs";
import { getSdk } from "./sdk.mjs";
import { reportSdkError, fail } from "./sdk-errors.mjs";
import { assertAllowedValue, assertKnownFlags, flagValue, normalizeArgv, positionalArgs } from "./argparse.mjs";

export const AUDIENCES = ["anon", "service"];

const HELP = `run402 live — change hints for live tables (push on change, no polling)

Usage:
  run402 live --tables <a,b> [--project <project_id>] [--cursor <cursor>] [--as anon|service]
  run402 live --tables <a,b> --once [--cursor <cursor>] [--wait <1..25>] [--project <project_id>]

Options:
  --tables <names>  Comma-separated live table names (tables with "live": true in the
                    expose manifest). Required.
  --project <project_id>    Project to read (defaults to the active project)
  --cursor <c>      Resume from a cursor (a previous "cursor" or a change's cursor)
  --as <audience>   anon (project anon key; public-policy tables) or service (service
                    key; every hint, including owner-scoped ones). Default anon.
  --once            One held read instead of a stream: returns hints since --cursor,
                    or holds up to --wait seconds for the first one, then exits.
  --wait <s>        With --once: seconds to hold (clamped 1..25 by the gateway)

Streaming output (default): one JSON object per line —
  {"type":"ready","cursor":"…","tables":[…]}
  {"type":"change","change":{"table":"cells","op":"insert","pk":[{"id":1}],"n":1,"cursor":"…"}}
  {"type":"resync","tables":[…],"reason":"…"}        ← refetch what you care about
  {"type":"reconnect",…} / {"type":"disconnected",…} ← the stream reconnects on its own
Stop with Ctrl-C. "pk": null is a table-level hint (refetch the table).

The one rule: handle "resync". A hint is a nudge, not a log; when the gateway cannot
promise it saw everything since your cursor it says so instead of inventing a gap.

Exit codes: 0 on Ctrl-C or after --once; 1 on a refusal (TABLE_NOT_LIVE names the
table and the manifest fix; AUTH_REQUIRED for an owner-scoped table without --as
service; LIVE_CONNECTION_LIMIT when the project is at its cap).
`;

export async function run(sub, args) {
  const argv = [sub, ...(Array.isArray(args) ? args : [])].filter((a) => a !== undefined && a !== null);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP);
    process.exit(0);
  }
  const a = normalizeArgv(argv);
  const valueFlags = ["--project", "--tables", "--cursor", "--as", "--wait"];
  assertKnownFlags(a, [...valueFlags, "--once", "--help", "-h"], valueFlags);
  const extra = positionalArgs(a, valueFlags);
  if (extra.length > 0) {
    fail({
      code: "BAD_USAGE",
      message: `Unexpected argument for live: ${extra[0]}`,
      hint: "Run `run402 live --help` for usage.",
    });
  }
  const tablesRaw = flagValue(a, "--tables");
  if (!tablesRaw) {
    fail({
      code: "BAD_USAGE",
      message: "--tables is required: a comma-separated list of live table names.",
      hint: 'Mark a table live with { "name": "cells", "expose": true, "policy": "…", "live": true } in the expose manifest, then `run402 live --tables cells`.',
    });
  }
  const tables = tablesRaw.split(",").map((t) => t.trim()).filter(Boolean);
  const audience = flagValue(a, "--as") ?? "anon";
  assertAllowedValue(audience, AUDIENCES, "--as");
  const cursor = flagValue(a, "--cursor") ?? undefined;
  const once = a.includes("--once");
  const waitRaw = flagValue(a, "--wait");
  if (waitRaw != null && !once) {
    fail({ code: "BAD_USAGE", message: "--wait only applies with --once.", hint: "Drop --wait to stream, or add --once for a single held read." });
  }
  const projectId = resolveProjectId(flagValue(a, "--project"));
  const opts = { tables, as: audience, ...(cursor ? { cursor } : {}) };

  try {
    const sdk = getSdk();
    if (once) {
      const page = await sdk.live.changes(projectId, { ...opts, ...(waitRaw != null ? { wait: Number(waitRaw) } : {}) });
      console.log(JSON.stringify(page, null, 2));
      return;
    }
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    const sub = sdk.live.subscribe(projectId, { ...opts, signal: controller.signal }, (event) => {
      process.stdout.write(`${JSON.stringify(event)}\n`);
    });
    await sub.done;
  } catch (err) {
    reportSdkError(err);
  }
}
