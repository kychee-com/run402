import { getSdk } from "./sdk.mjs";
import { reportSdkError, parseFlagJson } from "./sdk-errors.mjs";
import {
  normalizeArgv,
  assertKnownFlags,
  flagValue,
  requirePositionalCount,
  resolveProjectSelector,
  failUnknownSubcommand,
} from "./argparse.mjs";

const HELP = `run402 delegates — scoped deploy credentials an owner mints for an agent

Usage:
  run402 delegates <subcommand> [args...]

Subcommands:
  create --grant <grant_id> [--project <id>] [--capability <cap>] [--kind <kind>]
         [--scope <json>] [--expires <iso8601>]
                                 Mint a delegate. The bearer is printed ONCE.
  list [--project <id>]          List delegates (never shows tokens)
  revoke <delegate_id> [--project <id>]
                                 Revoke immediately
  rotate <delegate_id> [--project <id>]
                                 Revoke + reissue; new bearer printed ONCE

Notes:
  - A delegate NARROWS an existing grant, so mint the grant first:
      run402 grants create <agent-wallet> --capability deploy --project <id>
    then pass the returned grant_id to 'delegates create'.
  - Mutations require you to be an owner of the project's org (wallet SIWX).
  - A delegate can never be an owner, and is revocable and expiring.
  - The token is shown ONCE and is not recoverable. Store it immediately;
    if you lose it, 'rotate' issues a new one.
  - Use it with: RUN402_DELEGATE_TOKEN=<token> run402 deploy apply ...
  - JSON in, JSON out.

Why this exists:
  Project API keys are issued once at project-create and are never re-issued.
  An agent that loses local state therefore cannot deploy to its own project.
  You still hold the wallet, so SIWX is enough to mint a fresh credential.

Examples:
  run402 grants create 0x90F3eB...F80a --capability deploy --project prj_abc
  run402 delegates create --grant 1d86452e-... --project prj_abc
  run402 delegates list --project prj_abc
  run402 delegates revoke 5845f17b-... --project prj_abc
`;

const SUB_HELP = {
  create: `run402 delegates create — mint a scoped deploy credential

Usage:
  run402 delegates create --grant <grant_id> [--project <id>] [--capability <cap>]
                          [--kind <kind>] [--scope <json>] [--expires <iso8601>]

--capability defaults to "deploy". --kind defaults to "run402_agent_key" (the
only kind that returns a bearer). --scope, if given, overrides --capability and
must be a JSON object like {"v":1,"capabilities":["deploy"]}.

The bearer is printed ONCE and cannot be read back. Store it immediately.
Requires owner of the project's org.
`,
  list: `run402 delegates list — list a project's delegates

Usage:
  run402 delegates list [--project <id>]

Never returns tokens or secret material — id, kind, scope, expiry, revocation.
`,
  revoke: `run402 delegates revoke — revoke a delegate immediately

Usage:
  run402 delegates revoke <delegate_id> [--project <id>]

Takes effect for every subsequent request. Requires owner of the project's org.
`,
  rotate: `run402 delegates rotate — revoke and reissue in one step

Usage:
  run402 delegates rotate <delegate_id> [--project <id>]

Keeps the same principal, grant, kind, scope, cap and expiry. The NEW bearer is
printed once. Use this when a token is lost or possibly exposed.
`,
};

const CREATE_VALUE_FLAGS = ["--project", "--grant", "--capability", "--kind", "--scope", "--expires"];

async function create(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, [...CREATE_VALUE_FLAGS, "--help", "-h"], CREATE_VALUE_FLAGS);
  const grantId = flagValue(a, "--grant");
  const capability = flagValue(a, "--capability") || "deploy";
  const kind = flagValue(a, "--kind") || undefined;
  const scopeRaw = flagValue(a, "--scope");
  const expiresAt = flagValue(a, "--expires");
  const { projectId, rest } = resolveProjectSelector(a, { valueFlags: CREATE_VALUE_FLAGS });
  requirePositionalCount(rest, CREATE_VALUE_FLAGS, {
    min: 0,
    max: 0,
    command: "run402 delegates create --grant <grant_id> [--project <id>]",
    missing: "",
  });
  if (!grantId) {
    console.error("Missing --grant <grant_id>. Mint one first:");
    console.error("  run402 grants create <agent-wallet> --capability deploy --project <id>");
    process.exit(1);
  }
  const scope = scopeRaw != null
    ? parseFlagJson("--scope", scopeRaw)
    : { v: 1, capabilities: [capability], projects: [projectId] };
  try {
    const res = await getSdk().delegates.create(projectId, {
      grantId,
      kind,
      scope,
      expiresAt: expiresAt || undefined,
    });
    console.log(JSON.stringify(res, null, 2));
    if (res?.token) {
      console.error("");
      console.error("The token above is shown ONCE and cannot be read back.");
      console.error("Store it now, then use it as: RUN402_DELEGATE_TOKEN=<token>");
    }
  } catch (err) {
    reportSdkError(err);
  }
}

async function list(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, ["--project", "--help", "-h"], ["--project"]);
  const { projectId, rest } = resolveProjectSelector(a, { valueFlags: ["--project"] });
  requirePositionalCount(rest, ["--project"], {
    min: 0,
    max: 0,
    command: "run402 delegates list [--project <id>]",
    missing: "",
  });
  try {
    console.log(JSON.stringify(await getSdk().delegates.list(projectId), null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

function oneIdCommand(name) {
  return async (args) => {
    const a = normalizeArgv(args);
    assertKnownFlags(a, ["--project", "--help", "-h"], ["--project"]);
    const { projectId, rest } = resolveProjectSelector(a, { valueFlags: ["--project"] });
    const [delegateId] = requirePositionalCount(rest, ["--project"], {
      min: 1,
      max: 1,
      command: `run402 delegates ${name} <delegate_id> [--project <id>]`,
      missing: "Missing <delegate_id>.",
    });
    try {
      const res = await getSdk().delegates[name](projectId, delegateId);
      console.log(JSON.stringify(res, null, 2));
      if (res?.token) {
        console.error("");
        console.error("The token above is shown ONCE and cannot be read back.");
      }
    } catch (err) {
      reportSdkError(err);
    }
  };
}

export async function run(sub, args) {
  if (!sub || sub === "--help" || sub === "-h") {
    console.log(HELP);
    process.exit(0);
  }
  if (Array.isArray(args) && (args.includes("--help") || args.includes("-h"))) {
    console.log(SUB_HELP[sub] || HELP);
    process.exit(0);
  }
  switch (sub) {
    case "create": await create(args); break;
    case "list": await list(args); break;
    case "revoke": await oneIdCommand("revoke")(args); break;
    case "rotate": await oneIdCommand("rotate")(args); break;
    default:
      failUnknownSubcommand("delegates", sub);
  }
}
