/**
 * run402 blob — direct-to-S3 storage CLI.
 *
 * Usage:
 *   run402 blob put <file> [files...] [--project <id>] [--key <dest>] [--content-type <mime>] [--private] [--immutable] [--concurrency N] [--no-resume]
 *   run402 blob get <key> --output <file> [--project <id>]
 *   run402 blob ls [--project <id>] [--prefix <p>] [--limit <n>]
 *   run402 blob rm <key> [--project <id>]
 *   run402 blob sign <key> [--project <id>] [--ttl <seconds>]
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
  createReadStream,
  statSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  unlinkSync,
  readdirSync,
  createWriteStream,
} from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import { homedir } from "node:os";
import { pipeline } from "node:stream/promises";

import { resolveProjectId } from "./config.mjs";
import { getSdk } from "./sdk.mjs";
import { reportSdkError, fail } from "./sdk-errors.mjs";
import { assertKnownFlags, hasHelp, normalizeArgv, parseIntegerFlag } from "./argparse.mjs";

const HELP = `run402 blob — Direct-to-S3 blob storage

Usage:
  run402 blob put <file> [files...] [options]
  run402 blob get <key> --output <file> [options]
  run402 blob ls [options]
  run402 blob rm <key> [options]
  run402 blob sign <key> [options]
  run402 blob diagnose <url> [options]

Options:
  --project <id>      Project ID (defaults to active project from 'run402 projects use')
  --key <dest>        Destination key (put only; defaults to file basename)
  --content-type <mime>  MIME override for blob put (defaults to extension inference)
  --private           Upload as private (not served by CDN; apikey required to read)
  --immutable         Adds a content-hash suffix to the URL so overwrites produce distinct URLs.
                      Requires computing SHA-256 over the file (CLI does this automatically).
  --concurrency N     Concurrent part PUTs (default 4)
  --no-resume         Start fresh; ignore any cached state
  --json              NDJSON progress events (for agent consumption)
  --prefix <p>        Prefix filter (ls only)
  --limit <n>         Max results (ls only; default 100, max 1000)
  --ttl <seconds>     Signed-URL TTL (sign only; default 3600, max 604800)

Examples:
  run402 blob put ./artifact.tgz --project prj_abc123
  run402 blob put ./dist/**/*.png --project prj_abc123 --key assets/
  run402 blob put huge.bin --project prj_abc123 --immutable
  run402 blob get images/logo.png --output /tmp/logo.png --project prj_abc123
  run402 blob ls --project prj_abc123 --prefix images/
  run402 blob rm images/logo.png --project prj_abc123
  run402 blob sign images/logo.png --project prj_abc123 --ttl 600
`;

const SUB_HELP = {
  put: `run402 blob put — Upload one or more files to blob storage

Usage:
  run402 blob put <file> [files...] [options]

Arguments:
  <file>              Path to a file (or glob); pass multiple files to batch-upload

Options:
  --project <id>      Project ID (defaults to active project from 'run402 projects use')
  --key <dest>        Destination key; defaults to file basename. Use trailing '/' as prefix.
  --content-type <mime>  MIME override; defaults to inferring from the destination key extension
  --private           Upload as private (not served by CDN; apikey required to read)
  --immutable         Append content-hash suffix so overwrites produce distinct URLs
  --concurrency N     Concurrent part PUTs for multipart uploads (default 4)
  --no-resume         Ignore any cached resumable-upload state and start fresh
  --json              Emit NDJSON progress events on stdout (for agent consumption)

Examples:
  run402 blob put ./artifact.tgz --project prj_abc123
  run402 blob put ./dist/**/*.png --project prj_abc123 --key assets/
  run402 blob put ./asset --project prj_abc123 --key assets/logo --content-type image/svg+xml
  run402 blob put huge.bin --project prj_abc123 --immutable --concurrency 8
`,
  get: `run402 blob get — Download a blob by key

Usage:
  run402 blob get <key> --output <file> [options]

Arguments:
  <key>               Blob key to download

Options:
  --output <file>     Local destination path (required)
  --project <id>      Project ID (defaults to active project)

Examples:
  run402 blob get images/logo.png --output /tmp/logo.png --project prj_abc123
`,
  ls: `run402 blob ls — List blob keys in a project

Usage:
  run402 blob ls [options]

Options:
  --project <id>      Project ID (defaults to active project)
  --prefix <p>        Only list keys starting with this prefix
  --limit <n>         Max results (default 100, max 1000)

Examples:
  run402 blob ls --project prj_abc123
  run402 blob ls --project prj_abc123 --prefix images/ --limit 500
`,
  rm: `run402 blob rm — Delete a blob

Usage:
  run402 blob rm <key> [options]

Arguments:
  <key>               Blob key to delete

Options:
  --project <id>      Project ID (defaults to active project)

Examples:
  run402 blob rm images/logo.png --project prj_abc123
`,
  sign: `run402 blob sign — Create a presigned download URL for a blob

Usage:
  run402 blob sign <key> [options]

Arguments:
  <key>               Blob key to sign

Options:
  --project <id>      Project ID (defaults to active project)
  --ttl <seconds>     Signed-URL TTL (default 3600, max 604800)

Examples:
  run402 blob sign reports/2025-q4.pdf --project prj_abc123 --ttl 600
`,
  diagnose: `run402 blob diagnose — Inspect the live CDN state for a public blob URL

Usage:
  run402 blob diagnose <url> [options]

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
  until run402 blob diagnose <url>; do sleep 1; done

Examples:
  run402 blob diagnose https://app.run402.com/_blob/avatar.png
`,
};

const UPLOAD_STATE_DIR = join(homedir(), ".run402", "uploads");

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
    else if (a === "--ttl") out.ttl = parseIntegerFlag("--ttl", args[++i], { min: 1, max: 604800 });
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

async function sha256File(filePath) {
  const h = createHash("sha256");
  const stream = createReadStream(filePath);
  for await (const chunk of stream) h.update(chunk);
  return h.digest("hex");
}

function loadState(uploadId) {
  const path = join(UPLOAD_STATE_DIR, `${uploadId}.json`);
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch { return null; }
}

function saveState(state) {
  mkdirSync(UPLOAD_STATE_DIR, { recursive: true });
  writeFileSync(join(UPLOAD_STATE_DIR, `${state.upload_id}.json`), JSON.stringify(state, null, 2));
}

function removeState(uploadId) {
  const path = join(UPLOAD_STATE_DIR, `${uploadId}.json`);
  if (existsSync(path)) unlinkSync(path);
}

function findResumableStateForFile(projectId, localPath, key) {
  if (!existsSync(UPLOAD_STATE_DIR)) return null;
  for (const f of readdirSync(UPLOAD_STATE_DIR)) {
    if (!f.endsWith(".json")) continue;
    try {
      const s = JSON.parse(readFileSync(join(UPLOAD_STATE_DIR, f), "utf8"));
      if (s.project_id === projectId && s.local_path === localPath && s.key === key) return s;
    } catch { /* ignore */ }
  }
  return null;
}

// ---------------------------------------------------------------------------
// put
// ---------------------------------------------------------------------------

async function putOne(projectId, filePath, opts) {
  const stat = statSync(filePath);
  const size = stat.size;
  const destKey = computeDestKey(filePath, opts.key);
  const absLocal = resolvePath(filePath);

  // Compute sha256 for immutable uploads up front; otherwise lazy.
  const needSha = opts.immutable;
  const sha256 = needSha ? await sha256File(filePath) : undefined;

  // Attempt to resume
  let state = opts.resume
    ? findResumableStateForFile(projectId, absLocal, destKey)
    : null;
  let initRes;
  if (state) {
    // Re-poll the session; if it's still active, resume. Otherwise start fresh.
    const poll = await getSdk().blobs.getUploadSession(projectId, state.upload_id);
    if (poll.status === "active") {
      log(opts, { event: "resume", upload_id: state.upload_id, key: destKey });
      initRes = {
        upload_id: state.upload_id,
        mode: poll.mode ?? state.mode,
        parts: poll.parts ?? state.parts,
        part_count: poll.part_count ?? state.part_count,
        part_size_bytes: poll.part_size_bytes ?? state.part_size_bytes,
      };
    } else {
      removeState(state.upload_id);
      state = null;
    }
  }

  if (!state) {
    initRes = await getSdk().blobs.initUploadSession(projectId, {
      key: destKey,
      size_bytes: size,
      content_type: opts.contentType ?? guessContentType(destKey),
      visibility: opts.private ? "private" : "public",
      immutable: opts.immutable,
      sha256,
    });
    state = {
      upload_id: initRes.upload_id,
      project_id: projectId,
      local_path: absLocal,
      key: destKey,
      mode: initRes.mode,
      part_size_bytes: initRes.part_size_bytes,
      part_count: initRes.part_count,
      parts: initRes.parts,
      parts_done: {},
      sha256,
      started_at: new Date().toISOString(),
    };
    if (opts.resume) saveState(state);
  }

  // Upload parts with concurrency limit. For single-PUT mode part_count=1 and
  // this loop runs once.
  const etags = Array(initRes.part_count);
  for (const pn of Object.keys(state.parts_done || {})) {
    const pd = state.parts_done[pn];
    // Legacy resume state stored just the etag string; new code stores
    // { etag, sha256 }. Normalize on load.
    etags[parseInt(pn, 10) - 1] = typeof pd === "string" ? { etag: pd, sha256: undefined } : pd;
  }

  // Presigned URLs are signed WITHOUT ChecksumAlgorithm (see gateway
  // s3-presign.ts). The client-asserted sha256 declared at init is the
  // integrity attestation — no x-amz-checksum-sha256 header on PUTs, and
  // the gateway trusts the declared value at complete when S3 has none.
  const todo = initRes.parts.filter((p) => !(state.parts_done || {})[String(p.part_number)]);
  await withConcurrency(todo, opts.concurrency, async (part) => {
    const { etag } = await putPart(filePath, part);
    etags[part.part_number - 1] = { etag };
    state.parts_done[String(part.part_number)] = { etag };
    if (opts.resume) saveState(state);
    log(opts, { event: "part", upload_id: state.upload_id, part_number: part.part_number, etag });
  });

  // Complete
  const body = initRes.mode === "multipart"
    ? { parts: etags.map((e, i) => ({ part_number: i + 1, etag: e.etag })) }
    : {};
  const result = await getSdk().blobs.completeUploadSession(projectId, state.upload_id, body, {
    contentType: opts.contentType ?? guessContentType(destKey),
  });

  removeState(state.upload_id);
  log(opts, { event: "done", ...result });
  return result;
}

function computeDestKey(filePath, keyOpt) {
  if (!keyOpt) return basename(filePath);
  if (keyOpt.endsWith("/")) return keyOpt + basename(filePath);
  return keyOpt;
}

async function putPart(filePath, part) {
  const start = part.byte_start ?? 0;
  const end = part.byte_end ?? (statSync(filePath).size - 1);
  const stream = createReadStream(filePath, { start, end });
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  const body = Buffer.concat(chunks);

  const res = await fetch(part.url, { method: "PUT", body });
  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`Part ${part.part_number} PUT failed: ${res.status} ${res.statusText}${errBody ? " — " + errBody.slice(0, 200) : ""}`);
  }
  const etag = res.headers.get("etag") ?? "";
  return { etag };
}

async function withConcurrency(items, limit, worker) {
  const running = [];
  for (const item of items) {
    const p = Promise.resolve().then(() => worker(item));
    running.push(p);
    if (running.length >= limit) {
      await Promise.race(running.map((r) => r.catch(() => {})));
      for (let i = running.length - 1; i >= 0; i--) {
        if (isSettled(running[i])) running.splice(i, 1);
      }
    }
  }
  await Promise.all(running);
}

function isSettled(p) {
  const marker = {};
  return Promise.race([p, marker]).then(
    (v) => v !== marker,
    () => true,
  );
}

async function put(projectId, argv) {
  const opts = parseArgs(argv);
  opts.project = opts.project || projectId;
  const resolvedId = resolveProjectId(opts.project);

  if (opts.positional.length === 0) die("At least one file path is required");
  if (opts.immutable && opts.positional.length > 1 && opts.key && !opts.key.endsWith("/")) {
    die("--key with --immutable across multiple files requires a directory prefix (ending with /)");
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
  if (!opts.output) die("--output <file> required");
  const key = opts.positional[0];

  let res;
  try {
    res = await getSdk().blobs.get(resolvedId, key);
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
    const data = await getSdk().blobs.ls(resolvedId, {
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
  const key = opts.positional[0];

  try {
    await getSdk().blobs.rm(resolvedId, key);
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
  const url = opts.positional[0];

  try {
    const env = await getSdk().blobs.diagnoseUrl(resolvedId, url);
    // Always print the JSON envelope for agent consumption (parseable).
    console.log(JSON.stringify(env, null, 2));
    // Vantage caveat to stderr so a TTY operator sees it; agent shell loops
    // that pipe stdout into another tool aren't affected.
    process.stderr.write(
      `\n# probed once from ${env.vantage}; not a global view\n`,
    );
    // Exit code: 0 if observed === expected, 1 otherwise. Lets agents
    // shell-script `until run402 blob diagnose <url>; do sleep 1; done`.
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
  const key = opts.positional[0];

  try {
    const data = await getSdk().blobs.sign(resolvedId, key, {
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
