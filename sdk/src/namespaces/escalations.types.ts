/**
 * Wire types for the `escalations` namespace — the agent→human hotline
 * (gateway `add-agent-escalations`).
 *
 * Every field is the gateway's `snake_case` wire shape, passed through
 * unchanged. Timestamps are ISO 8601.
 */

/** Who raised it. An escalation is always attributed — that is the point. */
export interface EscalationRaisedBy {
  /** The control-plane principal the judgement belongs to. */
  principal_id: string;
  /** Set when the raiser was a scoped delegate rather than a member. */
  delegate_id: string | null;
  /** The coordination-room presence name, when the agent supplied one. */
  presence_name: string | null;
}

/** A human took ownership. This is what the raiser is waiting for. */
export interface EscalationAcknowledgement {
  at: string;
  /** The acking human's verified email; null when acked by an unnamed token tap. */
  by_email: string | null;
  /** `token` = one-tap link from the page; `authenticated` = an org member. */
  channel: "token" | "authenticated";
}

export interface EscalationResolution {
  at: string;
  by_email: string | null;
  note: string | null;
}

/** One deadman hop, appended when a level let its deadline lapse. */
export interface EscalationClimb {
  from_level: number;
  to_level: number;
  at: string;
  reason: "deadline_lapsed";
}

/**
 * What actually happened on the wire, per contact × channel. Only present when
 * the read asked for it (`include: "delivery"`) — it is read from the delivery
 * audit log, never assumed.
 */
export interface EscalationDeliveryAttempt {
  email: string;
  /** `email` | `telegram` | `webhook`. */
  channel: string;
  /** `delivered` | `failed_transient` | `failed_permanent` | `skipped_disabled`. */
  status: string;
  error: string | null;
  at: string;
}

export interface Escalation {
  escalation_id: string;
  org_id: string;
  /**
   * A SOFT reference: the escalation outlives this project's deletion, because
   * the case that matters most is being paged about something that then gets
   * deleted.
   */
  project_id: string | null;
  raised_by: EscalationRaisedBy;
  severity: "normal" | "high";
  /** The agent's argument, verbatim. Rendered as DATA wherever it is shown. */
  reason: string;
  /** Structured sidecar. Readable here; never rendered into a page body. */
  details: Record<string, unknown>;
  status: "open" | "acknowledged" | "resolved";
  /** Which contact level is currently paged. */
  level: number;
  raised_at: string;
  /** When an unacknowledged escalation climbs to the next level. */
  deadline_at: string;
  acknowledged: EscalationAcknowledgement | null;
  resolved: EscalationResolution | null;
  climbs: EscalationClimb[];
  /**
   * Top-level re-pages so far. At the bound the escalation rests OPEN — never
   * auto-resolved, because "every human was paged and none answered" is not
   * the same thing as "handled".
   */
  repage_count: number;
  /** Only when the read passed `include: "delivery"`. */
  delivery_attempts?: EscalationDeliveryAttempt[];
}

/**
 * Who the raise is about to page. FUTURE TENSE on purpose: at raise time the
 * page is enqueued, not delivered, and a contact with no verified operator
 * email never receives the Telegram half at all. Ask for
 * `include: "delivery"` on a read to learn what actually landed.
 */
export interface EscalationDelivery {
  status: "queued";
  level: number;
  will_page: Array<{ email: string; display_name: string | null }>;
  deadline_at: string;
}

export interface RaisedEscalation extends Escalation {
  delivery: EscalationDelivery;
  /** True when an `idempotencyKey` replay returned the ORIGINAL escalation. */
  deduplicated: boolean;
  /**
   * Non-blocking reachability notes — e.g. the org has no escalation contacts
   * configured, so the escalation was recorded but nobody was paged.
   */
  warnings?: string[];
  next_actions?: Array<Record<string, unknown>>;
}

export interface EscalationList {
  escalations: Escalation[];
  /**
   * `organization` when the caller is a member (sees every escalation);
   * `own` for a delegate or grant-only principal (sees only what it raised).
   */
  scope: "organization" | "own";
  has_more: boolean;
  /** Opaque keyset continuation. Store and echo; never parse. */
  next_cursor: string | null;
}

export interface EscalationContact {
  contact_id: string;
  email: string;
  display_name: string | null;
  /** An ordering, not a rank: level 1 is paged first. */
  level: number;
  created_at: string;
  /** Present when the address has no verified operator email yet. */
  warnings?: string[];
}

export interface EscalationContactList {
  escalation_contacts: EscalationContact[];
}

export interface RaiseEscalationInput {
  /**
   * Your argument for why a human is needed. Over ~4 KiB is a 400, never a
   * truncation — the argument IS the escalation.
   */
  reason: string;
  severity?: "normal" | "high";
  projectId?: string;
  /** Your coordination-room presence name, so a human knows which agent this is. */
  presenceName?: string;
  details?: Record<string, unknown>;
  /** A replay returns the ORIGINAL escalation and never pages twice. */
  idempotencyKey?: string;
}

export interface ListEscalationsOptions {
  status?: "open" | "acknowledged" | "resolved";
  limit?: number;
  /** Opaque `next_cursor` from a previous page. */
  cursor?: string;
}

export interface GetEscalationOptions {
  /**
   * `"delivery"` adds `delivery_attempts[]` from the delivery audit log.
   * Opt-in: the wait-for-human poll is the hot path and should not pay for an
   * audit read it rarely needs.
   */
  include?: "delivery";
}

export interface AddEscalationContactInput {
  email: string;
  displayName?: string;
  /** Defaults to 1. Level N is paged only if level < N let the deadline lapse. */
  level?: number;
}

export interface EscalationActionResult extends Escalation {
  /** False on an idempotent replay — the ORIGINAL acknowledgement is reported. */
  changed: boolean;
}

export interface TokenAckResult {
  escalation_id: string;
  status: "acknowledged" | "resolved";
  acknowledged_at: string | null;
  changed: boolean;
  reason: string;
}
