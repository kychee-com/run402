/**
 * Request/response types for the `events` namespace — the cursored project
 * events feed (`GET /projects/v1/:project_id/events` and
 * `GET /orgs/v1/:org_id/events`).
 *
 * The feed is the platform's durable, ordered record of operationally
 * significant facts (deploy activations, mailbox suspensions, transfers,
 * lifecycle cliffs, verification outcomes, and `platform_incident`
 * fault-attribution events). Cursors are OPAQUE (`evc_…`): store the page's
 * `cursor` and pass it back as `{ cursor }` next time — never parse it. The
 * platform owns the event vocabulary, `next_actions` synthesis, and reset
 * behavior; the SDK passes everything through (index signatures keep unknown
 * future fields, including the additive `platform_incidents[]` overlay and
 * `platform_status` rider on the page).
 *
 * The feed also carries app-emitted business facts alongside platform
 * events (the `app-events-emit-lane` capability): every row is
 * `source`-discriminated — `"app"` for a deployed function's own
 * `events.emit(...)` calls, `"platform"` for everything else (the
 * platform's internal sources, e.g. `gateway` / `email-lambda`, collapse
 * under that one value). `list` / `listForOrg` accept optional `source` and
 * `eventType` filters (see {@link ListEventsOptions}); consumers should key
 * on `(source, event_type)` together — a platform type added later can
 * share a name with an app's own vocabulary, and only the pair disambiguates.
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
  /**
   * Restrict to the app-emitted lane (`"app"`) or every other source
   * (`"platform"` — `source <> 'app'`). Omit for the unfiltered feed
   * (platform + app together). Composes with cursor pagination unchanged.
   */
  source?: "app" | "platform";
  /**
   * Restrict to one or more event types (OR match). Pass a single name, or
   * an array for readability — either way it serializes to the wire as the
   * comma-joined `event_type` query param (`event_type=a,b`).
   */
  eventType?: string | string[];
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
  /**
   * Sidecar overlay of open GLOBAL (unattributed) platform incidents, each
   * with a stable `id` for dedup across reads. Present only while such an
   * incident is open; NEVER interleaved into `events[]` (the cursor stays
   * monotonic). Attributed incidents instead land as a `platform_incident`
   * row inside `events[]`. Access via the index signature — pass-through.
   */
  platform_incidents?: Array<Record<string, unknown>>;
  /**
   * Health rider: `"degraded"` while an open platform incident is global or
   * affects one of your projects; omitted when clear. The same rider appears
   * on `r.admin.getOperatorStatus()` and `r.tiers.status()`. Pass-through via
   * the index signature.
   */
  platform_status?: string;
  [key: string]: unknown;
}
