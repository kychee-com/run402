/**
 * `run402 approve --action <capability> (--org <org_id> | --project <project_id>)`
 * — mint a passkey-signed write approval scoped to one (action, target) so a
 * person signed in without a wallet can provision, deploy, or write secrets.
 * See sign-in.mjs.
 */

import { fail } from "./sdk-errors.mjs";
import { normalizeArgv, hasHelp, assertKnownFlags, flagValue, positionalArgs } from "./argparse.mjs";
import { APPROVAL_ACTIONS, mintApproval } from "./sign-in.mjs";

const HELP = `run402 approve — mint a write approval for one action on one target

Usage:
  run402 approve --action <capability> (--org <org_id> | --project <project_id>) [--no-open]

A person signed in with 'run402 login' (no wallet) needs a write approval to
provision a project, deploy, or write secrets. It is signed with your passkey,
covers one action on one org or project, lasts 30 minutes idle (4 hours at
most), and dies with the sign-in session. It never counts as a step-up.
From an interactive terminal the CLI opens this ceremony for you when a write
needs it; agents and CI relay the command instead.

Actions:
  org.project.create     --org <org_id>
  project.deploy         --project <project_id>
  project.secret.write   --project <project_id>

Options:
  --no-open  Do not open the browser; print the URL only.

Notes:
  - Requires 'run402 login' (a device-grade session cannot approve).
  - 'run402 whoami' lists the approvals cached on this machine.
`;

export async function run(args = []) {
  args = normalizeArgv(args);
  if (hasHelp(args)) {
    console.log(HELP);
    process.exit(0);
  }
  const valueFlags = ["--action", "--org", "--project"];
  assertKnownFlags(args, ["--help", "-h", "--no-open", ...valueFlags], valueFlags);
  const extra = positionalArgs(args, valueFlags);
  if (extra.length > 0) {
    fail({ code: "BAD_USAGE", message: `Unexpected argument for approve: ${extra[0]}`, hint: "Use `run402 approve --action <capability> (--org <org_id> | --project <project_id>)`." });
  }
  const action = flagValue(args, "--action");
  const org = flagValue(args, "--org");
  const project = flagValue(args, "--project");

  if (!action || !APPROVAL_ACTIONS[action]) {
    fail({
      code: "BAD_FLAG",
      message: `--action must be one of: ${Object.keys(APPROVAL_ACTIONS).join(", ")}`,
      details: { flag: "--action", value: action, allowed: Object.keys(APPROVAL_ACTIONS) },
    });
  }
  const scope = APPROVAL_ACTIONS[action];
  if (scope === "org" && !org) fail({ code: "BAD_FLAG", message: `--org <org_id> is required for --action ${action}` });
  if (scope === "project" && !project) fail({ code: "BAD_FLAG", message: `--project <project_id> is required for --action ${action}` });
  if (scope === "org" && project) fail({ code: "BAD_FLAG", message: `--project is not valid for org-scoped --action ${action}; use --org` });
  if (scope === "project" && org) fail({ code: "BAD_FLAG", message: `--org is not valid for project-scoped --action ${action}; use --project` });

  const approval = await mintApproval({
    action,
    orgId: org ?? undefined,
    projectId: project ?? undefined,
    noOpen: args.includes("--no-open"),
  });
  console.log(
    JSON.stringify({
      approved: true,
      action,
      ...(org ? { org_id: org } : {}),
      ...(project ? { project_id: project } : {}),
      expires_at: new Date(approval.expires_at).toISOString(),
    }),
  );
}
