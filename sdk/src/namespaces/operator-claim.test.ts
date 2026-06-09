import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Run402, isStepUpRequired } from "../index.js";
import type { CredentialsProvider } from "../credentials.js";

interface FetchCall {
  url: string;
  method: string;
  headers: Headers;
  body: Record<string, unknown>;
}

function mockFetch(
  handler: (call: FetchCall) => Response | Promise<Response>,
): { fetch: typeof globalThis.fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const call: FetchCall = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers ?? {}),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : {},
    };
    calls.push(call);
    return handler(call);
  };
  return { fetch: fetchImpl, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function makeSdk(fetchImpl: typeof globalThis.fetch): Run402 {
  const creds: CredentialsProvider = {
    async getAuth() {
      return { "SIGN-IN-WITH-X": "default-wallet-proof" };
    },
    async getProject() {
      return null;
    },
  };
  return new Run402({ apiBase: "https://api.example.test", credentials: creds, fetch: fetchImpl });
}

describe("operator.claimWalletOrg.challenge", () => {
  it("POSTs the challenge with the control-plane session bearer and { wallet }", async () => {
    const { fetch, calls } = mockFetch((call) => {
      assert.equal(call.method, "POST");
      assert.equal(call.url, "https://api.example.test/agent/v1/operator/claim-wallet-org/challenge");
      assert.equal(call.headers.get("authorization"), "Bearer tok_human");
      assert.deepEqual(call.body, { wallet: "0xWallet" });
      return jsonResponse({ challenge_id: "ch_1", nonce: "nonce_abc", expires_at: "2026-06-09T00:05:00Z" }, 201);
    });
    const res = await makeSdk(fetch).operator.claimWalletOrg.challenge({ wallet: "0xWallet", token: "tok_human" });
    assert.equal(res.nonce, "nonce_abc");
    assert.equal(calls.length, 1);
  });
});

describe("operator.claimWalletOrg.submit", () => {
  it("sends BOTH proofs on one request: Bearer + SIGN-IN-WITH-X", async () => {
    const { fetch, calls } = mockFetch((call) => {
      assert.equal(call.method, "POST");
      assert.equal(call.url, "https://api.example.test/agent/v1/operator/claim-wallet-org");
      assert.equal(call.headers.get("authorization"), "Bearer tok_human");
      assert.equal(call.headers.get("sign-in-with-x"), "wallet-proof-over-nonce");
      return jsonResponse({ status: "claimed", org_id: "org_1", display_name: "Kychee", role: "owner", already_owned: false });
    });
    const res = await makeSdk(fetch).operator.claimWalletOrg.submit({ token: "tok_human", siwx: "wallet-proof-over-nonce" });
    assert.equal(res.status, "claimed");
    if (res.status === "claimed") assert.equal(res.org_id, "org_1");
    assert.equal(calls.length, 1);
  });

  it("omits org_id on the first submit", async () => {
    const { fetch } = mockFetch((call) => {
      assert.ok(!("org_id" in call.body), "first submit must not carry org_id");
      return jsonResponse({ status: "claimed", org_id: "org_1", display_name: null, role: "owner" });
    });
    await makeSdk(fetch).operator.claimWalletOrg.submit({ token: "t", siwx: "s" });
  });

  it("returns select_org as a value (not thrown) and re-submit reuses the same proof + adds org_id", async () => {
    let round = 0;
    const { fetch } = mockFetch((call) => {
      round += 1;
      // Both rounds present the SAME token + siwx (no re-challenge, no re-sign).
      assert.equal(call.headers.get("authorization"), "Bearer t");
      assert.equal(call.headers.get("sign-in-with-x"), "s");
      if (round === 1) {
        assert.ok(!("org_id" in call.body));
        return jsonResponse({
          status: "select_org",
          selectable_orgs: [
            { org_id: "org_a", display_name: "A", tier: "prototype" },
            { org_id: "org_b", display_name: "B", tier: "prototype" },
          ],
        });
      }
      assert.equal(call.body.org_id, "org_b");
      return jsonResponse({ status: "claimed", org_id: "org_b", display_name: "B", role: "owner" });
    });
    const sdk = makeSdk(fetch);
    const first = await sdk.operator.claimWalletOrg.submit({ token: "t", siwx: "s" });
    assert.equal(first.status, "select_org");
    if (first.status === "select_org") {
      assert.equal(first.selectable_orgs.length, 2);
      assert.equal(first.selectable_orgs[1]!.tier, "prototype");
    }
    const second = await sdk.operator.claimWalletOrg.submit({ token: "t", siwx: "s", orgId: "org_b" });
    assert.equal(second.status, "claimed");
  });

  it("throws StepUpRequiredError on a 403 STEP_UP_REQUIRED", async () => {
    const { fetch } = mockFetch(() =>
      jsonResponse(
        {
          error: "step up required",
          code: "STEP_UP_REQUIRED",
          details: { op_class: "org.claim_wallet", required_amr: ["passkey"], max_age_seconds: 300, reason: "stale" },
        },
        403,
      ),
    );
    await assert.rejects(
      () => makeSdk(fetch).operator.claimWalletOrg.submit({ token: "t", siwx: "s" }),
      (err: unknown) => isStepUpRequired(err),
    );
  });
});
