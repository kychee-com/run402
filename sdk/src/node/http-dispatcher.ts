/**
 * The client-owned HTTP dispatcher (gitvault-owned-dispatcher).
 *
 * Node's built-in fetch pool has the one behavior no prewarm can beat: a
 * request issued while a socket is still CONNECTING dials a second socket
 * instead of queueing, so the first real operation of every invocation pays
 * the full DNS+TCP+TLS premium no matter how early the prewarm fired
 * (measured: ~800 ms first-op wire on a no-op fetch whose server work is
 * ~33 ms). Owning the dispatcher fixes both halves:
 *
 *   - the API origin is served by a SINGLE undici `Client` with `allowH2`
 *     (api.run402.com's ALB negotiates HTTP/2): requests queue on the one
 *     — possibly still connecting — socket and multiplex once it is up, so
 *     the prewarm's dial IS the verb's dial;
 *   - its connector persists the TLS session ticket under the profile config
 *     dir, so the NEXT process resumes the session instead of performing a
 *     full handshake.
 *
 * Every other origin (presigned S3/edge GETs) keeps a default `Pool` —
 * those are HTTP/1.1 and the bounded-concurrency pack fetches want real
 * parallel sockets.
 *
 * Version coherence (design D1): this module uses npm undici's OWN `fetch`
 * with an explicit dispatcher — never the cross-realm global-dispatcher
 * symbol, which would marry npm undici 7's dispatch contract to whatever
 * undici the running Node bundles (6.x on Node 22, the engines floor).
 * `globalThis.fetch` is untouched for everything that is not the SDK.
 *
 * Test seam (design D4): suites deliberately monkeypatch `globalThis.fetch`
 * and must keep seeing every request. `sdkFetch` captures the original
 * global fetch at module load and defers to the CURRENT global whenever it
 * is not that original; the owned dispatcher serves only the unpatched case.
 */
import { readFileSync, lstatSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { connect as tlsConnect } from "node:tls";
import { Agent, Client, Pool, fetch as undiciFetch, type Dispatcher, type buildConnector } from "undici";
import { getApiBase, getConfigDir } from "../../core-dist/config.js";

/** Session tickets above this size are refused (sanity, not a protocol bound). */
const MAX_TICKET_BYTES = 16 * 1024;

/**
 * Best-effort TLS session persistence for ONE origin (the API's). A missing,
 * stale, rejected, oversized, symlinked, or unreadable ticket degrades to a
 * full handshake; a failed write is silently dropped. Raw ticket bytes,
 * owner-only file, atomic rename — the keystore file discipline.
 */
class TicketStore {
  #path: string;
  #loaded = false;
  #ticket: Buffer | null = null;

  constructor(path: string) {
    this.#path = path;
  }

  get(): Buffer | undefined {
    if (!this.#loaded) {
      this.#loaded = true;
      try {
        const st = lstatSync(this.#path, { throwIfNoEntry: false });
        if (st && st.isFile() && !st.isSymbolicLink() && st.size > 0 && st.size <= MAX_TICKET_BYTES) {
          this.#ticket = readFileSync(this.#path);
        }
      } catch {
        /* silent by contract */
      }
    }
    return this.#ticket ?? undefined;
  }

  put(session: Buffer): void {
    if (session.length === 0 || session.length > MAX_TICKET_BYTES) return;
    this.#ticket = session;
    try {
      mkdirSync(join(this.#path, ".."), { recursive: true, mode: 0o700 });
      const tmp = `${this.#path}.tmp-${process.pid}`;
      writeFileSync(tmp, session, { mode: 0o600, flag: "w" });
      renameSync(tmp, this.#path);
    } catch {
      /* silent by contract */
    }
  }
}

/**
 * A connector for the API origin only: offers the stored session for
 * resumption, captures the fresh ticket, negotiates h2 via ALPN. Shape and
 * error discipline mirror undici's buildConnector (callback exactly once).
 */
function apiConnector(store: TicketStore): buildConnector.connector {
  return ((options: { hostname: string; host?: string; port?: string | number; servername?: string }, callback: (err: Error | null, socket: import("node:tls").TLSSocket | null) => void): void => {
    let done = false;
    const fin = (err: Error | null, socket: import("node:tls").TLSSocket | null): void => {
      if (done) return;
      done = true;
      callback(err, socket);
    };
    try {
      const socket = tlsConnect({
        host: options.host ?? options.hostname,
        port: options.port ? Number(options.port) : 443,
        servername: options.servername || options.hostname,
        ALPNProtocols: ["h2", "http/1.1"],
        session: store.get(),
      });
      socket.setNoDelay(true);
      socket.on("session", (session: Buffer) => store.put(session));
      socket.once("secureConnect", () => fin(null, socket));
      socket.once("error", (err: Error) => fin(err, null));
    } catch (err) {
      fin(err as Error, null);
    }
  }) as unknown as buildConnector.connector;
}

/** Test-only export of the store (the class itself is not public API). */
export { TicketStore as _TicketStoreForTests };

let agentSingleton: Agent | null = null;

/** The owned dispatcher — created lazily so config/env resolution happens at first use, once per process. */
export function sdkDispatcher(): Dispatcher {
  if (agentSingleton) return agentSingleton;
  let apiOrigin: string | null = null;
  let store: TicketStore | null = null;
  try {
    apiOrigin = new URL(getApiBase()).origin;
    store = new TicketStore(join(getConfigDir(), "tls-session-api.v1.bin"));
  } catch {
    /* no config — every origin gets the default Pool */
  }
  agentSingleton = new Agent({
    factory(origin, opts) {
      const o = typeof origin === "string" ? origin : origin.origin;
      if (apiOrigin && store && o === apiOrigin && o.startsWith("https:")) {
        // ONE connection: requests queue on the connecting socket (never a
        // second dial) and multiplex over h2 where the origin negotiates it.
        // Keep-alive sits just under the ALB's 60 s idle timeout — the
        // undici default (~4 s) silently re-dialed between a RESIDENT
        // daemon's sessions, observed as ~340 ms median first-op wire where
        // a genuinely warm socket serves at ~150 ms.
        return new Client(origin, { ...opts, allowH2: true, keepAliveTimeout: 55_000, keepAliveMaxTimeout: 55_000, connect: apiConnector(store) });
      }
      return new Pool(origin, opts);
    },
  });
  return agentSingleton;
}

/** Test-only: drop the singleton so a suite can re-resolve config. */
export function _resetSdkDispatcher(): void {
  agentSingleton = null;
}

const ORIGINAL_GLOBAL_FETCH = globalThis.fetch;
/**
 * A suite may install its fetch mock BEFORE this module first loads (a
 * dynamic-import graph behind a beforeEach), making the captured "original"
 * the mock itself — identity comparison alone would then route real network
 * traffic. Node's built-in fetch is named "fetch"; every in-repo mock is a
 * differently-named function. When the captured value does not look native,
 * identity proves nothing: always defer to the live global.
 */
const CAPTURED_LOOKS_NATIVE = typeof ORIGINAL_GLOBAL_FETCH === "function" && ORIGINAL_GLOBAL_FETCH.name === "fetch";

/**
 * npm undici's fetch does not recognize the GLOBAL `Request` class (Node's
 * bundled undici is a different instance), stringifying it to
 * "[object Request]" and failing URL parsing — and the x402 buyer path
 * constructs global Requests. Normalize a foreign Request-like input into
 * (url, init), buffering the body (SDK request bodies are small JSON;
 * nothing streams uploads through fetch — presigned PUTs carry bytes
 * explicitly).
 */
async function normalizedUndiciFetch(input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]): Promise<Response> {
  let url: string | URL;
  let mergedInit = init as Record<string, unknown> | undefined;
  if (typeof input === "object" && input !== null && !(input instanceof URL) && typeof (input as Request).url === "string") {
    const req = input as Request;
    url = req.url;
    const method = (init?.method ?? req.method ?? "GET").toUpperCase();
    const body = init?.body !== undefined ? init.body : method !== "GET" && method !== "HEAD" ? Buffer.from(await req.arrayBuffer()) : undefined;
    // No spread: Headers is not iterable under every entrypoint lib config.
    const headerPairs: Array<[string, string]> = [];
    req.headers.forEach((value, key) => headerPairs.push([key, value]));
    mergedInit = {
      method,
      headers: init?.headers ?? headerPairs,
      ...(body !== undefined ? { body } : {}),
      ...(init?.signal || req.signal ? { signal: init?.signal ?? req.signal } : {}),
      ...(init?.redirect || req.redirect ? { redirect: init?.redirect ?? req.redirect } : {}),
    };
  } else {
    url = input as string | URL;
  }
  return undiciFetch(url, {
    ...(mergedInit as Parameters<typeof undiciFetch>[1]),
    dispatcher: sdkDispatcher(),
  }) as unknown as Promise<Response>;
}

/**
 * The SDK's transport fetch. Unpatched process → npm undici's fetch on the
 * owned dispatcher. A test that replaced `globalThis.fetch` sees every
 * request instead, exactly as before this change (design D4).
 */
export const sdkFetch: typeof globalThis.fetch = (input, init) => {
  if (!CAPTURED_LOOKS_NATIVE || globalThis.fetch !== ORIGINAL_GLOBAL_FETCH) return globalThis.fetch(input, init);
  return normalizedUndiciFetch(input, init);
};
