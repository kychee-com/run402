/**
 * `run402 claims` — advisory work claims for agent coordination.
 *
 * Gateway subsystem: add-agent-messaging (/orgs/v1/:org_id/rooms/:room_key/claims).
 * A claim declares "I'm working on X until T" so concurrent agents discover
 * collisions BEFORE they happen. Claims are ADVISORY: creating a conflicting
 * claim succeeds and reports the complete conflict set — nothing, ever, is
 * blocked by a claim (deploys included). JSON to stdout (pipe contract).
 */
import { getSdk } from "./sdk.mjs";
import { reportSdkError } from "./sdk-errors.mjs";
import {
  normalizeArgv,
  hasHelp,
  assertKnownFlags,
  assertAllowedValue,
  parseIntegerFlag,
  flagValue,
  positionalArgs,
  requirePositionalCount,
  failUnknownSubcommand,
} from "./argparse.mjs";
import { resolveRoom, withPresenceRetry } from "./rooms-context.mjs";

export const MODES = ["exclusive", "shared"];

const ROOM_FLAGS = ["--project", "--org", "--room"];

const HELP = `run402 claims — say what you're working on before you collide

Usage:
  run402 claims create <resource> [--mode exclusive|shared] [--ttl <seconds>]
  run402 claims list [--all]
  run402 claims release <claim_id>

Resources (namespaced; conflicts never cross namespaces):
  repo:<glob>        Repo paths — repo:src/auth/** (glob overlap detection)
  function:<name>    A deployed function by name
  table:<name>       A database table
  deploy             The deploy itself (a soft mutex by convention)
  <free-form>        Anything else (exact-match overlap)

Advisory, always:
  Creating a conflicting claim SUCCEEDS — the response carries the complete
  conflicts[] (holder, resource, mode, expiry) and the deploy-path responses
  surface other agents' claims automatically. A claim never blocks anything;
  it makes collisions visible before they happen. Claims auto-expire (default
  1h, max 24h) so a dead session cannot wedge the room; <=32 active per
  presence.

Room addressing:
  Default room of the active project with no flags; --project <id> for another
  project; --org <org_id> --room <key> (or RUN402_ROOM=<org_id>/<key>) for a
  named org room.

Options:
  --mode <m>        exclusive (default) — one worker; shared — parallel-safe.
  --ttl <seconds>   Claim lifetime (default 3600, max 86400).
  --note <text>     Why you're claiming it (shown to everyone).
  --all             list: include released/expired history.

Tip: claim before you edit, release when you hand off — and put the handoff
     in \`run402 rooms send\` so the room's timeline tells the story.

Examples:
  run402 claims create repo:src/auth/** --note "migrating to passkeys"
  run402 claims create deploy --ttl 900
  run402 claims list
  run402 claims release clm_1a
`;

async function create(args) {
  const a = normalizeArgv(args);
  const valueFlags = [...ROOM_FLAGS, "--mode", "--ttl", "--note"];
  assertKnownFlags(a, [...valueFlags, "--help", "-h"], valueFlags);
  const positionals = positionalArgs(a, valueFlags);
  requirePositionalCount(positionals, valueFlags, {
    min: 1, max: 1, command: "run402 claims create <resource>", missing: "<resource>",
  });
  const mode = flagValue(a, "--mode") ?? "exclusive";
  assertAllowedValue(mode, MODES, "--mode");
  const ttl = flagValue(a, "--ttl");
  const room = await resolveRoom({
    org: flagValue(a, "--org"), room: flagValue(a, "--room"), project: flagValue(a, "--project"),
  });
  try {
    const created = await withPresenceRetry(room.orgId, room.roomKey, (presenceId) =>
      getSdk().rooms.createClaim(room.orgId, room.roomKey, {
        resource: positionals[0],
        mode,
        ttlSeconds: ttl != null ? parseIntegerFlag("--ttl", ttl, { min: 1, max: 86400 }) : undefined,
        note: flagValue(a, "--note") ?? undefined,
        presenceId: presenceId ?? undefined,
      }));
    console.log(JSON.stringify(created, null, 2));
    const conflicts = Array.isArray(created.conflicts) ? created.conflicts : [];
    if (conflicts.length > 0) {
      console.error(`Granted with ${conflicts.length} conflict(s) — advisory, nothing is blocked. Coordinate via run402 rooms send.`);
    }
  } catch (err) {
    reportSdkError(err);
  }
}

async function list(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, [...ROOM_FLAGS, "--all", "--help", "-h"], ROOM_FLAGS);
  requirePositionalCount(positionalArgs(a, ROOM_FLAGS), ROOM_FLAGS, {
    min: 0, max: 0, command: "run402 claims list", missing: "",
  });
  const room = await resolveRoom({
    org: flagValue(a, "--org"), room: flagValue(a, "--room"), project: flagValue(a, "--project"),
  });
  try {
    const page = await getSdk().rooms.listClaims(room.orgId, room.roomKey, {
      includeInactive: a.includes("--all"),
    });
    console.log(JSON.stringify(page, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function release(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, [...ROOM_FLAGS, "--help", "-h"], ROOM_FLAGS);
  const positionals = positionalArgs(a, ROOM_FLAGS);
  requirePositionalCount(positionals, ROOM_FLAGS, {
    min: 1, max: 1, command: "run402 claims release <claim_id>", missing: "<claim_id>",
  });
  const room = await resolveRoom({
    org: flagValue(a, "--org"), room: flagValue(a, "--room"), project: flagValue(a, "--project"),
  });
  try {
    console.log(JSON.stringify(await getSdk().rooms.releaseClaim(room.orgId, room.roomKey, positionals[0]), null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

export async function run(sub, args) {
  const argv = Array.isArray(args) ? args : [];
  if (!sub || hasHelp([sub, ...argv])) {
    console.log(HELP);
    process.exit(0);
  }
  switch (sub) {
    case "create": {
      await create(argv);
      break;
    }
    case "list": {
      await list(argv);
      break;
    }
    case "release": {
      await release(argv);
      break;
    }
    default:
      failUnknownSubcommand("claims", sub, {
        hint: "Run `run402 claims --help` for usage.",
      });
  }
}
