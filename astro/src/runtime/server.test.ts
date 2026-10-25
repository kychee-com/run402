import assert from "node:assert/strict";
import { beforeEach, describe, it, mock } from "node:test";

// A stand-in for Astro's App that behaves the way Astro does: cookies a page
// sets through `Astro.cookies.set()` stay on the render context and reach the
// Response as `Set-Cookie` only when the caller passes `addCookieHeader: true`.
let renderOptions: Array<{ addCookieHeader?: boolean } | undefined> = [];
let pageCookies: string[] = [];

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
    }),
  },
});

const { handler } = await import("./server.js");

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
