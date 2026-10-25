import assert from "node:assert/strict";
import { beforeEach, describe, it, mock } from "node:test";

// A stand-in for Astro's App that behaves the way Astro does: cookies a page
// sets through `Astro.cookies.set()` stay on the render context and reach the
// Response as `Set-Cookie` only when the caller passes `addCookieHeader: true`.
let renderOptions: Array<{ addCookieHeader?: boolean } | undefined> = [];
let pageCookies: string[] = [];
// The modules the stand-in manifest's loaders evaluated, in order.
let evaluated: string[] = [];
let failingModule: string | null = null;

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
      render: async (_request: Request, opts?: { addCookieHeader?: boolean }) => {
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
