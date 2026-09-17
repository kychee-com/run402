/**
 * tenant-live-changes — change hints for live tables (`tables[].live: true`
 * in the expose manifest). A hint says WHAT changed (table, operation, the
 * primary keys touched), never the row: refetch through the REST API under
 * your own key, so RLS keeps deciding what you may see.
 */

export type LiveOp = "insert" | "update" | "delete";

/** One change hint. `pk: null` is a table-level hint: refetch the table. */
export interface LiveChange {
  table: string;
  op: LiveOp;
  pk: Array<Record<string, unknown>> | null;
  /** Rows the statement touched (for this owner group). */
  n: number;
  /** Continue from here (`cursor` on the held read, `Last-Event-ID` on the stream). */
  cursor: string;
}

/** `GET /live/v1/changes` response. `resync: true` means the cursor could not be answered: refetch `tables`. */
export interface LiveChangesPage {
  changes: LiveChange[];
  cursor: string;
  resync: boolean;
  tables?: string[];
  waited_seconds?: number;
}

export type LiveResyncReason =
  | "cursor_expired"
  | "listener_reconnect"
  | "slot_reset"
  | "foreign_epoch"
  | "before_listen"
  | (string & {});

/** Who the subscription reads as. `anon` uses the project's anon key; `user` adds a
 *  user access token; `service` uses the service key and sees every hint. */
export type LiveAudienceOptions =
  | { as?: "anon" }
  | { as: "user"; accessToken: string }
  | { as: "service" };

export type LiveChangesOptions = {
  /** Live table names to read. */
  tables: string[];
  /** Cursor from a previous page or a `change` event; omit to start now. */
  cursor?: string;
  /** Hold up to this many seconds for the first hint (clamped 1..25 by the gateway). */
  wait?: number;
} & LiveAudienceOptions;

export type LiveSubscribeOptions = {
  tables: string[];
  /** Resume from this cursor (sent as `Last-Event-ID`). */
  cursor?: string;
  /** Stop the subscription. `close()` on the handle does the same. */
  signal?: AbortSignal;
} & LiveAudienceOptions;

/** Events delivered to a `live.subscribe` callback. */
export type LiveEvent =
  | { type: "ready"; cursor: string; tables: string[] }
  | { type: "change"; change: LiveChange }
  | { type: "resync"; tables: string[]; reason: LiveResyncReason }
  | { type: "reconnect"; cursor: string | null; reason: string }
  | { type: "disconnected"; reason: string; retry_in_ms: number };

export interface LiveSubscription {
  /** Stop streaming; `done` resolves once the loop has exited. */
  close(): void;
  readonly done: Promise<void>;
}
