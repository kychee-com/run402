import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

// A stand-in for Astro's App that behaves the way Astro does: cookies a page
// sets through `Astro.cookies.set()` stay on the render context and reach the
// Response as `Set-Cookie` only when the caller passes `addCookieHeader: true`.
let renderOptions: Array<{ addCookieHeader?: boolean } | undefined> = [];
let pageCookies: string[] = [];
// The modules the stand-in manifest's loaders evaluated, in order.
let evaluated: string[] = [];
let failingModule: string | null = null;
// How the stand-in render answers: Astro's own page (200), a throw Astro
// catches itself (renderError with the error, then its 500 page), an
// endpoint's own 503 with nothing thrown, or a throw that escapes render.
let renderMode: "page" | "astro_caught" | "own_503" | "escapes" = "page";

function loader(name: string) {
  return async () => {
    if (name === failingModule) throw new Error(`${name} needs a request`);
    evaluated.push(name);
    return { name };
  };
}

mock.module("astro/app/entrypoint", {
  namedExports: {
    createApp: () => ({
      // Astro's BaseApp.render reaches renderError late-bound on the instance.
      async renderError(_request: Request, _opts: { status: number; error?: unknown }) {
        return new Response("<h1>Custom 500</h1>", { status: 500, headers: { "content-type": "text/html" } });
      },
      match: (request: Request) => {
        const path = new URL(request.url).pathname;
        return path.startsWith("/items/") ? { route: "/items/[id]" } : path === "/nope" ? undefined : { route: path };
      },
      async render(request: Request, opts?: { addCookieHeader?: boolean }) {
        if (renderMode === "astro_caught") return this.renderError(request, { status: 500, error: new RangeError("item 42 missing") });
        if (renderMode === "own_503") return new Response("busy", { status: 503 });
        if (renderMode === "escapes") throw new TypeError("render exploded");
        renderOptions.push(opts);
        const response = new Response("<html></html>", { headers: { "content-type": "text/html" } });
        if (opts?.addCookieHeader) {
          for (const cookie of pageCookies) response.headers.append("set-cookie", cookie);
        }
        return response;
      },
      manifest: {
        middleware: loader("middleware"),
        pageMap: new Map([
          ["src/pages/index.astro", async () => ({ page: loader("index") })],
          ["src/pages/gate.astro", async () => ({ page: loader("gate") })],
        ]),
      },
    }),
  },
});

const { handler, warmApp } = await import("./server.js");

describe("SSR runtime handler", () => {
  beforeEach(() => {
    renderOptions = [];
    pageCookies = [];
  });

  it("writes cookies a page sets through Astro.cookies onto the Response", async () => {
    pageCookies = ["lang=he; Path=/; SameSite=Lax", "theme=dark; Path=/"];
    const response = await handler(new Request("https://example.run402.app/"));
    assert.deepEqual(renderOptions, [{ addCookieHeader: true }]);
    assert.deepEqual(response.headers.getSetCookie(), pageCookies);
  });

  it("sends no Set-Cookie when the page sets none", async () => {
    const response = await handler(new Request("https://example.run402.app/"));
    assert.equal(response.status, 200);
    assert.deepEqual(response.headers.getSetCookie(), []);
  });
});

describe("noting the errors Astro catches and the route it matched", () => {
  const ACCESSOR = Symbol.for("run402.getCurrentContext");
  let ctx: { caughtError: { value: unknown }; routePattern: { value: unknown } };
  beforeEach(() => {
    ctx = { caughtError: { value: null }, routePattern: { value: null } };
    (globalThis as Record<symbol, unknown>)[ACCESSOR] = () => ctx;
    renderMode = "page";
  });
  afterEach(() => {
    delete (globalThis as Record<symbol, unknown>)[ACCESSOR];
    renderMode = "page";
  });

  it("a page error Astro catches is noted with the matched route, and its 500 page is unchanged", async () => {
    renderMode = "astro_caught";
    const response = await handler(new Request("https://example.run402.app/items/42"));
    assert.equal(response.status, 500);
    assert.equal(await response.text(), "<h1>Custom 500</h1>");
    assert.equal((ctx.caughtError.value as Error).message, "item 42 missing");
    assert.equal(ctx.routePattern.value, "/items/[id]");
  });

  it("an endpoint's own 503 notes the route and no error", async () => {
    renderMode = "own_503";
    const response = await handler(new Request("https://example.run402.app/api/five"));
    assert.equal(response.status, 503);
    assert.equal(ctx.caughtError.value, null);
    assert.equal(ctx.routePattern.value, "/api/five");
  });

  it("a throw that escapes render is noted and still answered R402_SSR_RUNTIME_ERROR", async () => {
    renderMode = "escapes";
    const response = await handler(new Request("https://example.run402.app/api/intake", { method: "POST" }));
    assert.equal(response.status, 500);
    assert.equal(((await response.json()) as { code: string }).code, "R402_SSR_RUNTIME_ERROR");
    assert.equal((ctx.caughtError.value as Error).name, "TypeError");
    assert.equal(ctx.routePattern.value, "/api/intake");
  });

  it("a page that renders notes nothing", async () => {
    const response = await handler(new Request("https://example.run402.app/"));
    assert.equal(response.status, 200);
    assert.equal(ctx.caughtError.value, null);
    assert.equal(ctx.routePattern.value, null);
  });

  it("without the wrapper's accessor (Run402 Core, an older wrapper) the response is the same and nothing is noted", async () => {
    delete (globalThis as Record<symbol, unknown>)[ACCESSOR];
    renderMode = "astro_caught";
    const response = await handler(new Request("https://example.run402.app/items/42"));
    assert.equal(response.status, 500);
    assert.equal(await response.text(), "<h1>Custom 500</h1>");
    assert.equal(ctx.caughtError.value, null);
  });
});

describe("warmApp (cold start)", () => {
  beforeEach(() => {
    evaluated = [];
    failingModule = null;
  });

  it("evaluates the middleware and every page module", async () => {
    await warmApp();
    assert.deepEqual(evaluated, ["middleware", "index", "gate"]);
  });

  it("logs a module that throws and still evaluates the rest", async () => {
    failingModule = "index";
    const warn = mock.method(console, "warn", () => {});
    try {
      await warmApp();
    } finally {
      warn.mock.restore();
    }
    assert.deepEqual(evaluated, ["middleware", "gate"]);
    assert.equal(warn.mock.callCount(), 1);
    const line = JSON.parse(String(warn.mock.calls[0]?.arguments[0]));
    assert.deepEqual(line, {
      event: "run402.ssr.warm_failed",
      module: "src/pages/index.astro",
      message: "index needs a request",
    });
  });

  it("runs during module evaluation on Lambda, before any request", async () => {
    process.env.AWS_LAMBDA_FUNCTION_NAME = "run402_prj_test_ssr";
    try {
      await import("./server.js?lambda");
    } finally {
      delete process.env.AWS_LAMBDA_FUNCTION_NAME;
    }
    assert.deepEqual(evaluated, ["middleware", "index", "gate"]);
  });
});
