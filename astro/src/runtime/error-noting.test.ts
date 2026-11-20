/**
 * The runtime notes the errors Astro catches and the route it matched
 * (astro-ssr-runtime), against a real Astro build of
 * test/fixtures/error-noting: the site is built with the Run402 adapter, its
 * server entry is loaded, and a request context with the wrapper's two slots
 * is published where the gateway's wrapper publishes it.
 */

import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, before, describe, it } from "node:test";

import run402 from "../index.js";

const ACCESSOR = Symbol.for("run402.getCurrentContext");

describe("a built Astro site notes the errors Astro catches", () => {
  const FIXTURE = fileURLToPath(new URL("../../test/fixtures/error-noting/", import.meta.url));
  let root: string;
  let handler: (request: Request) => Promise<Response>;
  let ctx: { caughtError: { value: unknown }; routePattern: { value: unknown } };

  before(async () => {
    root = mkdtempSync(path.join(tmpdir(), "r402-error-noting-"));
    cpSync(path.join(FIXTURE, "src"), path.join(root, "src"), { recursive: true });
    mkdirSync(path.join(root, "node_modules"));
    const astroDir = path.dirname(createRequire(import.meta.url).resolve("astro/package.json"));
    symlinkSync(astroDir, path.join(root, "node_modules", "astro"), "dir");
    const { build } = await import("astro");
    await build({ root, configFile: false, logLevel: "silent", ...run402({ images: false }) });
    const entry = (await import(pathToFileURL(path.join(root, "dist", "run402", "server", "entry.mjs")).href)) as {
      handler: (request: Request) => Promise<Response>;
    };
    handler = entry.handler;
    (globalThis as Record<symbol, unknown>)[ACCESSOR] = () => ctx;
  });

  after(() => {
    delete (globalThis as Record<symbol, unknown>)[ACCESSOR];
    rmSync(root, { recursive: true, force: true });
  });

  async function request(method: string, pathname: string): Promise<{ status: number; body: string; error: unknown; route: unknown }> {
    ctx = { caughtError: { value: null }, routePattern: { value: null } };
    const response = await handler(new Request(`https://site.run402.app${pathname}`, { method, headers: { origin: "https://site.run402.app" } }));
    let body: string;
    try {
      body = await response.text();
    } catch (err) {
      body = `<stream error: ${(err as Error).message}>`;
    }
    return { status: response.status, body, error: ctx.caughtError.value, route: ctx.routePattern.value };
  }

  it("an Astro page that throws: the error and the page's route are noted, and the 500 page keeps its bytes", async () => {
    const r = await request("GET", "/throw");
    assert.equal(r.status, 500);
    assert.match(r.body, /<h1>Custom 500<\/h1>/);
    assert.equal((r.error as Error).name, "TypeError");
    assert.match((r.error as Error).message, /Cannot read properties of undefined \(reading 'lang'\)/);
    assert.match(String((r.error as Error).stack), /\n\s+at /);
    assert.equal(r.route, "/throw");
  });

  it("a dynamic page notes its pattern, never the path", async () => {
    const r = await request("GET", "/items/42");
    assert.equal(r.status, 500);
    assert.equal((r.error as Error).name, "RangeError");
    assert.equal(r.route, "/items/[id]");
  });

  it("an endpoint that throws while handling POST /api/intake is noted with route /api/intake", async () => {
    const r = await request("POST", "/api/intake");
    assert.equal(r.status, 500);
    assert.equal((r.error as Error).name, "SyntaxError");
    assert.equal((r.error as Error).message, "intake body unreadable");
    assert.equal(r.route, "/api/intake");
  });

  it("an endpoint that answers 503 itself notes its route and no error", async () => {
    const r = await request("GET", "/api/five");
    assert.equal(r.status, 503);
    assert.equal(r.body, "nope");
    assert.equal(r.error, null);
    assert.equal(r.route, "/api/five");
  });

  it("a page that renders, an unmatched path and a late error in a streamed page note nothing", async () => {
    for (const pathname of ["/ok", "/nope", "/late"]) {
      const r = await request("GET", pathname);
      assert.ok(r.status < 500, `${pathname} answered ${r.status}`);
      assert.equal(r.error, null, pathname);
      assert.equal(r.route, null, pathname);
    }
  });
});
