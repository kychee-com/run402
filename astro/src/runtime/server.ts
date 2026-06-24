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
 * return the `Response`. The wrapper translates the Response back into
 * the routed-function envelope shape the gateway expects and attaches
 * the SSR metadata (cache-bypass taint, runtime error envelope).
 *
 * Uncaught render exceptions are caught at the outermost level and
 * surfaced as a `Response` with code `R402_SSR_RUNTIME_ERROR`; the
 * wrapper carries that through and the gateway logs accordingly.
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
type AstroApp = { render: (req: Request) => Promise<Response> };

async function getAstroApp(): Promise<AstroApp | null> {
  try {
    const { createApp } = (await import("astro/app/entrypoint")) as {
      createApp: (opts?: { streaming?: boolean }) => AstroApp;
    };
    return createApp({ streaming: true });
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
    return await appInstance.render(request);
  } catch (err) {
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
