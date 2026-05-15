/**
 * run402 cdn — CloudFront CDN diagnostics for public blob URLs.
 *
 * Usage:
 *   run402 cdn wait-fresh <url> --sha <sha256> [--timeout <seconds>] [--project <id>]
 *
 * Wraps the SDK's `client.blobs.waitFresh(...)`. Polls the gateway diagnose
 * endpoint until the URL serves the expected SHA, then exits 0. On timeout,
 * exits 1 (agent shell loops can chain a fallback action).
 *
 * **Mutable URLs only.** For immutable URLs (the `immutableUrl` field
 * returned by `run402 blob put --immutable`), no waiting is needed — they
 * are bound to a SHA at upload time and never previously cached.
 */

import { resolveProjectId } from "./config.mjs";
import { getSdk } from "./sdk.mjs";
import { reportSdkError, fail } from "./sdk-errors.mjs";
import { assertKnownFlags, flagValue, normalizeArgv, parseIntegerFlag, positionalArgs } from "./argparse.mjs";

const HELP = `run402 cdn — CloudFront CDN diagnostics for public blob URLs

Usage:
  run402 cdn wait-fresh <url> --sha <sha256> [options]

Subcommands:
  wait-fresh    Poll the CDN until a mutable URL serves the expected SHA-256

Examples:
  run402 cdn wait-fresh https://app.run402.com/_blob/avatar.png --sha abc...

For details: run402 cdn wait-fresh --help
`;

const SUB_HELP = {
  "wait-fresh": `run402 cdn wait-fresh — Poll the CDN for an expected SHA on a mutable URL

Usage:
  run402 cdn wait-fresh <url> --sha <sha256> [options]

Arguments:
  <url>               Full mutable blob URL to poll (e.g.
                      https://app.run402.com/_blob/avatar.png)

Options:
  --sha <hex>         Expected hex SHA-256. Required.
  --timeout <secs>    Max wait in seconds. Default 60.
  --project <id>      Project ID (defaults to active project)

Output:
  Prints a JSON result on stdout when polling ends:
    { "fresh": true|false, "observedSha256": "...", "attempts": N,
      "elapsedMs": ..., "vantage": "gateway-us-east-1" }

Exit codes:
  0   the URL served the expected SHA before the timeout
  1   the URL did NOT match within the timeout (or the project resolution failed)

Notes:
  - For IMMUTABLE URLs (returned as 'immutableUrl' from 'run402 blob put
    --immutable'), no waiting is needed. Use this command only for the
    mutable 'url' field, after a re-upload to an existing public key.
  - The probe is single-vantage (us-east-1). Other CloudFront PoPs may
    serve different cached states until invalidation propagates.

Examples:
  run402 cdn wait-fresh https://app.run402.com/_blob/avatar.png --sha ba78...
  run402 cdn wait-fresh https://app.run402.com/_blob/avatar.png --sha ba78... --timeout 120
`,
};

function die(msg, exit_code = 1) {
  fail({ code: "BAD_USAGE", message: msg, exit_code });
}

function parseArgs(args) {
  const normalized = normalizeArgv(args);
  const valueFlags = ["--sha", "--timeout", "--project"];
  assertKnownFlags(normalized, [...valueFlags, "--help", "-h"], valueFlags);
  const opts = {
    positional: positionalArgs(normalized, valueFlags),
    sha: flagValue(normalized, "--sha"),
    timeout: normalized.includes("--timeout")
      ? parseIntegerFlag("--timeout", flagValue(normalized, "--timeout"), { min: 1 })
      : undefined,
    project: flagValue(normalized, "--project"),
  };
  if (opts.positional.length > 1) {
    die(`Unexpected argument for cdn wait-fresh: ${opts.positional[1]}`);
  }
  return opts;
}

async function waitFresh(projectId, argv) {
  const opts = parseArgs(argv);
  opts.project = opts.project || projectId;
  const resolvedId = resolveProjectId(opts.project);
  if (opts.positional.length === 0) die("URL required");
  const url = opts.positional[0];
  if (!opts.sha) die("--sha is required");
  if (!/^[a-fA-F0-9]{64}$/.test(opts.sha)) {
    fail({
      code: "BAD_FLAG",
      message: "--sha must be a 64-character hex SHA-256 digest",
      details: { flag: "--sha", value: opts.sha },
    });
  }

  const timeoutMs = (opts.timeout ?? 60) * 1000;
  try {
    const result = await getSdk().blobs.waitFresh(resolvedId, {
      url,
      sha256: opts.sha.toLowerCase(),
      timeoutMs,
    });
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.fresh ? 0 : 1);
  } catch (err) {
    reportSdkError(err);
  }
}

export async function run(sub, args) {
  if (!sub || sub === "--help" || sub === "-h") {
    console.log(HELP);
    process.exit(0);
  }
  if (Array.isArray(args) && (args.includes("--help") || args.includes("-h"))) {
    console.log(SUB_HELP[sub] || HELP);
    process.exit(0);
  }
  const defaultProject = process.env.RUN402_PROJECT ?? null;
  switch (sub) {
    case "wait-fresh":
      await waitFresh(defaultProject, args);
      break;
    default:
      console.error(`Unknown subcommand: ${sub}`);
      console.log(HELP);
      process.exit(1);
  }
}
