import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CredentialsProvider } from "../credentials.js";
import { Run402 } from "../index.js";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function sdk(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let authCalls = 0;
  const credentials: CredentialsProvider = {
    async getAuth() { authCalls += 1; return { "SIGN-IN-WITH-X": "siwx-test" }; },
    async getProjectCredentials() { return null; },
  };
  const run402 = new Run402({
    apiBase: "https://api.run402.com",
    credentials,
    fetch: async (input, init = {}) => {
      calls.push({ url: String(input), init });
      return handler(String(input), init);
    },
  });
  return { run402, calls, authCalls: () => authCalls };
}

describe("Buzz SDK namespace", () => {
  it("detects an older gateway without manufacturing remote Buzz state", async () => {
    const { run402 } = sdk(() => response({ principal: { id: "prin_1" }, memberships: [] }));
    const status = await run402.buzz.status();
    assert.equal(status.supported, false);
    assert.equal(status.reason, "gateway_not_supported");
    assert.equal(status.buzz, null);
  });

  it("reports the conversational adoption-offer capability without inferring it from protocol v1", async () => {
    const { run402 } = sdk(() => response({
      buzz: {
        skill_installation: { status: "client_managed" },
        capabilities: { human_adoption_offers: true, browser_fragment_v1: true },
      },
    }));
    const status = await run402.buzz.status();
    assert.equal(status.supported, true);
    assert.equal(status.buzz?.capabilities?.human_adoption_offers, true);
  });

  it("creates an inert human-adoption offer with optional verified deployment context", async () => {
    const offer = { buzz_human_adoption_offer_id: "buzzhao_11111111111111111111111111111111", status: "available" };
    const { run402, calls } = sdk(() => response(offer, 201));
    const deploymentContext = {
      project_id: "prj_church",
      release_id: "rel_demo",
      live_url: "https://church.run402.com/",
      source_revision: "abc123",
      verified_at: "2026-07-31T10:00:00.000Z",
    };
    await run402.buzz.offerAdoption({
      organizationId: "org_11111111111111111111111111111111",
      identityLinkId: "idlnk_22222222222222222222222222222222",
      deploymentContext,
      idempotencyKey: "offer-after-demo-1",
    });
    assert.equal(calls[0]?.url, "https://api.run402.com/buzz-human-adoption-offers/v1");
    assert.equal(calls[0]?.init.method, "POST");
    assert.equal((calls[0]?.init.headers as Record<string, string>)["Idempotency-Key"], "offer-after-demo-1");
    assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), {
      org_id: "org_11111111111111111111111111111111",
      identity_link_id: "idlnk_22222222222222222222222222222222",
      deployment_context: deploymentContext,
    });
  });

  it("keeps offer polling/cancellation on agent auth and binds browser attempts to explicit callbacks", async () => {
    const { run402, calls } = sdk((_url, init) => response(init.method === "POST"
      ? { buzz_human_adoption_id: "buzzha_11111111111111111111111111111111", status: "pending" }
      : { buzz_human_adoption_offer_id: "buzzhao_11111111111111111111111111111111", status: "available" }));
    const id = "buzzhao_11111111111111111111111111111111";
    await run402.buzz.humanAdoptionOffers.get(id);
    await run402.buzz.humanAdoptionOffers.cancel(id, "cancel-offer-1");
    await run402.buzz.humanAdoptionOffers.createAttempt(id, {
      callbackUrl: `https://console.run402.com/buzz/adoptions/${id}`,
      idempotencyKey: "attempt-1",
    });
    assert.deepEqual(calls.map((call) => call.init.method ?? "GET"), ["GET", "DELETE", "POST"]);
    assert.deepEqual(JSON.parse(String(calls[2]?.init.body)), {
      callback_url: `https://console.run402.com/buzz/adoptions/${id}`,
    });
  });

  it("maps the goal-shaped enrollment request to the frozen wire contract", async () => {
    const enrollment = { buzz_agent_enrollment_id: "buzzae_11111111111111111111111111111111", status: "pending" };
    const { run402, calls } = sdk(() => response(enrollment, 201));
    await run402.buzz.enroll({
      buzzCommunityInstallationId: "buzzci_11111111111111111111111111111111",
      identityLinkId: "idlnk_11111111111111111111111111111111",
      requestedGrants: [{ project_id: "prj_1", capability: "deploy", expires_at: "2026-08-01T00:00:00.000Z" }],
      expiresAt: "2026-08-01T00:00:00.000Z",
      idempotencyKey: "honey-enroll-1",
    });
    assert.equal(calls[0]?.url, "https://api.run402.com/buzz-agent-enrollments/v1");
    assert.equal(calls[0]?.init.method, "POST");
    assert.equal((calls[0]?.init.headers as Record<string, string>)["Idempotency-Key"], "honey-enroll-1");
    assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), {
      buzz_community_installation_id: "buzzci_11111111111111111111111111111111",
      identity_link_id: "idlnk_11111111111111111111111111111111",
      requested_grants: [{ project_id: "prj_1", capability: "deploy", expires_at: "2026-08-01T00:00:00.000Z" }],
      expires_at: "2026-08-01T00:00:00.000Z",
    });
  });

  it("reads Run402-public descriptors without requesting Run402 credentials", async () => {
    const { run402, authCalls } = sdk(() => response({ provider: "run402" }));
    await run402.buzz.communityInstallations.getPublicDescriptor("buzzci_11111111111111111111111111111111");
    assert.equal(authCalls(), 0);
  });

  it("discovers Run402 descriptors by normalized Buzz community without credentials", async () => {
    const descriptor = { provider: "run402", buzz_community_installation_id: "buzzci_11111111111111111111111111111111" };
    const { run402, calls, authCalls } = sdk(() => response({ buzz_community_installation_descriptors: [descriptor] }));
    const found = await run402.buzz.communityInstallations.discoverPublicDescriptors("buzz:community:acme.communities.buzz.xyz");
    assert.deepEqual(found, [descriptor]);
    assert.equal(calls[0]?.url, "https://api.run402.com/buzz-community-installation-descriptors/v1?buzz_community_subject=buzz%3Acommunity%3Aacme.communities.buzz.xyz");
    assert.equal(authCalls(), 0);
  });

  it("keeps policy/default updates and revocation Run402-owned", async () => {
    const { run402, calls } = sdk(() => response({ status: "active" }));
    await run402.buzz.communityInstallations.update("buzzci_11111111111111111111111111111111", {
      defaultForEnrollment: true,
      enrollmentPolicy: { mode: "manual", requires_current_community_membership: true },
      policyRevision: 1,
      idempotencyKey: "select-default-1",
    });
    await run402.buzz.communityInstallations.revoke("buzzci_11111111111111111111111111111111", "revoke-installation-1");
    assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), {
      default_for_enrollment: true,
      enrollment_policy: { mode: "manual", requires_current_community_membership: true },
      policy_revision: 1,
    });
    assert.equal(calls[1]?.init.body, undefined);
    assert.equal((calls[1]?.init.headers as Record<string, string>)["Idempotency-Key"], "revoke-installation-1");
  });

  it("rejects nested secret material before network access", async () => {
    const { run402, calls } = sdk(() => response({}));
    await assert.rejects(
      run402.buzz.communityInstallations.activate(
        "buzzci_11111111111111111111111111111111",
        { nsec: "nsec1never" } as never,
      ),
      /never accepted/,
    );
    assert.equal(calls.length, 0);
  });

  it("preserves code-specific gateway recovery without synthesizing a generic retry", async () => {
    const nextAction = {
      type: "repair_buzz_enrollment_scope",
      field: "requested_grants[0].capability",
      auth: "requesting_agent_siwx",
      why: "Narrow the rejected capability before resubmitting.",
      safe_to_auto_execute: false,
      requires_approval: true,
      destructive: false,
      idempotent: false,
      spend_impact: { currency: "USD", max_amount: "0" },
    };
    const { run402 } = sdk(() => response({
      error: "Unsupported enrollment scope",
      message: "Unsupported enrollment scope",
      code: "BUZZ_ENROLLMENT_SCOPE_UNSUPPORTED",
      category: "validation",
      source: "gateway",
      retryable: false,
      safe_to_retry: false,
      mutation_state: "not_started",
      trace_id: "trc_0123456789abcdef0123456789abcdef",
      details: { field: "requested_grants[0].capability" },
      next_actions: [nextAction],
    }, 422));

    await assert.rejects(
      run402.buzz.enroll({
        buzzCommunityInstallationId: "buzzci_11111111111111111111111111111111",
        identityLinkId: "idlnk_11111111111111111111111111111111",
        requestedGrants: [{ project_id: "prj_1", capability: "deploy", expires_at: "2026-08-01T00:00:00.000Z" }],
        expiresAt: "2026-08-01T00:00:00.000Z",
        idempotencyKey: "honey-enroll-invalid-scope",
      }),
      (error: unknown) => {
        const value = error as {
          code?: string;
          safeToRetry?: boolean;
          nextActions?: unknown[];
        };
        assert.equal(value.code, "BUZZ_ENROLLMENT_SCOPE_UNSUPPORTED");
        assert.equal(value.safeToRetry, false);
        assert.deepEqual(value.nextActions, [nextAction]);
        return true;
      },
    );
  });
});
