import { getSdk } from "./sdk.mjs";
import { reportSdkError, fail } from "./sdk-errors.mjs";
import { assertKnownFlags, hasHelp, normalizeArgv } from "./argparse.mjs";

const HELP = `run402 admin — Platform-admin operations (v1.57+)

Usage:
  run402 admin <subcommand> [args...]

Subcommands:
  lease-perpetual <org_id> (--enable | --disable)
                                         Toggle the organization-level escape hatch.
                                         When enabled, the organization never advances
                                         past 'active' regardless of lease expiry.
                                         If the account is currently in a grace
                                         state, enabling reactivates it inline
                                         (\`reactivated: true\` in the response).
                                         Replaces the v1.56 per-project pin.

  archive <project_id> [--reason "..."]  Moderate-archive a single project. Sets
                                         projects.archived_at = NOW(). Independent
                                         of organization lifecycle; the rest of the
                                         organization's projects keep serving.

  reactivate <project_id>                Un-archive a project (flips archived_at
                                         back to NULL). In v1.57 this no longer
                                         touches organization-level lifecycle — to
                                         reactivate a grace-state account, use
                                         \`tier set <tier>\` or enable
                                         lease-perpetual above.

Notes:
  - All admin subcommands require platform-admin auth — the configured allowance
    wallet must be a platform admin, or an admin OAuth session cookie must be
    available. Regular project owners cannot run these.
  - Output is JSON.

Examples:
  run402 admin lease-perpetual org_abc123 --enable
  run402 admin lease-perpetual org_abc123 --disable
  run402 admin archive prj_abuse --reason "ToS violation"
  run402 admin reactivate prj_abuse
`;

const SUB_HELP = {
  "lease-perpetual": `run402 admin lease-perpetual — Toggle the organization-level escape hatch

Usage:
  run402 admin lease-perpetual <org_id> (--enable | --disable)

Options:
  --enable    Set lease_perpetual = true (pins every project on the account)
  --disable   Set lease_perpetual = false (resumes normal lifecycle advancement)

Notes:
  - Replaces the v1.56 per-project \`projects pin\` command (gateway endpoint
    /projects/v1/admin/:id/pin was removed in v1.57).
  - When --enable lands on a grace-state account (past_due / frozen / dormant),
    the gateway reactivates inline and reports \`reactivated: true\`.

Examples:
  run402 admin lease-perpetual org_abc123 --enable
  run402 admin lease-perpetual org_abc123 --disable
`,
  archive: `run402 admin archive — Moderate-archive a single project

Usage:
  run402 admin archive <project_id> [--reason "..."]

Options:
  --reason <text>    Free-text moderation reason recorded in the audit log.

Notes:
  - Sets projects.archived_at = NOW(). Independent of organization-level lifecycle —
    only this project goes dark; siblings on the same organization keep
    serving.
  - No-op when the project is already archived (returns \`note: "already
    archived"\` without changing archived_at).

Examples:
  run402 admin archive prj_abuse --reason "ToS violation"
  run402 admin archive prj_abuse
`,
  reactivate: `run402 admin reactivate — Un-archive a project

Usage:
  run402 admin reactivate <project_id>

Notes:
  - Flips projects.archived_at back to NULL. In v1.57 this was narrowed:
    organization-level lifecycle reactivation is NOT triggered. Use
    \`run402 tier set <tier>\` (the tier flow runs the lifecycle advance) or
    \`run402 admin lease-perpetual <org_id> --enable\` for that.
  - No-op when the project is not archived (returns \`note: "not archived"\`).

Examples:
  run402 admin reactivate prj_abuse
`,
};

const FLAGS_BY_SUB = {
  "lease-perpetual": { known: ["--enable", "--disable"], values: [] },
  archive: { known: ["--reason"], values: ["--reason"] },
  reactivate: { known: [], values: [] },
};

function validateFlags(sub, args) {
  const spec = FLAGS_BY_SUB[sub] ?? { known: [], values: [] };
  assertKnownFlags(args, [...spec.known, "--help", "-h"], spec.values);
}

async function leasePerpetual(args) {
  const organizationId = args.find((a) => typeof a === "string" && !a.startsWith("--"));
  const enable = args.includes("--enable");
  const disable = args.includes("--disable");
  if (!organizationId) {
    fail({
      code: "BAD_USAGE",
      message: "Missing <org_id>.",
      hint: "run402 admin lease-perpetual <org_id> --enable | --disable",
    });
  }
  if (enable === disable) {
    fail({
      code: "BAD_USAGE",
      message: "Pass exactly one of --enable / --disable.",
      hint: "run402 admin lease-perpetual <org_id> --enable | --disable",
    });
  }
  try {
    const data = await getSdk().admin.setLeasePerpetual(organizationId, enable);
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function archive(args) {
  const projectId = args.find((a) => typeof a === "string" && !a.startsWith("--"));
  if (!projectId) {
    fail({
      code: "BAD_USAGE",
      message: "Missing <project_id>.",
      hint: "run402 admin archive <project_id> [--reason \"...\"]",
    });
  }
  let reason;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--reason" && args[i + 1] !== undefined) {
      reason = args[++i];
    }
  }
  try {
    const data = await getSdk().admin.archiveProject(projectId, reason !== undefined ? { reason } : {});
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function reactivate(args) {
  const projectId = args.find((a) => typeof a === "string" && !a.startsWith("--"));
  if (!projectId) {
    fail({
      code: "BAD_USAGE",
      message: "Missing <project_id>.",
      hint: "run402 admin reactivate <project_id>",
    });
  }
  try {
    const data = await getSdk().admin.reactivateProject(projectId);
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

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
  validateFlags(sub, args);
  switch (sub) {
    case "lease-perpetual": await leasePerpetual(args); break;
    case "archive":         await archive(args); break;
    case "reactivate":      await reactivate(args); break;
    default:
      console.error(`Unknown subcommand: ${sub}\n`);
      console.log(HELP);
      process.exit(1);
  }
}
