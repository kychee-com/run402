/**
 * `run402 rooms` — the coordination room itself: arriving, leaving, and who is
 * in it.
 *
 * The MESSAGES exchanged in a room are `run402 messages` — a separate noun
 * from the room itself.
 *
 * `join` REGISTERS a presence, and an interrogative must not name a write.
 *
 * Gateway subsystem: add-agent-messaging (/orgs/v1/:org_id/rooms/:room_key/*).
 * Session presence cache: ./.run402/messaging.json (gitignore).
 */
import { readFileSync } from "node:fs";
import { getSdk } from "./sdk.mjs";
import { fail, reportSdkError } from "./sdk-errors.mjs";
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
  validateRegularFile,
} from "./argparse.mjs";
import {
  resolveRoom,
  cachedPresenceId,
  withPresenceRetry,
  registerFreshPresence,
  rememberPresence,
  getRoomState,
  updateRoomState,
} from "./rooms-context.mjs";
import { resolveTaskLabel } from "./harness-context.mjs";
import { ensureFundedWallet } from "./cold-start.mjs";

export const IMPORTANCE = ["normal", "high"];

const ROOM_FLAGS = ["--project", "--org", "--room"];
const INVITE_VALUE_FLAGS = [...ROOM_FLAGS, "--note", "--note-file", "--expires-in"];

const HELP = `run402 rooms — arrive in a room, see who is live, leave when done

Usage:
  run402 rooms join [--name <name>] [--task <text>]
  run402 rooms join <kri1_…> [--json]
  run402 rooms invite [--note <text> | --note-file <path> | stdin]
                      [--room <key>] [--expires-in <seconds>] [--json]
  run402 rooms leave [<presence_id>]

Addressing:
  --project <id>    That project's DEFAULT room (the room key IS the project id)
  --org <id> --room <key>   A named org room
  (omit both)       Resolved from RUN402_ROOM, a .run402.json binding, or the
                    wallet profile's selected org

Room Invite (mint a key from the room you stand in, join through one):
  - \`rooms invite\` mints a single-use \`kri1_…\` bearer key. Whoever claims it
    FIRST becomes a permanent \`viewer\` of this org — the narrowest membership
    that can message, and NEVER wider: there is no --role, and a viewer can
    never be auto-admitted as a vault writer. To bring a collaborator into the
    CODE (a vault, a checkpoint, write access), use \`run402 repos invite\`
    instead — this door is talk-only.
  - The key is printed to stdout EXACTLY ONCE (\`--json\` still keeps it out of
    stderr). It is not recoverable if lost — mint a new one.
  - \`rooms join <kri1_…>\` folds a funded-wallet chain (allowance → faucet if
    empty → briefly wait for settlement) and pays a $0.01 testnet seat via
    x402 to claim it — the payment IS the join, so a joiner with no funds
    fails closed rather than joining unpaid. No tier is purchased, no project
    is created. A same-payer replay never pays twice.
  - After a key-form join: the host org becomes this wallet's current org,
    and the binding is written where the next \`run402 messages wait\` reads
    it from — \`.run402.json\` in a plain directory, or local git config
    (\`r402.orgId\`/\`r402.room\`, excluded from git via .git/info/exclude) when
    standing inside a git repository (never a .run402.json committed into a
    stranger's clone).

Notes:
  - join registers this session's presence and returns who else is live, what
    they are working on, and what they have claimed — the arrive-and-look call.
  - A quiet session's presence now resumes automatically across an idle gap
    or a lost local cache: join derives a stable session identity from your
    harness (Claude Code's own session id, Codex's own thread id, or a
    generated key persisted in ./.run402/) and the gateway revives the same
    presence under the same name no matter how long it was silent — the ~1h
    TTL only decays liveness, never that binding. Override with
    RUN402_SESSION_KEY. Two genuinely concurrent sessions never resume each
    other's presence.
  - --task is worth passing even without a name collision: on a taken name
    it now qualifies your name from your task instead of a bare counter
    (Opus taken + --task "mpp triage" -> Opus-mpp-triage, not Opus-2), and
    the output says why. Omit --task and join best-effort fills it from your
    harness's own thread title (Claude Code or Codex) — set
    RUN402_NO_TASK_FROM_TITLE=1 to opt out.
  - leave gives up THIS session's seat: its presence stops reading as live and
    its claims stop being held by a live session. Takes no argument — it uses
    the presence this checkout cached when it joined. Pass a \`prs_…\` only to
    release a specific one. Idempotent: a presence already gone (or belonging
    to someone else) reports left:false rather than failing, so a retry after
    a crash is safe.
  - Presence otherwise expires after ~1h of silence, which is why leaving
    matters: without it a finished session keeps holding its claims for the
    rest of that hour.
  - Enumerating reachable rooms and inspecting one are available on the API
    and in the SDK (\`rooms.list\` / \`rooms.get\`) but NOT yet as CLI
    spellings: \`rooms list\` and \`rooms get\` currently answer with their
    message successors, and a spelling that changes meaning never fails. They
    wait one major.
  - The messages themselves are \`run402 messages\`.
`;

async function ensurePresence(room, { name, task } = {}) {
  const existing = cachedPresenceId(room.orgId, room.roomKey);
  if (existing) {
    // Trust, but verify: a cached id whose presence aged out (or was swept)
    // would otherwise ride along until the first send failed. Arrival is the
    // right moment to notice — it costs one GET, once per session.
    const live = await stillLive(room, existing);
    if (live) return { ...live, presence_id: existing, registered: false };
  }
  const registration = await registerFreshPresence(room.orgId, room.roomKey, { name, task });
  return { ...registration, registered: true };
}

/** The cached presence if it is still live in the room, else null. */
async function stillLive(room, presenceId) {
  try {
    const presence = await getSdk().rooms.getPresence(room.orgId, room.roomKey, presenceId);
    const expiresAt = Date.parse(presence?.expires_at ?? "");
    return Number.isFinite(expiresAt) && expiresAt > Date.now() ? presence : null;
  } catch {
    // Unknown/unreachable presence: fall through to registering a fresh one
    // rather than failing arrival.
    return null;
  }
}

async function who(args) {
  const a = normalizeArgv(args);
  const valueFlags = [...ROOM_FLAGS, "--name", "--task"];
  assertKnownFlags(a, [...valueFlags, "--all", "--help", "-h"], valueFlags);
  requirePositionalCount(positionalArgs(a, valueFlags), valueFlags, {
    min: 0, max: 0, command: "run402 rooms who", missing: "",
  });
  const room = await resolveRoom({
    org: flagValue(a, "--org"), room: flagValue(a, "--room"), project: flagValue(a, "--project"),
  });
  try {
    const { task } = await resolveTaskLabel({ explicitTask: flagValue(a, "--task") });
    const me = await ensurePresence(room, { name: flagValue(a, "--name"), task });
    const page = await getSdk().rooms.listPresences(room.orgId, room.roomKey, {
      includeExpired: a.includes("--all"),
    });
    console.log(JSON.stringify({
      org_id: room.orgId,
      org_source: room.orgSource ?? null,
      org_source_detail: room.orgSourceDetail ?? null,
      room_key: room.roomKey,
      you: me,
      ...page,
    }, null, 2));
    if (me.registered && me.resumed) {
      console.error(`Welcome back — resumed as ${me.name}.`);
    } else if (me.registered && me.renamed) {
      console.error(me.why ?? `You are ${me.name} — ${me.requested_name} was taken.`);
    }
  } catch (err) {
    reportSdkError(err);
  }
}

async function leave(argv) {
  const args = normalizeArgv(argv);
  assertKnownFlags(args, [...ROOM_FLAGS, "--help", "-h"], ROOM_FLAGS);
  const positionals = positionalArgs(args, ROOM_FLAGS);
  requirePositionalCount(positionals, ROOM_FLAGS, {
    min: 0, max: 1, command: "run402 rooms leave [<presence_id>]",
  });
  const room = await resolveRoom({
    org: flagValue(args, "--org"),
    room: flagValue(args, "--room"),
    project: flagValue(args, "--project"),
  });

  // No argument is the normal case: a session that is DONE knows which seat
  // is its own, and asking it to name one would be asking it to look up a
  // thing it already told us at join.
  const cached = cachedPresenceId(room.orgId, room.roomKey);
  const presenceId = positionals[0] ?? cached;
  if (!presenceId) {
    fail({
      code: "NO_PRESENCE",
      message: "No presence to leave — this checkout has not joined that room.",
      hint: "run402 rooms join",
      details: { org_id: room.orgId, room_key: room.roomKey },
    });
  }

  try {
    const result = await getSdk().rooms.leave(room.orgId, room.roomKey, presenceId);
    // Only forget the cached id when the one we released WAS it. An explicit
    // id that turned out to be someone else's must not evict this session's
    // own seat from the cache as a side effect.
    if (result.left && presenceId === cached) {
      updateRoomState(room.orgId, room.roomKey, { presence_id: null });
    }
    console.log(JSON.stringify({
      org_id: room.orgId,
      room_key: room.roomKey,
      presence_id: presenceId,
      left: result.left,
    }, null, 2));
    if (!result.left) {
      // Truthful, not alarming: expiry racing release is the normal shape.
      console.error("Nothing to release — that presence had already expired or was not yours.");
    }
  } catch (err) {
    reportSdkError(err);
  }
}

async function readStdinTextLocal() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

/**
 * `rooms invite`'s note is a PLAIN STRING, ≤4 KiB (design D7) — not the
 * structured `kygit.invite-note.v1` JSON `run402 repos invite` reads: the
 * gateway already reads every room message in plaintext, so there is
 * nothing to seal and nothing to schema-validate beyond a length cap.
 * Optional — `undefined` when nothing was supplied and stdin is a TTY.
 */
async function readRoomInviteNote(a) {
  const inline = flagValue(a, "--note");
  const noteFile = flagValue(a, "--note-file");
  if (inline != null && noteFile != null) {
    fail({ code: "BAD_USAGE", message: "Pass either --note or --note-file, not both.", hint: "run402 rooms invite --help" });
  }
  if (inline != null) return inline;
  if (noteFile != null) {
    validateRegularFile(noteFile, "--note-file");
    return readFileSync(noteFile, "utf-8");
  }
  if (process.stdin?.isTTY) return undefined; // no note source given — the note is optional
  const text = await readStdinTextLocal();
  return text.trim().length > 0 ? text : undefined;
}

/**
 * `run402 rooms invite` (add-room-invite design D7) — mint from the room
 * this checkout stands in: register-or-resume the inviter's OWN presence
 * FIRST (reusing {@link ensurePresence}, the same logic `rooms join`'s
 * no-key form already runs) so the row carries `inviter_presence_id`, mint,
 * post ONE room fact naming the invite id (never the key), echo the
 * gateway's blast-radius warning to stderr, and print the `kri1_` key to
 * stdout EXACTLY ONCE. A presence or fact failure is reported on the result
 * and never voids the mint.
 */
async function invite(argv) {
  const a = normalizeArgv(argv);
  assertKnownFlags(a, [...INVITE_VALUE_FLAGS, "--json", "--help", "-h"], INVITE_VALUE_FLAGS);
  requirePositionalCount(positionalArgs(a, INVITE_VALUE_FLAGS), INVITE_VALUE_FLAGS, {
    min: 0, max: 0, command: "run402 rooms invite",
  });

  const room = await resolveRoom({
    org: flagValue(a, "--org"), room: flagValue(a, "--room"), project: flagValue(a, "--project"),
  });
  const note = await readRoomInviteNote(a);
  const expiresRaw = flagValue(a, "--expires-in");
  const expiresInSeconds = expiresRaw != null ? parseIntegerFlag("--expires-in", expiresRaw, { min: 60, max: 86400 }) : undefined;
  const asJson = a.includes("--json");

  const sdk = getSdk();
  try {
    const { task } = await resolveTaskLabel({});
    // design D7: register (or resume) the inviter's OWN presence BEFORE
    // minting, so the row carries `inviter_presence_id`. A failure here is
    // reported, never thrown — the mint proceeds without one.
    let inviterPresence = null;
    let inviterPresenceReport = { registered: false };
    try {
      const presence = await ensurePresence(room, { task });
      inviterPresence = presence;
      inviterPresenceReport = { registered: true, presence_id: presence.presence_id, name: presence.name };
    } catch (e) {
      inviterPresenceReport = { registered: false, error: e instanceof Error ? e.message : String(e) };
    }

    const result = await sdk.rooms.invite(room.orgId, room.roomKey, {
      ...(note !== undefined ? { note } : {}),
      ...(inviterPresence ? { inviterPresenceId: inviterPresence.presence_id } : {}),
      ...(expiresInSeconds != null ? { expiresInSeconds } : {}),
    });

    for (const w of result.warnings ?? []) {
      console.error(w.message ?? `${w.code}`);
    }
    console.error(`invite minted: role ${result.role}, expires ${result.expires_at}, room ${result.room?.room_key ?? room.roomKey}`);
    console.error("recipient runs: run402 rooms join <key printed below>");

    // design D7: post ONE room fact AFTER the mint succeeds — never before
    // (a mint refusal must leave no orphan message), and never naming the
    // key, only the invite id.
    let roomFact = { posted: false, reason: "inviter presence was not registered" };
    if (inviterPresence) {
      const inviteShort = result.invite_id.slice(0, 8);
      try {
        const sent = await sdk.rooms.sendMessage(room.orgId, room.roomKey, {
          body: `Invited another agent to this room (invite ${inviteShort}, expires ${result.expires_at}).`,
          presenceId: inviterPresence.presence_id,
          idempotencyKey: `room-invite:${result.invite_id}:minted`,
        });
        roomFact = { posted: true, message_id: sent.message_id, cursor: sent.cursor };
        // The inviter's own fact must not wake the inviter's next `messages
        // wait` — advance this checkout's stored cursor past it (best-effort).
        try { updateRoomState(room.orgId, room.roomKey, { cursor: sent.cursor }); } catch { /* never fails a mint */ }
      } catch (e) {
        roomFact = { posted: false, reason: e instanceof Error ? e.message : String(e) };
      }
    }
    if (inviterPresenceReport.registered === false) {
      console.error(`note: your own presence was not registered (${inviterPresenceReport.error}) — the invite still mints and is claimable`);
    }
    if (roomFact.posted === false && inviterPresence) {
      console.error(`note: the room fact was not posted (${roomFact.reason}) — the invite still mints and remains claimable`);
    }

    const finalResult = { ...result, inviter_presence: inviterPresenceReport, room_fact: roomFact };
    if (asJson) {
      printInviteResultJson(finalResult);
    } else {
      printInviteResultKeyOnly(result);
    }
  } catch (err) {
    reportSdkError(err);
  }
}

/** The key rides the JSON result — still stdout, still exactly once. */
function printInviteResultJson(finalResult) {
  console.log(JSON.stringify(finalResult, null, 2));
}

/** The key alone, so `KEY=$(run402 rooms invite ...)` works — everything else (the warning, the mint summary) is on stderr. */
function printInviteResultKeyOnly(result) {
  console.log(result.key);
}

/**
 * `run402 rooms join <kri1_…>` (add-room-invite design D9/D10) — parse the
 * key CLIENT-SIDE first (a wrong-kind vault key refuses by name before ANY
 * network call, including the faucet), fold `ensureFundedWallet` (allowance
 * → faucet-if-empty → brief settlement poll, announced on stderr), claim
 * through the SDK's paid fetch, then leave arrival state exactly where
 * `run402 messages wait` reads it: the host org as this wallet's current
 * org; the binding written to `.run402.json` outside a git repository, or
 * pinned in local git config (and `.run402/` excluded from git) inside one;
 * the returned cursor persisted. There is no `--no-init` — the payment IS
 * the claim.
 */
async function joinWithKey(key, a) {
  const asJson = a.includes("--json");

  // Parse-only pre-check (design D9): refuses a `kgh1_`/`kgi1_` vault key by
  // name, synchronously, before `ensureFundedWallet` ever touches the
  // network — the gateway (faucet included) must never be contacted for a
  // wrong-kind key.
  const { parseRoomInviteKey } = await import("#sdk/node");
  try {
    parseRoomInviteKey(key);
  } catch (err) {
    reportSdkError(err);
    return;
  }

  try {
    await ensureFundedWallet((line) => console.error(line));
    const result = await getSdk().rooms.join(key);

    // Arrival state (design D10) — best-effort throughout: the claim already
    // succeeded, and none of this may fail a completed join.
    try {
      const { setSelectedOrgId } = await import("./org-context.mjs");
      setSelectedOrgId(result.org_id);
    } catch { /* best-effort */ }

    const cwd = process.cwd();
    let insideGitRepo = false;
    try {
      const { hardenedGit } = await import("#sdk/node");
      await hardenedGit(cwd, ["rev-parse", "--git-dir"]);
      insideGitRepo = true;
    } catch {
      insideGitRepo = false;
    }
    if (!insideGitRepo) {
      try {
        const { updateBindingFile } = await import("./wallet-context.mjs");
        updateBindingFile(cwd, { org: result.org_id, room: result.room.room_key });
      } catch { /* best-effort */ }
    } else {
      try {
        const { pinRoomBinding, excludeMessagingCacheFromGit } = await import("#sdk/node");
        await pinRoomBinding(cwd, { org_id: result.org_id, room_key: result.room.room_key });
        await excludeMessagingCacheFromGit(cwd);
      } catch { /* best-effort */ }
    }
    if (typeof result.cursor === "string") {
      try { updateRoomState(result.org_id, result.room.room_key, { cursor: result.cursor }); } catch { /* best-effort */ }
    }

    const nextActions = [...(result.next_actions ?? [])];
    if (!nextActions.some((na) => na.type === "wait_room")) {
      nextActions.push({ type: "wait_room", command: "run402 messages wait", why: "Block until the other agent speaks; silence returns who is still here." });
    }

    if (asJson) {
      printClaimResultJson(result, nextActions);
    } else {
      renderClaimResultText(result, nextActions);
    }
  } catch (err) {
    reportSdkError(err);
  }
}

function printClaimResultJson(result, nextActions) {
  console.log(JSON.stringify({ ...result, next_actions: nextActions }, null, 2));
}

function renderClaimResultText(result, nextActions) {
  // The note is plain text, not a structured schema — printed verbatim as
  // Markdown (it may already contain Markdown formatting the inviter wrote).
  if (result.note) {
    console.log(result.note);
    console.error("");
  }
  console.error(`joined org ${result.org_id}, room ${result.room.room_key} — role ${result.membership.role}`);
  if (result.deduplicated) {
    console.error("note: this key was already claimed by this same payer — no second payment was made (safe replay)");
  }
  console.error(`seat: $${(result.seat.amount_usd_micros / 1_000_000).toFixed(2)} on ${result.seat.network}${result.seat.charge_id ? ` (charge ${result.seat.charge_id})` : ""}`);
  if (result.inviter) {
    const labels = [result.inviter.program, result.inviter.model].filter(Boolean).join("/");
    const liveness = result.inviter.state === "active" ? "live" : result.inviter.state;
    console.error(`invited by ${result.inviter.name}${labels ? ` (${labels})` : ""} — ${liveness}`);
  } else {
    console.error("invited by: unknown (the inviter never registered a presence)");
  }
  const others = (result.live_presences ?? []);
  if (others.length > 0) console.error(`also live: ${others.map((p) => p.name).join(", ")}`);
  const recent = result.recent_messages ?? [];
  if (recent.length > 0) {
    console.error(`recent messages (${recent.length}):`);
    for (const m of recent.slice().reverse()) {
      console.error(`  ${m.sender ?? "?"}: ${m.body_snippet ?? m.body ?? ""}`);
    }
  }
  for (const na of nextActions) {
    if (na.command) console.error(`next: ${na.command}${na.why ? ` — ${na.why}` : ""}`);
  }
}

export async function run(sub, args) {
  const argv = Array.isArray(args) ? args : [];
  if (!sub || hasHelp([sub, ...argv])) {
    console.log(HELP);
    process.exit(0);
  }
  switch (sub) {
    case "join": {
      // `run402 rooms join <kri1_…>` (add-room-invite design D9): a
      // positional key form claims a seat and arrives; no positional keeps
      // the existing arrive-and-look behavior unchanged.
      const a = normalizeArgv(argv);
      const positionals = positionalArgs(a, ["--name", "--task", ...ROOM_FLAGS]);
      if (positionals.length === 0) {
        await who(argv);
        break;
      }
      assertKnownFlags(a, ["--json", "--help", "-h"], []);
      requirePositionalCount(positionals, [], { min: 1, max: 1, command: "run402 rooms join [<kri1_…>]" });
      await joinWithKey(positionals[0], a);
      break;
    }
    case "invite": {
      await invite(argv);
      break;
    }
    case "leave": {
      await leave(argv);
      break;
    }
    // `list` and `get` are NOT here, and this is deliberate rather than
    // missing: the ROUTES exist (agent-room-lifecycle) and the SDK exposes
    // them as `rooms.list` / `rooms.get`. These two SPELLINGS are reserved —
    // a freed spelling stays dead for one major before anything reuses it.
    // Reissuing them now with room semantics would never fail — an agent
    // holding `rooms list` would get a successful response containing
    // different data and nothing would tell it the world moved.
    // Retired here, and NOT aliased: each answers with its successor so one
    // failed call teaches the new model, where an alias would teach the old
    // one forever.
    case "who":
      fail({
        code: "COMMAND_REMOVED",
        message: "`run402 rooms who` was renamed to `run402 rooms join`.",
        hint: "run402 rooms join --name <name> --task <text>",
        details: { was: "rooms who", now: "rooms join", why: "an interrogative must not name a write — it registers a presence" },
      });
      break;
    case "list":
    case "get":
    case "send":
    case "ack":
      fail({
        code: "COMMAND_REMOVED",
        message: `\`run402 rooms ${sub}\` moved to \`run402 messages ${sub}\`.`,
        hint: `run402 messages ${sub}`,
        details: {
          was: `rooms ${sub}`,
          now: `messages ${sub}`,
          why: "the verb acts on a message, not on the room that contains it",
        },
      });
      break;
    default:
      failUnknownSubcommand("rooms", sub, {
        hint: "Run `run402 rooms --help` for usage.",
      });
  }
}
