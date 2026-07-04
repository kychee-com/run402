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

const HELP = `run402 branches — Contained project data branches

Usage:
  run402 branches create [project-id] [--from-snapshot <snapshot-id>] [--name <label>] [--email-mode sandbox|off] [--enable-cron] [--ttl-days <n>] [--json]
  run402 branches list [project-id] [--json]
  run402 branches renew [project-id] <branch-project-id> [--ttl-days <n>] [--json]
  run402 branches delete [project-id] <branch-project-id> [--json]
`;

const FLAG_VALUES = ["--from-snapshot", "--name", "--email-mode", "--ttl-days"];
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
      fail({
        code: "UNKNOWN_SUBCOMMAND",
        message: `Unknown branches subcommand: ${sub}`,
        hint: "Run `run402 branches --help` for usage.",
        details: { command: "branches", subcommand: sub },
      });
  }
}

async function create(args) {
  const projectId = resolveOptionalProject(positionalArgs(args, FLAG_VALUES)[0]);
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
  const projectId = resolveOptionalProject(positionalArgs(args, FLAG_VALUES)[0]);
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

function resolveOptionalProject(value) {
  if (value && String(value).startsWith("prj_")) return value;
  return resolveProjectId(null);
}

function resolveProjectAndBranch(args, usage) {
  const pos = positionalArgs(args, FLAG_VALUES);
  if (pos.length === 1) return { projectId: resolveProjectId(null), branchProjectId: pos[0] };
  if (pos.length === 2 && pos[0].startsWith("prj_")) return { projectId: pos[0], branchProjectId: pos[1] };
  fail({ code: "BAD_USAGE", message: `Usage: ${usage}` });
}
