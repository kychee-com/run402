import { describe, it } from "node:test";
import assert from "node:assert/strict";

/**
 * Test that storage route ordering is correct.
 *
 * The bug: GET /storage/v1/object/:bucket/*splat was registered before
 * GET /storage/v1/object/list/:bucket, so a request to /storage/v1/object/list/mybucket
 * matched the wildcard route (bucket="list", splat="mybucket") instead of the list route.
 * Same issue for POST /storage/v1/object/sign/:bucket/*.
 *
 * We verify route ordering by inspecting the Express router's layer stack directly.
 */

// We only need to import the router — no mocks needed for route-order checks.
// But storage.ts imports config and middleware, so we mock just enough to load it.

import { mock } from "node:test";

mock.module("../config.js", {
  namedExports: {
    S3_BUCKET: "",
    S3_REGION: "us-east-1",
  },
});

mock.module("../middleware/apikey.js", {
  namedExports: {
    apikeyAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  },
});

mock.module("../middleware/metering.js", {
  namedExports: {
    meteringMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
  },
});

mock.module("../middleware/demo.js", {
  namedExports: {
    demoStorageMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
  },
});

mock.module("../services/budget.js", {
  namedExports: {
    updateStorageBytes: async () => {},
  },
});

const { default: router } = await import("./storage.js");

/**
 * Extract ordered list of route signatures from Express router.
 */
function getRoutes(): Array<{ method: string; path: string }> {
  const routes: Array<{ method: string; path: string }> = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const layer of (router as any).stack) {
    if (layer.route) {
      const methods = Object.keys(layer.route.methods);
      for (const m of methods) {
        routes.push({ method: m.toUpperCase(), path: layer.route.path });
      }
    }
  }
  return routes;
}

describe("storage route ordering", () => {
  it("GET list route is registered before GET wildcard route", () => {
    const routes = getRoutes();
    const getRoutesList = routes.filter((r) => r.method === "GET");

    const listIndex = getRoutesList.findIndex((r) => r.path.includes("/list/"));
    const wildcardIndex = getRoutesList.findIndex((r) => r.path.includes("*splat") && !r.path.includes("/list/"));

    assert.ok(listIndex !== -1, "list route must exist");
    assert.ok(wildcardIndex !== -1, "wildcard GET route must exist");
    assert.ok(
      listIndex < wildcardIndex,
      `list route (index ${listIndex}) must come before wildcard GET route (index ${wildcardIndex}). Routes: ${JSON.stringify(getRoutesList)}`,
    );
  });

  it("POST sign route is registered before POST wildcard upload route", () => {
    const routes = getRoutes();
    const postRoutes = routes.filter((r) => r.method === "POST");

    const signIndex = postRoutes.findIndex((r) => r.path.includes("/sign/"));
    const uploadIndex = postRoutes.findIndex((r) => r.path.includes("*splat") && !r.path.includes("/sign/"));

    assert.ok(signIndex !== -1, "sign route must exist");
    assert.ok(uploadIndex !== -1, "wildcard POST route must exist");
    assert.ok(
      signIndex < uploadIndex,
      `sign route (index ${signIndex}) must come before wildcard POST route (index ${uploadIndex}). Routes: ${JSON.stringify(postRoutes)}`,
    );
  });
});
