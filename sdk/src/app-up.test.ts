import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  compileRun402AppInstallGraph,
  generatedMailboxBindings,
  RUN402_APP_SCHEMA_ID,
  type Run402AppSpec,
} from "./app-up.js";

const SHA = "a".repeat(64);

function appSpec(): Run402AppSpec {
  return {
    $schema: RUN402_APP_SCHEMA_ID,
    spec_version: 1,
    app: { id: "kysigned", display_name: "Kysigned" },
    project: { name: "${input.name}", origin: { subdomain: "${input.name}" } },
    resources: {
      mailboxes: {
        forward_to_sign: { roles: ["auth_sender"] },
        notifications: { roles: ["default_outbound"] },
      },
    },
    secrets: {
      KYSIGNED_ALLOWED_CREATORS: {
        required: true,
        source_env: "KYSIGNED_ALLOWED_CREATORS",
        description: "Allowed request creators. Comma-separated emails or domain wildcards such as *@example.com.",
      },
    },
    build: {
      mode: "remote",
      commands: [
        { id: "install", argv: ["npm", "ci"] },
        { id: "build", argv: ["npm", "run", "build:run402-cloud"] },
      ],
    },
    release: {
      functions: {
        replace: {
          api: {
            runtime: "node22",
            source: { sha256: SHA, size: 42 },
            triggers: [
              {
                id: "forward-to-sign",
                type: "email",
                mailbox: "${RUN402_MAILBOX_FORWARD_TO_SIGN_ID}",
                events: ["reply_received"],
                run: { event_type: "kysigned.email.received" },
              },
            ],
          },
        },
      },
    },
    verify: {
      http: [
        { id: "home", path: "/", expect: { status: 200 }, retries: 6 },
      ],
    },
  };
}

describe("app-up install graph", () => {
  it("compiles Run402AppSpec into deterministic graph nodes", async () => {
    const graph = await compileRun402AppInstallGraph(appSpec(), {
      source: {
        kind: "repo",
        repo_url: "https://github.com/kychee-com/kysigned",
        commit: "abc123",
      },
      name: "kysigned2",
      root_idempotency_key: "install-1",
    });

    assert.equal(graph.schema_version, "run402.app_install_graph.v1");
    assert.equal(graph.app_id, "kysigned");
    assert.match(graph.spec_digest, /^sha256:[0-9a-f]{64}$/);
    assert.match(graph.graph_digest, /^sha256:[0-9a-f]{64}$/);
    assert.deepEqual(graph.nodes.map((node) => node.id), [
      "discover",
      "account.ensure",
      "project.ensure",
      "origin.ensure",
      "mailbox.forward_to_sign.ensure",
      "mailbox.notifications.ensure",
      "bindings.resolve",
      "secrets.ensure",
      "build.remote",
      "release.apply",
      "verify.http.home",
    ]);
    assert.deepEqual(graph.nodes.find((node) => node.id === "mailbox.forward_to_sign.ensure")?.depends_on, [
      "project.ensure",
    ]);
    assert.equal(graph.nodes.find((node) => node.id === "release.apply")?.kind, "release.apply");
    assert.deepEqual(graph.release_spec, appSpec().release);
    assert.equal(JSON.stringify(graph.release_spec).includes("resources"), false);
    assert.deepEqual(graph.bindings.mailboxes.forward_to_sign, generatedMailboxBindings("forward_to_sign"));
    assert.equal(graph.nodes.every((node) => /^sha256:[0-9a-f]{64}$/.test(node.input_digest)), true);
  });

  it("keeps graph digest stable across object key order changes", async () => {
    const a = appSpec();
    const b = appSpec();
    b.resources = {
      mailboxes: {
        notifications: b.resources?.mailboxes?.notifications ?? {},
        forward_to_sign: b.resources?.mailboxes?.forward_to_sign ?? {},
      },
    };

    const graphA = await compileRun402AppInstallGraph(a, { name: "kysigned2" });
    const graphB = await compileRun402AppInstallGraph(b, { name: "kysigned2" });

    assert.equal(graphA.spec_digest, graphB.spec_digest);
    assert.equal(graphA.graph_digest, graphB.graph_digest);
    assert.deepEqual(graphA.nodes.map((node) => node.id), graphB.nodes.map((node) => node.id));
  });

  it("rejects release email trigger mailbox templates without generated bindings", async () => {
    const spec = appSpec();
    spec.release.functions!.replace!.api!.triggers![0]!.mailbox = "${RUN402_MAILBOX_UNKNOWN_ID}";

    await assert.rejects(
      () => compileRun402AppInstallGraph(spec, { name: "kysigned2" }),
      /release\.functions\.replace\.api\.triggers\.0\.mailbox.*RUN402_MAILBOX_UNKNOWN_ID/,
    );
  });
});
