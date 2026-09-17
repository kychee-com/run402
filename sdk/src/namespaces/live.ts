/**
 * tenant-live-changes — `r.live.subscribe(projectId, { tables }, onEvent)` and
 * `r.live.changes(projectId, { tables, cursor, wait })`, also project-scoped
 * as `r.project(id).live.*`.
 *
 * The stream is `GET /live/v1` as Server-Sent Events, read through the
 * injected fetch so it works in Node and browsers alike and can carry the
 * `apikey` header (a bare `EventSource` cannot). It reconnects on its own with
 * `Last-Event-ID`, honors the server's `retry:` hint and `Retry-After`, and
 * surfaces `resync` to the caller — the one event every consumer must handle:
 * refetch what you care about. The held read is one request.
 *
 * Helpers are module-level on purpose: the public surface of the class is
 * exactly `changes` and `subscribe` (the surface sync test enumerates runtime
 * methods, and `private` is erased at runtime).
 */
import type { Client } from "../kernel.js";
import { LocalError } from "../errors.js";
import type {
  LiveAudienceOptions,
  LiveChangesOptions,
  LiveChangesPage,
  LiveEvent,
  LiveSubscribeOptions,
  LiveSubscription,
} from "./live.types.js";

const DEFAULT_RETRY_MS = 3000;
const MAX_RETRY_MS = 30_000;

export class Live {
  constructor(private readonly client: Client) {}

  /** `GET /live/v1/changes` — hints since `cursor`, or hold up to `wait` seconds for the first one. */
  async changes(projectId: string, opts: LiveChangesOptions): Promise<LiveChangesPage> {
    const context = "reading live changes";
    const tables = assertTables(opts.tables, context);
    const headers = await authHeadersFor(this.client, projectId, opts, context);
    return this.client.request<LiveChangesPage>(
      `/live/v1/changes?${query(projectId, tables, { cursor: opts.cursor, wait: opts.wait === undefined ? undefined : String(opts.wait) })}`,
      { method: "GET", headers, withAuth: false, context },
    );
  }

  /**
   * `GET /live/v1` as a reconnecting SSE subscription. `onEvent` receives
   * `ready`, `change`, `resync`, `reconnect` (server-side lifetime close, the
   * loop reconnects) and `disconnected` (a retryable failure; the loop backs
   * off and retries). A non-retryable refusal (403 TABLE_NOT_LIVE, 401, 400)
   * rejects `done` with the gateway's error envelope, as `request` would.
   */
  subscribe(projectId: string, opts: LiveSubscribeOptions, onEvent: (event: LiveEvent) => void): LiveSubscription {
    const context = "subscribing to live changes";
    const tables = assertTables(opts.tables, context);
    const controller = new AbortController();
    if (opts.signal) {
      if (opts.signal.aborted) controller.abort();
      else opts.signal.addEventListener("abort", () => controller.abort(), { once: true });
    }
    const done = runStream(this.client, projectId, tables, opts, onEvent, controller.signal, context);
    return {
      close: () => controller.abort(),
      done,
    };
  }
}

function query(projectId: string, tables: string[], extra: Record<string, string | undefined>): string {
  const params = new URLSearchParams({ project_id: projectId, tables: tables.join(",") });
  for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== "") params.set(k, v);
  return params.toString();
}

function assertTables(tables: unknown, context: string): string[] {
  if (!Array.isArray(tables) || tables.length === 0 || tables.some((t) => typeof t !== "string" || t === "")) {
    throw new LocalError("live: `tables` must be a non-empty array of live table names", context);
  }
  return tables as string[];
}

async function authHeadersFor(client: Client, projectId: string, opts: LiveAudienceOptions, context: string): Promise<Record<string, string>> {
  const keys = await client.getProjectCredentials(projectId);
  if (!keys) {
    throw new LocalError(
      `live: no credentials stored for project ${projectId} (run \`run402 projects use ${projectId}\` or pass keys to the credentials provider)`,
      context,
    );
  }
  if (opts.as === "service") return { apikey: keys.service_key };
  if (opts.as === "user") return { apikey: keys.anon_key, Authorization: `Bearer ${opts.accessToken}` };
  return { apikey: keys.anon_key };
}

async function runStream(
  client: Client,
  projectId: string,
  tables: string[],
  opts: LiveSubscribeOptions,
  onEvent: (event: LiveEvent) => void,
  signal: AbortSignal,
  context: string,
): Promise<void> {
  let cursor: string | undefined = opts.cursor;
  let retryMs = DEFAULT_RETRY_MS;
  let failures = 0;
  const headers = await authHeadersFor(client, projectId, opts, context);
  const path = `/live/v1?${query(projectId, tables, {})}`;

  while (!signal.aborted) {
    let res: Response;
    try {
      res = await client.fetch(`${client.apiBase}${path}`, {
        method: "GET",
        headers: {
          ...headers,
          Accept: "text/event-stream",
          ...(cursor ? { "Last-Event-ID": cursor } : {}),
        },
        signal,
      });
    } catch (err) {
      if (signal.aborted) return;
      failures += 1;
      const wait = Math.min(retryMs * 2 ** Math.min(failures - 1, 4), MAX_RETRY_MS);
      onEvent({ type: "disconnected", reason: (err as Error).message ?? "fetch failed", retry_in_ms: wait });
      await sleep(wait, signal);
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      failures += 1;
      const retryAfter = Number(res.headers.get("retry-after"));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : Math.min(retryMs * 2 ** Math.min(failures - 1, 4), MAX_RETRY_MS);
      await res.body?.cancel().catch(() => {});
      onEvent({ type: "disconnected", reason: `HTTP ${res.status}`, retry_in_ms: wait });
      await sleep(wait, signal);
      continue;
    }
    if (!res.ok) {
      // Let the kernel map the refusal into the canonical error (TABLE_NOT_LIVE,
      // AUTH_REQUIRED, VALIDATION_FAILED …). It throws; if the race resolved,
      // fall through and subscribe again.
      await res.body?.cancel().catch(() => {});
      await client.request(path, { method: "GET", headers: { ...headers, Accept: "application/json" }, withAuth: false, context });
      continue;
    }
    if (!res.body) {
      onEvent({ type: "disconnected", reason: "empty body", retry_in_ms: retryMs });
      await sleep(retryMs, signal);
      continue;
    }
    failures = 0;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let serverClosed = false;
    try {
      for (;;) {
        const { value, done: streamDone } = await reader.read();
        if (streamDone) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const parsed = parseFrame(frame);
          if (parsed.retry !== undefined) retryMs = parsed.retry;
          if (parsed.id !== undefined) cursor = parsed.id;
          if (parsed.event === "ready") {
            const data = JSON.parse(parsed.data) as { cursor: string; tables: string[] };
            cursor = data.cursor;
            onEvent({ type: "ready", cursor: data.cursor, tables: data.tables });
          } else if (parsed.event === "change") {
            const data = JSON.parse(parsed.data) as { table: string; op: "insert" | "update" | "delete"; pk: Array<Record<string, unknown>> | null; n: number };
            onEvent({ type: "change", change: { ...data, cursor: parsed.id ?? cursor ?? "" } });
          } else if (parsed.event === "resync") {
            const data = JSON.parse(parsed.data) as { tables: string[]; reason: string };
            onEvent({ type: "resync", tables: data.tables, reason: data.reason });
          } else if (parsed.event === "reconnect") {
            const data = JSON.parse(parsed.data) as { reason: string; cursor?: string };
            if (data.cursor) cursor = data.cursor;
            serverClosed = true;
            onEvent({ type: "reconnect", cursor: cursor ?? null, reason: data.reason });
          }
        }
      }
    } catch (err) {
      if (signal.aborted) return;
      onEvent({ type: "disconnected", reason: (err as Error).message ?? "stream error", retry_in_ms: retryMs });
      await sleep(retryMs, signal);
      continue;
    } finally {
      reader.releaseLock?.();
    }
    if (signal.aborted) return;
    if (!serverClosed) {
      // The connection dropped without a reconnect event: back off briefly.
      onEvent({ type: "disconnected", reason: "stream ended", retry_in_ms: retryMs });
      await sleep(retryMs, signal);
    }
  }
}

function parseFrame(frame: string): { event?: string; data: string; id?: string; retry?: number } {
  let event: string | undefined;
  let id: string | undefined;
  let retry: number | undefined;
  const data: string[] = [];
  for (const line of frame.split("\n")) {
    if (line === "" || line.startsWith(":")) continue;
    const sep = line.indexOf(":");
    const field = sep === -1 ? line : line.slice(0, sep);
    let value = sep === -1 ? "" : line.slice(sep + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
    else if (field === "id") id = value;
    else if (field === "retry") {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) retry = n;
    }
  }
  return { event, data: data.join("\n"), id, retry };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
