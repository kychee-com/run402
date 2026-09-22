import { getSdk } from "./sdk.mjs";
import { reportSdkError, parseFlagJson, fail } from "./sdk-errors.mjs";
import {
  normalizeArgv,
  assertKnownFlags,
  flagValue,
  requirePositionalCount,
  resolveProjectSelector,
  failUnknownSubcommand,
} from "./argparse.mjs";

const HELP = `run402 grants — per-project capability grants and their grant keys

Usage:
  run402 grants <subcommand> [args...]

Subcommands:
  create <wallet> --capability <cap> [--project <project_id>] [--policy <json>] [--expires-at <iso8601>]
         [--key [--kind <kind>] [--scope <json>] [--spend-cap <json>]]
                                 Issue a grant; with --key also mint its first
                                 grant key (the token is printed ONCE)
  list [--project <project_id>]  List grants with their keys nested (never tokens)
  revoke <grant_id> [--project <project_id>]
                                 Revoke a grant and every key minted against it
  revoke-key <key_id> [--project <project_id>]
                                 Revoke one grant key; the grant stays
  rotate-key <key_id> [--project <project_id>]
                                 Replace a lost key; the new token is printed ONCE

Notes:
  - A grant is the permission row: this wallet may do this capability on this
    project until this date. An agent with its own wallet needs only the grant.
  - A grant key is a credential minted against exactly one grant: narrower than
    it, spend-capped, expiring, revocable on its own, never an owner. Hand it to
    an agent without a wallet: RUN402_GRANT_KEY=<token> run402 deploy ...
  - Every subcommand requires owner of the project's org. Minting a key with a
    sign-in session takes a fresh step-up.
  - The key token is shown ONCE and cannot be read back. Store it immediately;
    if you lose it, 'rotate-key' issues a new one.
  - capability examples: deploy, functions:write.
  - JSON in, JSON out.

Examples:
  run402 grants create 0xf39Fd6...92266 --capability deploy --project prj_abc
  run402 grants create 0x90F3eB...F80a --capability deploy --key --project prj_abc
  run402 grants list --project prj_abc
  run402 grants revoke-key 5845f17b-... --project prj_abc
  run402 grants revoke 1d86452e-... --project prj_abc
`;

const SUB_HELP = {
  create: `run402 grants create — issue a per-project capability grant, optionally with a grant key

Usage:
  run402 grants create <wallet> --capability <cap> [--project <project_id>] [--policy <json>] [--expires-at <iso8601>]
                       [--key [--kind <kind>] [--scope <json>] [--spend-cap <json>]]

Arguments:
  <wallet>              EVM address or named wallet the grant is issued to

Options:
  --project <project_id>  Project to grant access to (defaults to the active project)
  --capability <cap>      e.g. deploy, functions:write
  --policy <json>         Capability-scoping policy object (gateway-interpreted)
  --expires-at <iso8601>  Expiry; omit for a non-expiring grant. With --key the
                          key takes the same expiry.
  --key                   Also mint the grant's first grant key in the same
                          transaction. Its token is printed ONCE.
  --kind <kind>           Key kind (with --key). Default run402_agent_key, the
                          only kind that returns a bearer token.
  --scope <json>          Key scope (with --key), e.g. {"v":1,"capabilities":["deploy"]}.
                          Defaults to the grant's own capability; never wider.
  --spend-cap <json>      Key spend cap (with --key), e.g.
                          {"v":1,"currency":"usd_micros","per_period":5000000,"period":"month"}

Requires you to be an owner of the project's org.
`,
  list: `run402 grants list — list a project's grants with their grant keys

Usage:
  run402 grants list [--project <project_id>]

Each grant carries its keys under "keys" (kind, scope, spend cap, expiry,
revocation). Never returns a token or secret material.
`,
  revoke: `run402 grants revoke — revoke a per-project capability grant

Usage:
  run402 grants revoke <grant_id> [--project <project_id>]

Revokes the grant and every grant key minted against it. Requires you to be an
owner of the project's org.
`,
  "revoke-key": `run402 grants revoke-key — revoke one grant key

Usage:
  run402 grants revoke-key <key_id> [--project <project_id>]

Takes effect for every subsequent request. The grant and its other keys stay.
Requires you to be an owner of the project's org.
`,
  "rotate-key": `run402 grants rotate-key — replace a grant key

Usage:
  run402 grants rotate-key <key_id> [--project <project_id>]

Revokes the key and mints a fresh one against the same grant with the same
kind, scope, spend cap and expiry. The NEW token is printed once. Use this when
a token is lost or possibly exposed.
`,
};

const CREATE_VALUE_FLAGS = ["--project", "--capability", "--policy", "--expires-at", "--kind", "--scope", "--spend-cap"];
const KEY_ONLY_FLAGS = ["--kind", "--scope", "--spend-cap"];

function warnTokenOnce(key) {
  if (!key?.token) return;
  console.error("");
  console.error("The grant key token above is shown ONCE and cannot be read back.");
  console.error("Store it now, then use it as: RUN402_GRANT_KEY=<token>");
}

async function create(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, [...CREATE_VALUE_FLAGS, "--key", "--help", "-h"], CREATE_VALUE_FLAGS);
  const policyRaw = flagValue(a, "--policy");
  const expiresAt = flagValue(a, "--expires-at") || undefined;
  const capability = flagValue(a, "--capability");
  const wantsKey = a.includes("--key");
  const kind = flagValue(a, "--kind") || undefined;
  const scopeRaw = flagValue(a, "--scope");
  const spendCapRaw = flagValue(a, "--spend-cap");
  const { projectId, rest } = resolveProjectSelector(a, { valueFlags: CREATE_VALUE_FLAGS });
  const [wallet] = requirePositionalCount(rest, CREATE_VALUE_FLAGS, {
    min: 1,
    max: 1,
    command: "run402 grants create <wallet> --capability <cap> [--project <project_id>] [--key]",
    missing: "Missing <wallet>.",
  });
  if (!capability) {
    fail({
      code: "BAD_USAGE",
      message: "Missing --capability <cap>.",
      hint: "run402 grants create <wallet> --capability deploy [--project <project_id>]",
    });
  }
  if (!wantsKey) {
    const stray = KEY_ONLY_FLAGS.filter((f) => a.includes(f));
    if (stray.length > 0) {
      fail({
        code: "BAD_USAGE",
        message: `${stray.join(", ")} describe a grant key; add --key to mint one.`,
        hint: "run402 grants create <wallet> --capability <cap> --key [--kind <kind>] [--scope <json>] [--spend-cap <json>]",
      });
    }
  }
  const policy = policyRaw != null ? parseFlagJson("--policy", policyRaw) : undefined;
  let key;
  if (wantsKey) {
    key = {};
    if (kind) key.kind = kind;
    if (scopeRaw != null) key.scope = parseFlagJson("--scope", scopeRaw);
    if (spendCapRaw != null) key.spendCap = parseFlagJson("--spend-cap", spendCapRaw);
    if (expiresAt) key.expiresAt = expiresAt;
  }
  try {
    const res = await getSdk().grants.create(projectId, {
      wallet,
      capability,
      policy,
      expiresAt,
      key,
    });
    console.log(JSON.stringify(res, null, 2));
    warnTokenOnce(res?.key);
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
    command: "run402 grants list [--project <project_id>]",
    missing: "",
  });
  try {
    console.log(JSON.stringify(await getSdk().grants.list(projectId), null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

function oneIdCommand({ verb, idName, method }) {
  return async (args) => {
    const a = normalizeArgv(args);
    assertKnownFlags(a, ["--project", "--help", "-h"], ["--project"]);
    const { projectId, rest } = resolveProjectSelector(a, { valueFlags: ["--project"] });
    const [id] = requirePositionalCount(rest, ["--project"], {
      min: 1,
      max: 1,
      command: `run402 grants ${verb} <${idName}> [--project <project_id>]`,
      missing: `Missing <${idName}>.`,
    });
    try {
      const res = await getSdk().grants[method](projectId, id);
      console.log(JSON.stringify(res, null, 2));
      warnTokenOnce(res?.key);
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
    case "revoke": await oneIdCommand({ verb: "revoke", idName: "grant_id", method: "revoke" })(args); break;
    case "revoke-key": await oneIdCommand({ verb: "revoke-key", idName: "key_id", method: "revokeKey" })(args); break;
    case "rotate-key": await oneIdCommand({ verb: "rotate-key", idName: "key_id", method: "rotateKey" })(args); break;
    default:
      failUnknownSubcommand("grants", sub);
  }
}
