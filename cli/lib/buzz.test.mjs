import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

let sdk;
const authModes = [];

mock.module("./sdk.mjs", {
  namedExports: {
    getSdk: (options = {}) => {
      authModes.push(options.authMode ?? "default");
      return sdk;
    },
  },
});

const { run } = await import("./buzz.mjs");
// Link the notifications group NOW, while the sdk.mjs module mock is active —
// buzz.mjs imports it lazily, and a first import that happens mid-suite (after
// an afterEach mock.restoreAll) would bind the REAL getSdk.
await import("./buzz-notifications.mjs");

let stdout;
let stderr;

beforeEach(() => {
  stdout = [];
  stderr = [];
  authModes.length = 0;
  mock.method(console, "log", (value) => stdout.push(String(value)));
  mock.method(console, "error", (value) => stderr.push(String(value)));
});

afterEach(() => mock.restoreAll());

describe("run402 buzz CLI", () => {
  it("renders the four independent lifecycle states in help", async () => {
    sdk = {};
    await run("help");
    assert.match(stdout.join("\n"), /skill installation/);
    assert.match(stdout.join("\n"), /community installation/);
    assert.match(stdout.join("\n"), /human adoption/);
    assert.match(stdout.join("\n"), /agent enrollment/);
  });

  it("reports an older gateway as unsupported without attempting a mutation", async () => {
    sdk = {
      buzz: {
        status: async () => ({
          supported: false,
          protocol: "run402.buzz-control-plane.v1",
          reason: "gateway_not_supported",
          buzz: null,
        }),
      },
    };
    await run("status");
    assert.equal(JSON.parse(stdout[0]).supported, false);
    assert.match(stderr.join("\n"), /predates/);
  });

  it("creates the canonical conversational adoption offer after capability detection", async () => {
    const directory = mkdtempSync(join(tmpdir(), "run402-buzz-offer-cli-"));
    const contextPath = join(directory, "deployment.json");
    const deploymentContext = {
      project_id: "prj_church",
      release_id: "rel_demo",
      live_url: "https://church.run402.com/",
      source_revision: "abc123",
      verified_at: "2026-07-31T10:00:00.000Z",
    };
    writeFileSync(contextPath, JSON.stringify(deploymentContext));
    let observed;
    sdk = {
      buzz: {
        status: async () => ({
          supported: true,
          buzz: { capabilities: { human_adoption_offers: true, browser_fragment_v1: true } },
        }),
        offerAdoption: async (input) => {
          observed = input;
          return {
            buzz_human_adoption_offer_id: `buzzhao_${"1".repeat(32)}`,
            status: "available",
            handoff_url: `https://console.run402.com/buzz/adoptions/buzzhao_${"1".repeat(32)}`,
          };
        },
      },
    };
    try {
      await run("adopt", [
        "offer",
        "--org", `org_${"2".repeat(32)}`,
        "--identity-link", `idlnk_${"3".repeat(32)}`,
        "--deployment-context-file", contextPath,
        "--idempotency-key", "offer-after-demo-1",
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
    assert.deepEqual(observed.deploymentContext, deploymentContext);
    assert.equal(observed.idempotencyKey, "offer-after-demo-1");
    assert.deepEqual(authModes, ["wallet"]);
    assert.equal(JSON.parse(stdout[0]).status, "available");
    assert.doesNotMatch(stdout[0], /private|session|credential/i);
  });

  it("polls and cancels offers with the initiating agent wallet", async () => {
    const calls = [];
    sdk = {
      buzz: {
        humanAdoptionOffers: {
          get: async (id) => { calls.push(["get", id]); return { status: "available" }; },
          cancel: async (id, key) => { calls.push(["cancel", id, key]); return { status: "cancelled" }; },
        },
      },
    };
    const id = `buzzhao_${"1".repeat(32)}`;
    await run("adopt", ["offer", "show", id]);
    await run("adopt", ["offer", "cancel", id, "--idempotency-key", "cancel-1"]);
    assert.deepEqual(calls, [["get", id], ["cancel", id, "cancel-1"]]);
    assert.deepEqual(authModes, ["wallet", "wallet"]);
  });

  it("explains completed receipt, public identity attribution, and membership as independent effects", async () => {
    sdk = {
      buzz: {
        humanAdoptionOffers: {
          get: async () => ({
            status: "completed",
            completed_buzz_human_adoption: {
              status: "completed",
              consent_receipt: { status: "completed" },
              public_identity_attribution: {
                human_identity_link_id: `idlnk_${"1".repeat(32)}`,
                authority_for_organization: false,
                revoke_independently: true,
              },
              organization_authority: {
                membership_id: `org_${"2".repeat(32)}:prin_human`,
                role: "owner",
                source: "org_membership",
                revoke_independently: true,
              },
            },
          }),
        },
      },
    };
    await run("adopt", ["offer", "show", `buzzhao_${"3".repeat(32)}`]);
    assert.equal(JSON.parse(stdout[0]).status, "completed");
    assert.match(stderr.join("\n"), /terminal consent receipt/i);
    assert.match(stderr.join("\n"), /public identity attribution.*does not grant organization authority/i);
    assert.match(stderr.join("\n"), /ordinary owner membership.*only source of organization authority/i);
    assert.match(stderr.join("\n"), /revoke.*independently/i);
  });

  it("maps a Honey enrollment file to the goal-shaped SDK call and prints only JSON", async () => {
    const directory = mkdtempSync(join(tmpdir(), "run402-buzz-cli-"));
    const grantsPath = join(directory, "grants.json");
    const grants = [{
      project_id: "prj_existing",
      capability: "deploy",
      policy: {},
      expires_at: "2026-08-01T00:00:00.000Z",
    }];
    writeFileSync(grantsPath, JSON.stringify(grants));
    let observed;
    sdk = {
      buzz: {
        enroll: async (input) => {
          observed = input;
          return { buzz_agent_enrollment_id: `buzzae_${"1".repeat(32)}`, status: "pending" };
        },
      },
    };
    try {
      await run("enroll", [
        "--installation", `buzzci_${"2".repeat(32)}`,
        "--identity-link", `idlnk_${"3".repeat(32)}`,
        "--grants-file", grantsPath,
        "--expires-at", "2026-08-01T00:00:00.000Z",
        "--idempotency-key", "honey-request-1",
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
    assert.deepEqual(observed.requestedGrants, grants);
    assert.equal(observed.idempotencyKey, "honey-request-1");
    assert.deepEqual(authModes, ["wallet"]);
    assert.equal(JSON.parse(stdout[0]).status, "pending");
    assert.match(stderr.join("\n"), /pending/);
  });

  it("discovers descriptors by community without authentication", async () => {
    let observed;
    sdk = {
      buzz: {
        communityInstallations: {
          discoverPublicDescriptors: async (community) => {
            observed = community;
            return [{ provider: "run402", status: "active" }];
          },
        },
      },
    };
    await run("install", ["discover", "--community", "buzz:community:acme.communities.buzz.xyz"]);
    assert.equal(observed, "buzz:community:acme.communities.buzz.xyz");
    assert.deepEqual(authModes, ["none"]);
    assert.equal(JSON.parse(stdout[0])[0].provider, "run402");
  });

  it("updates and revokes a Run402 installation without asking Buzz to sign again", async () => {
    const directory = mkdtempSync(join(tmpdir(), "run402-buzz-cli-policy-"));
    const policyPath = join(directory, "policy.json");
    writeFileSync(policyPath, JSON.stringify({ mode: "manual", requires_current_community_membership: true }));
    const calls = [];
    sdk = {
      buzz: {
        communityInstallations: {
          update: async (id, input) => { calls.push(["update", id, input]); return { status: "active" }; },
          revoke: async (id, key) => { calls.push(["revoke", id, key]); return { status: "revoked" }; },
        },
      },
    };
    try {
      await run("install", ["update", `buzzci_${"2".repeat(32)}`, "--policy-file", policyPath, "--policy-revision", "1", "--default", "true", "--idempotency-key", "select-default-1"]);
      await run("install", ["revoke", `buzzci_${"2".repeat(32)}`, "--idempotency-key", "revoke-installation-1"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
    assert.equal(calls[0][2].authorityProof, undefined);
    assert.equal(calls[1][2], "revoke-installation-1");
  });
});

describe("run402 buzz notifications CLI", () => {
  const ORG = "11111111-1111-4111-8111-111111111111";
  const ROUTE_ID = `buzzper_${"1".repeat(32)}`;
  const DELIVERY_ID = `buzzped_${"2".repeat(32)}`;

  beforeEach(() => {
    process.exitCode = undefined;
  });

  it("teaches the configure → authorize → test → live workflow in group help", async () => {
    sdk = {};
    await run("notifications", ["--help"]);
    const help = stdout.join("\n");
    assert.match(help, /Usage:/);
    assert.match(help, /configure -> authorize -> test -> live/);
    assert.match(help, /deploy_activated, error_fingerprints_observed/);
    assert.match(help, /may NEVER be routed/);
    assert.match(help, /Buzz Desktop -> Settings -> Profile -> Identity/);
    assert.match(help, /never a deadman channel/);
  });

  it("configure maps repeatable flags onto the SDK input and shouts the pending authorization handoff on stderr", async () => {
    let observedOrg;
    let observedInput;
    const pubkey = "ab".repeat(32);
    sdk = {
      buzz: {
        notifications: {
          createRoute: async (orgId, input) => {
            observedOrg = orgId;
            observedInput = input;
            return {
              buzz_project_event_route_id: ROUTE_ID,
              org_id: orgId,
              status: "pending_authorization",
              authorization: {
                status: "pending_buzz_authorization",
                notification_pubkey: pubkey,
                connect_command: `buzz-admin add-member --pubkey ${pubkey}`,
                instructions: `Ask a community owner or admin to add this pubkey as a relay member (e.g. ./run.sh add-member ${pubkey}), then POST the test route to verify.`,
                verify_path: `/buzz-project-event-routes/v1/${ROUTE_ID}/test`,
              },
            };
          },
        },
      },
    };
    await run("notifications", [
      "configure",
      "--org", ORG,
      "--installation", `buzzci_${"3".repeat(32)}`,
      "--name", "deploys",
      "--channel", "chan-1",
      "--project", "prj_a",
      "--project", "prj_b",
      "--event-type", "deploy_activated",
      "--idempotency-key", "route-1",
    ]);
    assert.equal(observedOrg, ORG, "org_id is the bare dashed UUID, passed through verbatim");
    assert.deepEqual(observedInput.projectIds, ["prj_a", "prj_b"]);
    assert.deepEqual(observedInput.eventTypes, ["deploy_activated"]);
    assert.equal(observedInput.eventClasses, undefined, "an unset filter is omitted, never fabricated");
    assert.equal(observedInput.idempotencyKey, "route-1");
    assert.equal(JSON.parse(stdout[0]).authorization.status, "pending_buzz_authorization");
    const err = stderr.join("\n");
    assert.match(err, /PENDING BUZZ AUTHORIZATION/);
    assert.ok(err.includes(pubkey), "the notification pubkey is the one exact handoff and must be on stderr");
    assert.match(err, /add-member/);
    assert.doesNotMatch(err, /private|nsec|secret/i);
  });

  it("status lists for an org and reads one route by positional id", async () => {
    const calls = [];
    sdk = {
      buzz: {
        notifications: {
          list: async (orgId) => { calls.push(["list", orgId]); return [{ buzz_project_event_route_id: ROUTE_ID }]; },
          get: async (routeId) => { calls.push(["get", routeId]); return { buzz_project_event_route_id: routeId, health: "active" }; },
        },
      },
    };
    await run("notifications", ["status", "--org", ORG]);
    await run("notifications", ["status", ROUTE_ID]);
    assert.deepEqual(calls, [["list", ORG], ["get", ROUTE_ID]]);
    assert.deepEqual(JSON.parse(stdout[0]).buzz_project_event_routes, [{ buzz_project_event_route_id: ROUTE_ID }]);
    assert.equal(JSON.parse(stdout[1]).health, "active");
  });

  it("test --wait narrates once on stderr and reports a delivered route as live", async () => {
    sdk = {
      buzz: {
        notifications: {
          testAndWait: async (routeId, opts) => {
            opts.onPoll({ buzz_project_event_delivery_id: DELIVERY_ID, status: "queued", poll: { path: "p" } });
            const delivered = {
              buzz_project_event_delivery_id: DELIVERY_ID,
              status: "delivered",
              nostr_event_id: "ev1",
            };
            opts.onPoll(delivered);
            return delivered;
          },
        },
      },
    };
    await run("notifications", ["test", ROUTE_ID, "--wait"]);
    assert.equal(JSON.parse(stdout[0]).status, "delivered");
    const announcements = stderr.filter((line) => line.includes(DELIVERY_ID) && line.includes("waiting"));
    assert.equal(announcements.length, 1, "the queued announcement happens exactly once");
    assert.match(stderr.join("\n"), /route is live/i);
    assert.equal(process.exitCode, undefined);
  });

  it("test --wait exits 2 on a still-queued timeout — the tick cadence is not failure", async () => {
    sdk = {
      buzz: {
        notifications: {
          testAndWait: async (routeId, opts) => {
            const queued = { buzz_project_event_delivery_id: DELIVERY_ID, status: "queued", poll: { path: "p" } };
            opts.onPoll(queued);
            return queued;
          },
        },
      },
    };
    await run("notifications", ["test", ROUTE_ID, "--wait", "--poll-seconds", "2", "--timeout-seconds", "10"]);
    const exitCode = process.exitCode;
    // Reset before asserting so a signalled exit code never leaks into the
    // test child process's own exit status.
    process.exitCode = undefined;
    assert.equal(JSON.parse(stdout[0]).status, "queued", "stdout stays one JSON doc — the still-queued delivery");
    assert.match(stderr.join("\n"), /still queued — the tick publishes within ~60s; silence is not failure, poll deliveries/);
    assert.equal(exitCode, 2);
  });

  it("test without --wait prints the queued 202 and the poll handoff", async () => {
    sdk = {
      buzz: {
        notifications: {
          test: async (routeId, key) => ({
            buzz_project_event_delivery_id: DELIVERY_ID,
            status: "queued",
            poll: { path: `/buzz-project-event-routes/v1/${routeId}/deliveries?delivery_id=${DELIVERY_ID}` },
            _key: key,
          }),
        },
      },
    };
    await run("notifications", ["test", ROUTE_ID]);
    assert.equal(JSON.parse(stdout[0]).status, "queued");
    assert.match(stderr.join("\n"), /publishes within ~60s/);
    assert.match(stderr.join("\n"), new RegExp(`deliveries ${ROUTE_ID} --delivery ${DELIVERY_ID}`));
    assert.equal(process.exitCode, undefined);
  });

  it("deliveries maps limit/cursor/delivery flags onto SDK options", async () => {
    let observed;
    sdk = {
      buzz: {
        notifications: {
          deliveries: async (routeId, opts) => {
            observed = [routeId, opts];
            return { buzz_project_event_deliveries: [], has_more: false };
          },
        },
      },
    };
    await run("notifications", ["deliveries", ROUTE_ID, "--limit", "20", "--cursor", "cur_1", "--delivery", DELIVERY_ID]);
    assert.deepEqual(observed, [ROUTE_ID, { limit: 20, cursor: "cur_1", deliveryId: DELIVERY_ID }]);
    assert.equal(JSON.parse(stdout[0]).has_more, false);
  });

  it("revoke reports credential destruction and rotate shouts the staged next-key handoff", async () => {
    const nextPubkey = "cd".repeat(32);
    sdk = {
      buzz: {
        notifications: {
          revoke: async (routeId, key) => ({
            buzz_project_event_route_id: routeId,
            status: "revoked",
            notification_credential_destroyed: true,
            _key: key,
          }),
          rotate: async (routeId) => ({
            buzz_project_event_route_id: routeId,
            rotation: {
              status: "pending_buzz_authorization",
              next_signing_generation: 2,
              next_notification_pubkey: nextPubkey,
              authorize_hint: "Ask a community owner or admin to add the NEXT pubkey as a relay member; the swap activates only after that membership verifies.",
              verify_path: `/buzz-project-event-routes/v1/${routeId}/test`,
            },
          }),
        },
      },
    };
    await run("notifications", ["revoke", ROUTE_ID, "--idempotency-key", "rm-1"]);
    assert.equal(JSON.parse(stdout[0]).notification_credential_destroyed, true);
    assert.match(stderr.join("\n"), /last live route/);
    await run("notifications", ["rotate", ROUTE_ID]);
    assert.equal(JSON.parse(stdout[1]).rotation.next_signing_generation, 2);
    const err = stderr.join("\n");
    assert.match(err, /STAGED, not active/);
    assert.ok(err.includes(nextPubkey), "the NEXT pubkey is the rotation handoff and must be on stderr");
  });
});
