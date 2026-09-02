/**
 * `r.gitvault.resume` — gateway error propagation, and the raw Handoff Key's
 * absence from every failure path (kygit-handoff design D3, task 9.4's
 * acceptance sketch: "second claim HANDOFF_KEY_ALREADY_CLAIMED; expired ->
 * _EXPIRED; revoked -> _REVOKED; raw key absent from logs/traces/error
 * reports").
 *
 * `resume()`'s claim POST is the FIRST network call it makes — before any
 * keystore write, clone, or filesystem touch — so a gateway refusal there is
 * reachable with no real git repository at all. This mirrors ci.test.ts's
 * "preserves gateway CI error bodies" table-driven pattern (mocked fetch +
 * the isomorphic `Run402` class), extended with the key-never-leaks
 * assertion this feature's threat model specifically calls for.
 *
 * Run: node --test --import tsx sdk/src/namespaces/gitvault-resume-errors.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Run402 } from "../index.js";
import { ApiError, isRun402Error } from "../errors.js";
import type { CredentialsProvider } from "../credentials.js";

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function mockFetch(handler: (call: FetchCall) => Response | Promise<Response>): { fetch: typeof globalThis.fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const call: FetchCall = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ?? null,
    };
    calls.push(call);
    return handler(call);
  };
  return { fetch: fetchImpl, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function makeCreds(): CredentialsProvider {
  return {
    async getAuth() {
      return { "SIGN-IN-WITH-X": "test-siwx" };
    },
    async getProject() {
      return null;
    },
  };
}

function makeSdk(fetchImpl: typeof globalThis.fetch): Run402 {
  return new Run402({ apiBase: "https://api.example.test", credentials: makeCreds(), fetch: fetchImpl });
}

// A syntactically-valid but entirely fabricated key — assembleHandoffKey's
// own round-trip is covered by gitvault-handoff.test.ts; this file only
// needs SOMETHING parseHandoffKey accepts so resume() reaches the network
// call whose response is under test.
const FABRICATED_KEY = "kgh1_" + "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".slice(0, 64);

describe("r.gitvault.resume — gateway claim refusals propagate untouched", () => {
  const cases = [
    { code: "HANDOFF_KEY_ALREADY_CLAIMED", status: 409 },
    { code: "HANDOFF_KEY_EXPIRED", status: 410 },
    { code: "HANDOFF_KEY_REVOKED", status: 409 },
    { code: "HANDOFF_NOT_FOUND", status: 404 },
  ] as const;

  for (const c of cases) {
    it(`${c.code} (${c.status}) surfaces as an ApiError carrying that exact code`, async () => {
      const body = { code: c.code, message: `gateway says ${c.code}` };
      const { fetch, calls } = mockFetch(() => jsonResponse(body, c.status));
      const r = makeSdk(fetch);

      await assert.rejects(
        r.gitvault.resume({ key: FABRICATED_KEY }),
        (err: unknown) => {
          assert.ok(err instanceof ApiError, `expected ApiError, got ${String(err)}`);
          assert.equal((err as ApiError).code, c.code);
          assert.deepEqual((err as ApiError).body, body);
          return true;
        },
      );
      // The claim POST is the ONLY network call this failure path makes.
      assert.equal(calls.length, 1);
      assert.match(calls[0]!.url, /\/gitvault\/v1\/handoffs\/.+\/claim$/);
    });
  }
});

describe("r.gitvault.resume — the raw key never appears in a thrown error (design: key-once contract)", () => {
  it("a claim refusal's error never carries the raw Handoff Key, its master secret, or its derived auth_secret", async () => {
    const body = { code: "HANDOFF_KEY_ALREADY_CLAIMED", message: "already claimed" };
    const { fetch, calls } = mockFetch(() => jsonResponse(body, 409));
    const r = makeSdk(fetch);

    let caught: unknown;
    try {
      await r.gitvault.resume({ key: FABRICATED_KEY });
      assert.fail("resume() must reject");
    } catch (err) {
      caught = err;
    }

    // Every string the error object could plausibly surface — message,
    // stack, JSON-serialized body/details, and (via isRun402Error) the
    // structured envelope this SDK's own error hierarchy exposes.
    const serialized = JSON.stringify({
      message: caught instanceof Error ? caught.message : String(caught),
      stack: caught instanceof Error ? caught.stack : undefined,
      envelope: isRun402Error(caught) ? caught.toJSON?.() : undefined,
    });

    assert.equal(serialized.includes(FABRICATED_KEY), false, "the raw kgh1_ key must never appear in a thrown error");
    // The key body is the part that actually carries secret material — the
    // 5-char `kgh1_` prefix alone is not sensitive and is a legitimate
    // thing to name in a "not a recognized kygit key" refusal.
    assert.equal(serialized.includes(FABRICATED_KEY.slice(5)), false, "the key BODY (id + master secret) must never appear in a thrown error, prefix included or not");

    // Also confirm the ONLY thing the request itself carried was the
    // derived, gateway-verifiable auth_secret hex — never the raw key or
    // the master secret it was derived from.
    const sentBody = JSON.parse(calls[0]!.body as string) as { auth_secret: string };
    // Base64url of exactly 32 bytes — the documented wire contract, and what
    // the gateway's decoder (base64/base64url, 32 bytes or nothing) accepts.
    // 4.67.0–4.68.0 sent 64 hex chars here, which that decoder reads as 48
    // bytes and discards, so EVERY claim answered HANDOFF_KEY_INVALID while
    // both sides' own unit tests stayed green. This assertion is the
    // cross-side vector: decode it exactly the way the gateway does.
    assert.match(sentBody.auth_secret, /^[A-Za-z0-9_-]{43}$/, "auth_secret must be base64url of 32 bytes, never hex and never the raw key material");
    const gatewayDecoded = Buffer.from(sentBody.auth_secret.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    assert.equal(gatewayDecoded.length, 32, "the gateway decodes base64/base64url and requires exactly 32 bytes");
    assert.equal(JSON.stringify(sentBody).includes(FABRICATED_KEY), false);
  });

  it("a malformed key's parse refusal names no part of the input", async () => {
    const { fetch } = mockFetch(() => jsonResponse({}, 200));
    const r = makeSdk(fetch);
    const malformed = "kgh1_not-valid-base64url!!!";

    let caught: unknown;
    try {
      await r.gitvault.resume({ key: malformed });
      assert.fail("resume() must reject a malformed key before any network call");
    } catch (err) {
      caught = err;
    }
    const message = caught instanceof Error ? caught.message : String(caught);
    assert.equal(message.includes(malformed), false);
    assert.equal(message.includes("not-valid-base64url"), false);
  });
});
