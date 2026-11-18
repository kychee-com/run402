/**
 * Tier limits are the gateway's answer: a deploy the plan refuses reaches the
 * caller as `Run402DeployError`, through the real kernel (which throws every
 * 401/403 as `Unauthorized`) and the wire body the gateway sends, with its
 * code, HTTP status, fix and next actions. A 403 no deploy phase answered
 * (auth, lifecycle) stays `Unauthorized`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Run402 } from "../index.js";
import { isDeployError, isUnauthorized, Run402DeployError } from "../errors.js";
import type { CredentialsProvider } from "../credentials.js";

const creds: CredentialsProvider = {
  async getAuth() { return { "SIGN-IN-WITH-X": "test" }; },
  async getProjectCredentials(id: string) {
    return id === "prj_known" ? { anon_key: "anon_k", service_key: "svc_k" } : null;
  },
};

const fix = { tier: "prototype", max_function_timeout_sec: 10, got_timeout_sec: 20 };
const nextActions = [
  { type: "edit_request", why: "Set functions.api.config.timeoutSeconds to at most 10." },
  { type: "renew_tier", method: "POST", path: "/tiers/v1/team", auth: "x402", why: "A higher tier raises the per-function timeout cap." },
];
const message = "timeoutSeconds 20 exceeds your prototype tier limit of 10s. Upgrade your tier or lower the timeout.";

/** The plan's 403 as the gateway's error envelope writes it. */
const tierRefusalBody = {
  phase: "validate",
  resource: "functions.api.config.timeoutSeconds",
  operation_id: "op_pending",
  fix,
  error: message,
  message,
  code: "TIER_LIMIT_EXCEEDED",
  category: "quota",
  source: "gateway",
  retryable: false,
  safe_to_retry: false,
  mutation_state: "none",
  trace_id: "trc_test",
  details: { phase: "validate", resource: "functions.api.config.timeoutSeconds", operation_id: "op_pending", fix },
  next_actions: nextActions,
};

function sdkAnswering(status: number, body: unknown): { r: Run402; paths: string[] } {
  const paths: string[] = [];
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    paths.push(`${init?.method ?? "GET"} ${new URL(String(input)).pathname}`);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  return { r: new Run402({ apiBase: "https://api.example.test", credentials: creds, fetch: fetchImpl }), paths };
}

const spec = {
  functions: {
    replace: {
      api: {
        source: "export default async () => new Response('ok');",
        config: { timeoutSeconds: 20 },
      },
    },
  },
};

describe("a deploy the gateway's plan refuses", () => {
  for (const [name, call] of [
    ["apply", (r: Run402) => r.project("prj_known").apply(spec)],
    ["apply.plan", (r: Run402) => r.project("prj_known").apply.plan(spec)],
    ["apply.start", async (r: Run402) => (await r.project("prj_known").apply.start(spec)).result()],
  ] as const) {
    it(`${name} throws Run402DeployError with the gateway's code, status, fix and next actions`, async () => {
      const { r, paths } = sdkAnswering(403, tierRefusalBody);
      await assert.rejects(() => call(r), (err: unknown) => {
        assert.ok(err instanceof Run402DeployError, `expected Run402DeployError, got ${String(err)}`);
        assert.equal(isDeployError(err), true);
        assert.equal(err.kind, "deploy_error");
        assert.equal(err.code, "TIER_LIMIT_EXCEEDED");
        assert.equal(err.status, 403);
        assert.equal(err.phase, "validate");
        assert.equal(err.resource, "functions.api.config.timeoutSeconds");
        assert.equal(err.message, message);
        assert.deepEqual(err.fix, fix);
        assert.deepEqual(err.nextActions, nextActions);
        return true;
      });
      assert.deepEqual(paths, ["POST /apply/v1/plans"], "the plan is the only request");
    });
  }

  it("leaves a 403 no deploy phase answered (a lifecycle refusal) Unauthorized", async () => {
    const { r } = sdkAnswering(403, {
      error: "Project is frozen",
      message: "Project is frozen",
      code: "PROJECT_FROZEN",
      category: "lifecycle",
      details: {},
      next_actions: [{ type: "renew_tier", method: "POST", path: "/tiers/v1/:tier", why: "Renew the tier." }],
    });
    await assert.rejects(() => r.project("prj_known").apply(spec), (err: unknown) => {
      assert.equal(isUnauthorized(err), true);
      assert.equal(isDeployError(err), false);
      return true;
    });
  });
});
