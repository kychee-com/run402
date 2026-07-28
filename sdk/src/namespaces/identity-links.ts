import type { Client } from "../kernel.js";
import { LocalError } from "../errors.js";
import {
  assertNoForbiddenIdentityInput,
  canonicalProofContent,
  normalizeNostrPublicKey,
  verifyRawNostrEvent,
  walletFromPublicPayload,
} from "./identity-links.protocol.js";
import type {
  IdentityLinkChallenge,
  IdentityLinkListResult,
  IdentityLinkProof,
  NostrEventV1,
  PreparedIdentityLinkChallenge,
} from "./identity-links.types.js";

export interface BeginNostrIdentityLinkInput {
  nostrPubkey: string;
  visibility: "public";
  idempotencyKey?: string;
}

export interface CompleteNostrIdentityLinkInput {
  rawEvent: string | NostrEventV1;
}

export class NostrIdentityLinks {
  constructor(private readonly client: Client) {}

  async begin(input: BeginNostrIdentityLinkInput): Promise<PreparedIdentityLinkChallenge> {
    if (!input || typeof input !== "object") throw new LocalError("identityLinks.nostr.begin requires an input object", "beginning Nostr identity link");
    assertNoForbiddenIdentityInput(input as unknown as Record<string, unknown>);
    if (typeof input.nostrPubkey !== "string" || input.visibility !== "public") {
      throw new LocalError("nostrPubkey and explicit visibility: 'public' are required", "beginning Nostr identity link", { code: "IDENTITY_LINK_PUBLIC_VISIBILITY_REQUIRED" });
    }
    const nostrPubkey = normalizeNostrPublicKey(input.nostrPubkey);
    const signer = this.client.credentials.signPersonalMessage;
    if (!signer) throw new LocalError("The active credential provider cannot sign EIP-191 personal messages", "beginning Nostr identity link", { code: "IDENTITY_LINK_EOA_SIGNER_REQUIRED" });
    const challenge = await this.client.request<IdentityLinkChallenge>("/identity-links/v1/challenges", {
      method: "POST",
      headers: { "Idempotency-Key": input.idempotencyKey ?? globalThis.crypto.randomUUID() },
      body: { nostr_pubkey: nostrPubkey, visibility: input.visibility },
      context: "creating public Nostr identity-link challenge",
    });
    const signed = await signer.call(this.client.credentials, challenge.public_payload);
    const expected = walletFromPublicPayload(challenge.public_payload);
    if (signed.address.toLowerCase() !== expected.toLowerCase()) {
      throw new LocalError("The personal-message signer differs from the EOA that authenticated the challenge", "beginning Nostr identity link", { code: "IDENTITY_LINK_EOA_SIGNER_MISMATCH" });
    }
    const proofContent = canonicalProofContent(challenge.public_payload, signed.signature);
    return {
      ...challenge,
      wallet_address: signed.address,
      wallet_signature: signed.signature,
      proof_content: proofContent,
    };
  }

  async complete(input: CompleteNostrIdentityLinkInput): Promise<IdentityLinkProof> {
    if (!input || !("rawEvent" in input)) throw new LocalError("identityLinks.nostr.complete requires { rawEvent }", "completing Nostr identity link");
    const event = verifyRawNostrEvent(input.rawEvent);
    const wrapper = JSON.parse(event.content) as { public_payload: string };
    const payload = JSON.parse(wrapper.public_payload) as { challenge_id?: unknown };
    if (typeof payload.challenge_id !== "string") throw new LocalError("Signed payload has no challenge_id", "completing Nostr identity link");
    return this.client.request<IdentityLinkProof>("/identity-links/v1", {
      method: "POST",
      body: { identity_link_challenge_id: payload.challenge_id, nostr_event: event },
      context: "completing public Nostr identity link",
    });
  }
}

export class IdentityLinks {
  readonly nostr: NostrIdentityLinks;
  constructor(private readonly client: Client) { this.nostr = new NostrIdentityLinks(client); }

  async list(): Promise<IdentityLinkListResult> {
    return this.client.request<IdentityLinkListResult>("/identity-links/v1", { context: "listing linked identities" });
  }

  async getProof(identityLinkId: string): Promise<IdentityLinkProof> {
    if (!identityLinkId) throw new LocalError("identityLinks.getProof requires identityLinkId", "reading public identity-link proof");
    return this.client.request<IdentityLinkProof>(`/identity-link-proofs/v1/${encodeURIComponent(identityLinkId)}`, {
      withAuth: false,
      context: "reading public identity-link proof",
    });
  }

  async revoke(identityLinkId: string): Promise<IdentityLinkProof> {
    if (!identityLinkId) throw new LocalError("identityLinks.revoke requires identityLinkId", "revoking identity link");
    return this.client.request<IdentityLinkProof>(`/identity-links/v1/${encodeURIComponent(identityLinkId)}`, {
      method: "DELETE",
      context: "revoking identity link",
    });
  }
}
