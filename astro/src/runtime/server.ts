/**
 * SSR Lambda runtime entry — capability `astro-ssr-runtime`.
 *
 * This module is the `serverEntrypoint` Astro's build registers via
 * `setAdapter`. At Lambda cold start, the gateway's `buildEntryWrapper`
 * imports THIS module as `userModule` and calls its exported `handler`
 * with a Web `Request` — NOT the raw routed-function envelope. The
 * wrapper has already:
 *
 *   1. Translated the routed-function envelope into a Web `Request`,
 *      preserving all `x-run402-*` request headers (`x-run402-request-id`,
 *      `x-run402-project-id`, `x-run402-release-id`, `x-run402-locale`,
 *      `x-run402-default-locale`, `x-run402-host`, etc.).
 *   2. Established the AsyncLocalStorage request context via
 *      `runWithContext` (so `getUser()` / `db()` / `cache.*` etc. work
 *      inside the render).
 *
 * The adapter's job is the minimal: call `app.render(request)` and
 * return the `Response`, with every cookie set through `Astro.cookies` /
 * `context.cookies` written onto it as `Set-Cookie` (`addCookieHeader`;
 * Astro leaves them off the `Response` by default). The wrapper translates the Response back into
 * the routed-function envelope shape the gateway expects and attaches
 * the SSR metadata (the cache-bypass taint).
 *
 * Errors. Astro catches a throw in a page, an endpoint or a middleware
 * itself and answers the site's 500 page, so the wrapper never sees it. The
 * runtime notes that error, and the route pattern Astro matched, in the two
 * slots the wrapper puts on the request context (`caughtError`,
 * `routePattern`, reached through the `getCurrentContext` the wrapper publishes
 * on `Symbol.for("run402.getCurrentContext")`); on a response of
 * 500 or above the wrapper sends the error to the gateway as it does an
 * uncaught throw, with its `function.error` log line, and leaves the
 * response unchanged. Astro's own catches all end in
 * `app.renderError(request, { status: 500, error })`, which `BaseApp.render`
 * calls late-bound on the instance (Astro 6 and 7), so wrapping that method
 * on the app this module creates sees each one. A throw that escapes
 * `render` is answered with `R402_SSR_RUNTIME_ERROR` and noted the same way.
 * Under a wrapper without the slots, and on Run402 Core, nothing is noted.
 * A late error in a streamed page, after its 200 status left, is outside
 * this: it surfaces only as a broken body stream.
 *
 * (Pre-1.2.2 versions of this file tried to receive the raw envelope
 * AND establish ALS context themselves — which double-wrapped under the
 * gateway's `buildEntryWrapper` and crashed on `envelope.context.requestId`
 * because the wrapper passed a Web `Request`, not the envelope.)
 *
 * @see the astro-ssr-runtime OpenSpec change (routed-http-functions, functions-sdk-auth-model)
 */

/**
 * Shape of `Astro.locals.run402` — the Run402 SSR request context object
 * available inside Astro frontmatter / endpoints / middleware. Populated
 * by the project's middleware (or @run402/functions helpers) reading
 * AsyncLocalStorage. Exposed as a re-exported type from `@run402/astro`
 * so consumers can type their `Astro.locals` accesses.
 */
export interface Run402Locals {
  requestId: string;
  projectId: string;
  releaseId: string | null;
  locale: string | null;
  defaultLocale: string | null;
  host: string;
}

/**
 * The Astro App reference. Astro 6's auto-resolution contract bundles the
 * adapter's `serverEntrypoint` together with a virtual `astro/app/entrypoint`
 * module that exposes `createApp()` — the manifest is baked in at build
 * time and emitted next to this file. In dev/test (no Astro bundle), the
 * dynamic import throws and `handler` falls back to a stub.
 */
type AstroApp = {
  render: (req: Request, opts?: { addCookieHeader?: boolean }) => Promise<Response>;
  /** Astro's error-page renderer, called with the error behind every 500 Astro catches. */
  renderError?: (req: Request, opts: { status: number; error?: unknown }) => Promise<Response>;
  /** The route Astro matches for a request (`route` is its file pattern). */
  match?: (req: Request) => { route?: unknown } | undefined;
  /** Astro's build manifest: the middleware and page loaders `warmApp` evaluates. */
  manifest?: {
    middleware?: () => Promise<unknown>;
    pageMap?: Map<string, () => Promise<{ page?: () => Promise<unknown> }>>;
  };
};

/** The wrapper's request-context slots this runtime fills (function-diagnostics). */
interface ErrorSlots {
  caughtError?: { value: unknown };
  routePattern?: { value: unknown };
}

/**
 * The wrapper's `getCurrentContext`, which it publishes on this symbol. Read
 * without importing `@run402/functions` (an optional peer: a static import
 * would break a site that does not install it). Absent on Run402 Core and
 * under a wrapper that predates the slots.
 */
const GET_CURRENT_CONTEXT = Symbol.for("run402.getCurrentContext");

function errorSlots(): ErrorSlots | null {
  try {
    const getCurrentContext = (globalThis as Record<symbol, unknown>)[GET_CURRENT_CONTEXT];
    if (typeof getCurrentContext !== "function") return null;
    const ctx = (getCurrentContext as () => unknown)();
    return ctx && typeof ctx === "object" ? (ctx as ErrorSlots) : null;
  } catch {
    return null;
  }
}

/** Note the error behind a 500; the first one noted for a request is kept. */
function noteError(error: unknown): void {
  const slot = errorSlots()?.caughtError;
  if (slot && typeof slot === "object" && (slot.value === null || slot.value === undefined)) slot.value = error;
}

/** Note the route pattern Astro matched for the request (never its path). */
function noteRoute(appInstance: AstroApp, request: Request): void {
  const slot = errorSlots()?.routePattern;
  if (!slot || typeof slot !== "object" || typeof appInstance.match !== "function") return;
  try {
    const route = appInstance.match(request)?.route;
    if (typeof route === "string" && route.startsWith("/")) slot.value = route;
  } catch {
    // An unmatchable request has no route to note.
  }
}

/** Wrap the instance's `renderError` so each error Astro catches is noted before its 500 page renders. */
function noteCaughtErrors(appInstance: AstroApp): AstroApp {
  const renderError = appInstance.renderError;
  if (typeof renderError !== "function") return appInstance;
  appInstance.renderError = (request, options) => {
    if (options?.status === 500 && options.error !== null && options.error !== undefined) noteError(options.error);
    return renderError.call(appInstance, request, options);
  };
  return appInstance;
}

async function getAstroApp(): Promise<AstroApp | null> {
  try {
    const { createApp } = (await import("astro/app/entrypoint")) as unknown as {
      createApp: (opts?: { streaming?: boolean }) => AstroApp;
    };
    return noteCaughtErrors(createApp({ streaming: true }));
  } catch {
    return null;
  }
}

let appPromise: Promise<AstroApp | null> | null = null;
function app(): Promise<AstroApp | null> {
  if (!appPromise) appPromise = getAstroApp();
  return appPromise;
}

/**
 * Do the first request's module work now. Astro creates the App, and
 * evaluates the middleware and each page module, only when a request first
 * needs them; on Lambda that work would run inside the first request, on an
 * invocation's share of the CPU, which is a fraction of what the init phase
 * gets. Called at module scope on Lambda, so it runs during init. A module
 * that throws is logged and left to the request that loads it.
 */
export async function warmApp(): Promise<void> {
  const appInstance = await app();
  const manifest = appInstance?.manifest;
  const loaders: Array<[string, () => Promise<unknown>]> = [];
  if (manifest?.middleware) loaders.push(["middleware", manifest.middleware]);
  for (const [component, load] of manifest?.pageMap ?? []) {
    loaders.push([component, async () => (await load()).page?.()]);
  }
  for (const [module, load] of loaders) {
    try {
      await load();
    } catch (err) {
      console.warn(JSON.stringify({
        event: "run402.ssr.warm_failed",
        module,
        message: err instanceof Error ? err.message : String(err),
      }));
    }
  }
}

if (process.env.AWS_LAMBDA_FUNCTION_NAME) await warmApp();

/**
 * Lambda handler — receives a Web `Request` from the gateway's
 * `buildEntryWrapper`, renders via Astro, returns a Web `Response`.
 * The wrapper handles envelope translation and ALS context.
 */
export async function handler(request: Request): Promise<Response> {
  const appInstance = await app();
  if (!appInstance) {
    // Dev/test stub — the Astro bundle isn't loaded.
    return new Response("Astro app not loaded (dev/test stub)", { status: 500 });
  }
  try {
    const response = await appInstance.render(request, { addCookieHeader: true });
    if (response.status >= 500) noteRoute(appInstance, request);
    return response;
  } catch (err) {
    noteError(err);
    noteRoute(appInstance, request);
    const message = err instanceof Error ? err.message : String(err);
    const requestId = request.headers.get("x-run402-request-id") ?? null;
    const releaseId = request.headers.get("x-run402-release-id") ?? null;
    return new Response(
      JSON.stringify({
        ok: false,
        code: "R402_SSR_RUNTIME_ERROR",
        message,
        ...(requestId ? { requestId } : {}),
        ...(releaseId ? { releaseId } : {}),
        docs: "https://docs.run402.com/functions/errors#ssr-runtime-error",
      }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
  }
}

export default handler;
