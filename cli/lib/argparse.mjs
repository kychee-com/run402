import { existsSync, statSync } from "node:fs";
import { fail } from "./sdk-errors.mjs";
import { resolveProjectId } from "./config.mjs";

export function normalizeArgv(argv = []) {
  const out = [];
  for (const arg of argv ?? []) {
    if (typeof arg === "string" && arg.startsWith("--") && arg.includes("=")) {
      const eq = arg.indexOf("=");
      out.push(arg.slice(0, eq), arg.slice(eq + 1));
    } else {
      out.push(arg);
    }
  }
  return out;
}

export function hasHelp(args = []) {
  return args.includes("--help") || args.includes("-h");
}

export function assertKnownFlags(args = [], knownFlags = [], flagsWithValues = []) {
  const known = new Set(knownFlags);
  const valueFlags = new Set(flagsWithValues);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (valueFlags.has(arg)) {
      if (i + 1 >= args.length || (typeof args[i + 1] === "string" && args[i + 1].startsWith("--"))) {
        fail({
          code: "BAD_FLAG",
          message: `${arg} requires a value`,
          details: { flag: arg },
        });
      }
      i += 1;
      continue;
    }
    if (typeof arg !== "string" || !arg.startsWith("-") || arg === "-") continue;
    if (known.has(arg)) continue;
    failUnknownFlag(arg, known);
  }
}

export function failUnknownFlag(flag, knownFlags = []) {
  const known = [...knownFlags].filter((f) => typeof f === "string" && f.startsWith("-"));
  const closest = closestFlag(flag, known);
  fail({
    code: "UNKNOWN_FLAG",
    message: closest ? `Unknown flag: ${flag}. Did you mean ${closest}?` : `Unknown flag: ${flag}.`,
    details: { flag, closest: closest ? [closest] : [] },
  });
}

export function flagValue(args, flag) {
  const idx = args.indexOf(flag);
  if (idx === -1) return null;
  if (idx + 1 >= args.length || (typeof args[idx + 1] === "string" && args[idx + 1].startsWith("--"))) {
    fail({
      code: "BAD_FLAG",
      message: `${flag} requires a value`,
      details: { flag },
    });
  }
  return args[idx + 1];
}

export function parseIntegerFlag(name, value, { min = 1, max = Number.POSITIVE_INFINITY, def } = {}) {
  if (value === undefined || value === null) {
    if (def !== undefined) return def;
    fail({
      code: "BAD_FLAG",
      message: `${name} requires an integer value`,
      details: { flag: name },
    });
  }
  const raw = String(value);
  if (!/^-?\d+$/.test(raw)) {
    fail({
      code: "BAD_FLAG",
      message: `${name} must be an integer, got: ${raw}`,
      details: { flag: name, value: raw },
    });
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(n)) {
    fail({
      code: "BAD_FLAG",
      message: `${name} must be a safe integer, got: ${raw}`,
      details: { flag: name, value: raw },
    });
  }
  if (n < min) {
    fail({
      code: "BAD_FLAG",
      message: `${name} must be >= ${min}, got: ${n}`,
      details: { flag: name, value: n, min },
    });
  }
  if (n > max) {
    fail({
      code: "BAD_FLAG",
      message: `${name} must be <= ${max}, got: ${n}`,
      details: { flag: name, value: n, max },
    });
  }
  return n;
}

export function assertAllowedValue(value, allowed, fieldName) {
  if (!allowed.includes(value)) {
    fail({
      code: "BAD_FLAG",
      message: `${fieldName} must be one of: ${allowed.join(", ")}`,
      details: { field: fieldName, value, allowed },
    });
  }
}

export function validateEvmAddress(value, fieldName = "address") {
  if (typeof value !== "string" || !/^0x[a-fA-F0-9]{40}$/.test(value)) {
    fail({
      code: "BAD_FLAG",
      message: `${fieldName} must be a 0x-prefixed 20-byte EVM address`,
      details: { field: fieldName, value },
    });
  }
}

export function failBadProjectId(value) {
  fail({
    code: "BAD_PROJECT_ID",
    message: `Argument '${value}' is not a project id. Project IDs must start with 'prj_'.`,
    hint: "Omit the project id to use the active project, or pass the full prj_... id.",
    details: { value, expected_prefix: "prj_" },
  });
}

/**
 * Validate a webhook URL: parse it locally and reject non-https:// schemes.
 *
 * Scope (GH-192): scheme-only validation. Reject `javascript:`, `file:`,
 * `http:`, `data:`, `ftp:`, etc. before the request leaves the CLI process.
 * Server-side SSRF defenses (private-IP filtering, DNS rebinding, IMDS
 * blocking) live on the gateway, not here — this helper is the cheap
 * client-side guard against the obvious classes.
 *
 * No-op when `url` is null/undefined/empty so callers can pass optional
 * flag values directly. Required-vs-optional handling stays at the call
 * site (e.g. `webhooks register` does its own missing-flag check first).
 *
 * On failure: `fail()` writes the canonical error envelope and exits 1.
 *
 * @param {string|null|undefined} url - The webhook URL to validate.
 * @param {string} fieldName - The CLI flag name for the error envelope (e.g. "--url", "--webhook").
 */
export function validateWebhookUrl(url, fieldName = "--url") {
  if (!url) return;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    fail({
      code: "BAD_WEBHOOK_URL",
      message: `${fieldName} is not a valid URL: ${JSON.stringify(url)}`,
      field: fieldName,
      hint: "Webhook URL must be a fully-qualified https:// URL.",
      details: { flag: fieldName, value: url },
    });
  }
  if (parsed.protocol !== "https:") {
    fail({
      code: "BAD_WEBHOOK_URL",
      message: `${fieldName} must use https://, got ${parsed.protocol}`,
      field: fieldName,
      hint: "Webhook URLs must be https:// for transport security.",
      details: { flag: fieldName, value: url, scheme: parsed.protocol },
    });
  }
}

/**
 * Validate that a CLI flag pointing at a filesystem path resolves to an
 * existing regular file. Replaces the GH-195 inline pattern that was
 * duplicated across `functions deploy`, `secrets set`, `projects sql`,
 * and `projects apply-expose` (GH-233).
 *
 * Without this guard, `readFileSync` against a missing path leaks a raw
 * `node:fs` ENOENT/EISDIR stack to stderr (with the V8 source pointer),
 * which violates the CLI's structured-error contract.
 *
 * No-op: this helper is meant to be called only when the flag is set.
 * Callers handle the optional/required dichotomy themselves.
 *
 * On failure: `fail()` writes a `FILE_NOT_FOUND` or `NOT_A_FILE` envelope
 * to stderr and exits 1.
 *
 * @param {string} path - The filesystem path captured from the flag.
 * @param {string} fieldName - The flag name for the envelope (default "--file").
 */
export function validateRegularFile(path, fieldName = "--file") {
  if (!existsSync(path)) {
    fail({
      code: "FILE_NOT_FOUND",
      message: `File not found: ${path}`,
      field: fieldName,
      path,
      hint: `Check that ${fieldName} points to an existing file.`,
    });
  }
  const stat = statSync(path);
  if (!stat.isFile()) {
    fail({
      code: "NOT_A_FILE",
      message: `${fieldName} points to a ${stat.isDirectory() ? "directory" : "non-regular file"}: ${path}`,
      field: fieldName,
      path,
    });
  }
}

export function positionalArgs(args = [], flagsWithValues = []) {
  const valueFlags = new Set(flagsWithValues);
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (valueFlags.has(arg)) {
      i += 1;
      continue;
    }
    if (typeof arg === "string" && arg.startsWith("-")) continue;
    out.push(arg);
  }
  return out;
}

export function requirePositionalCount(args = [], flagsWithValues = [], opts = {}) {
  const {
    min = 0,
    max = min,
    command = "command",
    missing = "Missing required argument.",
  } = opts;
  const pos = positionalArgs(args, flagsWithValues);
  if (pos.length < min) {
    fail({
      code: "BAD_USAGE",
      message: missing,
      hint: command,
    });
  }
  if (pos.length > max) {
    fail({
      code: "BAD_USAGE",
      message: `Unexpected argument for ${command}: ${pos[max]}`,
      hint: `Use \`${command}\`.`,
    });
  }
  return pos;
}

// Resolve a positional project_id argument with active-project fallback (GH-102, GH-187).
// If the first positional starts with "prj_", treat it as the project id and
// strip it from the rest. Otherwise, fall through to the active project from
// the keystore. Callers can tighten the legacy shorthand when a bare non-prj
// positional is more likely a mistyped project id than an argument for the
// active project.
//
// Options:
//   rejectBareFirst:                   when true, error if the first positional
//                                      is non-empty and doesn't start with "prj_".
//   rejectBareFirstWhenFlagPresent:    when one of these flags is present in
//                                      args AND the first positional doesn't
//                                      start with "prj_", error out.
//   maxBarePositionals + valueFlags:   when set, count the bare (non-flag)
//                                      positionals using `positionalArgs(args,
//                                      valueFlags)` and error if the count
//                                      exceeds maxBarePositionals.
export function resolvePositionalProject(args, opts = {}) {
  const first = Array.isArray(args) ? args[0] : undefined;
  if (typeof first === "string" && first.startsWith("prj_")) {
    return { projectId: first, rest: args.slice(1) };
  }
  if (
    typeof first === "string" &&
    first.length > 0 &&
    !first.startsWith("-") &&
    Array.isArray(opts.rejectBareFirstWhenFlagPresent) &&
    opts.rejectBareFirstWhenFlagPresent.some((flag) => args.includes(flag))
  ) {
    failBadProjectId(first);
  }
  if (typeof first === "string" && first.length > 0 && !first.startsWith("-") && opts.rejectBareFirst) {
    failBadProjectId(first);
  }
  if (typeof first === "string" && first.length > 0 && !first.startsWith("-") && opts.maxBarePositionals !== undefined) {
    const bare = positionalArgs(args, opts.valueFlags ?? []);
    if (bare.length > opts.maxBarePositionals) {
      failBadProjectId(first);
    }
  }
  return { projectId: resolveProjectId(null), rest: Array.isArray(args) ? args : [] };
}

function closestFlag(flag, candidates) {
  let best = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const d = levenshtein(flag, candidate);
    if (d < bestDistance) {
      best = candidate;
      bestDistance = d;
    }
  }
  if (!best) return null;
  return bestDistance <= 3 ? best : null;
}

function levenshtein(a, b) {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  const curr = Array.from({ length: b.length + 1 }, () => 0);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1,
        prev[j] + 1,
        prev[j - 1] + cost,
      );
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}
