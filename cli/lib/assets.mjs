/**
 * run402 assets — direct-to-S3 storage CLI.
 *
 * Usage:
 *   run402 assets put <file> [files...] [--project <id>] [--key <dest>] [--content-type <mime>] [--private] [--immutable] [--concurrency N] [--no-resume]
 *   run402 assets get <key> --output <file> [--project <id>]
 *   run402 assets ls [--project <id>] [--prefix <p>] [--limit <n>]
 *   run402 assets rm <key> [--project <id>]
 *   run402 assets sign <key> [--project <id>] [--ttl <seconds>]
 *
 * For any file ≤ 5 GiB a single presigned PUT is used. Larger files use S3
 * multipart uploads with 16 MiB parts (640 parts at 10 GiB; up to 10 000
 * parts at 5 TiB). The gateway never carries upload bytes — PUTs go straight
 * to S3 from the client.
 *
 * Resumable uploads are enabled by default. The CLI persists per-upload
 * state to ~/.run402/uploads/<upload_id>.json so a Ctrl-C'd upload can be
 * resumed by re-running the same command.
 */

import {
  statSync,
  readFileSync,
  mkdirSync,
  existsSync,
  createWriteStream,
} from "node:fs";
import { basename, dirname, resolve as resolvePath } from "node:path";
import { pipeline } from "node:stream/promises";

import { resolveProjectId } from "./config.mjs";
import { getSdk } from "./sdk.mjs";
import { reportSdkError, fail } from "./sdk-errors.mjs";
import { assertKnownFlags, hasHelp, normalizeArgv, parseIntegerFlag } from "./argparse.mjs";

const HELP = `run402 blob — Direct-to-S3 blob storage

Usage:
  run402 assets put <file> [files...] [options]
  run402 assets get <key> --output <file> [options]
  run402 assets ls [options]
  run402 assets rm <key> [options]
  run402 assets sign <key> [options]
  run402 assets diagnose <url> [options]

Options:
  --project <id>      Project ID (defaults to active project from 'run402 projects use')
  --key <dest>        Destination key (put only; defaults to file basename)
  --content-type <mime>  MIME override for blob put (defaults to extension inference)
  --private           Upload as private (not served by CDN; apikey required to read)
  --immutable         Append a content-hash suffix to the URL so overwrites produce distinct URLs.
  --json              NDJSON progress events (for agent consumption)
  --prefix <p>        Prefix filter (ls only)
  --limit <n>         Max results (ls only; default 100, max 1000)
  --ttl <seconds>     Signed-URL TTL (sign only; default 3600, min 60, max 604800)

Examples:
  run402 assets put ./artifact.tgz --project prj_abc123
  run402 assets put ./dist/**/*.png --project prj_abc123 --key assets/
  run402 assets put huge.bin --project prj_abc123 --immutable
  run402 assets get images/logo.png --output /tmp/logo.png --project prj_abc123
  run402 assets ls --project prj_abc123 --prefix images/
  run402 assets rm images/logo.png --project prj_abc123
  run402 assets sign images/logo.png --project prj_abc123 --ttl 600

Note: as of v2.1.0, the CLI delegates to sdk.assets.put which routes through
the unified-apply hero. The pre-v2.1.0 --concurrency and --no-resume flags
are still accepted for backward compatibility but are ignored; resume
semantics now live at the apply-plan level (24h plan TTL).
`;

const SUB_HELP = {
  put: `run402 assets put — Upload one or more files to blob storage

Usage:
  run402 assets put <file> [files...] [options]

Arguments:
  <file>              Path to a file (or glob); pass multiple files to batch-upload

Options:
  --project <id>      Project ID (defaults to active project from 'run402 projects use')
  --key <dest>        Destination key; defaults to file basename. Use trailing '/' as prefix.
  --content-type <mime>  MIME override; defaults to inferring from the destination key extension
  --private           Upload as private (not served by CDN; apikey required to read)
  --immutable         Append content-hash suffix so overwrites produce distinct URLs
  --json              Emit NDJSON progress events on stdout (for agent consumption)

Examples:
  run402 assets put ./artifact.tgz --project prj_abc123
  run402 assets put ./dist/**/*.png --project prj_abc123 --key assets/
  run402 assets put ./asset --project prj_abc123 --key assets/logo --content-type image/svg+xml
  run402 assets put huge.bin --project prj_abc123 --immutable
`,
  get: `run402 assets get — Download a blob by key

Usage:
  run402 assets get <key> --output <file> [options]

Arguments:
  <key>               Blob key to download

Options:
  --output <file>     Local destination path (required)
  --project <id>      Project ID (defaults to active project)

Examples:
  run402 assets get images/logo.png --output /tmp/logo.png --project prj_abc123
`,
  ls: `run402 assets ls — List blob keys in a project

Usage:
  run402 assets ls [options]

Options:
  --project <id>      Project ID (defaults to active project)
  --prefix <p>        Only list keys starting with this prefix
  --limit <n>         Max results (default 100, max 1000)

Examples:
  run402 assets ls --project prj_abc123
  run402 assets ls --project prj_abc123 --prefix images/ --limit 500
`,
  rm: `run402 assets rm — Delete a blob

Usage:
  run402 assets rm <key> [options]

Arguments:
  <key>               Blob key to delete

Options:
  --project <id>      Project ID (defaults to active project)

Examples:
  run402 assets rm images/logo.png --project prj_abc123
`,
  sign: `run402 assets sign — Create a presigned download URL for a blob

Usage:
  run402 assets sign <key> [options]

Arguments:
  <key>               Blob key to sign

Options:
  --project <id>      Project ID (defaults to active project)
  --ttl <seconds>     Signed-URL TTL (default 3600, min 60, max 604800)

Examples:
  run402 assets sign reports/2025-q4.pdf --project prj_abc123 --ttl 600
`,
  diagnose: `run402 assets diagnose — Inspect the live CDN state for a public blob URL

Usage:
  run402 assets diagnose <url> [options]

Arguments:
  <url>               Full blob URL (e.g. https://app.run402.com/_blob/avatar.png)

Options:
  --project <id>      Project ID (defaults to active project)

Output:
  - Prints the JSON envelope on stdout (parseable by agent shell loops).
  - Vantage caveat ("# probed once from gateway-us-east-1; not a global view")
    on stderr — visible to TTY operators, ignored by piped consumers.

Exit codes:
  0   observed SHA matches the gateway's expected SHA
  1   observed SHA does not match (or probe returned no SHA)

Agent loop pattern:
  until run402 assets diagnose <url>; do sleep 1; done

Examples:
  run402 assets diagnose https://app.run402.com/_blob/avatar.png
`,
};

function die(msg, exit_code = 1) {
  fail({ code: "BAD_USAGE", message: msg, exit_code });
}

function parseArgs(rawArgs) {
  const args = normalizeArgv(rawArgs);
  const valueFlags = ["--project", "--key", "--content-type", "--concurrency", "--prefix", "--limit", "--output", "-o", "--ttl"];
  assertKnownFlags(args, [
    "--project",
    "--key",
    "--content-type",
    "--private",
    "--immutable",
    "--concurrency",
    "--no-resume",
    "--json",
    "--prefix",
    "--limit",
    "--output",
    "-o",
    "--ttl",
    "--help",
    "-h",
  ], valueFlags);
  const out = { positional: [], project: null, key: null, private: false, immutable: false,
                 concurrency: 4, resume: true, json: false, prefix: null, limit: null,
                 output: null, ttl: null, contentType: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--project") out.project = args[++i];
    else if (a === "--key") out.key = args[++i];
    else if (a === "--content-type") out.contentType = parseContentTypeFlag("--content-type", args[++i]);
    else if (a === "--private") out.private = true;
    else if (a === "--immutable") out.immutable = true;
    else if (a === "--concurrency") out.concurrency = parseIntegerFlag("--concurrency", args[++i], { min: 1 });
    else if (a === "--no-resume") out.resume = false;
    else if (a === "--json") out.json = true;
    else if (a === "--prefix") out.prefix = args[++i];
    else if (a === "--limit") out.limit = parseIntegerFlag("--limit", args[++i], { min: 1, max: 1000 });
    else if (a === "--output" || a === "-o") out.output = args[++i];
    else if (a === "--ttl") out.ttl = parseIntegerFlag("--ttl", args[++i], { min: 60, max: 604800 });
    else if (!a.startsWith("--")) out.positional.push(a);
  }
  return out;
}

function parseContentTypeFlag(name, value) {
  if (value === undefined || value === null) {
    fail({
      code: "BAD_FLAG",
      message: `${name} requires a MIME type value`,
      details: { flag: name },
    });
  }
  const raw = String(value).trim();
  const base = raw.split(";", 1)[0].trim();
  if (!/^[^\s/]+\/[^\s/]+$/.test(base)) {
    fail({
      code: "BAD_FLAG",
      message: `${name} must be a non-empty type/subtype MIME value, got: ${String(value)}`,
      details: { flag: name, value: String(value) },
    });
  }
  return raw;
}

// ---------------------------------------------------------------------------
// put
// ---------------------------------------------------------------------------

async function putOne(projectId, filePath, opts) {
  const stat = statSync(filePath);
  if (!stat.isFile()) {
    die(`Not a regular file: ${filePath}`);
  }
  const destKey = computeDestKey(filePath, opts.key);

  // v2.1.0: the legacy /storage/v1/uploads* session API is gone. The CLI
  // now delegates to `sdk.assets.put`, which routes through the
  // unified-apply hero (apply/v1/plans -> content/v1/plans -> S3 PUT ->
  // commit).
  //
  // Trade-off vs v2.0.x: resumable uploads via persisted state under
  // ~/.run402/uploads/ are no longer supported. Resume semantics now live
  // at the apply-plan level (24h plan TTL); a future CLI redesign can
  // expose that. The --concurrency and --no-resume flags are accepted but
  // ignored — the SDK upload paths handle parallelism internally.
  log(opts, { event: "start", key: destKey, size_bytes: stat.size });
  const bytes = new Uint8Array(readFileSync(filePath));
  const result = await getSdk().assets.put(projectId, destKey, { bytes }, {
    contentType: opts.contentType ?? guessContentType(destKey),
    visibility: opts.private ? "private" : "public",
    immutable: opts.immutable,
  });
  log(opts, { event: "done", ...result });
  return result;
}

function computeDestKey(filePath, keyOpt) {
  if (!keyOpt) return basename(filePath);
  if (keyOpt.endsWith("/")) return keyOpt + basename(filePath);
  return keyOpt;
}

async function put(projectId, argv) {
  const opts = parseArgs(argv);
  opts.project = opts.project || projectId;
  const resolvedId = resolveProjectId(opts.project);

  if (opts.positional.length === 0) die("At least one file path is required");
  if (opts.positional.length > 1 && opts.key && !opts.key.endsWith("/")) {
    die("--key across multiple files requires a directory prefix (ending with /)");
  }

  const results = [];
  for (const filePath of opts.positional) {
    if (!existsSync(filePath)) die(`File not found: ${filePath}`);
    try {
      const r = await putOne(resolvedId, filePath, opts);
      results.push({ file: filePath, ...r });
    } catch (err) {
      reportSdkError(err);
    }
  }
  if (!opts.json) console.log(JSON.stringify(results, null, 2));
}

// ---------------------------------------------------------------------------
// get
// ---------------------------------------------------------------------------

async function get(projectId, argv) {
  const opts = parseArgs(argv);
  opts.project = opts.project || projectId;
  const resolvedId = resolveProjectId(opts.project);
  if (opts.positional.length === 0) die("Key required");
  if (opts.positional.length > 1) die("blob get expects exactly one key");
  if (!opts.output) die("--output <file> required");
  const key = opts.positional[0];

  let res;
  try {
    res = await getSdk().assets.get(resolvedId, key);
  } catch (err) {
    reportSdkError(err);
    return;
  }
  if (!res.body) die("Empty response body");

  mkdirSync(dirname(resolvePath(opts.output)), { recursive: true });
  await pipeline(res.body, createWriteStream(opts.output));
  console.log(JSON.stringify({ status: "ok", key, output: opts.output }));
}

// ---------------------------------------------------------------------------
// ls
// ---------------------------------------------------------------------------

async function ls(projectId, argv) {
  const opts = parseArgs(argv);
  opts.project = opts.project || projectId;
  const resolvedId = resolveProjectId(opts.project);

  try {
    const data = await getSdk().assets.ls(resolvedId, {
      prefix: opts.prefix ?? undefined,
      limit: opts.limit ?? undefined,
    });
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

// ---------------------------------------------------------------------------
// rm
// ---------------------------------------------------------------------------

async function rm(projectId, argv) {
  const opts = parseArgs(argv);
  opts.project = opts.project || projectId;
  const resolvedId = resolveProjectId(opts.project);
  if (opts.positional.length === 0) die("Key required");
  if (opts.positional.length > 1) die("blob rm expects exactly one key");
  const key = opts.positional[0];

  try {
    await getSdk().assets.rm(resolvedId, key);
    console.log(JSON.stringify({ status: "ok", key }));
  } catch (err) {
    reportSdkError(err);
  }
}

// ---------------------------------------------------------------------------
// sign
// ---------------------------------------------------------------------------

async function diagnose(projectId, argv) {
  const opts = parseArgs(argv);
  opts.project = opts.project || projectId;
  const resolvedId = resolveProjectId(opts.project);
  if (opts.positional.length === 0) die("URL required");
  if (opts.positional.length > 1) die("blob diagnose expects exactly one URL");
  const url = opts.positional[0];

  try {
    const env = await getSdk().assets.diagnoseUrl(resolvedId, url);
    // Always print the JSON envelope for agent consumption (parseable).
    console.log(JSON.stringify(env, null, 2));
    // Vantage caveat to stderr so a TTY operator sees it; agent shell loops
    // that pipe stdout into another tool aren't affected.
    process.stderr.write(
      `\n# probed once from ${env.vantage}; not a global view\n`,
    );
    // Exit code: 0 if observed === expected, 1 otherwise. Lets agents
    // shell-script `until run402 assets diagnose <url>; do sleep 1; done`.
    if (env.observedSha256 && env.observedSha256 === env.expectedSha256) {
      process.exit(0);
    }
    process.exit(1);
  } catch (err) {
    reportSdkError(err);
  }
}

async function sign(projectId, argv) {
  const opts = parseArgs(argv);
  opts.project = opts.project || projectId;
  const resolvedId = resolveProjectId(opts.project);
  if (opts.positional.length === 0) die("Key required");
  if (opts.positional.length > 1) die("blob sign expects exactly one key");
  const key = opts.positional[0];

  try {
    const data = await getSdk().assets.sign(resolvedId, key, {
      ttl_seconds: opts.ttl ?? undefined,
    });
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function guessContentType(key) {
  const ext = key.slice(key.lastIndexOf(".") + 1).toLowerCase();
  const map = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
    svg: "image/svg+xml", webp: "image/webp",
    html: "text/html", css: "text/css", js: "text/javascript", json: "application/json",
    txt: "text/plain", md: "text/markdown", pdf: "application/pdf",
    mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime",
    zip: "application/zip", tgz: "application/gzip", gz: "application/gzip",
  };
  return map[ext] ?? "application/octet-stream";
}

function log(opts, event) {
  if (opts.json) console.log(JSON.stringify(event));
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export async function run(sub, args) {
  if (!sub || sub === "--help" || sub === "-h") {
    console.log(HELP);
    process.exit(0);
  }
  args = normalizeArgv(args);
  if (Array.isArray(args) && hasHelp(args)) {
    console.log(SUB_HELP[sub] || HELP);
    process.exit(0);
  }
  const defaultProject = process.env.RUN402_PROJECT ?? null;
  switch (sub) {
    case "put":      await put(defaultProject, args); break;
    case "get":      await get(defaultProject, args); break;
    case "ls":       await ls(defaultProject, args); break;
    case "rm":       await rm(defaultProject, args); break;
    case "sign":     await sign(defaultProject, args); break;
    case "diagnose": await diagnose(defaultProject, args); break;
    default:
      console.error(`Unknown subcommand: ${sub}`);
      console.log(HELP);
      process.exit(1);
  }
}
