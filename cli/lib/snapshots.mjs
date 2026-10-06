import { getSdk } from "./sdk.mjs";
import { fail, reportSdkError } from "./sdk-errors.mjs";
import {
  assertAllowedValue,
  assertKnownFlags,
  flagValue,
  hasHelp,
  normalizeArgv,
  parseIntegerFlag,
  positionalArgs,
  resolveProjectSelector,
  failUnknownSubcommand,
} from "./argparse.mjs";

const HELP = `run402 snapshots — Project database restore points

Usage:
  run402 snapshots create [--label <text>] [--metadata <json>] [--project <project_id>] [--json]
  run402 snapshots list [--project <project_id>] [--kind <kind>] [--limit <n>] [--after <cursor>] [--json]
  run402 snapshots get <snapshot_id> [--project <project_id>] [--json]
  run402 snapshots restore <snapshot_id> [--project <project_id>] [--release keep|snapshot] [--include-auth] [--confirm <token>] [--json]
  run402 snapshots restore-status <snapshot_id> <restore_id> [--project <project_id>] [--json]
  run402 snapshots delete <snapshot_id> [--project <project_id>] [--json]

Legacy (still supported): a leading prj_... positional selects the project,
e.g. run402 snapshots restore prj_abc123 <snapshot_id>. --project defaults to
the active project.

--label (1-120 characters) and --metadata (a flat JSON object of string,
number, boolean, or string-array values, up to 4 KB) are stored with the
snapshot and survive restores. Never put secrets in metadata.

Restore is a two-step handshake. First call without --confirm to get a
restore_plan.confirm.token, then re-run with --confirm after reviewing the
data-loss statement. Pass the same --release and --include-auth both times.
--release snapshot also puts back the release that was live when the snapshot
was taken (site, routes, subdomains); the plan's release.warnings lists any
function whose code does not roll back. The confirmed restore waits for the
result; restore-status reads a restore by id.
`;

const FLAG_VALUES = ["--project", "--kind", "--limit", "--after", "--confirm", "--label", "--metadata", "--release"];
const FLAGS = new Set([...FLAG_VALUES, "--include-auth", "--json", "--help", "-h"]);
const SNAPSHOT_KINDS = ["manual", "pre_migration", "pre_restore", "scheduled"];
const RELEASE_MODES = ["keep", "snapshot"];

export async function run(sub, args = []) {
  const all = [sub, ...args].filter(Boolean);
  if (!sub || hasHelp(all)) {
    console.log(HELP);
    return;
  }
  const rest = normalizeArgv(args);
  assertKnownFlags(rest, [...FLAGS], FLAG_VALUES);
  switch (sub) {
    case "create": return create(rest);
    case "list": return list(rest);
    case "get": return get(rest);
    case "restore": return restore(rest);
    case "restore-status": return restoreStatus(rest);
    case "delete": return deleteSnapshot(rest);
    default:
      failUnknownSubcommand("snapshots", sub);
  }
}

function parseMetadataFlag(args) {
  const raw = flagValue(args, "--metadata");
  if (raw === null) return undefined;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    fail({
      code: "BAD_FLAG",
      message: `--metadata must be a JSON object: ${err instanceof Error ? err.message : String(err)}`,
      details: { flag: "--metadata" },
    });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail({ code: "BAD_FLAG", message: "--metadata must be a JSON object", details: { flag: "--metadata" } });
  }
  return parsed;
}

function releaseFlag(args) {
  const release = flagValue(args, "--release");
  if (release === null) return undefined;
  assertAllowedValue(release, RELEASE_MODES, "--release");
  return release;
}

async function create(args) {
  const { projectId } = resolveProjectSelector(args, { valueFlags: FLAG_VALUES });
  const label = flagValue(args, "--label") ?? undefined;
  const metadata = parseMetadataFlag(args);
  try {
    const snapshot = await getSdk().snapshots.create(projectId, {
      ...(label !== undefined ? { label } : {}),
      ...(metadata !== undefined ? { metadata } : {}),
    });
    console.log(JSON.stringify({ ok: snapshot.status === "ready", snapshot }, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function list(args) {
  const { projectId } = resolveProjectSelector(args, { valueFlags: FLAG_VALUES });
  const kind = flagValue(args, "--kind") ?? undefined;
  if (kind !== undefined) assertAllowedValue(kind, SNAPSHOT_KINDS, "--kind");
  const limitFlag = flagValue(args, "--limit");
  const limit = limitFlag === null ? undefined : parseIntegerFlag("--limit", limitFlag, { min: 1, max: 100 });
  try {
    const result = await getSdk().snapshots.list(projectId, {
      ...(kind ? { kind } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(flagValue(args, "--after") ? { after: flagValue(args, "--after") } : {}),
    });
    console.log(JSON.stringify({ project_id: projectId, ...result }, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function get(args) {
  const { projectId, snapshotId } = resolveProjectAndSnapshot(args, "run402 snapshots get [project_id] <snapshot_id>");
  try {
    const snapshot = await getSdk().snapshots.get(projectId, snapshotId);
    console.log(JSON.stringify({ snapshot }, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function restore(args) {
  const { projectId, snapshotId } = resolveProjectAndSnapshot(args, "run402 snapshots restore [project_id] <snapshot_id> [--confirm <token>]");
  const includeAuth = args.includes("--include-auth");
  const release = releaseFlag(args);
  const confirm = flagValue(args, "--confirm");
  const opts = { includeAuth, ...(release !== undefined ? { release } : {}) };
  try {
    if (confirm) {
      const result = await getSdk().snapshots.restore(projectId, snapshotId, confirm, opts);
      console.log(JSON.stringify({ ok: result.status === "ready", restore: result }, null, 2));
      return;
    }
    const plan = await getSdk().snapshots.restorePlan(projectId, snapshotId, opts);
    console.log(JSON.stringify({
      ok: true,
      project_id: projectId,
      snapshot_id: snapshotId,
      ...plan,
      confirm_command: `run402 snapshots restore ${snapshotId} --project ${projectId} --confirm ${JSON.stringify(plan.restore_plan.confirm.token)}${release !== undefined ? ` --release ${release}` : ""}${includeAuth ? " --include-auth" : ""} --json`,
    }, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function restoreStatus(args) {
  const usage = "run402 snapshots restore-status [project_id] <snapshot_id> <restore_id>";
  const { projectId, rest } = resolveProjectSelector(args, { valueFlags: FLAG_VALUES, requireRestPositional: true });
  const pos = positionalArgs(rest, FLAG_VALUES);
  if (pos.length !== 2) fail({ code: "BAD_USAGE", message: `Usage: ${usage}` });
  try {
    const restoreRead = await getSdk().snapshots.getRestore(projectId, pos[0], pos[1]);
    console.log(JSON.stringify({ ok: restoreRead.status !== "failed", restore: restoreRead }, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function deleteSnapshot(args) {
  const { projectId, snapshotId } = resolveProjectAndSnapshot(args, "run402 snapshots delete [project_id] <snapshot_id>");
  try {
    await getSdk().snapshots.delete(projectId, snapshotId);
    console.log(JSON.stringify({ ok: true, project_id: projectId, snapshot_id: snapshotId, deleted: true }, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

function resolveProjectAndSnapshot(args, usage) {
  // Canonical: `<snapshot_id> [--project <project_id>]`; legacy `<prj_id> <snapshot_id>`
  // still works (requireRestPositional keeps a lone snapshot id that happens to
  // start with prj_ from being eaten as the project selector).
  const { projectId, rest } = resolveProjectSelector(args, { valueFlags: FLAG_VALUES, requireRestPositional: true });
  const pos = positionalArgs(rest, FLAG_VALUES);
  if (pos.length !== 1) fail({ code: "BAD_USAGE", message: `Usage: ${usage}` });
  return { projectId, snapshotId: pos[0] };
}
