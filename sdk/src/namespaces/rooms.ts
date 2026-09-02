/**
 * `rooms` namespace — agent-messaging coordination rooms (gateway
 * `agent-messaging`): session-grained presence, room-visible addressed
 * messages with cursored reads, and TTL-expiring advisory claims, for 2+
 * agents working the same product.
 *
 * Rooms are ORG-scoped and auto-vivify on first use — there is no create
 * call. A room key equal to a project id is that project's DEFAULT room:
 * {@link Rooms.forProject} resolves the owning org and returns the scoped
 * handle, so two agents on different machines rendezvous through the project
 * id already in `run402.config.json`, zero configuration. Free-form room
 * keys name org rooms for multi-repo products.
 *
 * Load-bearing semantics:
 * - Presence names are unique per room FOREVER; a `requestedName` is honored
 *   verbatim when free, else deterministically suffixed (`Opus` → `Opus-2`)
 *   and reported via `renamed: true` — never an error, never a retry.
 * - Messages are room-visible; `to`/`cc` routes attention, not access.
 * - Claims are ADVISORY and never block anything, anywhere (deploys
 *   included) — creation always succeeds and reports `conflicts[]`.
 * - Message cursors are opaque (`mcr_…`): store and echo, never parse. An
 *   unusable cursor never errors — the page returns `reset: true` +
 *   `earliest_cursor` (events-feed semantics).
 *
 * Writes (presence registration, sends, acks, claims) need a
 * principal-backed credential — SIWX, control-plane session, or a
 * `run402_agent_key` delegate; a project service_key is read-only in its own
 * default room. Rooms are never lifecycle-gated: agents of an org in grace
 * keep coordinating.
 */

import type { Client } from "../kernel.js";
import { LocalError } from "../errors.js";
import type {
  AckRoomMessageOptions,
  CreatedRoomClaim,
  CreateRoomClaimInput,
  ListPresencesOptions,
  ListRoomClaimsOptions,
  ListRoomMessagesOptions,
  PresenceRegistration,
  RegisterPresenceOptions,
  RoomAckResult,
  RoomClaimList,
  RoomClaimReleaseResult,
  RoomMessage,
  RoomLeaveResult,
  RoomList,
  RoomMessagePage,
  RoomMessageWaitResult,
  RoomPresence,
  RoomPresenceList,
  RoomSummary,
  SendRoomMessageInput,
  SentRoomMessage,
  WaitForRoomMessagesOptions,
} from "./rooms.types.js";

function roomPath(orgId: string, roomKey: string): string {
  return `/orgs/v1/${encodeURIComponent(orgId)}/rooms/${encodeURIComponent(roomKey)}`;
}

function presencesQuery(opts: ListPresencesOptions = {}): string {
  const params = new URLSearchParams();
  if (opts.includeExpired !== undefined) params.set("include_expired", String(opts.includeExpired));
  if (opts.name !== undefined) params.set("name", opts.name);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

function messagesQuery(opts: ListRoomMessagesOptions = {}): string {
  const params = new URLSearchParams();
  if (opts.cursor !== undefined) params.set("cursor", opts.cursor);
  if (opts.order !== undefined) params.set("order", opts.order);
  if (opts.before !== undefined) params.set("before", opts.before);
  if (opts.threadId !== undefined) params.set("thread_id", opts.threadId);
  if (opts.addressedTo !== undefined) params.set("addressed_to", opts.addressedTo);
  if (opts.unread !== undefined) params.set("unread", String(opts.unread));
  if (opts.presenceId !== undefined) params.set("presence_id", opts.presenceId);
  if (opts.sessionKey !== undefined) params.set("session_key", opts.sessionKey);
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  if (opts.wait !== undefined) params.set("wait", String(opts.wait));
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

function claimsQuery(opts: ListRoomClaimsOptions = {}): string {
  const params = new URLSearchParams();
  if (opts.includeInactive !== undefined) params.set("include_inactive", String(opts.includeInactive));
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export class Rooms {
  constructor(private readonly client: Client) {}

  /**
   * Rooms this credential can reach (`GET /orgs/v1/:org_id/rooms`), newest
   * activity first — the answer to "I have an org id, where do I go".
   *
   * Enumeration is DERIVED from use: a key nobody has written under is not a
   * room and is not listed. What comes back is exactly what per-room
   * authorization would admit one at a time — a member sees the org's rooms,
   * a delegate or grant-holder sees the named rooms plus the default rooms of
   * the projects it reaches (never a sibling project's), and a project
   * service_key sees only its own.
   */
  async list(orgId: string): Promise<RoomList> {
    if (!orgId) {
      throw new LocalError("rooms.list requires an orgId", "listing rooms");
    }
    return this.client.request<RoomList>(`/orgs/v1/${encodeURIComponent(orgId)}/rooms`, {
      context: "listing rooms",
    });
  }

  /**
   * Look at one room WITHOUT joining it
   * (`GET /orgs/v1/:org_id/rooms/:room_key`) — is anyone here, and when did
   * anything last happen. {@link Rooms.registerPresence} would answer the
   * same question by adding you to the room; this does not change it.
   *
   * A key nothing has been written under reads as empty (zero presences, null
   * activity), never 404 — a room has no existence apart from its contents.
   */
  async get(orgId: string, roomKey: string): Promise<RoomSummary> {
    if (!orgId) {
      throw new LocalError("rooms.get requires an orgId", "reading room");
    }
    if (!roomKey) {
      throw new LocalError("rooms.get requires a roomKey", "reading room");
    }
    return this.client.request<RoomSummary>(roomPath(orgId, roomKey), { context: "reading room" });
  }

  /**
   * Give up your seat
   * (`DELETE /orgs/v1/:org_id/rooms/:room_key/presences/:presence_id`) — the
   * session is done, so it should stop reading as live and stop holding its
   * claims, rather than lingering for the rest of its ~1h TTL.
   *
   * Scoped to the caller's PRINCIPAL: another principal's presence is simply
   * not found (never an eviction). Note the asymmetry — a presence IS a
   * session, but delete authority is the principal, so a credential MAY
   * release a seat held by one of its OWN other sessions. That is deliberate:
   * it is how a fresh session clears a crashed predecessor whose presence
   * would otherwise hold claims for the rest of its TTL.
   *
   * Idempotent — an already-released presence (or another principal's)
   * reports `left: false` truthfully, so a crashed session's retry does not
   * fail.
   */
  async leave(orgId: string, roomKey: string, presenceId: string): Promise<RoomLeaveResult> {
    if (!orgId) {
      throw new LocalError("rooms.leave requires an orgId", "leaving room");
    }
    if (!roomKey) {
      throw new LocalError("rooms.leave requires a roomKey", "leaving room");
    }
    if (!presenceId) {
      throw new LocalError("rooms.leave requires a presenceId", "leaving room");
    }
    return this.client.request<RoomLeaveResult>(
      `${roomPath(orgId, roomKey)}/presences/${encodeURIComponent(presenceId)}`,
      { method: "DELETE", context: "leaving room" },
    );
  }

  /**
   * Register a session presence in a room
   * (`POST /orgs/v1/:org_id/rooms/:room_key/presences`). Each call is a NEW
   * presence with a new room-unique name — pass the returned `presence_id` on
   * every later call to keep speaking as the SAME session (the server never
   * infers a session from the credential). `opts.requestedName` is honored-or-suffixed
   * (`Opus` → `Opus-2`, reported via `renamed`); omit it for a
   * server-assigned memorable name. Expiry after ~1h of silence; any
   * coordination call bumps liveness.
   */
  async registerPresence(
    orgId: string,
    roomKey: string,
    opts: RegisterPresenceOptions = {},
  ): Promise<PresenceRegistration> {
    if (!orgId) {
      throw new LocalError("rooms.registerPresence requires an orgId", "registering room presence");
    }
    if (!roomKey) {
      throw new LocalError("rooms.registerPresence requires a roomKey", "registering room presence");
    }
    const body: Record<string, unknown> = {};
    if (opts.requestedName !== undefined) body.requested_name = opts.requestedName;
    if (opts.task !== undefined) body.task = opts.task;
    if (opts.program !== undefined) body.program = opts.program;
    if (opts.model !== undefined) body.model = opts.model;
    if (opts.sessionKey !== undefined) body.session_key = opts.sessionKey;
    return this.client.request<PresenceRegistration>(`${roomPath(orgId, roomKey)}/presences`, {
      method: "POST",
      body,
      context: "registering room presence",
    });
  }

  /**
   * List a room's live presences
   * (`GET /orgs/v1/:org_id/rooms/:room_key/presences`) — who else is here,
   * what they're working on, and their `active_claims` counts.
   * `opts.includeExpired` adds history; `opts.name` is an exact-name lookup.
   */
  async listPresences(
    orgId: string,
    roomKey: string,
    opts: ListPresencesOptions = {},
  ): Promise<RoomPresenceList> {
    if (!orgId) {
      throw new LocalError("rooms.listPresences requires an orgId", "listing room presences");
    }
    if (!roomKey) {
      throw new LocalError("rooms.listPresences requires a roomKey", "listing room presences");
    }
    return this.client.request<RoomPresenceList>(
      `${roomPath(orgId, roomKey)}/presences${presencesQuery(opts)}`,
      { method: "GET", context: "listing room presences" },
    );
  }

  /**
   * Read one presence
   * (`GET /orgs/v1/:org_id/rooms/:room_key/presences/:presence_id`).
   */
  async getPresence(orgId: string, roomKey: string, presenceId: string): Promise<RoomPresence> {
    if (!orgId) {
      throw new LocalError("rooms.getPresence requires an orgId", "reading room presence");
    }
    if (!roomKey) {
      throw new LocalError("rooms.getPresence requires a roomKey", "reading room presence");
    }
    if (!presenceId) {
      throw new LocalError("rooms.getPresence requires a presenceId", "reading room presence");
    }
    return this.client.request<RoomPresence>(
      `${roomPath(orgId, roomKey)}/presences/${encodeURIComponent(presenceId)}`,
      { method: "GET", context: "reading room presence" },
    );
  }

  /**
   * Send a room-visible message
   * (`POST /orgs/v1/:org_id/rooms/:room_key/messages`). `to`/`cc` take
   * presence NAMES and route attention, not access — an unknown or expired
   * addressee is a 422 naming the unresolved entries. Omitting `presenceId`
   * REGISTERS a fresh session presence for the send (`requestedName`/`task`
   * apply to it) — it never adopts an existing one, so pass your stored
   * `presenceId` to stay the same session. An
   * `idempotencyKey` replay returns the ORIGINAL stored message with
   * `deduplicated: true`. Sends are bounded by the org-pooled
   * `messages_per_day` quota.
   */
  async sendMessage(orgId: string, roomKey: string, input: SendRoomMessageInput): Promise<SentRoomMessage> {
    if (!orgId) {
      throw new LocalError("rooms.sendMessage requires an orgId", "sending room message");
    }
    if (!roomKey) {
      throw new LocalError("rooms.sendMessage requires a roomKey", "sending room message");
    }
    if (!input?.body) {
      throw new LocalError("rooms.sendMessage requires { body }", "sending room message");
    }
    const body: Record<string, unknown> = { body: input.body };
    if (input.to !== undefined) body.to = input.to;
    if (input.cc !== undefined) body.cc = input.cc;
    if (input.threadId !== undefined) body.thread_id = input.threadId;
    if (input.importance !== undefined) body.importance = input.importance;
    if (input.ackRequired !== undefined) body.ack_required = input.ackRequired;
    if (input.idempotencyKey !== undefined) body.idempotency_key = input.idempotencyKey;
    if (input.presenceId !== undefined) body.presence_id = input.presenceId;
    if (input.requestedName !== undefined) body.requested_name = input.requestedName;
    if (input.task !== undefined) body.task = input.task;
    if (input.program !== undefined) body.program = input.program;
    if (input.model !== undefined) body.model = input.model;
    if (input.sessionKey !== undefined) body.session_key = input.sessionKey;
    return this.client.request<SentRoomMessage>(`${roomPath(orgId, roomKey)}/messages`, {
      method: "POST",
      body,
      context: "sending room message",
    });
  }

  /**
   * Read a page of room messages
   * (`GET /orgs/v1/:org_id/rooms/:room_key/messages`) — events-feed cursor
   * semantics: ascending catch-up via `cursor`, or newest-first display via
   * `order: "desc"` + `before`. List items carry `body_snippet` only; fetch
   * the full body with {@link getMessage} (the view truncates, the data
   * never does). Ascending reads with a resolved presence advance its read
   * watermark (what `unread: true` filters against).
   */
  async listMessages(
    orgId: string,
    roomKey: string,
    opts: ListRoomMessagesOptions = {},
  ): Promise<RoomMessagePage> {
    if (!orgId) {
      throw new LocalError("rooms.listMessages requires an orgId", "listing room messages");
    }
    if (!roomKey) {
      throw new LocalError("rooms.listMessages requires a roomKey", "listing room messages");
    }
    return this.client.request<RoomMessagePage>(
      `${roomPath(orgId, roomKey)}/messages${messagesQuery(opts)}`,
      { method: "GET", context: "listing room messages" },
    );
  }

  /**
   * Block until at least one matching message lands, or the timeout elapses
   * (kygit-invite design D6/D7) — the agent's ear. Uses the gateway's held
   * read (`wait=<seconds>` on the ascending message read) when it is
   * observed to hold (a page carrying `waited_ms`), and degrades to
   * client-side polling at `opts.pollMs` (default 5000ms) the instant a
   * page comes back WITHOUT `waited_ms` — an older gateway that ignored the
   * parameter. Decided by evidence on every read, not by a version check,
   * so a single call is safe against either gateway.
   *
   * Silence is an answer: on timeout this RETURNS the last observed
   * (empty) page with `settled: false`, never throws — the same contract as
   * the shared `waitFor` helper. `live_presences` comes from the last
   * page's own rider when the gateway held; otherwise it is fetched once at
   * the end, best-effort (empty on any failure).
   */
  async waitForMessages(
    orgId: string,
    roomKey: string,
    opts: WaitForRoomMessagesOptions = {},
  ): Promise<RoomMessageWaitResult> {
    if (!orgId) {
      throw new LocalError("rooms.waitForMessages requires an orgId", "waiting for room messages");
    }
    if (!roomKey) {
      throw new LocalError("rooms.waitForMessages requires a roomKey", "waiting for room messages");
    }
    const waitSeconds = Math.min(Math.max(Math.trunc(opts.waitSeconds ?? 25), 1), 25);
    const timeoutMs = opts.timeoutMs ?? 120_000;
    const fallbackPollMs = Math.max(opts.pollMs ?? 5000, 1000);
    const startedAt = Date.now();

    // The hold requested on each read is clamped to the budget that is LEFT,
    // never the full `waitSeconds`: a held read is the gateway sleeping on
    // the caller's behalf, so a 25 s hold issued with 5 s of budget remaining
    // would overshoot `timeoutMs` by 20 s — past a coding harness's own
    // tool-call limit when the caller sized the timeout to it (design D7).
    const remainingMs = () => timeoutMs - (Date.now() - startedAt);
    const holdFor = () => Math.max(1, Math.min(waitSeconds, Math.floor(remainingMs() / 1000)));
    const fetchPage = (wait: number) => this.listMessages(orgId, roomKey, {
      ...(opts.cursor !== undefined ? { cursor: opts.cursor } : {}),
      ...(opts.threadId !== undefined ? { threadId: opts.threadId } : {}),
      ...(opts.addressedTo !== undefined ? { addressedTo: opts.addressedTo } : {}),
      ...(opts.presenceId !== undefined ? { presenceId: opts.presenceId } : {}),
      ...(opts.sessionKey !== undefined ? { sessionKey: opts.sessionKey } : {}),
      wait,
    });

    let page = await fetchPage(holdFor());
    opts.onPoll?.(page, Date.now() - startedAt);

    while (page.messages.length === 0) {
      const elapsed = Date.now() - startedAt;
      // Evidence, not version: THIS page decides whether the next read is a
      // zero-sleep held re-read (the fetch itself already blocked up to
      // `waitSeconds`) or a throttled poll.
      const held = typeof page.waited_ms === "number";
      const sleepMs = held ? 0 : fallbackPollMs;
      // Look ahead by the upcoming sleep, exactly like the shared `waitFor`
      // helper's own loop guard — otherwise a budget check made only BEFORE
      // each sleep lets the total elapsed time overshoot `timeoutMs` by up
      // to one whole `sleepMs`.
      if (elapsed + sleepMs >= timeoutMs) break;
      if (sleepMs > 0) await new Promise((resolve) => setTimeout(resolve, sleepMs));
      // Less than a full second of budget left cannot be expressed as a
      // hold (the gateway clamps `wait` to >= 1) — stop rather than overshoot.
      if (remainingMs() < 1000) break;
      page = await fetchPage(holdFor());
      opts.onPoll?.(page, Date.now() - startedAt);
    }

    let livePresences: RoomPresence[] = Array.isArray(page.live_presences) ? page.live_presences : [];
    if (!Array.isArray(page.live_presences)) {
      try {
        const listed = await this.listPresences(orgId, roomKey);
        livePresences = opts.presenceId ? listed.presences.filter((p) => p.presence_id !== opts.presenceId) : listed.presences;
      } catch {
        livePresences = [];
      }
    }

    return {
      ...page,
      settled: page.messages.length > 0,
      waited_ms: Date.now() - startedAt,
      live_presences: livePresences,
    };
  }

  /**
   * Read one message with its full body and per-recipient ack state
   * (`GET /orgs/v1/:org_id/rooms/:room_key/messages/:message_id`).
   */
  async getMessage(orgId: string, roomKey: string, messageId: string): Promise<RoomMessage> {
    if (!orgId) {
      throw new LocalError("rooms.getMessage requires an orgId", "reading room message");
    }
    if (!roomKey) {
      throw new LocalError("rooms.getMessage requires a roomKey", "reading room message");
    }
    if (!messageId) {
      throw new LocalError("rooms.getMessage requires a messageId", "reading room message");
    }
    return this.client.request<RoomMessage>(
      `${roomPath(orgId, roomKey)}/messages/${encodeURIComponent(messageId)}`,
      { method: "GET", context: "reading room message" },
    );
  }

  /**
   * Acknowledge a message addressed to you
   * (`POST /orgs/v1/:org_id/rooms/:room_key/messages/:message_id/ack`).
   * Recipients only (422 otherwise). Idempotent — a replay reports the
   * ORIGINAL `acked_at` with `already_acked: true`.
   */
  async ackMessage(
    orgId: string,
    roomKey: string,
    messageId: string,
    opts: AckRoomMessageOptions = {},
  ): Promise<RoomAckResult> {
    if (!orgId) {
      throw new LocalError("rooms.ackMessage requires an orgId", "acknowledging room message");
    }
    if (!roomKey) {
      throw new LocalError("rooms.ackMessage requires a roomKey", "acknowledging room message");
    }
    if (!messageId) {
      throw new LocalError("rooms.ackMessage requires a messageId", "acknowledging room message");
    }
    const body: Record<string, unknown> = {};
    if (opts.presenceId !== undefined) body.presence_id = opts.presenceId;
    if (opts.sessionKey !== undefined) body.session_key = opts.sessionKey;
    return this.client.request<RoomAckResult>(
      `${roomPath(orgId, roomKey)}/messages/${encodeURIComponent(messageId)}/ack`,
      { method: "POST", body, context: "acknowledging room message" },
    );
  }

  /**
   * Create an advisory claim
   * (`POST /orgs/v1/:org_id/rooms/:room_key/claims`). GRANT-AND-REPORT: the
   * 201 always succeeds and returns the complete `conflicts[]` — a claim
   * never blocks anything, anywhere (deploys included). Auto-expires
   * (`ttlSeconds` default 3600, max 86400); at most 32 active claims per
   * presence. Omitting `presenceId` registers a fresh session presence for the
   * claim — pass your stored `presenceId` to attribute it to this session.
   */
  async createClaim(orgId: string, roomKey: string, input: CreateRoomClaimInput): Promise<CreatedRoomClaim> {
    if (!orgId) {
      throw new LocalError("rooms.createClaim requires an orgId", "creating room claim");
    }
    if (!roomKey) {
      throw new LocalError("rooms.createClaim requires a roomKey", "creating room claim");
    }
    if (!input?.resource) {
      throw new LocalError("rooms.createClaim requires { resource }", "creating room claim");
    }
    if (!input?.mode) {
      throw new LocalError("rooms.createClaim requires { mode }", "creating room claim");
    }
    const body: Record<string, unknown> = { resource: input.resource, mode: input.mode };
    if (input.ttlSeconds !== undefined) body.ttl_seconds = input.ttlSeconds;
    if (input.note !== undefined) body.note = input.note;
    if (input.presenceId !== undefined) body.presence_id = input.presenceId;
    if (input.sessionKey !== undefined) body.session_key = input.sessionKey;
    return this.client.request<CreatedRoomClaim>(`${roomPath(orgId, roomKey)}/claims`, {
      method: "POST",
      body,
      context: "creating room claim",
    });
  }

  /**
   * List a room's active claims
   * (`GET /orgs/v1/:org_id/rooms/:room_key/claims`).
   * `opts.includeInactive` adds released/expired history (with
   * `released_at`).
   */
  async listClaims(orgId: string, roomKey: string, opts: ListRoomClaimsOptions = {}): Promise<RoomClaimList> {
    if (!orgId) {
      throw new LocalError("rooms.listClaims requires an orgId", "listing room claims");
    }
    if (!roomKey) {
      throw new LocalError("rooms.listClaims requires a roomKey", "listing room claims");
    }
    return this.client.request<RoomClaimList>(
      `${roomPath(orgId, roomKey)}/claims${claimsQuery(opts)}`,
      { method: "GET", context: "listing room claims" },
    );
  }

  /**
   * Release your own claim
   * (`DELETE /orgs/v1/:org_id/rooms/:room_key/claims/:claim_id`). Holder's
   * credential only. Idempotent — an already-released claim returns
   * `already_released: true` with the original time.
   */
  async releaseClaim(orgId: string, roomKey: string, claimId: string): Promise<RoomClaimReleaseResult> {
    if (!orgId) {
      throw new LocalError("rooms.releaseClaim requires an orgId", "releasing room claim");
    }
    if (!roomKey) {
      throw new LocalError("rooms.releaseClaim requires a roomKey", "releasing room claim");
    }
    if (!claimId) {
      throw new LocalError("rooms.releaseClaim requires a claimId", "releasing room claim");
    }
    return this.client.request<RoomClaimReleaseResult>(
      `${roomPath(orgId, roomKey)}/claims/${encodeURIComponent(claimId)}`,
      { method: "DELETE", context: "releasing room claim" },
    );
  }

  /**
   * Return a room-scoped sub-client with `(orgId, roomKey)` pre-bound.
   * Synchronous — both ids are explicit. For a project's default room
   * without knowing the org, use {@link forProject}.
   */
  scoped(orgId: string, roomKey: string): ScopedRoom {
    return new ScopedRoom(this, orgId, roomKey);
  }

  /**
   * Resolve a project's DEFAULT room (`GET /projects/v1/:project_id` for the
   * owning `org_id`, then {@link scoped}). The default room's key IS the
   * project id verbatim — this is the zero-config rendezvous: two agents
   * holding the same `run402.config.json` land in the same room with no
   * shared setup.
   */
  async forProject(projectId: string): Promise<ScopedRoom> {
    if (!projectId) {
      throw new LocalError("rooms.forProject requires a projectId", "resolving a project's default room");
    }
    const project = await this.client.request<{ org_id?: string | null }>(
      `/projects/v1/${encodeURIComponent(projectId)}`,
      { method: "GET", context: "resolving a project's default room" },
    );
    const orgId = typeof project.org_id === "string" ? project.org_id : "";
    if (!orgId) {
      throw new LocalError(
        "rooms.forProject could not resolve the project's owning org: the project read carried no org_id",
        "resolving a project's default room",
      );
    }
    return this.scoped(orgId, projectId);
  }
}

/**
 * A room-scoped sub-client returned by {@link Rooms.scoped} /
 * {@link Rooms.forProject}. The `(orgId, roomKey)` pair is bound at
 * construction; instance operations drop both leading arguments.
 */
export class ScopedRoom {
  /** The org id this sub-client is bound to. Read-only. */
  readonly orgId: string;
  /** The room key this sub-client is bound to (a project id for a default room). Read-only. */
  readonly roomKey: string;

  constructor(private readonly rooms: Rooms, orgId: string, roomKey: string) {
    if (!orgId) {
      throw new LocalError("rooms.scoped requires an orgId", "scoping client to room");
    }
    if (!roomKey) {
      throw new LocalError("rooms.scoped requires a roomKey", "scoping client to room");
    }
    this.orgId = orgId;
    this.roomKey = roomKey;
  }

  /** See {@link Rooms.get}. */
  get(): Promise<RoomSummary> {
    return this.rooms.get(this.orgId, this.roomKey);
  }

  /** See {@link Rooms.leave}. */
  leave(presenceId: string): Promise<RoomLeaveResult> {
    return this.rooms.leave(this.orgId, this.roomKey, presenceId);
  }

  /** See {@link Rooms.registerPresence}. */
  registerPresence(opts: RegisterPresenceOptions = {}): Promise<PresenceRegistration> {
    return this.rooms.registerPresence(this.orgId, this.roomKey, opts);
  }

  /** See {@link Rooms.listPresences}. */
  listPresences(opts: ListPresencesOptions = {}): Promise<RoomPresenceList> {
    return this.rooms.listPresences(this.orgId, this.roomKey, opts);
  }

  /** See {@link Rooms.getPresence}. */
  getPresence(presenceId: string): Promise<RoomPresence> {
    return this.rooms.getPresence(this.orgId, this.roomKey, presenceId);
  }

  /** See {@link Rooms.sendMessage}. */
  sendMessage(input: SendRoomMessageInput): Promise<SentRoomMessage> {
    return this.rooms.sendMessage(this.orgId, this.roomKey, input);
  }

  /** See {@link Rooms.listMessages}. */
  listMessages(opts: ListRoomMessagesOptions = {}): Promise<RoomMessagePage> {
    return this.rooms.listMessages(this.orgId, this.roomKey, opts);
  }

  /** See {@link Rooms.getMessage}. */
  getMessage(messageId: string): Promise<RoomMessage> {
    return this.rooms.getMessage(this.orgId, this.roomKey, messageId);
  }

  /** See {@link Rooms.waitForMessages}. */
  waitForMessages(opts: WaitForRoomMessagesOptions = {}): Promise<RoomMessageWaitResult> {
    return this.rooms.waitForMessages(this.orgId, this.roomKey, opts);
  }

  /** See {@link Rooms.ackMessage}. */
  ackMessage(messageId: string, opts: AckRoomMessageOptions = {}): Promise<RoomAckResult> {
    return this.rooms.ackMessage(this.orgId, this.roomKey, messageId, opts);
  }

  /** See {@link Rooms.createClaim}. */
  createClaim(input: CreateRoomClaimInput): Promise<CreatedRoomClaim> {
    return this.rooms.createClaim(this.orgId, this.roomKey, input);
  }

  /** See {@link Rooms.listClaims}. */
  listClaims(opts: ListRoomClaimsOptions = {}): Promise<RoomClaimList> {
    return this.rooms.listClaims(this.orgId, this.roomKey, opts);
  }

  /** See {@link Rooms.releaseClaim}. */
  releaseClaim(claimId: string): Promise<RoomClaimReleaseResult> {
    return this.rooms.releaseClaim(this.orgId, this.roomKey, claimId);
  }
}
