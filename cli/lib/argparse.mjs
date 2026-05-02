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
  if (idx + 1 >= args.length) {
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

export function failBadProjectId(value) {
  fail({
    code: "BAD_PROJECT_ID",
    message: `Argument '${value}' is not a project id. Project IDs must start with 'prj_'.`,
    hint: "Omit the project id to use the active project, or pass the full prj_... id.",
    details: { value, expected_prefix: "prj_" },
  });
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
