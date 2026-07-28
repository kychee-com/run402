import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { CredentialsProvider } from "../credentials.js";
import { Run402 } from "../index.js";
import { verifyRawNostrEvent } from "./identity-links.protocol.js";

const vector = JSON.parse(readFileSync(
  new URL("../../../integrations/run402-for-buzz/fixtures/identity-link-v1-golden.json", import.meta.url),
  "utf8",
));

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function sdk(handler: (url: string, init: RequestInit) => Response | Promise<Response>, credentials?: CredentialsProvider) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const creds: CredentialsProvider = credentials ?? {
    async getAuth() { return { "SIGN-IN-WITH-X": "siwx-test" }; },
    async getProjectCredentials() { return null; },
    async signPersonalMessage(message) {
      assert.equal(message, vector.public_payload);
      return { address: vector.eip191.recovered_address, signature: vector.eip191.signature };
    },
  };
  const run402 = new Run402({
    apiBase: "https://api.run402.com",
    credentials: creds,
    fetch: async (input, init = {}) => {
      calls.push({ url: String(input), init });
      return handler(String(input), init);
    },
  });
  return { run402, calls };
}

describe("identityLinks protocol", () => {
  it("verifies the same immutable managed-agent kind-1 golden event as the gateway", () => {
    assert.deepEqual(verifyRawNostrEvent(JSON.stringify(vector.nip01.event)), vector.nip01.event);
  });

  it("rejects duplicate JSON fields and secret-shaped fields before ordinary parsing", () => {
    const raw = JSON.stringify(vector.nip01.event).replace(
      `"kind":1`,
      `"kind":1,"kind":1`,
    );
    assert.throws(() => verifyRawNostrEvent(raw), /Duplicate JSON field/);
    const secret = JSON.stringify({ ...vector.nip01.event, private_key: "never" });
    assert.throws(() => verifyRawNostrEvent(secret), /Secret-bearing identity-link fields are forbidden/);
  });
});

describe("identityLinks SDK namespace", () => {
  it("begins with explicit public disclosure and signs the exact payload bytes", async () => {
    const challenge = {
      identity_link_challenge_id: "ilc_01K1BW4R2MZ7B4M5SH9XJ2C3DT",
      proof_protocol: "run402.identity-link.nostr.v1",
      visibility: "public",
      nostr_pubkey: vector.nip01.event.pubkey,
      npub: "npub1fixture",
      public_payload: vector.public_payload,
      issued_at: "2026-07-28T17:10:00.000Z",
      challenge_expires_at: "2026-07-28T17:15:00.000Z",
      disclosure: { permanence: "public_and_durable", published_fields: [], warning: "public" },
      next_actions: [],
    };
    const { run402, calls } = sdk(() => response(challenge, 201));
    const result = await run402.identityLinks.nostr.begin({
      nostrPubkey: vector.nip01.event.pubkey,
      visibility: "public",
      idempotencyKey: "buzz-link-1",
    });
    assert.equal(calls[0]?.url, "https://api.run402.com/identity-links/v1/challenges");
    assert.equal(calls[0]?.init.method, "POST");
    assert.equal((calls[0]?.init.headers as Record<string, string>)["Idempotency-Key"], "buzz-link-1");
    assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), { nostr_pubkey: vector.nip01.event.pubkey, visibility: "public" });
    assert.equal(result.proof_content, vector.event_content);
    assert.equal(result.wallet_signature, vector.eip191.signature);
  });

  it("validates the raw event locally before completing", async () => {
    const { run402, calls } = sdk(() => response(vector.expected_public_proof_response, 201));
    const proof = await run402.identityLinks.nostr.complete({ rawEvent: JSON.stringify(vector.nip01.event) });
    assert.equal(proof.identity_link_id, vector.expected_public_proof_response.identity_link_id);
    assert.equal(calls[0]?.url, "https://api.run402.com/identity-links/v1");
    assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), {
      identity_link_challenge_id: "ilc_01K1BW4R2MZ7B4M5SH9XJ2C3DT",
      nostr_event: vector.nip01.event,
    });
  });

  it("reads the isolated proof without requesting credentials", async () => {
    let authCalls = 0;
    const credentials: CredentialsProvider = {
      async getAuth() { authCalls += 1; return { Authorization: "must-not-be-sent" }; },
      async getProjectCredentials() { return null; },
    };
    const { run402, calls } = sdk(() => response(vector.expected_public_proof_response), credentials);
    await run402.identityLinks.getProof("idlnk_01K1BW9H2RZ71H90FNNK01F2MT");
    assert.equal(authCalls, 0);
    assert.equal(calls[0]?.url, "https://api.run402.com/identity-link-proofs/v1/idlnk_01K1BW9H2RZ71H90FNNK01F2MT");
  });

  it("forbids Nostr secret aliases before network access", async () => {
    const { run402, calls } = sdk(() => response({}));
    await assert.rejects(
      run402.identityLinks.nostr.begin({
        nostrPubkey: vector.nip01.event.pubkey,
        visibility: "public",
        nsec: "nsec1never",
      } as never),
      /never accepted/,
    );
    assert.equal(calls.length, 0);
  });
});
