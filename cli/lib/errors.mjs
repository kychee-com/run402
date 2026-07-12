/**
 * run402 errors — grouped error fingerprints + a release-baselined
 * promote/revert verdict (gateway release-error-rollup).
 *
 * Two audiences from one wire envelope:
 *   --json  → the gateway envelope VERBATIM (list page, detail row, or the
 *             watch triggering/final page). No reshaping — CLI-JSON and HTTP
 *             consumers see one contract.
 *   default → a rendered read: the verdict first (so "0 errors over 0 traffic"
 *             is never mistaken for health), then one line per fingerprint,
 *             then a runnable logs drill-down.
 *
 * The promote gate: `--new-in <release> --fail-on-new` exits 0 when no error
 * identity was first seen under that release, 1 when new fingerprints appear,
 * and 2 when a verdict could not be produced (outage / auth / gate misuse) —
 * so a script can never mistake an outage for a clean verdict. `--watch` tails
 * the release under real traffic and fails fast the moment a new identity lands.
 */

import { resolveProjectId } from "./config.mjs";
import { getSdk } from "./sdk.mjs";
import { reportSdkError, fail } from "./sdk-errors.mjs";
import {
  assertKnownFlags,
  assertAllowedValue,
  flagValue,
  normalizeArgv,
  parseIntegerFlag,
  positionalArgs,
} from "./argparse.mjs";

/** Wire `kind` vocabulary (mirrors the gateway's KINDS set). */
export const KINDS = ["uncaught", "boot_crash", "invoke_failed", "handled_5xx"];

/** Poll cadence floor for --watch, enforced client-side. */
export const INTERVAL_FLOOR_MS = 5000;
/** Default poll cadence for --watch. */
export const DEFAULT_INTERVAL_MS = 15000;

const HELP = `run402 errors — grouped error fingerprints + a promote/revert verdict

Usage:
  run402 errors [--project <id>] [filters] [--json]
  run402 errors <fingerprint_id> [--project <id>] [--json]
  run402 errors --new-in <release_id|active> --fail-on-new [--json]
  run402 errors --new-in <release_id|active> --watch <dur> [--fail-on-new]

What this is:
  A "fingerprint" is one error IDENTITY — errors with the same normalized
  message + stable stack frames collapse into a single group with a count,
  a first/last-seen, and the releases they were seen under. You read groups,
  not a firehose of individual lines.

  The "verdict" pairs new-vs-recurring identity counts with the invocations
  in the window and a coverage note. That pairing is the point: 0 errors over
  0 traffic is ABSENCE OF SIGNAL, not proven health — the verdict makes the
  two distinguishable so an empty result is never silently read as "healthy".

  The "baseline" is the previously ACTIVE release, resolved by activation
  history (not lineage) — so it is rollback-safe: after A -> B -> rollback to
  A -> C, C's baseline is A, and identities first seen under B are not
  attributed to C. "--new-in <release>" selects the identities first seen
  under that release; "active" resolves the project's live release.

Filters (each maps 1:1 to a query param):
  --project <id>        Project to read (defaults to the active project)
  --since <iso>         Window start (ISO-8601). Default: 24h before --until
  --until <iso>         Window end (ISO-8601). Default: now
  --function <name>     Only this function's fingerprints
  --kind <kind>         One of: ${KINDS.join(", ")}
  --fingerprint <id>    Only this fingerprint id (exact)
  --new-in <rel|active> Only identities first seen under this release
                        (a release id, or the literal "active" for live)
  --limit <n>           Page size (default 50, max 200)
  --cursor <cursor>     Opaque cursor from a prior response's next_cursor.
                        Never parse or compare it — pass it back as-is.

Output:
  --json                Emit the gateway envelope verbatim (never reshaped)
  --watch <dur>         Poll the release for new identities for <dur>, then
                        stop. Requires --new-in. Durations: 90s, 10m, 2h, or a
                        bare number of seconds. Progress ticks go to stderr so
                        stdout stays pipeable.
  --interval <dur>      Poll cadence for --watch (default 15s, floor 5s)
  --fail-on-new         Turn the run into the promote gate (exit codes below).
                        Requires --new-in.

Quality tiers (fingerprint_quality):
  frame_names   full fidelity — grouped by stable stack frames
  message_only  medium — grouped by normalized message
  coarse        the function predates the error side-channel; redeploy it and
                future occurrences fingerprint at full fidelity. The verdict's
                coverage line counts how many functions are still coarse.

Exit codes (the promote gate — only when --fail-on-new is set):
  0   clean   — no identity was first seen under the --new-in release
  1   new     — new identities appeared (printed with a sample id + a runnable
                logs command for each, so you can act without another query).
                Under --watch this fails FAST the instant a new identity lands.
  2   unknown — a verdict could NOT be produced: network / auth / API failure,
                or gate misuse (--fail-on-new without --new-in). A script must
                never read an outage as a clean verdict, so this is distinct
                from 1. Without --fail-on-new, failures are the usual exit 1.

Auth:
  The addressed project's own anon_key or service_key. A key for project A
  requesting project B's errors gets 403 (never a 404 that leaks existence).
  Read-only; never lifecycle-gated.

The golden path — gate a promote:
  run402 deploy promote --project <id> --release <rel>
  run402 errors --project <id> --new-in <rel> --watch 10m --fail-on-new
  # exit 0 -> the new release is clean; exit 1 -> revert, drill in via logs.
  # (a promote response already hands you this exact command in next_actions
  #  as the "watch_errors" action — copy it verbatim.)

Examples:
  run402 errors                                   # last 24h, verdict + groups
  run402 errors --function checkout --kind uncaught
  run402 errors --since 2026-07-11T00:00:00Z --limit 200
  run402 errors fp_9b21fa                          # one fingerprint, all samples
  run402 errors --new-in active                    # what's new under the live release
  run402 errors --new-in rel_01JX --fail-on-new    # one-shot gate (CI)
  run402 errors --new-in rel_01JX --watch 10m --interval 30s --fail-on-new
`;

export async function run(sub, args = []) {
  const argv = [sub, ...(Array.isArray(args) ? args : [])].filter((x) => x !== undefined && x !== null);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP);
    process.exit(0);
  }

  const a = normalizeArgv(argv);
  const valueFlags = [
    "--project", "--since", "--until", "--function", "--kind",
    "--fingerprint", "--new-in", "--limit", "--cursor", "--watch", "--interval",
  ];
  const boolFlags = ["--json", "--fail-on-new", "--help", "-h"];
  assertKnownFlags(a, [...valueFlags, ...boolFlags], valueFlags);

  const positionals = positionalArgs(a, valueFlags);
  if (positionals.length > 1) {
    fail({
      code: "BAD_USAGE",
      message: `Unexpected extra argument: ${positionals[1]}`,
      hint: "Pass at most one <fingerprint_id> for the detail view. Run `run402 errors --help`.",
    });
  }
  const fingerprintId = positionals[0] ?? null;
  const json = a.includes("--json");
  const failOnNew = a.includes("--fail-on-new");
  const project = flagValue(a, "--project");
  const newIn = flagValue(a, "--new-in");
  const watchRaw = flagValue(a, "--watch");
  const intervalRaw = flagValue(a, "--interval");

  // ---- Detail view (single positional fingerprint id) ----------------------
  if (fingerprintId) {
    const listOnly = [
      "--since", "--until", "--function", "--kind", "--fingerprint",
      "--new-in", "--limit", "--cursor", "--watch", "--interval", "--fail-on-new",
    ];
    const offending = listOnly.find((f) => a.includes(f));
    if (offending) {
      fail({
        code: "BAD_USAGE",
        message: `${offending} is not valid with a <fingerprint_id> (detail view).`,
        hint: "Detail view accepts only --project and --json. Drop the fingerprint id to list + get a verdict.",
      });
    }
    const projectId = resolveProjectId(project);
    let detail;
    try {
      detail = await getSdk().errors.get(projectId, fingerprintId);
    } catch (err) {
      reportSdkError(err);
      return;
    }
    if (json) {
      console.log(JSON.stringify(detail, null, 2));
      return;
    }
    console.log(renderHumanDetail(detail));
    return;
  }

  // ---- Gate misuse (order matters for the exit-code contract) --------------
  // --fail-on-new without --new-in is a verdict that can't be produced -> 2.
  if (failOnNew && !newIn) {
    fail({
      code: "BAD_USAGE",
      message: "--fail-on-new requires --new-in <release_id|active>.",
      hint: "The promote gate compares identities first seen under a release against its baseline. Pass --new-in <release_id> (or `active`).",
      exit_code: 2,
    });
  }
  // --watch without --new-in (and without the gate) is ordinary bad usage -> 1.
  if (watchRaw != null && !newIn) {
    fail({
      code: "BAD_USAGE",
      message: "--watch requires --new-in <release_id|active>.",
      hint: "Watch tails a specific release for new error identities. Pass --new-in <release_id> (or `active`).",
    });
  }

  // ---- Client-side validation (fail fast, before project / network) --------
  // Build list opts (1:1 with query params) and validate every flag value up
  // front so a malformed flag never surfaces as a project-resolution error.
  const opts = {};
  const since = flagValue(a, "--since");
  const until = flagValue(a, "--until");
  const fn = flagValue(a, "--function");
  const kind = flagValue(a, "--kind");
  const fingerprint = flagValue(a, "--fingerprint");
  const limit = flagValue(a, "--limit");
  const cursor = flagValue(a, "--cursor");
  if (since != null) opts.since = since;
  if (until != null) opts.until = until;
  if (fn != null) opts.function = fn;
  if (kind != null) {
    assertAllowedValue(kind, KINDS, "--kind");
    opts.kind = kind;
  }
  if (fingerprint != null) opts.fingerprint = fingerprint;
  if (newIn != null) opts.newIn = newIn;
  if (limit != null) opts.limit = parseIntegerFlag("--limit", limit, { min: 1, max: 200 });
  if (cursor != null) opts.cursor = cursor;

  let watchConfig = null;
  if (watchRaw != null) {
    const durationMs = parseDurationMs(watchRaw);
    if (durationMs == null || durationMs <= 0) {
      fail({
        code: "BAD_FLAG",
        message: `--watch must be a duration like 90s, 10m, 2h, or a bare number of seconds (got: ${watchRaw})`,
        details: { flag: "--watch", value: watchRaw },
      });
    }
    let intervalMs = DEFAULT_INTERVAL_MS;
    if (intervalRaw != null) {
      const parsed = parseDurationMs(intervalRaw);
      if (parsed == null || parsed <= 0) {
        fail({
          code: "BAD_FLAG",
          message: `--interval must be a duration like 15s, 1m, or a bare number of seconds (got: ${intervalRaw})`,
          details: { flag: "--interval", value: intervalRaw },
        });
      }
      intervalMs = parsed;
    }
    if (intervalMs < INTERVAL_FLOOR_MS) {
      process.stderr.write(`(interval ${fmtDuration(intervalMs)} is below the ${fmtDuration(INTERVAL_FLOOR_MS)} floor; using ${fmtDuration(INTERVAL_FLOOR_MS)})\n`);
      intervalMs = INTERVAL_FLOOR_MS;
    }
    watchConfig = { durationMs, intervalMs };
  }

  // ---- Project resolution (prerequisite for any call) ----------------------
  const projectId = resolveProjectId(project);

  // ---- Watch mode ----------------------------------------------------------
  if (watchConfig != null) {
    await runWatch({ projectId, newIn, ...watchConfig, failOnNew, json });
    return;
  }

  // ---- Single-shot list ----------------------------------------------------
  let page;
  try {
    page = await getSdk().errors.list(projectId, opts);
  } catch (err) {
    // Under the gate, an error means the verdict is UNKNOWN (exit 2), never a
    // clean/dirty verdict.
    if (failOnNew) failVerdictUnavailable(err);
    reportSdkError(err);
    return;
  }

  if (json) console.log(JSON.stringify(page, null, 2));

  if (failOnNew) {
    const totalNew = Number(page?.verdict?.new_fingerprints ?? 0);
    if (totalNew > 0) {
      if (!json) console.log(renderFailOnNewList(page?.errors ?? [], newIn, totalNew));
      process.exit(1);
    }
    if (!json) console.log(renderCleanGate(page?.verdict, newIn));
    process.exit(0);
  }

  if (!json) console.log(renderHumanList(page));
}

// ─── Watch driver ────────────────────────────────────────────────────────────

async function runWatch({ projectId, newIn, durationMs, intervalMs, failOnNew, json }) {
  let lastPage = null;
  let triggeringPage = null;

  const onPoll = (page, meta) => {
    if (page && typeof page === "object") lastPage = page;
    const newSoFar = Number(page?.verdict?.new_fingerprints ?? 0);
    if (failOnNew && newSoFar > 0 && !triggeringPage) triggeringPage = page;
    const poll = meta?.poll ?? "?";
    const elapsed = fmtDuration(meta?.elapsedMs ?? 0);
    // Progress lives on stderr so stdout carries only the final page / render.
    process.stderr.write(`watch · poll ${poll} · ${elapsed} elapsed · ${fmtInt(newSoFar)} new fingerprint(s) so far\n`);
  };

  let result;
  try {
    result = await getSdk().errors.watch(projectId, {
      newIn,
      durationMs,
      intervalMs,
      onPoll,
      failFast: failOnNew,
    });
  } catch (err) {
    if (failOnNew) failVerdictUnavailable(err);
    reportSdkError(err);
    return;
  }

  const clean = result?.clean === true;
  const newErrors = Array.isArray(result?.new_errors) ? result.new_errors : [];
  const totalNew = Number(result?.verdict?.new_fingerprints ?? newErrors.length);

  if (json) {
    // The triggering page if we fired early, else the last poll's page. Fall
    // back to a page-shaped envelope only if no poll ever ran (edge case).
    const page = triggeringPage ?? lastPage ?? {
      verdict: result?.verdict ?? null,
      errors: newErrors,
      has_more: false,
    };
    console.log(JSON.stringify(page, null, 2));
  }

  if (failOnNew) {
    if (!clean) {
      if (!json) console.log(renderFailOnNewList(newErrors, newIn, totalNew));
      process.exit(1);
    }
    if (!json) {
      console.log(renderCleanGate(result?.verdict, newIn, { watched: true, durationMs, polls: result?.polls }));
    }
    process.exit(0);
  }

  // --watch without --fail-on-new: report and exit 0.
  if (!json) {
    const page = triggeringPage ?? lastPage;
    if (page) console.log(renderHumanList(page));
    else console.log(renderVerdict(result?.verdict));
  }
}

// ─── Gate-failure emitter (exit 2) ───────────────────────────────────────────

/**
 * A verdict could not be produced. Distinct from exit 1 (new fingerprints) so
 * a script never reads an outage as a clean/dirty verdict. Uses fail() with
 * exit_code 2 while preserving the underlying error's http/code for diagnosis.
 */
function failVerdictUnavailable(err) {
  const http = err?.status ?? null;
  const underlying = err?.code ?? (err?.body && typeof err.body === "object" ? err.body.code : undefined) ?? null;
  const detail =
    (err?.body && typeof err.body === "object" ? err.body.message : undefined) ??
    err?.message ??
    String(err);
  fail({
    code: "VERDICT_UNAVAILABLE",
    message: `Could not produce an error verdict: ${detail}`,
    hint: "Network / auth / API failure means the gate result is UNKNOWN (exit 2) — not a clean verdict (exit 0) and not new-fingerprints (exit 1). Retry, or run `run402 doctor`.",
    details: { http, underlying_code: underlying },
    retryable: true,
    exit_code: 2,
  });
}

// ─── Pure helpers (exported for unit tests; no network, no SDK) ──────────────

/**
 * Parse a watch/interval duration into milliseconds.
 * Accepts `90s`, `10m`, `2h`, or a bare number of seconds (`600`). A bare
 * number is seconds. Returns null for anything malformed (caller fails).
 */
export function parseDurationMs(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase();
  const m = /^(\d+)(s|m|h)?$/.exec(s);
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  if (!Number.isFinite(n)) return null;
  const unit = m[2] || "s";
  const mult = unit === "h" ? 3600000 : unit === "m" ? 60000 : 1000;
  return n * mult;
}

/** Compact, human-friendly duration for a millisecond span (e.g. 90000 -> "90s"). */
export function fmtDuration(ms) {
  const total = Math.max(0, Math.round(Number(ms) / 1000));
  if (total === 0) return "0s";
  if (total % 86400 === 0) return `${total / 86400}d`;
  if (total % 3600 === 0) return `${total / 3600}h`;
  if (total % 60 === 0) return `${total / 60}m`;
  return `${total}s`;
}

/** Thousands-separated integer. */
export function fmtInt(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return String(n ?? 0);
  return v.toLocaleString("en-US");
}

/** Truncate a display string to ~n chars, appending an ellipsis. */
export function truncate(s, n = 100) {
  const str = String(s ?? "");
  return str.length <= n ? str : `${str.slice(0, Math.max(0, n - 1))}…`;
}

/** "just now" / "3m ago" / "2h ago" / "5d ago" for an ISO timestamp. */
export function relativeTime(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return String(iso ?? "");
  let diff = now - t;
  if (diff < 0) diff = 0;
  const sec = Math.floor(diff / 1000);
  if (sec < 45) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

/**
 * A verdict-window span. Like fmtDuration but prefers HOURS for spans under
 * ~2 days, so the default 24h window reads "24h" (not "1d").
 */
function humanizeWindowSpan(ms) {
  const sec = Math.max(0, Math.round(Number(ms) / 1000));
  if (sec === 0) return "0s";
  if (sec % 86400 === 0 && sec / 86400 >= 2) return `${sec / 86400}d`;
  if (sec % 3600 === 0) return `${sec / 3600}h`;
  if (sec % 60 === 0) return `${sec / 60}m`;
  return `${sec}s`;
}

/** Describe the verdict window: "last 24h" when it ends ~now, else a range. */
export function describeWindow(since, until, now = Date.now()) {
  if (!since || !until) return "recent window";
  const s = Date.parse(since);
  const u = Date.parse(until);
  if (Number.isNaN(s) || Number.isNaN(u)) return `${since} → ${until}`;
  if (Math.abs(now - u) <= 120000) return `last ${humanizeWindowSpan(u - s)}`;
  return `${since} → ${until}`;
}

function logsCommand(fn, id) {
  return fn && id ? `run402 logs ${fn} --request-id ${id}` : null;
}

function topSampleId(row) {
  const recent = row?.samples?.recent;
  if (Array.isArray(recent) && recent[0]?.id) return recent[0].id;
  return row?.samples?.first?.id ?? null;
}

/** The verdict block — printed FIRST so absence-of-signal never reads as health. */
export function renderVerdict(verdict) {
  const v = verdict || {};
  const L = (label) => `  ${String(label).padEnd(22)}`;
  const lines = [];

  let header = `Verdict — ${describeWindow(v.window?.since, v.window?.until)}`;
  if (v.compared_release_id) {
    header += ` · comparing ${v.compared_release_id} against baseline ${v.baseline_release_id ?? "(none — first activation)"}`;
  }
  lines.push(header);

  const newVal = fmtInt(v.new_fingerprints ?? 0);
  lines.push(
    v.compared_release_id
      ? `${L("new error identities")}${newVal}   ← first seen under ${v.compared_release_id}`
      : `${L("new error identities")}${newVal}`,
  );
  lines.push(`${L("recurring")}${fmtInt(v.recurring_fingerprints ?? 0)}`);
  lines.push(`${L("invocations in window")}${fmtInt(v.invocations_in_window ?? 0)}`);

  const full = Number(v.coverage?.full_fidelity_functions ?? 0);
  const coarse = Number(v.coverage?.coarse_functions ?? 0);
  let coverage = `${fmtInt(full)} function(s) full-fidelity · ${fmtInt(coarse)} coarse`;
  if (coarse > 0) coverage += " (redeploy the coarse functions to upgrade fidelity)";
  lines.push(`${L("coverage")}${coverage}`);

  if (v.row_cap?.at_cap) {
    lines.push(`${L("row cap")}showing up to ${fmtInt(v.row_cap?.limit ?? 0)} — AT CAP; narrow the window (--since / --function) for completeness`);
  }

  return lines.join("\n");
}

/** One readable line per fingerprint. */
export function renderListRow(row) {
  const r = row || {};
  const coarse = r.fingerprint_quality === "coarse" ? "  [coarse]" : "";
  const msg = truncate(r.message_template, 100);
  return `${r.fingerprint_id}  ${r.kind}  ×${fmtInt(r.count)}  ${r.error_name}  fn:${r.function}  "${msg}"  · ${relativeTime(r.last_seen)}${coarse}`;
}

/** The full human list render: verdict, rows (or the empty note), a drill-down. */
export function renderHumanList(page) {
  const p = page || {};
  const errors = Array.isArray(p.errors) ? p.errors : [];
  const parts = [renderVerdict(p.verdict), ""];

  if (errors.length === 0) {
    const inv = Number(p.verdict?.invocations_in_window ?? 0);
    parts.push(`No error fingerprints in window (${fmtInt(inv)} invocation(s) observed).`);
    if (inv === 0) {
      parts.push("Zero errors over zero traffic is absence of signal, not proven health — drive traffic, then re-check.");
    }
    return parts.join("\n");
  }

  for (const row of errors) parts.push(renderListRow(row));

  if (p.has_more) {
    parts.push("");
    parts.push(`More rows available — page with --cursor ${p.next_cursor ?? "<next_cursor from --json>"} (cursors are opaque; pass as-is).`);
  }

  const top = errors[0];
  const cmd =
    (Array.isArray(top?.next_actions) ? top.next_actions.find((x) => x?.type === "fetch_logs")?.command : null) ??
    logsCommand(top?.function, topSampleId(top));
  if (cmd) {
    parts.push("");
    parts.push("Investigate the top fingerprint:");
    parts.push(`  ${cmd}`);
  }

  return parts.join("\n");
}

/** Full detail render: both release attributions, all samples with runnable logs. */
export function renderHumanDetail(detail) {
  const d = detail || {};
  const parts = [];
  parts.push(`Fingerprint ${d.fingerprint_id}`);
  parts.push(`  kind            ${d.kind}`);
  parts.push(`  error           ${d.error_name}`);
  parts.push(`  function        fn:${d.function}`);
  parts.push(`  quality         ${d.fingerprint_quality}`);
  if (d.fingerprint_quality === "coarse") {
    parts.push("                  This function predates the error side-channel; redeploying it upgrades future fingerprint fidelity (frame-level grouping).");
  }
  parts.push(`  count           ${fmtInt(d.count)}`);
  parts.push(`  first seen      ${d.first_seen}  (release ${d.first_seen_release_id ?? "unknown"})`);
  parts.push(`  last seen       ${d.last_seen}  (release ${d.last_seen_release_id ?? "unknown"})`);
  if (Array.isArray(d.also_seen_in_functions) && d.also_seen_in_functions.length > 0) {
    parts.push(`  also seen in    ${d.also_seen_in_functions.map((f) => `fn:${f}`).join(", ")}`);
  }
  parts.push(`  message         ${d.message_template}`);

  const frames = Array.isArray(d.stable_frames) ? d.stable_frames : [];
  if (frames.length > 0) {
    parts.push("  stable frames:");
    for (const f of frames) parts.push(`    ${f}`);
  }

  const first = d.samples?.first;
  const recent = Array.isArray(d.samples?.recent) ? d.samples.recent : [];
  parts.push("");
  parts.push("Samples — pinned first occurrence + recent ring (newest first):");
  if (first?.id) {
    parts.push(`  first   ${first.id}  ${first.at ?? ""}  (release ${first.release_id ?? "unknown"})`);
    parts.push(`          ${logsCommand(d.function, first.id)}`);
  }
  for (const s of recent) {
    if (!s?.id) continue;
    parts.push(`  recent  ${s.id}  ${s.at ?? ""}  (release ${s.release_id ?? "unknown"})`);
    parts.push(`          ${logsCommand(d.function, s.id)}`);
  }

  return parts.join("\n");
}

/** Actionable exit-1 render: each new identity with a sample id + logs command. */
export function renderFailOnNewList(newErrors, newIn, totalNew) {
  const rows = Array.isArray(newErrors) ? newErrors : [];
  const total = Number.isFinite(Number(totalNew)) ? Number(totalNew) : rows.length;
  const parts = [];
  parts.push(`FAIL — ${fmtInt(total)} new error identit${total === 1 ? "y" : "ies"} first seen under ${newIn}:`);
  for (const row of rows) {
    const sid = topSampleId(row);
    parts.push("");
    parts.push(`  ${row.fingerprint_id}  ${row.kind}  ×${fmtInt(row.count)}  ${row.error_name}  fn:${row.function}`);
    parts.push(`    "${truncate(row.message_template, 100)}"`);
    if (sid) {
      parts.push(`    sample ${sid}`);
      parts.push(`    ${logsCommand(row.function, sid)}`);
    }
  }
  if (total > rows.length) {
    parts.push("");
    parts.push(`  … and ${fmtInt(total - rows.length)} more not shown (raise --limit or page with --cursor).`);
  }
  return parts.join("\n");
}

/** Clean-gate render (exit 0). */
export function renderCleanGate(verdict, newIn, opts = {}) {
  const parts = [];
  const watched = opts.watched
    ? `Watched ${fmtDuration(opts.durationMs)}${opts.polls != null ? ` (${fmtInt(opts.polls)} polls)` : ""} — `
    : "";
  parts.push(`PASS — ${watched}no new error identities first seen under ${newIn}.`);
  if (verdict) parts.push(renderVerdict(verdict));
  return parts.join("\n");
}
