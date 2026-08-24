/**
 * Request/response types for the `events` namespace — the cursored project
 * events feed (`GET /projects/v1/:project_id/events` and
 * `GET /orgs/v1/:org_id/events`).
 *
 * The feed is the platform's durable, ordered record of operationally
 * significant facts (deploy activations, mailbox suspensions, transfers,
 * lifecycle cliffs, verification outcomes, and `platform_incident`
 * fault-attribution events).
 *
 * An ORGANIZATION owns each fact and `project_id` says what it is about, so
 * three things follow. The org feed is a SUPERSET of the project feeds: it
 * also carries organization-level facts, which belong to no project and
 * arrive with `project_id: null`. A fact OUTLIVES the project it describes —
 * deleting a project no longer erases its history, so a row may name a
 * project that no longer exists. And an event's `id` is NOT a page cursor:
 * see {@link ProjectEvent.id} and {@link ListEventsOptions.cursor}.
 *
 * Both tokens are OPAQUE (`evc_…`) — store the page's `cursor`, pass it back
 * as `{ cursor }` next time, and never parse either one. The
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

/** One immutable fact from the events feed. */
export interface ProjectEvent {
  /**
   * This event's opaque identity (`evc_…`). The SAME event carries the SAME
   * `id` in the project feed and the organization feed, which is what lets
   * you dedup across both.
   *
   * NOT a page cursor. An id names a FACT; a cursor names a POSITION inside
   * one projection, and only the page's `cursor` is that. Passing an `id` as
   * `{ cursor }` returns `reset: true` rather than resuming.
   */
  id: string;
  /**
   * What this fact is ABOUT — `null` for an organization-level fact, which
   * belongs to the organization and to no project. Those appear only on the
   * organization feed; a project feed can never show them.
   *
   * May name a project that NO LONGER EXISTS: a fact outlives the project it
   * describes, so do not assume this resolves.
   */
  project_id: string | null;
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
   * Opaque page cursor from a prior page's `cursor` field. Returns events
   * strictly after it. Omit on first contact to start from the earliest
   * retained event.
   *
   * A page cursor is bound to the PROJECTION that issued it — the feed you
   * read plus any `source` / `eventType` filters. It is not portable:
   * replaying a project feed's cursor against the organization feed, an
   * unfiltered cursor against a filtered read, or an event `id` in place of a
   * cursor all return `reset: true` instead of resuming, because resuming
   * would silently skip exactly the rows the other projection omitted.
   *
   * So key any cursor you persist by the read shape it came from.
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
   * True when the supplied cursor was unusable — malformed, older than the
   * retention floor, issued for a DIFFERENT projection (another feed or
   * filter set), or actually an event `id`. The page restarts from the
   * earliest retained event and `earliest_cursor` is provided — never a bare
   * error, never a silent skip.
   */
  reset: boolean;
  /**
   * Present only when `reset` is true: a page cursor just before the earliest
   * retained event, issued for the projection you actually read.
   */
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
