/**
 * run402 cache — SSR cache inspection and invalidation.
 *
 * Capability `ssr-isr-cache` (Run402 v1.52). Used by AI coding agents
 * and human developers to:
 *
 *   - Inspect the cache row state for a URL (`cache inspect`)
 *   - Invalidate a specific URL, prefix, or entire host (`cache invalidate`)
 *
 * Both subcommands are project-scoped: the active project id is read
 * from the SDK config, and any host referenced MUST be owned by that
 * project (subdomain `*.run402.com` or attached custom domain). The
 * gateway returns `R402_CACHE_INVALIDATION_HOST_FORBIDDEN` for
 * cross-project attempts; the CLI surfaces that as a structured error.
 *
 * @see https://docs.run402.com/cache/concepts
 */

import { getSdk } from "./sdk.mjs";
import { reportSdkError, fail } from "./sdk-errors.mjs";
import { assertKnownFlags, flagValue, normalizeArgv } from "./argparse.mjs";

// Locally-defined helpers — argparse.mjs's normalized form is a flat
// string array; we need to identify positional args (non-flag, non-flag-
// value tokens) and detect flag presence.
function hasFlag(args, flags) {
  return args.some((a) => flags.includes(a));
}
function positionalArgs(args) {
  // Filter out flags (--foo) AND values that immediately follow a
  // value-taking flag. We approximate by treating any token after a
  // --flag as the flag's value unless it starts with --.
  const out = [];
  const valueTakingFlags = new Set(["--locale", "--release-id", "--prefix", "--host"]);
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (typeof token !== "string") continue;
    if (token.startsWith("--")) {
      if (valueTakingFlags.has(token)) i += 1; // skip the value
      continue;
    }
    out.push(token);
  }
  return out;
}

const HELP = `run402 cache — SSR cache inspection and invalidation

Usage:
  run402 cache <subcommand> [args...]

Subcommands:
  inspect    <url>             Inspect cache row state for a URL
  invalidate <url>             Invalidate a specific URL
  invalidate --prefix <p> --host <h>   Invalidate all rows under a path prefix
  invalidate --all --host <h>          Invalidate all rows for a host

Common flags:
  --json                       Machine-readable output
  --locale <code>              (inspect only) Inspect a specific locale's row
                               (default: project's default locale)
  --release-id <id>            (inspect only) Inspect a specific release id
                               (default: project's active release)

Examples:
  run402 cache inspect https://eagles.kychon.com/the-guys
  run402 cache inspect https://eagles.kychon.com/the-guys --locale es --json
  run402 cache invalidate https://eagles.kychon.com/the-guys
  run402 cache invalidate --prefix /blog/ --host eagles.kychon.com
  run402 cache invalidate --all --host eagles.kychon.com

Notes:
  - The cache key is canonicalized (case-preserving query, ignored fragments,
    repeated-key ordering preserved). See the cache concepts doc for the
    canonical-key formula.
  - 'inspect' returns HIT (a fresh row exists) or MISS (no fresh row). It
    NEVER returns BYPASS — BYPASS is a runtime decision based on incoming
    request properties (cookies, auth headers, etc.), and inspect does not
    issue a request.
  - Invalidation is generation-guarded: an in-flight MISS render started
    before the invalidate will NOT overwrite the freshly-cleared state.
`;

export async function run(sub, args) {
  if (!sub || sub === "--help" || sub === "-h") {
    console.log(HELP);
    return;
  }

  switch (sub) {
    case "inspect":
      await inspect(args);
      break;
    case "invalidate":
      await invalidate(args);
      break;
    default:
      fail({
        code: "BAD_USAGE",
        message: `Unknown cache subcommand: ${sub}`,
        next_actions: ["run402 cache --help"],
      });
  }
}

async function inspect(args) {
  const parsed = normalizeArgv(args);
  assertKnownFlags(parsed, ["--json", "--locale", "--release-id", "--help", "-h"]);
  if (hasFlag(parsed, ["--help", "-h"])) {
    console.log(HELP);
    return;
  }

  const positionals = positionalArgs(parsed);
  if (positionals.length === 0) {
    fail({
      code: "BAD_USAGE",
      message: "Missing URL argument.",
      next_actions: ["run402 cache inspect <url>"],
    });
  }
  const url = positionals[0];
  if (!url.startsWith("https://") && !url.startsWith("http://")) {
    fail({
      code: "BAD_USAGE",
      message: `URL must be absolute (got: ${url})`,
      next_actions: ["run402 cache inspect https://<host>/<path>"],
    });
  }

  const locale = flagValue(parsed, "--locale");
  const releaseId = flagValue(parsed, "--release-id");
  const json = hasFlag(parsed, ["--json"]);

  try {
    const sdk = getSdk();
    // SDK shape — the gateway's cache inspect endpoint isn't yet wired
    // (separate task). For now the CLI POSTs to the same /cache/v1/
    // namespace with kind=inspect.
    const result = await sdk.cache.inspect(url, { locale, releaseId });
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(formatInspectResult(result));
    }
  } catch (err) {
    reportSdkError(err);
  }
}

async function invalidate(args) {
  const parsed = normalizeArgv(args);
  assertKnownFlags(parsed, ["--json", "--prefix", "--host", "--all", "--help", "-h"]);
  if (hasFlag(parsed, ["--help", "-h"])) {
    console.log(HELP);
    return;
  }

  const positionals = positionalArgs(parsed);
  const json = hasFlag(parsed, ["--json"]);
  const prefix = flagValue(parsed, "--prefix");
  const host = flagValue(parsed, "--host");
  const all = hasFlag(parsed, ["--all"]);

  const sdk = getSdk();

  // Three modes: exact URL, prefix, all.
  if (all) {
    if (!host) {
      fail({
        code: "BAD_USAGE",
        message: "--all requires --host <hostname>",
        next_actions: ["run402 cache invalidate --all --host <hostname>"],
      });
    }
    try {
      const result = await sdk.cache.invalidateAll({ host });
      emit(result, json);
    } catch (err) {
      reportSdkError(err);
    }
    return;
  }

  if (prefix) {
    if (!host) {
      fail({
        code: "BAD_USAGE",
        message: "--prefix requires --host <hostname>",
        next_actions: ["run402 cache invalidate --prefix /blog/ --host <hostname>"],
      });
    }
    if (!prefix.startsWith("/")) {
      fail({
        code: "BAD_USAGE",
        message: `prefix must start with '/' (got: ${prefix})`,
      });
    }
    try {
      const result = await sdk.cache.invalidatePrefix({ host, prefix });
      emit(result, json);
    } catch (err) {
      reportSdkError(err);
    }
    return;
  }

  // Exact URL form.
  if (positionals.length === 0) {
    fail({
      code: "BAD_USAGE",
      message: "Missing URL argument.",
      next_actions: [
        "run402 cache invalidate <url>",
        "run402 cache invalidate --prefix /blog/ --host <hostname>",
        "run402 cache invalidate --all --host <hostname>",
      ],
    });
  }
  const url = positionals[0];
  if (!url.startsWith("https://") && !url.startsWith("http://")) {
    fail({
      code: "BAD_USAGE",
      message: `URL must be absolute (got: ${url})`,
      next_actions: ["run402 cache invalidate https://<host>/<path>"],
    });
  }
  try {
    const result = await sdk.cache.invalidate(url);
    emit(result, json);
  } catch (err) {
    reportSdkError(err);
  }
}

function emit(result, json) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const parts = [`Invalidated ${result.deleted} cache row(s)`];
    if (result.host) parts.push(`on ${result.host}`);
    if (result.path) parts.push(`for ${result.path}`);
    parts.push(`(generation: ${result.generation})`);
    console.log(parts.join(" "));
  }
}

function formatInspectResult(result) {
  if (result.status === "MISS") {
    return `MISS — no cache row for ${result.url || "this URL"}.`;
  }
  const lines = [
    `${result.status} — ${result.host}${result.path}`,
    `  locale:           ${result.locale}`,
    `  releaseId:        ${result.releaseId}`,
    `  cachedAt:         ${result.cachedAt}`,
    `  expiresAt:        ${result.expiresAt}`,
    `  contentSha256:    ${result.contentSha256}`,
  ];
  if (result.writtenUnderGeneration) {
    lines.push(`  writtenUnderGen:  ${result.writtenUnderGeneration}`);
  }
  return lines.join("\n");
}
