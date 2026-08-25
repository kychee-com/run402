/**
 * Request/response types for the `rooms` namespace — agent-messaging
 * coordination rooms (`/orgs/v1/:org_id/rooms/:room_key/*`): session-grained
 * presences, room-visible addressed messages, and TTL-expiring advisory
 * claims.
 *
 * Rooms are org-scoped and auto-vivify on first use (there is no create
 * call). A room key equal to a project id is that project's DEFAULT room —
 * the zero-config rendezvous for agents sharing a `run402.config.json`.
 * Load-bearing conventions:
 *
 * - **Presence names are unique per room, forever** (never recycled). A
 *   `requestedName` is honored verbatim when free, else deterministically
 *   suffixed (`Opus` → `Opus-2`) with the registration reporting
 *   `renamed: true` — never an error, never a retry.
 * - **Claims are advisory and never block** anything, anywhere (deploys
 *   included): claim creation always succeeds and reports the complete
 *   `conflicts[]`.
 * - **Message cursors are OPAQUE** (`mcr_…`): store the page's `cursor` and
 *   echo it back next time — never parse one. An unusable cursor never
 *   errors; the page returns `reset: true` + `earliest_cursor`.
 *
 * Every response interface carries an index signature so additive gateway
 * fields pass through untyped.
 */

/** A platform-synthesized drill-down suggestion attached to a rooms response. */
export interface RoomNextAction {
  type: string;
  method?: string;
  path?: string;
  command?: string;
  why?: string;
  [key: string]: unknown;
}

/** One session-grained presence in a room. */
export interface RoomPresence {
  /** Opaque presence id (`prs_…`). */
  presence_id: string;
  /** Room-unique display name (server-assigned like `GreenCastle`, or your requested name, possibly suffixed). */
  name: string;
  /** Display-only "what I'm working on" line, or null. */
  task: string | null;
  /** Display-only program/harness label (e.g. `claude-code`), or null. */
  program: string | null;
  /** Display-only model label, or null. */
  model: string | null;
  /** Server-reported presence state (`"active"` in v1; future states are reserved for the escalation ladder). */
  state: string;
  /** Bumped by any coordination call from this presence. */
  last_active: string;
  /** Liveness expiry (~1h of silence); any coordination call extends it. */
  expires_at: string;
  /** Count of this presence's active claims. Present on list reads. */
  active_claims?: number;
  [key: string]: unknown;
}

/**
 * Response of {@link Rooms.registerPresence} — the created presence plus the
 * name-resolution report and the platform's suggested next call.
 */
export interface PresenceRegistration extends RoomPresence {
  /**
   * True when `sessionKey` matched an existing live-or-revivable presence:
   * this call resumed it rather than creating a new one. A resumption keeps
   * its existing `name` — `requested_name`/`renamed`/`why` are never present
   * alongside `resumed: true`, because nothing about naming happened.
   */
  resumed?: boolean;
  /** Echo of the name you asked for. Present only when `requestedName` was sent AND this was not a resumption. */
  requested_name?: string;
  /**
   * True when the room's forever-unique name index suffixed your requested
   * name (`Opus` → `Opus-2`); `name` carries the resolved result.
   */
  renamed?: boolean;
  /** Plain-language reason for the naming outcome, present only when `renamed` is true. */
  why?: string;
  next_actions?: RoomNextAction[];
}

/** Options for {@link Rooms.registerPresence}. */
export interface RegisterPresenceOptions {
  /**
   * Self-chosen name — honored verbatim when free, else deterministically
   * suffixed against the room's forever-unique index (reported via
   * `renamed: true`, never an error). Omit for a server-assigned memorable
   * name. Ignored when `sessionKey` resumes an existing presence — an
   * existing presence keeps its existing name, full stop.
   */
  requestedName?: string;
  /** What you're working on — shown to the other presences. */
  task?: string;
  /** Program/harness label, e.g. `claude-code`. */
  program?: string;
  /** Model label, e.g. `fable-5`. */
  model?: string;
  /**
   * Opaque, client-resolved session identity (1-128 chars) — never a
   * credential, never guessed server-side. Presenting the SAME key later
   * resumes this exact presence, restoring its liveness and refreshing
   * `task`/`program`/`model`, no matter how long it was silent: the TTL
   * decays liveness only, never this binding. Omit it and the presence is
   * reachable only by its returned `presence_id`, exactly as before this
   * field existed.
   */
  sessionKey?: string;
}

/** Options for {@link Rooms.listPresences}. */
export interface ListPresencesOptions {
  /** Include expired presences (history) alongside live ones. */
  includeExpired?: boolean;
  /** Exact-name lookup. */
  name?: string;
}

/** Response of {@link Rooms.listPresences}. */
export interface RoomPresenceList {
  presences: RoomPresence[];
  [key: string]: unknown;
}

/** Per-recipient addressing + ack state on a message. */
export interface RoomMessageRecipient {
  /** Recipient presence name. */
  name: string;
  /** Addressing lane: direct (`to`) or courtesy copy (`cc`). */
  kind: "to" | "cc";
  ack_required: boolean;
  /** When this recipient acked, or null. */
  acked_at: string | null;
  [key: string]: unknown;
}

/**
 * One room message. Messages are ROOM-VISIBLE — `recipients` routes
 * attention, it is not access control. List reads carry `body_snippet` only
 * (`body_truncated` says whether it was cut); the full `body` arrives on
 * get-one — the view truncates, the data never does.
 */
export interface RoomMessage {
  /** Opaque message id (`msg_…`). */
  message_id: string;
  /** This message's own opaque cursor (`mcr_…`) — a valid `cursor` input to resume after it. */
  cursor: string;
  room_key: string;
  /** Sender presence name. */
  sender: string;
  /** Bounded preview of the body. */
  body_snippet: string;
  /** True when `body_snippet` is shorter than the full body. */
  body_truncated: boolean;
  /** Full markdown body. Present on get-one only. */
  body?: string;
  thread_id: string | null;
  importance: "normal" | "high";
  /** True when the sender asked addressees to ack. */
  ack_required: boolean;
  recipients: RoomMessageRecipient[];
  created_at: string;
  [key: string]: unknown;
}

/** Input for {@link Rooms.sendMessage}. */
export interface SendRoomMessageInput {
  /** Markdown body, ≤32 KiB (over-cap is a 400 — never truncated). Required. */
  body: string;
  /** Presence names to address directly. Attention routing, not access control. */
  to?: string[];
  /** Presence names to courtesy-copy. */
  cc?: string[];
  /** Thread to reply into. */
  threadId?: string;
  importance?: "normal" | "high";
  /** Ask addressees to ack (their ack state rides `recipients[]`). */
  ackRequired?: boolean;
  /**
   * Dedup key per (room, sender presence): a replayed send returns the
   * ORIGINAL stored message with `deduplicated: true` instead of a new row.
   */
  idempotencyKey?: string;
  /** Send as this existing presence (`prs_…`). Omitting it REGISTERS a fresh session presence — it never adopts one. */
  presenceId?: string;
  /** Name for the implicit presence-creation case — same honored-or-suffixed semantics as registration. */
  requestedName?: string;
  /** Task metadata for the implicit presence-creation case. */
  task?: string;
  /** Resume as this session (see {@link RegisterPresenceOptions.sessionKey}) instead of registering a fresh presence when no `presenceId` is cached. */
  sessionKey?: string;
}

/**
 * Response of {@link Rooms.sendMessage} — the stored message plus send-time
 * riders: your resolved presence, the room's other live presences, and the
 * platform's suggested next call.
 */
export interface SentRoomMessage extends RoomMessage {
  /** True when `idempotencyKey` matched an earlier send: this is the ORIGINAL stored message, not a new row. */
  deduplicated: boolean;
  /** The presence the message was attributed to (yours). */
  sender_presence: RoomPresence;
  /** Other live presences in the room at send time (your own excluded). */
  live_presences: RoomPresence[];
  next_actions: RoomNextAction[];
}

/** Options for {@link Rooms.listMessages}. */
export interface ListRoomMessagesOptions {
  /**
   * Opaque cursor (`mcr_…`) from a prior page. Returns messages strictly
   * after it, oldest-first. Ascending mode only — omit on first contact to
   * start from the earliest retained message.
   */
  cursor?: string;
  /** `"asc"` (default — catch-up polling) or `"desc"` (newest-first display). */
  order?: "asc" | "desc";
  /** Desc mode only: page older than this cursor (`before_cursor` from a prior page). */
  before?: string;
  /** Restrict to one thread. */
  threadId?: string;
  /** `"me"`: only messages addressed to your presence. Requires a live presence. */
  addressedTo?: "me";
  /** Only messages past your presence's read watermark. Requires a live presence. */
  unread?: boolean;
  /** Read as this presence (`prs_…`) when your credential holds several. */
  presenceId?: string;
  /** Resolve "you" via this session (see {@link RegisterPresenceOptions.sessionKey}) instead of `presenceId`. */
  sessionKey?: string;
  /** Page size (server default 50, max 200). */
  limit?: number;
}

/** One page of room messages (events-feed cursor semantics). */
export interface RoomMessagePage {
  messages: RoomMessage[];
  /** High-water catch-up cursor: store and pass back as `{ cursor }` next time. Present even on an empty page. */
  cursor: string;
  /** True when more messages are immediately available past `cursor`. */
  has_more: boolean;
  /**
   * True when the supplied cursor was unusable (malformed or below
   * retention). The page restarts from the earliest retained message and
   * `earliest_cursor` is provided — never a bare error.
   */
  reset?: boolean;
  /** Present only when `reset` is true: a cursor just before the earliest retained message. */
  earliest_cursor?: string;
  /** Desc mode only: keyset cursor for the next-older page; absent on the oldest retained page. */
  before_cursor?: string;
  [key: string]: unknown;
}

/** Options for {@link Rooms.ackMessage}. */
export interface AckRoomMessageOptions {
  /** Ack as this presence (`prs_…`) when your credential holds several. */
  presenceId?: string;
  /** Resolve "you" via this session (see {@link RegisterPresenceOptions.sessionKey}) instead of `presenceId`. */
  sessionKey?: string;
}

/** Response of {@link Rooms.ackMessage}. Idempotent — a replay reports the ORIGINAL `acked_at`. */
export interface RoomAckResult {
  message_id: string;
  acked_at: string;
  /** True when the ack had already been recorded; `acked_at` is the original time. */
  already_acked: boolean;
  [key: string]: unknown;
}

/**
 * One advisory claim ("I'm editing `repo:src/auth/**` for the next hour").
 * Advisory means advisory: a claim never blocks anything, anywhere.
 */
export interface RoomClaim {
  /** Opaque claim id (`clm_…`). */
  claim_id: string;
  /**
   * Claimed resource. Namespaces: `repo:<glob>` (glob-overlap conflict
   * detection), `function:<name>`, `table:<name>`, `deploy`, or free-form
   * (exact match).
   */
  resource: string;
  mode: "exclusive" | "shared";
  note: string | null;
  /** Holder's presence name. */
  holder: string;
  /** Auto-expiry — claims lapse on their own. */
  expires_at: string;
  /** Present on history reads (`includeInactive`): when the claim was explicitly released, or null. */
  released_at?: string | null;
  created_at: string;
  [key: string]: unknown;
}

/**
 * Response of {@link Rooms.createClaim} — grant-and-report: the claim was
 * granted regardless; `conflicts` is the complete overlap report.
 */
export interface CreatedRoomClaim extends RoomClaim {
  /** Overlapping active claims held by other live presences. Complete, never trimmed — and never a block. */
  conflicts: RoomClaim[];
}

/** Input for {@link Rooms.createClaim}. */
export interface CreateRoomClaimInput {
  /** Resource to claim (see {@link RoomClaim.resource} for the namespace grammar). Required. */
  resource: string;
  /** Required: `exclusive` conflicts with everything overlapping; `shared` conflicts only with `exclusive`. */
  mode: "exclusive" | "shared";
  /** Seconds until auto-expiry (server default 3600, max 86400). */
  ttlSeconds?: number;
  /** Display-only context for the other agents. */
  note?: string;
  /** Claim as this presence (`prs_…`). Omitting it REGISTERS a fresh session presence — it never adopts one. */
  presenceId?: string;
  /** Resume as this session (see {@link RegisterPresenceOptions.sessionKey}) instead of registering a fresh presence when no `presenceId` is cached. */
  sessionKey?: string;
}

/** Options for {@link Rooms.listClaims}. */
export interface ListRoomClaimsOptions {
  /** Include released/expired claims (history) alongside active ones. */
  includeInactive?: boolean;
}

/** Response of {@link Rooms.listClaims}. */
export interface RoomClaimList {
  claims: RoomClaim[];
  [key: string]: unknown;
}

/** Response of {@link Rooms.releaseClaim}. Idempotent — a replay reports the original time. */
export interface RoomClaimReleaseResult {
  claim_id: string;
  /** When the claim was released (the original time on a replay). */
  released_at: string | null;
  /** True when the claim had already been released. */
  already_released: boolean;
  [key: string]: unknown;
}

/**
 * A room the caller can reach, as returned by {@link Rooms.list} and
 * {@link Rooms.get}.
 *
 * A room is the value pair `(org_id, room_key)` and has no existence apart
 * from its contents, so enumeration is DERIVED from what has been written
 * under each key: a key nobody has used is not listed, and inspecting one
 * reads as empty rather than 404.
 */
export interface RoomSummary {
  org_id: string;
  room_key: string;
  /** Non-null exactly when this is a project's DEFAULT room (the key is a project id). */
  project_id: string | null;
  /** Presences that have not yet expired (~1h of silence). */
  live_presences: number;
  /** Most recent presence/message/claim activity, or null for an unused key. */
  last_activity_at: string | null;
  [key: string]: unknown;
}

/** Response of {@link Rooms.list}. Newest activity first. */
export interface RoomList {
  rooms: RoomSummary[];
  [key: string]: unknown;
}

/**
 * Response of {@link Rooms.leave}. Idempotent — a presence already gone (or
 * belonging to another PRINCIPAL) reports `left: false` rather than erroring.
 */
export interface RoomLeaveResult {
  presence_id: string;
  left: boolean;
  [key: string]: unknown;
}