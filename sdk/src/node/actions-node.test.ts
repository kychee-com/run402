import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { Run402Action } from "../actions.js";
import { RUN402_APP_SCHEMA_ID } from "../app-up.js";
import { NodeActions } from "./actions-node.js";

test("up check discovers run402.json app manifest and compiles an install graph locally", async () => {
  const dir = mkdtempSync(join(tmpdir(), "run402-app-up-check-"));
  writeFileSync(join(dir, "run402.json"), JSON.stringify(appManifest({
    build: {
      mode: "local",
      commands: [
        { id: "install", argv: ["npm", "ci"] },
        { id: "build", argv: ["npm", "run", "build:run402-cloud"] },
      ],
    },
  })));
  const previous = process.env.KYSIGNED_ALLOWED_CREATORS;
  process.env.KYSIGNED_ALLOWED_CREATORS = "*@example.com";
  const calls: string[] = [];
  const sdk = fakeSdk({
    calls,
    allowanceConfigured: false,
    tierActive: false,
    activeProject: null,
  });

  try {
    const actions = new NodeActions(sdk, { targetKind: "cloud", cwd: dir });
    const result = await actions.up({ name: "kysigned2" }, { mode: "check" });

    assert.equal(result.mode, "check");
    assert.equal(result.dry_run, true);
    assert.equal(result.result?.manifest_path, join(dir, "run402.json"));
    assert.equal(result.result?.app_graph?.app_id, "kysigned");
    assert.equal(result.result?.app_result?.kind, "run402.up.result");
    assert.equal(result.result?.app_result?.status, "planned");
    assert.equal(result.result?.app_result?.source?.kind, "local");
    assert.equal(result.result?.app_result?.resources.mailboxes.forward_to_sign.bindings[0]?.env, "RUN402_MAILBOX_FORWARD_TO_SIGN_ID");
    assert.deepEqual(result.result?.app_graph?.nodes.map((node) => node.id), [
      "discover",
      "account.ensure",
      "project.ensure",
      "origin.ensure",
      "mailbox.forward_to_sign.ensure",
      "mailbox.notifications.ensure",
      "bindings.resolve",
      "secrets.ensure",
      "build.local",
      "release.apply",
      "verify.http.home",
    ]);
    assert.deepEqual(calls, []);
  } finally {
    if (previous === undefined) delete process.env.KYSIGNED_ALLOWED_CREATORS;
    else process.env.KYSIGNED_ALLOWED_CREATORS = previous;
    rmSync(dir, { force: true, recursive: true });
  }
});

test("up check blocks fast with missing required secret usage and no gateway calls", async () => {
  const dir = mkdtempSync(join(tmpdir(), "run402-app-up-check-missing-secret-"));
  writeFileSync(join(dir, "run402.json"), JSON.stringify(appManifest()));
  const previous = process.env.KYSIGNED_ALLOWED_CREATORS;
  delete process.env.KYSIGNED_ALLOWED_CREATORS;
  const calls: string[] = [];
  const sdk = fakeSdk({
    calls,
    allowanceConfigured: false,
    tierActive: false,
    activeProject: null,
  });

  try {
    const actions = new NodeActions(sdk, { targetKind: "cloud", cwd: dir });
    const result = await actions.up({ name: "kysigned2" }, { mode: "check" });

    assert.equal(result.mode, "check");
    assert.equal(result.dry_run, true);
    assert.equal(result.result?.app_result?.status, "blocked");
    assert.equal(result.result?.app_result?.diagnostics[0]?.code, "MISSING_SECRET");
    assert.match(result.result?.app_result?.diagnostics[0]?.message ?? "", /Allowed request creators/);
    assert.match(result.result?.app_result?.next_actions[0]?.message ?? "", /Provide KYSIGNED_ALLOWED_CREATORS/);
    assert.equal(result.result?.app_result?.steps.find((step) => step.id === "secrets.ensure")?.status, "blocked");
    assert.deepEqual(calls, []);
  } finally {
    if (previous === undefined) delete process.env.KYSIGNED_ALLOWED_CREATORS;
    else process.env.KYSIGNED_ALLOWED_CREATORS = previous;
    rmSync(dir, { force: true, recursive: true });
  }
});

test("up dry-run for run402.json returns graph without gateway calls or local link writes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "run402-app-up-dry-run-"));
  writeFileSync(join(dir, "run402.json"), JSON.stringify(appManifest()));
  const calls: string[] = [];
  const sdk = fakeSdk({
    calls,
    allowanceConfigured: false,
    tierActive: false,
    activeProject: null,
  });

  try {
    const actions = new NodeActions(sdk, { targetKind: "cloud", cwd: dir });
    const result = await actions.up({ name: "kysigned2" }, { dryRun: true });

    assert.equal(result.dry_run, true);
    assert.equal(result.result?.project_id, "prj_planned");
    assert.equal(result.result?.app_result?.dry_run, true);
    assert.equal(result.result?.app_result?.project.public_origin, "https://kysigned2.run402.com");
    assert.match(result.result?.app_graph?.graph_digest ?? "", /^sha256:[0-9a-f]{64}$/);
    assert.deepEqual(calls, []);
    assert.equal(existsSync(join(dir, ".run402", "project.json")), false);
    assert.ok(result.steps.some((step) => step.action === "deploy.discover" && step.details?.manifest_kind === "app"));
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("up app apply blocks fast with missing required secret usage as shared next action", async () => {
  const dir = mkdtempSync(join(tmpdir(), "run402-app-up-missing-secret-"));
  writeFileSync(join(dir, "run402.json"), JSON.stringify(appManifest()));
  const previous = process.env.KYSIGNED_ALLOWED_CREATORS;
  delete process.env.KYSIGNED_ALLOWED_CREATORS;
  const calls: string[] = [];
  const sdk = fakeSdk({
    calls,
    allowanceConfigured: true,
    tierActive: true,
    activeProject: null,
  });

  try {
    const actions = new NodeActions(sdk, { targetKind: "cloud", cwd: dir });
    const result = await actions.up({ name: "kysigned2" }, { approval: "yes" });

    assert.equal(result.result?.app_result?.status, "blocked");
    assert.equal(result.result?.app_result?.diagnostics[0]?.code, "MISSING_SECRET");
    assert.match(result.result?.app_result?.diagnostics[0]?.message ?? "", /Allowed request creators/);
    assert.match(result.result?.app_result?.diagnostics[0]?.message ?? "", /\*@example\.com/);
    assert.equal(result.result?.app_result?.next_actions[0]?.type, "set_user_secret");
    assert.match(result.result?.app_result?.next_actions[0]?.message ?? "", /Comma-separated emails/);
    assert.equal(result.result?.app_result?.next_actions[0]?.command, 'KYSIGNED_ALLOWED_CREATORS="<value>" run402 up --name <name> --yes');
    assert.equal(result.result?.app_result?.steps.find((step) => step.id === "secrets.ensure")?.status, "blocked");
    assert.deepEqual(calls, []);
  } finally {
    if (previous === undefined) delete process.env.KYSIGNED_ALLOWED_CREATORS;
    else process.env.KYSIGNED_ALLOWED_CREATORS = previous;
    rmSync(dir, { force: true, recursive: true });
  }
});

test("up app apply blocks with name guidance when manifest needs input.name", async () => {
  const dir = mkdtempSync(join(tmpdir(), "run402-app-up-missing-name-"));
  writeFileSync(join(dir, "run402.json"), JSON.stringify(appManifest()));
  const previous = process.env.KYSIGNED_ALLOWED_CREATORS;
  process.env.KYSIGNED_ALLOWED_CREATORS = "*@example.com";
  const calls: string[] = [];
  const sdk = fakeSdk({
    calls,
    allowanceConfigured: true,
    tierActive: true,
    activeProject: null,
  });

  try {
    const actions = new NodeActions(sdk, { targetKind: "cloud", cwd: dir });
    const result = await actions.up({}, { approval: "yes" });

    assert.equal(result.result?.app_result?.status, "blocked");
    assert.equal(result.result?.app_result?.diagnostics[0]?.code, "PROJECT_REQUIRED");
    assert.match(result.result?.app_result?.diagnostics[0]?.message ?? "", /instance name/);
    assert.equal(result.result?.app_result?.next_actions[0]?.command, "run402 up --name <name> --yes");
    assert.equal(result.result?.app_result?.steps.find((step) => step.id === "project.ensure")?.status, "blocked");
    assert.deepEqual(calls, []);
  } finally {
    if (previous === undefined) delete process.env.KYSIGNED_ALLOWED_CREATORS;
    else process.env.KYSIGNED_ALLOWED_CREATORS = previous;
    rmSync(dir, { force: true, recursive: true });
  }
});

test("up app apply fails fast when --name collides with an existing project", async () => {
  const dir = mkdtempSync(join(tmpdir(), "run402-app-up-name-collision-"));
  writeFileSync(join(dir, "run402.json"), JSON.stringify(appManifest({
    build: {
      mode: "local",
      commands: [],
    },
  })));
  const previous = process.env.KYSIGNED_ALLOWED_CREATORS;
  process.env.KYSIGNED_ALLOWED_CREATORS = "*@example.com";
  const calls: string[] = [];
  const sdk = fakeSdk({
    calls,
    allowanceConfigured: true,
    tierActive: true,
    activeProject: null,
    existingProjects: [{
      id: "prj_existing",
      name: "kysigned5",
      site_url: "https://kysigned5.run402.com",
      status: "active",
      created_at: "2026-07-02T00:00:00.000Z",
    }],
  });

  try {
    const actions = new NodeActions(sdk, { targetKind: "cloud", cwd: dir });
    await assert.rejects(
      actions.up({ name: "kysigned5" }, { approval: "yes" }),
      /Project name "kysigned5" is already in use by prj_existing/,
    );
    assert.ok(calls.includes("projects.list"));
    assert.ok(!calls.some((call) => call.startsWith("projects.provision")));
  } finally {
    if (previous === undefined) delete process.env.KYSIGNED_ALLOWED_CREATORS;
    else process.env.KYSIGNED_ALLOWED_CREATORS = previous;
    rmSync(dir, { force: true, recursive: true });
  }
});

test("up project creation does not reuse a stable idempotency key by default", async () => {
  const dir = mkdtempSync(join(process.cwd(), ".tmp-run402-app-up-project-idempotency-"));
  writeFileSync(join(dir, "run402.json"), JSON.stringify(appManifest({
    build: {
      mode: "local",
      commands: [],
    },
  })));
  const previous = process.env.KYSIGNED_ALLOWED_CREATORS;
  process.env.KYSIGNED_ALLOWED_CREATORS = "*@example.com";
  const calls: string[] = [];
  const sdk = fakeSdk({
    calls,
    allowanceConfigured: true,
    tierActive: true,
    activeProject: null,
  });

  try {
    const actions = new NodeActions(sdk, { targetKind: "cloud", cwd: dir });
    await actions.up({ name: "kysigned5" }, { approval: "yes" });

    assert.ok(calls.includes("projects.provision:"), "default up project creation must omit a long-lived idempotency key");
    assert.ok(!calls.some((call) => call.startsWith("projects.provision:action:up:")));
  } finally {
    if (previous === undefined) delete process.env.KYSIGNED_ALLOWED_CREATORS;
    else process.env.KYSIGNED_ALLOWED_CREATORS = previous;
    rmSync(dir, { force: true, recursive: true });
  }
});

test("up project creation preserves explicit idempotency keys", async () => {
  const dir = mkdtempSync(join(process.cwd(), ".tmp-run402-app-up-explicit-project-idempotency-"));
  writeFileSync(join(dir, "run402.json"), JSON.stringify(appManifest({
    build: {
      mode: "local",
      commands: [],
    },
  })));
  const previous = process.env.KYSIGNED_ALLOWED_CREATORS;
  process.env.KYSIGNED_ALLOWED_CREATORS = "*@example.com";
  const calls: string[] = [];
  const sdk = fakeSdk({
    calls,
    allowanceConfigured: true,
    tierActive: true,
    activeProject: null,
  });

  try {
    const actions = new NodeActions(sdk, { targetKind: "cloud", cwd: dir });
    await actions.up({ name: "kysigned5", idempotencyKey: "user-up-key" }, { approval: "yes" });

    assert.ok(calls.includes("projects.provision:user-up-key"));
  } finally {
    if (previous === undefined) delete process.env.KYSIGNED_ALLOWED_CREATORS;
    else process.env.KYSIGNED_ALLOWED_CREATORS = previous;
    rmSync(dir, { force: true, recursive: true });
  }
});

test("up app apply blocks remote build with explicit unsupported next action", async () => {
  const dir = mkdtempSync(join(tmpdir(), "run402-app-up-remote-build-"));
  writeFileSync(join(dir, "run402.json"), JSON.stringify(appManifest()));
  const previous = process.env.KYSIGNED_ALLOWED_CREATORS;
  process.env.KYSIGNED_ALLOWED_CREATORS = "0xcreator";
  const calls: string[] = [];
  const sdk = fakeSdk({
    calls,
    allowanceConfigured: true,
    tierActive: true,
    activeProject: null,
  });

  try {
    const actions = new NodeActions(sdk, { targetKind: "cloud", cwd: dir });
    const result = await actions.up({ name: "kysigned2" }, { approval: "yes" });

    assert.equal(result.result?.app_result?.status, "blocked");
    assert.equal(result.result?.app_result?.diagnostics[0]?.code, "REMOTE_BUILD_UNSUPPORTED");
    assert.equal(result.result?.app_result?.next_actions[0]?.argv?.slice(0, 4).join(" "), "run402 up --build-mode local");
    assert.equal(result.result?.app_result?.steps.find((step) => step.id === "build.remote")?.status, "blocked");
    assert.deepEqual(calls, []);
  } finally {
    if (previous === undefined) delete process.env.KYSIGNED_ALLOWED_CREATORS;
    else process.env.KYSIGNED_ALLOWED_CREATORS = previous;
    rmSync(dir, { force: true, recursive: true });
  }
});

test("up app apply runs local build, sets generated bindings, deploys, and registers webhooks", async () => {
  const dir = mkdtempSync(join(process.cwd(), ".tmp-run402-app-up-apply-"));
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(join(dir, "scripts", "build.mjs"), `
import { mkdirSync, writeFileSync } from "node:fs";
mkdirSync("dist/run402/cloud-functions", { recursive: true });
mkdirSync("frontend/dist", { recursive: true });
writeFileSync("dist/run402/cloud-functions/api.js", "export default async () => new Response('ok');\\n");
writeFileSync("frontend/dist/index.html", "<h1>" + process.env.RUN402_PUBLIC_ORIGIN + "</h1>");
`);
  writeFileSync(join(dir, "run402.json"), JSON.stringify(appManifest({
    build: {
      mode: "local",
      commands: [
        { id: "build", argv: [process.execPath, "scripts/build.mjs"] },
      ],
    },
    release: {
      secrets: {
        require: [
          "RUN402_PROJECT_ID",
          "RUN402_SERVICE_KEY",
          "RUN402_ANON_KEY",
          "RUN402_PUBLIC_ORIGIN",
          "RUN402_MAILBOX_FORWARD_TO_SIGN_ID",
          "RUN402_MAILBOX_NOTIFICATIONS_ID",
          "KYSIGNED_ALLOWED_CREATORS",
        ],
      },
      functions: {
        replace: {
          api: {
            runtime: "node22",
            source: { path: "dist/run402/cloud-functions/api.js" },
          },
        },
      },
      site: {
        replace: { __source: "local-dir", path: "frontend/dist" },
        public_paths: { mode: "implicit" },
      },
      subdomains: { set: ["${input.name}"] },
      routes: {
        replace: [
          { pattern: "/v1/*", target: { type: "function", name: "api" } },
        ],
      },
    },
    resources: {
      mailboxes: {
        forward_to_sign: { roles: ["auth_sender"] },
        notifications: { roles: ["default_outbound"] },
      },
      webhooks: {
        inbound: {
          mailbox: "forward_to_sign",
          url: "${RUN402_PUBLIC_ORIGIN}/v1/webhooks/inbound",
          events: ["reply_received"],
        },
      },
    },
    verify: undefined,
  })));
  const previous = process.env.KYSIGNED_ALLOWED_CREATORS;
  process.env.KYSIGNED_ALLOWED_CREATORS = "*@example.com";
  const calls: string[] = [];
  const streamed: unknown[] = [];
  const secrets: Array<{ key: string; value: string }> = [];
  const appliedSpecs: unknown[] = [];
  const installStates: Array<Record<string, unknown>> = [];
  const sdk = fakeSdk({
    calls,
    secrets,
    appliedSpecs,
    installStates,
    allowanceConfigured: true,
    tierActive: true,
    activeProject: null,
  });

  try {
    const actions = new NodeActions(sdk, { targetKind: "cloud", cwd: dir });
    const result = await actions.up(
      { name: "kysigned3" },
      {
        approval: "yes",
        idempotencyKey: "app-test",
        onEvent: (event) => streamed.push(event),
      },
    );

    assert.equal(result.result?.project_id, "prj_new");
    assert.equal(result.result?.app_result?.status, "succeeded");
    assert.equal(result.result?.app_result?.project.public_origin, "https://kysigned3.run402.com");
    assert.equal(result.result?.app_result?.resources.mailboxes.forward_to_sign.id, "mbx_forward_to_sign");
    assert.equal(result.result?.app_result?.resources.webhooks.inbound.url, "https://kysigned3.run402.com/v1/webhooks/inbound");
    assert.equal(readFileSync(join(dir, "frontend/dist/index.html"), "utf-8"), "<h1>https://kysigned3.run402.com</h1>");
    assert.deepEqual(
      secrets.map((secret) => secret.key).sort(),
      [
        "KYSIGNED_ALLOWED_CREATORS",
        "RUN402_ANON_KEY",
        "RUN402_MAILBOX_FORWARD_TO_SIGN_ID",
        "RUN402_MAILBOX_NOTIFICATIONS_ID",
        "RUN402_PROJECT_ID",
        "RUN402_PUBLIC_ORIGIN",
        "RUN402_SERVICE_KEY",
      ],
    );
    assert.equal(secrets.find((secret) => secret.key === "RUN402_MAILBOX_FORWARD_TO_SIGN_ID")?.value, "mbx_forward_to_sign");
    assert.equal(secrets.find((secret) => secret.key === "KYSIGNED_ALLOWED_CREATORS")?.value, "*@example.com");
    assert.equal(appliedSpecs.length, 1);
    assert.ok(calls.includes("email.createMailbox:prj_new:forward-to-sign"));
    assert.ok(calls.includes("email.createMailbox:prj_new:notifications"));
    assert.ok(calls.includes("email.webhooks.register:prj_new:mbx_forward_to_sign"));
    assert.ok(calls.includes("project.apply:prj_new"));
    assert.deepEqual(
      installStates.map((state) => state.status),
      ["applying", "active"],
    );
    assert.equal(installStates[0]?.project_id, "prj_new");
    assert.equal(installStates[0]?.app_key, "kysigned");
    assert.match(String(installStates[0]?.manifest_digest), /^sha256:[0-9a-f]{64}$/);
    assert.equal("error" in installStates[0]!, false);
    assert.equal("last_operation_id" in installStates[0]!, false);
    assert.equal(installStates[1]?.last_operation_id, "op_123");
    assert.ok(streamed.some((event) => {
      const step = (event as { step?: { action?: string; details?: Record<string, unknown> } }).step;
      return step?.action === "app.build" &&
        step.details?.current_command_id === "build" &&
        step.details?.current_command_index === 1 &&
        step.details?.command_count === 1;
    }), "expected app.build progress to include the current command");
    assert.deepEqual((installStates[1]?.resources as { mailboxes?: unknown })?.mailboxes, {
      forward_to_sign: {
        id: "mbx_forward_to_sign",
        slug: "forward-to-sign",
        address: "forward-to-sign@kysigned3.mail.run402.com",
        managed_address: "forward-to-sign@kysigned3.mail.run402.com",
      },
      notifications: {
        id: "mbx_notifications",
        slug: "notifications",
        address: "notifications@kysigned3.mail.run402.com",
        managed_address: "notifications@kysigned3.mail.run402.com",
      },
    });
  } finally {
    if (previous === undefined) delete process.env.KYSIGNED_ALLOWED_CREATORS;
    else process.env.KYSIGNED_ALLOWED_CREATORS = previous;
    rmSync(dir, { force: true, recursive: true });
  }
});

test("up accepts repository URL sources and records commit metadata", async () => {
  const repo = mkdtempSync(join(tmpdir(), "run402-app-up-source-repo-"));
  writeFileSync(join(repo, "run402.json"), JSON.stringify(appManifest()));
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "agent@example.com"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Run402 Agent"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["add", "run402.json"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repo, stdio: "ignore" });
  const calls: string[] = [];
  const sdk = fakeSdk({
    calls,
    allowanceConfigured: false,
    tierActive: false,
    activeProject: null,
  });

  try {
    const actions = new NodeActions(sdk, { targetKind: "cloud" });
    const result = await actions.up({
      source: pathToFileURL(repo).href,
      name: "kysigned2",
    }, { mode: "check" });

    assert.equal(result.result?.app_result?.source?.kind, "repo");
    assert.match(result.result?.app_result?.source?.commit ?? "", /^[0-9a-f]{40}$/);
    assert.match(result.result?.manifest_path ?? "", /run402\.json$/);
    assert.deepEqual(calls, []);
  } finally {
    rmSync(repo, { force: true, recursive: true });
  }
});

test("up dry-run plans recursive steps without gateway mutations or local writes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "run402-up-dry-run-"));
  writeFileSync(join(dir, "run402.deploy.json"), JSON.stringify({
    site: { replace: { "index.html": { data: "<h1>hello</h1>" } } },
  }));
  const calls: string[] = [];
  const sdk = fakeSdk({
    calls,
    allowanceConfigured: false,
    tierActive: false,
    activeProject: null,
  });

  try {
    const actions = new NodeActions(sdk, { targetKind: "cloud", cwd: dir });
    const result = await actions.run({
      type: Run402Action.Up,
      name: "my-app",
      idempotencyKey: "up-test",
    }, { dryRun: true });

    assert.equal(result.dry_run, true);
    assert.equal(result.result?.project_id, "prj_planned");
    assert.deepEqual(calls, ["allowance.status"]);
    assert.equal(existsSync(join(dir, ".run402", "project.json")), false);
    assert.ok(result.steps.some((step) => step.action === "allowance.create" && step.state === "planned"));
    assert.ok(result.steps.some((step) => step.action === "tier.set" && step.state === "planned"));
    assert.ok(result.steps.some((step) => step.action === "projects.provision" && step.state === "planned"));
    assert.ok(result.steps.some((step) => step.action === "deploy.apply" && step.state === "planned"));
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

function appManifest(overrides: Record<string, unknown> = {}) {
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
            source: { sha256: "a".repeat(64), size: 42 },
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
      http: [{ id: "home", path: "/", expect: { status: 200 } }],
    },
    ...overrides,
  };
}

test("up check validates locally without gateway calls", async () => {
  const dir = mkdtempSync(join(tmpdir(), "run402-up-check-"));
  writeFileSync(join(dir, "run402.deploy.json"), JSON.stringify({
    site: { replace: { "index.html": { data: "<h1>hello</h1>" } } },
  }));
  const calls: string[] = [];
  const sdk = fakeSdk({
    calls,
    allowanceConfigured: false,
    tierActive: false,
    activeProject: null,
  });

  try {
    const actions = new NodeActions(sdk, { targetKind: "cloud", cwd: dir });
    const result = await actions.up({}, { mode: "check" });

    assert.equal(result.mode, "check");
    assert.equal(result.dry_run, true);
    assert.equal(result.result?.manifest_path, join(dir, "run402.deploy.json"));
    assert.deepEqual(calls, []);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("up requires explicit manifest for executable configs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "run402-up-exec-trust-"));
  writeFileSync(join(dir, "run402.deploy.ts"), "export default { site: { replace: {} } };\n");
  const sdk = fakeSdk({
    calls: [],
    allowanceConfigured: false,
    tierActive: false,
    activeProject: null,
  });

  try {
    const actions = new NodeActions(sdk, { targetKind: "cloud", cwd: dir });
    await assert.rejects(
      () => actions.up({}, { mode: "check" }),
      (err) => {
        const e = err as { code?: string; details?: { next_actions?: Array<{ argv?: string[] }> } };
        assert.equal(e.code, "EXECUTABLE_CONFIG_REQUIRES_EXPLICIT_MANIFEST");
        assert.deepEqual(e.details?.next_actions?.[0]?.argv?.slice(-1), ["--check"]);
        return true;
      },
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("up plan returns same-surface require-plan next action", async () => {
  const dir = mkdtempSync(join(tmpdir(), "run402-up-plan-"));
  writeFileSync(join(dir, "run402.deploy.json"), JSON.stringify({
    project_id: "prj_ready",
    site: { replace: { "index.html": { data: "<h1>ready</h1>" } } },
  }));
  const calls: string[] = [];
  const sdk = fakeSdk({
    calls,
    allowanceConfigured: true,
    tierActive: true,
    activeProject: null,
  });

  try {
    const actions = new NodeActions(sdk, { targetKind: "cloud", cwd: dir });
    const result = await actions.up({}, { mode: "plan" });

    assert.equal(result.mode, "plan");
    assert.equal(result.result?.plan?.plan_id, "plan_123");
    assert.deepEqual(result.result?.plan?.next_actions?.[0], {
      type: "retry",
      command: `run402 up --manifest ${join(dir, "run402.deploy.json")} --require-plan plan_123 --plan-fingerprint pfp_123`,
      argv: ["run402", "up", "--manifest", join(dir, "run402.deploy.json"), "--require-plan", "plan_123", "--plan-fingerprint", "pfp_123"],
      why: "Apply exactly this reviewed plan from the same repo surface before it expires.",
    });
    assert.deepEqual(calls, [
      "projects.keys:prj_ready",
      "project:prj_ready",
      "project.apply.plan:prj_ready",
    ]);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("up deploys when workspace link and active tier are configured", async () => {
  const dir = mkdtempSync(join(tmpdir(), "run402-up-configured-"));
  writeFileSync(join(dir, "run402.deploy.json"), JSON.stringify({
    site: { replace: { "index.html": { data: "<h1>ready</h1>" } } },
  }));
  mkdirSync(join(dir, ".run402"), { recursive: true });
  writeFileSync(join(dir, ".run402", "project.json"), JSON.stringify({
    schema_version: "run402.workspace-project.v1",
    project_id: "prj_ready",
    name: "ready",
    created_at: "2026-06-30T00:00:00.000Z",
  }));
  const calls: string[] = [];
  const sdk = fakeSdk({
    calls,
    allowanceConfigured: true,
    tierActive: true,
    activeProject: null,
  });

  try {
    const actions = new NodeActions(sdk, { targetKind: "cloud", cwd: dir });
    const result = await actions.up();

    assert.equal(result.result?.project_id, "prj_ready");
    assert.equal(result.result?.deploy?.release_id, "rel_123");
    assert.deepEqual(calls, [
      "allowance.status",
      "tier.status",
      "projects.keys:prj_ready",
      "project:prj_ready",
      "project.apply:prj_ready",
    ]);
    assert.ok(result.steps.some((step) => step.action === "tier.set" && step.state === "skipped"));
    assert.ok(!result.steps.some((step) => step.action === "allowance.faucet" && step.state === "running"));
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("up apply does not synthesize deploy idempotency without an explicit key", async () => {
  const dir = mkdtempSync(join(tmpdir(), "run402-up-no-deploy-idem-"));
  writeFileSync(join(dir, "run402.deploy.json"), JSON.stringify({
    site: { replace: { "index.html": { data: "<h1>ready</h1>" } } },
  }));
  mkdirSync(join(dir, ".run402"), { recursive: true });
  writeFileSync(join(dir, ".run402", "project.json"), JSON.stringify({
    schema_version: "run402.workspace-project.v1",
    project_id: "prj_ready",
    name: "ready",
    created_at: "2026-06-30T00:00:00.000Z",
  }));
  const calls: string[] = [];
  const deployOptions: Array<{ idempotencyKey?: string }> = [];
  const sdk = fakeSdk({
    calls,
    deployOptions,
    allowanceConfigured: true,
    tierActive: true,
    activeProject: null,
  });

  try {
    const actions = new NodeActions(sdk, { targetKind: "cloud", cwd: dir });
    await actions.up();

    assert.equal(deployOptions.length, 1);
    assert.equal(deployOptions[0].idempotencyKey, undefined);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("up apply preserves explicit deploy idempotency keys", async () => {
  const dir = mkdtempSync(join(tmpdir(), "run402-up-explicit-deploy-idem-"));
  writeFileSync(join(dir, "run402.deploy.json"), JSON.stringify({
    idempotency_key: "deploy-explicit",
    site: { replace: { "index.html": { data: "<h1>ready</h1>" } } },
  }));
  mkdirSync(join(dir, ".run402"), { recursive: true });
  writeFileSync(join(dir, ".run402", "project.json"), JSON.stringify({
    schema_version: "run402.workspace-project.v1",
    project_id: "prj_ready",
    name: "ready",
    created_at: "2026-06-30T00:00:00.000Z",
  }));
  const calls: string[] = [];
  const deployOptions: Array<{ idempotencyKey?: string }> = [];
  const sdk = fakeSdk({
    calls,
    deployOptions,
    allowanceConfigured: true,
    tierActive: true,
    activeProject: null,
  });

  try {
    const actions = new NodeActions(sdk, { targetKind: "cloud", cwd: dir });
    await actions.up();

    assert.equal(deployOptions.length, 1);
    assert.equal(deployOptions[0].idempotencyKey, "deploy-explicit");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("up apply preserves deploy activation phase details in action events", async () => {
  const dir = mkdtempSync(join(tmpdir(), "run402-up-deploy-event-details-"));
  writeFileSync(join(dir, "run402.deploy.json"), JSON.stringify({
    site: { replace: { "index.html": { data: "<h1>ready</h1>" } } },
  }));
  mkdirSync(join(dir, ".run402"), { recursive: true });
  writeFileSync(join(dir, ".run402", "project.json"), JSON.stringify({
    schema_version: "run402.workspace-project.v1",
    project_id: "prj_ready",
    name: "ready",
    created_at: "2026-06-30T00:00:00.000Z",
  }));
  const calls: string[] = [];
  const streamed: unknown[] = [];
  const sdk = fakeSdk({
    calls,
    allowanceConfigured: true,
    tierActive: true,
    activeProject: null,
    deployEvents: [
      {
        id: "7",
        operation_id: "op_123",
        project_id: "prj_ready",
        type: "commit.phase.detail",
        phase: "activate.functions",
        status: "done",
        message: null,
        details: { duration_ms: 42 },
        created_at: "2026-07-02T00:00:00.000Z",
        updated_at: "2026-07-02T00:00:00.000Z",
      },
    ],
  });

  try {
    const actions = new NodeActions(sdk, { targetKind: "cloud", cwd: dir });
    await actions.up({}, {
      onEvent: (event) => streamed.push(event),
    });

    const activationEvent = streamed.find((event) => {
      const step = (event as { step?: { details?: Record<string, unknown> } }).step;
      return step?.details?.deploy_phase === "activate.functions";
    }) as { step?: { details?: Record<string, unknown> } } | undefined;
    assert.ok(activationEvent, "expected action event for activate.functions");
    assert.equal(activationEvent.step?.details?.deploy_event, "commit.phase.detail");
    assert.equal(activationEvent.step?.details?.deploy_status, "done");
    assert.equal(activationEvent.step?.details?.deploy_duration_ms, 42);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("up refuses to reuse a nameless workspace link when --name is supplied", async () => {
  const dir = mkdtempSync(join(tmpdir(), "run402-up-name-link-conflict-"));
  writeFileSync(join(dir, "run402.deploy.json"), JSON.stringify({
    site: { replace: { "index.html": { data: "<h1>ready</h1>" } } },
  }));
  mkdirSync(join(dir, ".run402"), { recursive: true });
  writeFileSync(join(dir, ".run402", "project.json"), JSON.stringify({
    schema_version: "run402.workspace-project.v1",
    project_id: "prj_kysigned3",
    target: { kind: "cloud" },
    created_at: "2026-06-30T00:00:00.000Z",
  }));
  const calls: string[] = [];
  const sdk = fakeSdk({
    calls,
    allowanceConfigured: true,
    tierActive: true,
    activeProject: null,
  });

  try {
    const actions = new NodeActions(sdk, { targetKind: "cloud", cwd: dir });
    await assert.rejects(
      () => actions.up({ name: "kysigned4" }, { approval: "yes" }),
      (err) => {
        const e = err as { code?: string; details?: { reason?: string; linked_project_id?: string; name?: string } };
        assert.equal(e.code, "RUN402_WORKSPACE_LINK_CONFLICT");
        assert.equal(e.details?.reason, "name_missing");
        assert.equal(e.details?.linked_project_id, "prj_kysigned3");
        assert.equal(e.details?.name, "kysigned4");
        return true;
      },
    );
    assert.ok(!calls.some((call) => call.startsWith("project.apply:")));
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("up refuses to reuse a workspace link from another target", async () => {
  const dir = mkdtempSync(join(tmpdir(), "run402-up-target-link-conflict-"));
  writeFileSync(join(dir, "run402.deploy.json"), JSON.stringify({
    site: { replace: { "index.html": { data: "<h1>ready</h1>" } } },
  }));
  mkdirSync(join(dir, ".run402"), { recursive: true });
  writeFileSync(join(dir, ".run402", "project.json"), JSON.stringify({
    schema_version: "run402.workspace-project.v1",
    project_id: "prj_core",
    name: "kysigned3",
    target: { kind: "core" },
    created_at: "2026-06-30T00:00:00.000Z",
  }));
  const calls: string[] = [];
  const sdk = fakeSdk({
    calls,
    allowanceConfigured: true,
    tierActive: true,
    activeProject: null,
  });

  try {
    const actions = new NodeActions(sdk, { targetKind: "cloud", cwd: dir });
    await assert.rejects(
      () => actions.up({}, { approval: "yes" }),
      (err) => {
        const e = err as { code?: string; details?: { reason?: string; linked_target?: string; target?: string } };
        assert.equal(e.code, "RUN402_WORKSPACE_LINK_CONFLICT");
        assert.equal(e.details?.reason, "target_mismatch");
        assert.equal(e.details?.linked_target, "core");
        assert.equal(e.details?.target, "cloud");
        return true;
      },
    );
    assert.ok(!calls.some((call) => call.startsWith("project.apply:")));
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("projects provision can run SDK-owned recursive prerequisites when explicitly enabled", async () => {
  const calls: string[] = [];
  const sdk = fakeSdk({
    calls,
    allowanceConfigured: false,
    tierActive: false,
    activeProject: null,
  });

  const actions = new NodeActions(sdk, { targetKind: "cloud" });
  const result = await actions.run({
    type: Run402Action.ProjectsProvision,
    name: "my-app",
  }, {
    autoPrerequisites: true,
    approval: "yes",
    idempotencyKey: "provision-root",
  });

  assert.equal(result.result?.project_id, "prj_new");
  assert.deepEqual(calls, [
    "allowance.status",
    "allowance.create",
    "tier.status",
    "allowance.status",
    "allowance.faucet:action:provision-root:allowance.faucet",
    "tier.set:action:provision-root:tier.set",
    "projects.provision:provision-root",
  ]);
  assert.ok(result.steps.some((step) => step.action === "allowance.faucet" && step.details?.idempotency_key === "action:provision-root:allowance.faucet"));
  assert.ok(result.steps.some((step) => step.action === Run402Action.TierSet && step.details?.idempotency_key === "action:provision-root:tier.set"));
});

test("up refuses to overwrite a workspace link changed during execution", async () => {
  const dir = mkdtempSync(join(process.cwd(), ".tmp-run402-up-link-conflict-"));
  writeFileSync(join(dir, "run402.deploy.json"), JSON.stringify({
    site: { replace: { "index.html": { data: "<h1>ready</h1>" } } },
  }));
  const calls: string[] = [];
  const sdk = fakeSdk({
    calls,
    allowanceConfigured: true,
    tierActive: true,
    activeProject: "prj_active",
  });

  try {
    const actions = new NodeActions(sdk, { targetKind: "cloud", cwd: dir });
    await assert.rejects(
      actions.up({}, {
        approval: {
          mode: "interactive",
          async approve(request) {
            if (request.step.action === "workspace.link.write") {
              mkdirSync(join(dir, ".run402"), { recursive: true });
              writeFileSync(join(dir, ".run402", "project.json"), JSON.stringify({
                schema_version: "run402.workspace-project.v1",
                project_id: "prj_other",
                created_at: "2026-06-30T00:00:00.000Z",
              }));
            }
            return true;
          },
        },
      }),
      /Workspace project link changed/,
    );
    assert.ok(!calls.some((call) => call === "project.apply:prj_active"));
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

function fakeSdk(opts: {
  calls: string[];
  allowanceConfigured: boolean;
  tierActive: boolean;
  activeProject: string | null;
  secrets?: Array<{ key: string; value: string }>;
  appliedSpecs?: unknown[];
  installStates?: Array<Record<string, unknown>>;
  existingProjects?: Array<Record<string, unknown>>;
  deployOptions?: Array<{ idempotencyKey?: string }>;
  deployPlanOptions?: Array<{ idempotencyKey?: string }>;
  deployEvents?: unknown[];
}) {
  const mailboxes: Array<Record<string, unknown>> = [];
  const mailboxSettings: { default_outbound_mailbox_id: string | null; auth_sender_mailbox_id: string | null } = {
    default_outbound_mailbox_id: null,
    auth_sender_mailbox_id: null,
  };
  const webhooks: Array<Record<string, unknown>> = [];
  return {
    apiBase: "https://api.example.test",
    allowance: {
      async status() {
        opts.calls.push("allowance.status");
        return opts.allowanceConfigured
          ? { configured: true, address: "0x0000000000000000000000000000000000000001", faucet_used: false }
          : { configured: false, address: "" };
      },
      async create() {
        opts.calls.push("allowance.create");
        opts.allowanceConfigured = true;
        return { address: "0x0000000000000000000000000000000000000001", created: "2026-06-30T00:00:00.000Z" };
      },
      async faucet(input?: { idempotencyKey?: string }) {
        opts.calls.push(`allowance.faucet:${input?.idempotencyKey ?? ""}`);
        return { transactionHash: "0xabc", amount: "0.25", amountUsdMicros: 250_000, token: "USDC", network: "base-sepolia" };
      },
    },
    tier: {
      async status() {
        opts.calls.push("tier.status");
        return {
          active: opts.tierActive,
          tier: opts.tierActive ? "prototype" : null,
        };
      },
      async set(_tier: string, input?: { idempotencyKey?: string }) {
        opts.calls.push(`tier.set:${input?.idempotencyKey ?? ""}`);
        opts.tierActive = true;
        return { tier: "prototype", action: "subscribe" };
      },
    },
    projects: {
      async active() {
        opts.calls.push("projects.active");
        return opts.activeProject;
      },
      async provision(input?: { idempotencyKey?: string }) {
        opts.calls.push(`projects.provision:${input?.idempotencyKey ?? ""}`);
        return {
          project_id: "prj_new",
          anon_key: "anon",
          service_key: "service",
          schema_slot: "p0001",
        };
      },
      async list() {
        opts.calls.push("projects.list");
        return { projects: opts.existingProjects ?? [] };
      },
      async keys(projectId: string) {
        opts.calls.push(`projects.keys:${projectId}`);
        return { anon_key: "anon", service_key: "service", site_url: `https://${projectId}.run402.test` };
      },
    },
    apps: {
      async upsertInstallState(input: Record<string, unknown>) {
        opts.calls.push(`apps.upsertInstallState:${input.project_id}:${input.app_key}:${input.status}`);
        opts.installStates?.push(input);
        return {
          id: "ain_test",
          ...input,
          created_at: "2026-06-30T00:00:00.000Z",
          updated_at: "2026-06-30T00:00:00.000Z",
        };
      },
    },
    email: {
      async listMailboxes(projectId: string) {
        opts.calls.push(`email.listMailboxes:${projectId}`);
        return { mailboxes, mailbox_settings: mailboxSettings };
      },
      async createMailbox(projectId: string, slug: string) {
        opts.calls.push(`email.createMailbox:${projectId}:${slug}`);
        const mailbox = {
          mailbox_id: `mbx_${slug.replace(/-/g, "_")}`,
          slug,
          address: `${slug}@kysigned3.mail.run402.com`,
          managed_address: `${slug}@kysigned3.mail.run402.com`,
          project_id: projectId,
          status: "active",
          sends_today: 0,
          unique_recipients: 0,
          created_at: "2026-06-30T00:00:00.000Z",
          updated_at: "2026-06-30T00:00:00.000Z",
        };
        mailboxes.push(mailbox);
        return mailbox;
      },
      async setMailboxDefaults(projectId: string, patch: { default_outbound_mailbox_id?: string; auth_sender_mailbox_id?: string }) {
        opts.calls.push(`email.setMailboxDefaults:${projectId}`);
        if (patch.default_outbound_mailbox_id !== undefined) mailboxSettings.default_outbound_mailbox_id = patch.default_outbound_mailbox_id;
        if (patch.auth_sender_mailbox_id !== undefined) mailboxSettings.auth_sender_mailbox_id = patch.auth_sender_mailbox_id;
        return { mailboxes, mailbox_settings: mailboxSettings };
      },
      webhooks: {
        async list(projectId: string, input: { mailbox?: string } = {}) {
          opts.calls.push(`email.webhooks.list:${projectId}:${input.mailbox ?? ""}`);
          return {
            webhooks: webhooks.filter((webhook) => webhook.mailbox_id === input.mailbox),
          };
        },
        async register(projectId: string, input: { mailbox?: string; url: string; events: string[] }) {
          opts.calls.push(`email.webhooks.register:${projectId}:${input.mailbox ?? ""}`);
          const webhook = {
            webhook_id: `whk_${webhooks.length + 1}`,
            mailbox_id: input.mailbox,
            url: input.url,
            events: input.events,
            created_at: "2026-06-30T00:00:00.000Z",
          };
          webhooks.push(webhook);
          return webhook;
        },
      },
    },
    secrets: {
      async set(projectId: string, key: string, input: { value: string }) {
        opts.calls.push(`secrets.set:${projectId}:${key}`);
        opts.secrets?.push({ key, value: input.value });
      },
    },
    async project(projectId: string) {
      opts.calls.push(`project:${projectId}`);
      return {
        apply: Object.assign(
          async (_spec?: unknown, input?: { idempotencyKey?: string; onEvent?: (event: unknown) => void }) => {
            opts.deployOptions?.push(input ?? {});
            opts.appliedSpecs?.push(_spec);
            opts.calls.push(`project.apply:${projectId}`);
            for (const event of opts.deployEvents ?? []) {
              input?.onEvent?.(event);
            }
            return {
              release_id: "rel_123",
              operation_id: "op_123",
              urls: {},
              diff: {},
              warnings: [],
            };
          },
          {
            async plan(_spec?: unknown, input?: { idempotencyKey?: string }) {
              opts.deployPlanOptions?.push(input ?? {});
              opts.calls.push(`project.apply.plan:${projectId}`);
              return {
                plan: {
                  kind: "plan_response",
                  schema_version: "agent-deploy-observability.v1",
                  plan_id: "plan_123",
                  operation_id: null,
                  plan_fingerprint: "pfp_123",
                  plan_expires_at: "2026-06-30T01:00:00.000Z",
                  base_release_id: null,
                  manifest_digest: "0".repeat(64),
                  is_noop: false,
                  summary: "Adds one site path",
                  warnings: [],
                  expected_events: [],
                  missing_content: [],
                  diff: {},
                  migrations: { new: [], noop: [] },
                  site: { added: [], removed: [], changed: [] },
                  functions: { added: [], removed: [], changed: [] },
                  secrets: { added: [], removed: [] },
                  subdomains: { added: [], removed: [] },
                  routes: { added: [], removed: [], changed: [] },
                },
                byteReaders: new Map(),
              };
            },
          },
        ),
      };
    },
  } as never;
}
