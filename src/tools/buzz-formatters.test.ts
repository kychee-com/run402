import assert from "node:assert/strict";
import { beforeEach, describe, it, mock } from "node:test";

let sdk: Record<string, unknown>;

mock.module("../sdk.js", {
  namedExports: { getSdk: () => sdk },
});

const { handleWhoami } = await import("./orgs.js");
const { handleProjectGet } = await import("./project-get.js");

beforeEach(() => {
  sdk = {};
});

describe("MCP Buzz control-plane formatting", () => {
  it("preserves independent lifecycle state and hands signing workflows to the CLI", async () => {
    sdk = {
      orgs: {
        whoami: async () => ({
          principal: { id: "prin_honey", type: "agent", display_name: null },
          authenticator_id: "authn_honey",
          active_authenticator: { kind: "siwx_eoa", public_subject: "eip155:8453:0x1234" },
          linked_identities: [],
          memberships: [],
          buzz: {
            skill_installation: { status: "client_managed" },
            human_adoptions: [],
            community_installations: [{
              buzz_community_installation_id: `buzzci_${"1".repeat(32)}`,
              org_id: `org_${"2".repeat(32)}`,
              status: "active",
              default_for_enrollment: true,
            }],
            agent_enrollments: [],
            eligibility: {
              can_start_identity_link_without_organization: false,
              can_select_community_installation: true,
              has_nonterminal_enrollment: false,
              cold_start_fallback_available: true,
            },
            drift: [],
            next_actions: [{
              type: "select_buzz_community_installation",
              field: "buzz_community_installation_id",
              auth: "agent_siwx",
              why: "Validate and select one.",
              safe_to_auto_execute: false,
              requires_approval: true,
              destructive: false,
              idempotent: true,
              spend_impact: { currency: "USD", max_amount: "0" },
            }],
          },
        }),
      },
    };
    const result = await handleWhoami();
    const text = result.content.map((entry) => entry.text).join("\n");
    assert.match(text, /buzz_control_plane: supported/);
    assert.match(text, /community_installations: 1/);
    assert.match(text, /run402 buzz enroll --help/);
    assert.match(text, /select_buzz_community_installation/);
    assert.match(text, /buzz_community_installation_id/);
    assert.match(text, /org-of-one provisioning remains available/);
    assert.doesNotMatch(text, /private.?key|nsec|seed|mnemonic/i);
  });

  it("keeps project ownership authoritative and gives a read-only enrollment handoff", async () => {
    sdk = {
      projects: {
        get: async () => ({
          name: "Fizz app",
          project_id: "prj_fizz",
          public_id: "prj_fizz",
          org_id: `org_${"2".repeat(32)}`,
          created_by: "prin_fizz",
          creator: null,
          tier: "prototype",
          effective_status: "active",
          organization_lifecycle_state: "active",
          site_url: null,
          custom_domains: [],
          last_deploy: null,
          mailbox: [],
          created_at: "2026-07-30T12:00:00.000Z",
          usage: {
            api_calls: 0,
            api_calls_limit: 500000,
            storage_bytes: 0,
            storage_bytes_limit: 250000000,
          },
        }),
      },
    };
    const result = await handleProjectGet({ project_id: "prj_fizz" });
    const text = result.content.map((entry) => entry.text).join("\n");
    assert.match(text, /owner \| organization/);
    assert.match(text, /run402 buzz enroll show/);
    assert.match(text, /Buzz signing remains outside MCP/);
  });
});
