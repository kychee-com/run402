/**
 * Request/response types for the `events` namespace — the cursored project
 * events feed (`GET /projects/v1/:project_id/events` and
 * `GET /orgs/v1/:org_id/events`).
 *
 * The feed is the platform's durable, ordered record of operationally
 * significant facts (deploy activations, mailbox suspensions, transfers,
 * lifecycle cliffs, verification outcomes). Cursors are OPAQUE (`evc_…`):
 * store the page's `cursor` and pass it back as `{ cursor }` next time —
 * never parse it. The platform owns the event vocabulary, `next_actions`
 * synthesis, and reset behavior; the SDK passes everything through.
 */

/** A platform-synthesized drill-down suggestion attached to a feed event. */
export interface ProjectEventNextAction {
  type: string;
  method?: string;
  path?: string;
  command?: string;
  why?: string;
  [key: string]: unknown;
}

/** One immutable fact from the project events feed. */
export interface ProjectEvent {
  /** Opaque event cursor (`evc_…`) — also a valid `cursor` input to resume after this event. */
  id: string;
  /** Flat snake_case event name, e.g. `deploy_activated`, `mailbox_suspended`. */
  event_type: string;
  /** Event class stamped at write time (drives retention: mandatory classes keep 365 days, others 90). */
  class: string;
  occurred_at: string;
  /** Compact fact: resource ids + verdict fields. Oversize payloads carry `payload_truncated: true` + `dropped_keys[]`. */
  payload: Record<string, unknown>;
  /** Platform-synthesized drill-downs — the highest-probability next call. */
  next_actions: ProjectEventNextAction[];
  [key: string]: unknown;
}

/** Options for {@link Events.list} / {@link Events.listForOrg}. */
export interface ListEventsOptions {
  /**
   * Opaque cursor from a prior page (`cursor` field or an event `id`).
   * Returns events strictly after it. Omit on first contact to start from
   * the earliest retained event.
   */
  cursor?: string;
  /** Page size (server default 50, max 200). */
  limit?: number;
}

/** One page of the events feed, oldest-first. */
export interface ProjectEventFeedPage {
  events: ProjectEvent[];
  /**
   * High-water mark: pass back as `{ cursor }` next time. Present even when
   * `events` is empty (an empty page echoes your own cursor unchanged).
   */
  cursor: string;
  /** True when more events are immediately available past `cursor`. */
  has_more: boolean;
  /**
   * True when the supplied cursor was unusable (malformed or older than the
   * retention floor). The page restarts from the earliest retained event and
   * `earliest_cursor` is provided — never a bare error, never a silent skip.
   */
  reset: boolean;
  /** Present only when `reset` is true: a cursor just before the earliest retained event. */
  earliest_cursor?: string;
  [key: string]: unknown;
}
