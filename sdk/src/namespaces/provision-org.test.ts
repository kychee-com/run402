import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Run402 } from "../index.js";
import type { CredentialsProvider } from "../credentials.js";

function makeSdk(fetchImpl: typeof globalThis.fetch): Run402 {
  const creds: CredentialsProvider = {
    async getAuth() {
      return { "SIGN-IN-WITH-X": "test-siwx" };
    },
    async getProjectCredentials() {
      return null;
    },
  };
  return new Run402({ apiBase: "https://api.example.test", credentials: creds, fetch: fetchImpl });
}

function captureBody(): { fetch: typeof globalThis.fetch; body: () => Record<string, unknown> } {
  let captured: Record<string, unknown> = {};
  const fetchImpl: typeof globalThis.fetch = async (_input, init) => {
    captured = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    return new Response(
      JSON.stringify({ project_id: "prj_1", anon_key: "a", service_key: "s", schema_slot: "slot_1" }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  return { fetch: fetchImpl, body: () => captured };
}

describe("projects.provision — org targeting (v1.82)", () => {
  it("includes org_id when orgId is set", async () => {
    const { fetch, body } = captureBody();
    await makeSdk(fetch).projects.provision({ orgId: "org_abc" });
    assert.equal(body().org_id, "org_abc");
  });

  it("omits org_id entirely on the cold-start path", async () => {
    const { fetch, body } = captureBody();
    await makeSdk(fetch).projects.provision({ name: "x" });
    assert.ok(!("org_id" in body()), "cold-start body must not carry org_id");
  });

  it("sends no tier: a project runs on its organization's tier", async () => {
    const { fetch, body } = captureBody();
    await makeSdk(fetch).projects.provision({ orgId: "org_abc" });
    assert.ok(!("tier" in body()));
  });
});
