/**
 * Unit tests for {@link controlPlaneSessionCredentials} — the control-plane
 * session bearer credential provider. Verifies the `getAuth` bearer header
 * (static + lazy), the brand guard, the no-project-keys contract, and that the
 * whole SDK authenticates as the session end-to-end (orgs.whoami → bearer).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  Run402,
  controlPlaneSessionCredentials,
  isControlPlaneSessionCredentials,
  isLocalError,
} from "./index.js";

describe("controlPlaneSessionCredentials", () => {
  it("getAuth returns the Bearer header for a static token", async () => {
    const creds = controlPlaneSessionCredentials({ token: "cps_tok" });
    assert.deepEqual(await creds.getAuth("/anything"), { Authorization: "Bearer cps_tok" });
  });

  it("getAuth resolves a lazy (async) getToken on every call", async () => {
    let n = 0;
    const creds = controlPlaneSessionCredentials({ getToken: async () => `tok_${++n}` });
    assert.deepEqual(await creds.getAuth("/a"), { Authorization: "Bearer tok_1" });
    assert.deepEqual(await creds.getAuth("/b"), { Authorization: "Bearer tok_2" });
  });

  it("carries no project keys (getProject → null)", async () => {
    const creds = controlPlaneSessionCredentials({ token: "cps_tok" });
    assert.equal(await creds.getProject("prj_x"), null);
  });

  it("throws a LocalError when neither token nor getToken is given", () => {
    try {
      // @ts-expect-error — intentionally invalid for the runtime guard
      controlPlaneSessionCredentials({});
      assert.fail("expected a throw");
    } catch (err) {
      assert.ok(isLocalError(err));
      assert.match((err as Error).message, /requires token or getToken/);
    }
  });

  it("is branded so isControlPlaneSessionCredentials detects it", () => {
    const creds = controlPlaneSessionCredentials({ token: "cps_tok" });
    assert.equal(isControlPlaneSessionCredentials(creds), true);
    assert.equal(
      isControlPlaneSessionCredentials({ async getAuth() { return null; }, async getProject() { return null; } }),
      false,
    );
  });

  it("authenticates the whole SDK as the session (orgs.whoami sends the bearer)", async () => {
    const calls: Array<Record<string, string>> = [];
    const fetchImpl: typeof globalThis.fetch = async (_input, init) => {
      calls.push((init?.headers ?? {}) as Record<string, string>);
      return new Response(
        JSON.stringify({ principal: { id: "prn_1", type: "human", createdAt: "x" }, memberships: [], authenticator_id: "a" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const r = new Run402({
      apiBase: "https://api.example.test",
      credentials: controlPlaneSessionCredentials({ token: "cps_tok" }),
      fetch: fetchImpl,
    });
    await r.orgs.whoami();
    assert.equal(calls[0]!["Authorization"], "Bearer cps_tok");
  });
});
