/**
 * `r.gitvault.join` — gateway error propagation, and the raw Invite Key's
 * absence from every failure path (kygit-invite design D3/D9's acceptance
 * sketch: "second claim INVITE_KEY_ALREADY_CLAIMED; expired -> _EXPIRED;
 * revoked -> _REVOKED; raw key absent from logs/traces/error reports").
 *
 * Mirrors `gitvault-resume-errors.test.ts` byte-for-byte, for the invite
 * kind: `join()`'s claim POST is the FIRST network call it makes — before
 * any keystore write, clone, or filesystem touch — so a gateway refusal
 * there is reachable with no real git repository at all.
 *
 * Run: node --test --import tsx sdk/src/namespaces/gitvault-join-errors.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Run402 } from "../index.js";
import { isRun402Error } from "../errors.js";
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

// A syntactically-valid but entirely fabricated key — assembleInviteKey's own
// round-trip is covered by gitvault-handoff.test.ts; this file only needs
// SOMETHING parseInviteKey accepts so join() reaches the network call whose
// response is under test.
const FABRICATED_KEY = "kgi1_" + "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".slice(0, 64);

describe("r.gitvault.join — gateway claim refusals propagate untouched", () => {
  const cases = [
    { code: "INVITE_KEY_ALREADY_CLAIMED", status: 409 },
    { code: "INVITE_KEY_EXPIRED", status: 410 },
    { code: "INVITE_KEY_REVOKED", status: 410 },
    { code: "INVITE_KEY_INVALID", status: 403 },
    { code: "INVITE_CLAIM_REQUIRES_WALLET", status: 403 },
  ] as const;

  for (const c of cases) {
    it(`${c.code} (${c.status}) surfaces as a Run402Error carrying that exact code and body, untouched`, async () => {
      const body = { code: c.code, message: `gateway says ${c.code}` };
      const { fetch, calls } = mockFetch(() => jsonResponse(body, c.status));
      const r = makeSdk(fetch);

      await assert.rejects(
        r.gitvault.join({ key: FABRICATED_KEY }),
        (err: unknown) => {
          // The status-to-class mapping (403 -> Unauthorized, 409/410 -> ApiError,
          // etc.) is `kernel.ts`'s own concern, not `join()`'s — what matters
          // here is that the gateway's code/body pass through UNCHANGED,
          // regardless of which Run402Error subclass carries them.
          assert.ok(isRun402Error(err), `expected a Run402Error, got ${String(err)}`);
          const e = err as { code?: string; body?: unknown; status?: number | null };
          assert.equal(e.code, c.code);
          assert.deepEqual(e.body, body);
          assert.equal(e.status, c.status);
          return true;
        },
      );
      // The claim POST is the ONLY network call this failure path makes.
      assert.equal(calls.length, 1);
      assert.match(calls[0]!.url, /\/gitvault\/v1\/invites\/.+\/claim$/);
    });
  }
});

describe("r.gitvault.join — the raw key never appears in a thrown error (design: key-once contract)", () => {
  it("a claim refusal's error never carries the raw Invite Key, its master secret, or its derived auth_secret", async () => {
    const body = { code: "INVITE_KEY_ALREADY_CLAIMED", message: "already claimed" };
    const { fetch, calls } = mockFetch(() => jsonResponse(body, 409));
    const r = makeSdk(fetch);

    let caught: unknown;
    try {
      await r.gitvault.join({ key: FABRICATED_KEY });
      assert.fail("join() must reject");
    } catch (err) {
      caught = err;
    }

    const serialized = JSON.stringify({
      message: caught instanceof Error ? caught.message : String(caught),
      stack: caught instanceof Error ? caught.stack : undefined,
      envelope: isRun402Error(caught) ? caught.toJSON?.() : undefined,
    });

    assert.equal(serialized.includes(FABRICATED_KEY), false, "the raw kgi1_ key must never appear in a thrown error");
    // The key body is the part that actually carries secret material — the
    // 5-char `kgi1_` prefix alone is not sensitive and is a legitimate
    // thing to name in a "not a recognized kygit key" refusal.
    assert.equal(serialized.includes(FABRICATED_KEY.slice(5)), false, "the key BODY (id + master secret) must never appear in a thrown error, prefix included or not");

    // Also confirm the ONLY thing the request itself carried was the
    // derived, gateway-verifiable auth_secret hex — never the raw key or
    // the master secret it was derived from.
    const sentBody = JSON.parse(calls[0]!.body as string) as { auth_secret: string };
    assert.match(sentBody.auth_secret, /^[0-9a-f]{64}$/, "auth_secret must be sent as a hex hash, never the raw key material");
    assert.equal(JSON.stringify(sentBody).includes(FABRICATED_KEY), false);
  });

  it("a malformed key's parse refusal names no part of the input", async () => {
    const { fetch } = mockFetch(() => jsonResponse({}, 200));
    const r = makeSdk(fetch);
    const malformed = "kgi1_not-valid-base64url!!!";

    let caught: unknown;
    try {
      await r.gitvault.join({ key: malformed });
      assert.fail("join() must reject a malformed key before any network call");
    } catch (err) {
      caught = err;
    }
    const message = caught instanceof Error ? caught.message : String(caught);
    assert.equal(message.includes(malformed), false);
    assert.equal(message.includes("not-valid-base64url"), false);
  });

  it("a kgh1_ handoff key handed to join() is refused by name, before any network call", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({}, 200));
    const r = makeSdk(fetch);
    const handoffLookingKey = "kgh1_" + "B".repeat(64);

    await assert.rejects(
      r.gitvault.join({ key: handoffLookingKey }),
      (err: unknown) => {
        const e = err as { code?: string; details?: { kind?: string; verb?: string } };
        return e.code === "INVITE_KEY_WRONG_KIND" && e.details?.kind === "handoff" && e.details?.verb === "resume";
      },
    );
    assert.equal(calls.length, 0, "a cross-kind key is refused locally — never reaches the network");
  });
});
