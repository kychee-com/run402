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
} from "./argparse.mjs";
import { resolveProjectId } from "./config.mjs";

const HELP = `run402 snapshots — Project database restore points

Usage:
  run402 snapshots create [project-id] [--json]
  run402 snapshots list [project-id] [--kind <kind>] [--limit <n>] [--after <cursor>] [--json]
  run402 snapshots get [project-id] <snapshot-id> [--json]
  run402 snapshots restore [project-id] <snapshot-id> [--include-auth] [--confirm <token>] [--json]
  run402 snapshots delete [project-id] <snapshot-id> [--json]

Restore is a two-step handshake. First call without --confirm to get a
restore_plan.confirm.token, then re-run with --confirm after reviewing the
data-loss statement.
`;

const FLAG_VALUES = ["--kind", "--limit", "--after", "--confirm"];
const FLAGS = new Set([...FLAG_VALUES, "--include-auth", "--json", "--help", "-h"]);
const SNAPSHOT_KINDS = ["manual", "pre_migration", "pre_restore", "scheduled"];

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
    case "delete": return deleteSnapshot(rest);
    default:
      fail({
        code: "UNKNOWN_SUBCOMMAND",
        message: `Unknown snapshots subcommand: ${sub}`,
        hint: "Run `run402 snapshots --help` for usage.",
        details: { command: "snapshots", subcommand: sub },
      });
  }
}

async function create(args) {
  const projectId = resolveOptionalProject(positionalArgs(args, FLAG_VALUES)[0]);
  try {
    const snapshot = await getSdk().snapshots.create(projectId);
    console.log(JSON.stringify({ ok: snapshot.status === "ready", snapshot }, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function list(args) {
  const projectId = resolveOptionalProject(positionalArgs(args, FLAG_VALUES)[0]);
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
  const { projectId, snapshotId } = resolveProjectAndSnapshot(args, "run402 snapshots get [project-id] <snapshot-id>");
  try {
    const snapshot = await getSdk().snapshots.get(projectId, snapshotId);
    console.log(JSON.stringify({ snapshot }, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function restore(args) {
  const { projectId, snapshotId } = resolveProjectAndSnapshot(args, "run402 snapshots restore [project-id] <snapshot-id> [--confirm <token>]");
  const includeAuth = args.includes("--include-auth");
  const confirm = flagValue(args, "--confirm");
  try {
    if (confirm) {
      const result = await getSdk().snapshots.restore(projectId, snapshotId, confirm, { includeAuth });
      console.log(JSON.stringify({ ok: result.status === "ready", restore: result }, null, 2));
      return;
    }
    const plan = await getSdk().snapshots.restorePlan(projectId, snapshotId, { includeAuth });
    console.log(JSON.stringify({
      ok: true,
      project_id: projectId,
      snapshot_id: snapshotId,
      ...plan,
      confirm_command: `run402 snapshots restore ${projectId} ${snapshotId} --confirm ${JSON.stringify(plan.restore_plan.confirm.token)}${includeAuth ? " --include-auth" : ""} --json`,
    }, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function deleteSnapshot(args) {
  const { projectId, snapshotId } = resolveProjectAndSnapshot(args, "run402 snapshots delete [project-id] <snapshot-id>");
  try {
    await getSdk().snapshots.delete(projectId, snapshotId);
    console.log(JSON.stringify({ ok: true, project_id: projectId, snapshot_id: snapshotId, deleted: true }, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

function resolveOptionalProject(value) {
  if (value && String(value).startsWith("prj_")) return value;
  return resolveProjectId(null);
}

function resolveProjectAndSnapshot(args, usage) {
  const pos = positionalArgs(args, FLAG_VALUES);
  if (pos.length === 1) return { projectId: resolveProjectId(null), snapshotId: pos[0] };
  if (pos.length === 2 && pos[0].startsWith("prj_")) return { projectId: pos[0], snapshotId: pos[1] };
  fail({ code: "BAD_USAGE", message: `Usage: ${usage}` });
}
