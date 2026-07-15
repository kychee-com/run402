/**
 * `events` namespace — the cursored project events feed (gateway
 * `project-events-outbox`). One call answers "what happened to my project
 * since I last looked": deploy activations, mailbox suspensions, transfers,
 * lifecycle cliffs, verification outcomes — each with platform-synthesized
 * `next_actions[]` drill-downs.
 *
 * Cursor contract (opaque, store-and-echo): keep the page's `cursor`
 * wherever you keep state and pass it back as `{ cursor }` next time. An
 * unusable cursor never errors — the page returns `reset: true` +
 * `earliest_cursor` and restarts from the earliest retained event. Events
 * become visible within seconds of commit (a short visibility watermark
 * orders concurrent transactions) and are never lost after it.
 *
 * Exposed both unscoped (`r.events.list(projectId, …)`) and project-scoped
 * (`r.project(id).events.list(…)`), mirroring `r.grants` / `r.functions`.
 * The read is never lifecycle-gated: a frozen project's feed stays readable.
 *
 * `{ source, eventType }` filter the app-emitted lane from the platform's
 * own events — see {@link ListEventsOptions}. Consumers should key on
 * `(source, event_type)` together, since the platform's vocabulary and an
 * app's own `event_type` names are only disambiguated by the pair.
 */

import type { Client } from "../kernel.js";
import { LocalError } from "../errors.js";
import type { ListEventsOptions, ProjectEventFeedPage } from "./events.types.js";

function feedQuery(opts: ListEventsOptions = {}): string {
  const params = new URLSearchParams();
  if (opts.cursor !== undefined) params.set("cursor", opts.cursor);
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  if (opts.source !== undefined) params.set("source", opts.source);
  if (opts.eventType !== undefined) {
    params.set("event_type", Array.isArray(opts.eventType) ? opts.eventType.join(",") : opts.eventType);
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export class Events {
  constructor(private readonly client: Client) {}

  /**
   * Read a page of a project's events feed
   * (`GET /projects/v1/:project_id/events`). Accepted credentials: the
   * project's own service_key, a SIWX/control-plane principal with
   * `project.read`, or a scoped delegate. `opts.source` / `opts.eventType`
   * filter to the app lane, the platform lane, or one-or-more event types;
   * both compose with `cursor`/`limit` unchanged.
   */
  async list(projectId: string, opts: ListEventsOptions = {}): Promise<ProjectEventFeedPage> {
    if (!projectId) {
      throw new LocalError("events.list requires a projectId", "reading project events feed");
    }
    return this.client.request<ProjectEventFeedPage>(
      `/projects/v1/${encodeURIComponent(projectId)}/events${feedQuery(opts)}`,
      { method: "GET", context: "reading project events feed" },
    );
  }

  /**
   * Read the org-wide feed — the union across every project the org owns
   * (`GET /orgs/v1/:org_id/events`). Principal-only: requires an active org
   * membership; a project service_key is rejected by the gateway. Same
   * `opts.source` / `opts.eventType` filters as {@link list}.
   */
  async listForOrg(orgId: string, opts: ListEventsOptions = {}): Promise<ProjectEventFeedPage> {
    if (!orgId) {
      throw new LocalError("events.listForOrg requires an orgId", "reading org events feed");
    }
    return this.client.request<ProjectEventFeedPage>(
      `/orgs/v1/${encodeURIComponent(orgId)}/events${feedQuery(opts)}`,
      { method: "GET", context: "reading org events feed" },
    );
  }
}
