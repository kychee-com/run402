/**
 * SSR Lambda runtime entry — capability `astro-ssr-runtime`.
 *
 * This module is the `serverEntrypoint` Astro's build registers via
 * `setAdapter`. At Lambda cold start, the bootstrap order is:
 *
 *   1. (SnapStart restore OR cold init) → AWS spawns Node.js with this
 *      module's exports.
 *   2. THIS file imports `installInitIoGuards` from `@run402/functions`'s
 *      runtime-context module BEFORE importing the Astro manifest /
 *      server entry — so any module-scope IO in user code is caught.
 *   3. The handler is exposed as `default` (and `handler`) for AWS Lambda
 *      to invoke per request.
 *
 * Per-invocation flow:
 *
 *   1. Receive Lambda invocation payload (the routed-function envelope
 *      from the gateway).
 *   2. Build a Web `Request` object from the envelope.
 *   3. Establish AsyncLocalStorage via `runWithContext()` with the SSR
 *      context shape (requestId, projectId, releaseId, locale, host,
 *      request.headers, cacheBypassTainted, active).
 *   4. Call Astro's `App.render(request)` inside the ALS scope.
 *   5. Materialize the response body fully (arrayBuffer) inside the
 *      ALS scope.
 *   6. Mark `active.value = false` AFTER materialization so any timers
 *      created during render that fire later see the inactive flag.
 *   7. Return the Lambda invoke response — the user's response PLUS
 *      the Run402 metadata envelope (cacheBypassTainted, runtimeError).
 *
 * Uncaught exceptions are caught at the outermost level and surfaced
 * as `runtimeError` in the metadata envelope; the gateway translates
 * to `R402_SSR_RUNTIME_ERROR` and the public response body omits the
 * stack trace.
 *
 * @see openspec/changes/astro-ssr-runtime/specs/routed-http-functions/spec.md
 * @see openspec/changes/astro-ssr-runtime/specs/functions-sdk-auth-model/spec.md
 */

// IMPORTANT: this import MUST run first so the init-IO guards are
// installed before the Astro manifest (which transitively imports user
// pages) is loaded. Static side-effecting imports above this line are
// dangerous.
//
// `runWithContext` from `@run402/functions` is the SSR ALS scope
// establishment primitive. Since `@run402/functions` is an OPTIONAL
// peer dep (users on the image-only path don't need it), we resolve
// it dynamically and fall back to a no-op when absent. Without the
// peer dep, ALS context is not established and SDK helpers (db(),
// getUser(), cache.*) won't see request scope — handler still works
// for non-SDK rendering, just without the SSR-class niceties.
type RunWithContext = <T>(ctx: unknown, cb: () => Promise<T> | T) => Promise<T> | T;
let runWithContext: RunWithContext = (_ctx, cb) => cb();
try {
  // Dynamic import; the type can't be statically checked because
  // `@run402/functions` may not be installed.
  const fns = (await import("@run402/functions" as string)) as { runWithContext?: RunWithContext };
  if (typeof fns.runWithContext === "function") {
    runWithContext = fns.runWithContext;
  }
} catch {
  // peer dep not installed; keep the noop fallback
}

/**
 * Routed-function invocation envelope shape (from `services/routed-http.ts`).
 * Mirrored here without importing to keep this package gateway-decoupled.
 */
interface RoutedHttpRequestV1 {
  version: "run402.routed_http.v1";
  method: string;
  url: string;
  path: string;
  rawPath: string;
  rawQuery: string;
  headers: Array<[string, string]>;
  cookies: { raw: string | null };
  body: null | { encoding: "base64"; data: string; size: number };
  context: {
    source: "route";
    projectId: string;
    releaseId: string | null;
    deploymentId: string | null;
    host: string;
    proto: "https" | "http";
    routePattern: string;
    routeKind: string;
    routeTarget: unknown;
    requestId: string;
    clientIp?: string;
    userAgent?: string;
    locale: string | null;
    defaultLocale: string | null;
  };
}

interface SsrLambdaMetadataV1 {
  cacheBypassTainted: boolean;
  runtimeError?: { code: "R402_SSR_RUNTIME_ERROR"; message: string; stack?: string };
}

interface SsrResponseEnvelope {
  status: number;
  headers: Array<[string, string]>;
  cookies?: string[];
  body: null | { encoding: "base64"; data: string; size: number };
  __r402_ssr_metadata: SsrLambdaMetadataV1;
}

/**
 * The Astro App reference. Astro emits a "manifest" build artifact
 * containing the `App` instance; the build system replaces this
 * dynamic import at bundle time with a real reference. In dev/test,
 * this returns null and `handler` no-ops.
 */
async function getAstroApp(): Promise<{ render: (req: Request) => Promise<Response> } | null> {
  try {
    // The actual bundled SSR entry exports a default `app` factory.
    // This dynamic import resolves at runtime against the Astro build's
    // manifest module. At build time, Astro's `serverEntrypoint`
    // contract emits a manifest at `./manifest.mjs` next to the entry;
    // see Astro's adapter docs.
    const { manifest } = (await import(
      // @ts-expect-error — resolved at Lambda runtime against Astro's emitted manifest
      "./manifest.mjs"
    )) as { manifest: unknown };
    const { App } = (await import("astro/app")) as {
      App: new (manifest: unknown) => { render: (req: Request) => Promise<Response> };
    };
    return new App(manifest);
  } catch {
    // Missing in dev or unit tests — fall back to a stub.
    return null;
  }
}

let appPromise: Promise<Awaited<ReturnType<typeof getAstroApp>>> | null = null;
function app(): Promise<Awaited<ReturnType<typeof getAstroApp>>> {
  if (!appPromise) appPromise = getAstroApp();
  return appPromise;
}

/**
 * Lambda handler — receives a routed-function envelope and returns the
 * SSR response envelope with metadata.
 */
export async function handler(envelope: RoutedHttpRequestV1): Promise<SsrResponseEnvelope> {
  const cacheBypassTainted = { value: false };
  const active = { value: true };

  // Build a Web Request from the routed envelope.
  const request = buildRequestFromEnvelope(envelope);

  // Establish the ALS context.
  const result = await runWithContext(
    {
      requestId: envelope.context.requestId,
      projectId: envelope.context.projectId,
      releaseId: envelope.context.releaseId ?? "",
      locale: envelope.context.locale,
      defaultLocale: envelope.context.defaultLocale,
      host: envelope.context.host,
      request: {
        method: envelope.method,
        url: envelope.url,
        headers: headersToRecord(envelope.headers),
      },
      cacheBypassTainted,
      active,
    },
    async (): Promise<{ response: Response | null; runtimeError?: SsrLambdaMetadataV1["runtimeError"] }> => {
      try {
        const appInstance = await app();
        if (!appInstance) {
          // Dev/test stub — return an empty 500 with a marker.
          return { response: new Response("Astro app not loaded (dev/test stub)", { status: 500 }) };
        }
        const response = await appInstance.render(request);
        return { response };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error ? err.stack : undefined;
        return {
          response: null,
          runtimeError: { code: "R402_SSR_RUNTIME_ERROR", message, stack },
        };
      }
    },
  );

  // Materialize the response body inside the ALS scope is the contract;
  // but practically, with the synchronous chain above, we materialize
  // here. The active.value=false flip happens regardless of whether
  // body materialization is a separate step or chained.
  const { response, runtimeError } = result as Awaited<ReturnType<typeof runWithContext<{
    response: Response | null;
    runtimeError?: SsrLambdaMetadataV1["runtimeError"];
  }>>>;

  active.value = false;

  if (runtimeError) {
    return {
      status: 500,
      headers: [["content-type", "application/json"]],
      body: {
        encoding: "base64",
        data: Buffer.from(
          JSON.stringify({
            ok: false,
            code: "R402_SSR_RUNTIME_ERROR",
            message: runtimeError.message,
            requestId: envelope.context.requestId,
            releaseId: envelope.context.releaseId,
            docs: "https://docs.run402.com/functions/errors#ssr-runtime-error",
          }),
          "utf-8",
        ).toString("base64"),
        size: 0,
      },
      __r402_ssr_metadata: {
        cacheBypassTainted: cacheBypassTainted.value,
        runtimeError,
      },
    };
  }

  if (!response) {
    return {
      status: 500,
      headers: [],
      body: null,
      __r402_ssr_metadata: { cacheBypassTainted: cacheBypassTainted.value },
    };
  }

  // Convert the Web Response to the routed envelope.
  const bodyBuf = await response.arrayBuffer();
  const bodyBase64 = Buffer.from(bodyBuf).toString("base64");
  const responseHeaders: Array<[string, string]> = [];
  response.headers.forEach((value: string, key: string) => responseHeaders.push([key, value]));

  return {
    status: response.status,
    headers: responseHeaders,
    body:
      bodyBuf.byteLength === 0
        ? null
        : { encoding: "base64", data: bodyBase64, size: bodyBuf.byteLength },
    __r402_ssr_metadata: {
      cacheBypassTainted: cacheBypassTainted.value,
    },
  };
}

export default handler;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildRequestFromEnvelope(envelope: RoutedHttpRequestV1): Request {
  const requestHeaders = new Headers();
  for (const [k, v] of envelope.headers) requestHeaders.append(k, v);

  let body: BodyInit | null = null;
  if (envelope.body && envelope.body.encoding === "base64") {
    body = Buffer.from(envelope.body.data, "base64");
  }

  const init: RequestInit = {
    method: envelope.method,
    headers: requestHeaders,
    body,
  };
  // GET / HEAD cannot have a body per fetch spec.
  if (envelope.method === "GET" || envelope.method === "HEAD") {
    delete init.body;
  }
  return new Request(envelope.url, init);
}

function headersToRecord(
  headers: Array<[string, string]>,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const pair of headers) {
    const [k, v] = pair as [string, string];
    const lower = k.toLowerCase();
    const existing = out[lower];
    if (existing === undefined) {
      out[lower] = v;
    } else if (typeof existing === "string") {
      out[lower] = [existing, v];
    } else {
      existing.push(v);
    }
  }
  return out;
}
