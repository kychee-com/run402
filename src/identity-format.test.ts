import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatActor, formatLinkedIdentity, formatPrincipal } from "./identity-format.js";

const capturedAt = "2026-07-28T12:00:00.000Z";

describe("identity and provenance formatting", () => {
  it("renders current linked and revoked identities without treating them as owners", () => {
    assert.match(formatLinkedIdentity({
      identity_link_id: "idlnk_1",
      proof_protocol: "run402.identity-link.nostr.human.v1",
      kind: "nostr_nip01",
      public_subject: "6b69",
      display_subject: "npub1agent",
      verified_at: capturedAt,
      status: "active",
      effective_status: "active",
      revoked_at: null,
    }), /idlnk_1.*npub1agent.*run402\.identity-link\.nostr\.human\.v1.*active.*public attribution only/i);

    assert.match(formatLinkedIdentity({
      identity_link_id: "idlnk_2",
      proof_protocol: "run402.identity-link.nostr.v1",
      kind: "nostr_nip01",
      public_subject: "dead",
      display_subject: "npub1old",
      verified_at: capturedAt,
      status: "revoked",
      effective_status: "revoked",
      revoked_at: capturedAt,
    }), /\(revoked\)/);
  });

  it("renders immutable delegate actor provenance", () => {
    const rendered = formatActor({
      schema_version: 1,
      principal: {
        principal_id: "prn_agent",
        principal_type: "agent",
        display_name_at_capture: "Fizz",
        linked_identities_at_capture: [{
          identity_link_id: "idlnk_1",
          kind: "nostr",
          public_subject: "6b69",
          display_subject: "npub1agent",
          verified_at: capturedAt,
          status_at_capture: "active",
        }],
      },
      authenticator: {
        authenticator_id: "auth_delegate",
        kind: "run402_agent_key",
        public_subject: "dlg_123",
      },
      authority: {
        kind: "delegate",
        organization_id: "org_1",
        project_id: "prj_1",
        grant_id: "grant_1",
        delegate_id: "delegate_1",
        scope: ["deploy.write"],
      },
      captured_at: capturedAt,
    });

    assert.match(rendered, /Fizz/);
    assert.match(rendered, /npub1agent/);
    assert.match(rendered, /authority: delegate/);
    assert.doesNotMatch(rendered, /owner/);
  });

  it("preserves legacy-null and unknown future kinds", () => {
    assert.equal(formatActor(null), "legacy / unavailable");
    const principal = formatPrincipal({
      principal_id: "prn_future",
      principal_type: "robot_v2",
      display_name: null,
      linked_identities: [{
        identity_link_id: "idlnk_future",
        proof_protocol: "did-key-proof-v2",
        kind: "did:key",
        public_subject: "did:key:z6Mk",
        display_subject: "did:key:z6Mk",
        verified_at: capturedAt,
        status: "active",
        effective_status: "principal_inactive",
        revoked_at: null,
      }],
    });
    assert.match(principal, /robot_v2/);
    assert.match(principal, /did:key/);
    assert.match(principal, /principal_inactive/);
  });
});
