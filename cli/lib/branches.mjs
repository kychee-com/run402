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

const HELP = `run402 branches — Contained project data branches

Usage:
  run402 branches create [--project <id>] [--from-snapshot <snapshot-id>] [--name <label>] [--email-mode sandbox|off] [--enable-cron] [--ttl-days <n>] [--json]
  run402 branches list [--project <id>] [--json]
  run402 branches renew <branch-project-id> [--project <id>] [--ttl-days <n>] [--json]
  run402 branches delete <branch-project-id> [--project <id>] [--json]

Legacy (still supported): a leading prj_... parent-project positional,
e.g. run402 branches renew prj_parent prj_branch. --project defaults to the
active project.
`;

const FLAG_VALUES = ["--project", "--from-snapshot", "--name", "--email-mode", "--ttl-days"];
const FLAGS = new Set([...FLAG_VALUES, "--enable-cron", "--json", "--help", "-h"]);

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
    case "renew": return renew(rest);
    case "delete": return deleteBranch(rest);
    default:
      failUnknownSubcommand("branches", sub);
  }
}

async function create(args) {
  const { projectId } = resolveProjectSelector(args, { valueFlags: FLAG_VALUES });
  const emailMode = flagValue(args, "--email-mode") ?? undefined;
  if (emailMode !== undefined) assertAllowedValue(emailMode, ["sandbox", "off"], "--email-mode");
  const ttlDaysFlag = flagValue(args, "--ttl-days");
  const ttlDays = ttlDaysFlag === null ? undefined : parseIntegerFlag("--ttl-days", ttlDaysFlag, { min: 1, max: 30 });
  try {
    const branch = await getSdk().branches.create(projectId, {
      ...(flagValue(args, "--from-snapshot") ? { fromSnapshotId: flagValue(args, "--from-snapshot") } : {}),
      ...(flagValue(args, "--name") ? { name: flagValue(args, "--name") } : {}),
      ...(emailMode ? { emailMode } : {}),
      ...(args.includes("--enable-cron") ? { enableCron: true } : {}),
      ...(ttlDays !== undefined ? { ttlDays } : {}),
    });
    console.log(JSON.stringify({ ok: true, branch }, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function list(args) {
  const { projectId } = resolveProjectSelector(args, { valueFlags: FLAG_VALUES });
  try {
    const result = await getSdk().branches.list(projectId);
    console.log(JSON.stringify({ project_id: projectId, ...result }, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function renew(args) {
  const { projectId, branchProjectId } = resolveProjectAndBranch(args, "run402 branches renew [project-id] <branch-project-id>");
  const ttlDaysFlag = flagValue(args, "--ttl-days");
  const ttlDays = ttlDaysFlag === null ? undefined : parseIntegerFlag("--ttl-days", ttlDaysFlag, { min: 1, max: 30 });
  try {
    const branch = await getSdk().branches.renew(projectId, branchProjectId, {
      ...(ttlDays !== undefined ? { ttlDays } : {}),
    });
    console.log(JSON.stringify({ ok: true, branch }, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function deleteBranch(args) {
  const { projectId, branchProjectId } = resolveProjectAndBranch(args, "run402 branches delete [project-id] <branch-project-id>");
  try {
    await getSdk().branches.delete(projectId, branchProjectId);
    console.log(JSON.stringify({ ok: true, project_id: projectId, branch_project_id: branchProjectId, deleted: true }, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

function resolveProjectAndBranch(args, usage) {
  // Canonical: `<branch-project-id> [--project <parent-id>]`. Branch ids are
  // themselves prj_..., so a leading prj_ positional is only treated as the
  // PARENT project when a second positional follows (requireRestPositional) —
  // the legacy `renew prj_parent prj_branch` form.
  const { projectId, rest } = resolveProjectSelector(args, { valueFlags: FLAG_VALUES, requireRestPositional: true });
  const pos = positionalArgs(rest, FLAG_VALUES);
  if (pos.length !== 1) fail({ code: "BAD_USAGE", message: `Usage: ${usage}` });
  return { projectId, branchProjectId: pos[0] };
}
