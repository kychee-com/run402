import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { realpathSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";
import { Run402Action } from "../actions.js";
import { RUN402_APP_SCHEMA_ID } from "../app-up.js";
import { X402BalanceError } from "./paid-fetch.js";
import { CLIENT_DETECTION_ENV_VARS, KNOWN_CLIENT_MARKERS, detectClientName } from "./client-detect.js";

let testBalance: bigint | Error = 0n;
mock.module("./prototype-balance.js", { namedExports: {
  prototypeBalance: async () => { if (testBalance instanceof Error) throw testBalance; return testBalance; },
} });
const { NodeActions, claimSubdomainNextAction, subdomainSlugFromProjectName } = await import("./actions-node.js");

test("sponsored wallet bootstrap skips faucet without a faucet marker", async () => {
  const calls: string[] = [];
  const sdk = fakeSdk({ calls, allowanceConfigured: true, tierActive: false, activeProject: null });
  testBalance = 250_000n;
  try {
    const result = await new NodeActions(sdk, { targetKind: "cloud" }).run({ type: Run402Action.ProjectsProvision, name: "sponsored" }, { autoPrerequisites: true, approval: "yes" });
    assert.equal(result.result?.project_id, "prj_new");
    assert.ok(!calls.some(c => c.startsWith("allowance.faucet:")));
    assert.ok(calls.some(c => c.startsWith("tier.set:")));
  } finally { testBalance = 0n; }
});

test("unavailable balance does not trigger a faucet transfer", async () => {
  const calls: string[] = [];
  const sdk = fakeSdk({ calls, allowanceConfigured: true, tierActive: false, activeProject: null });
  testBalance = new Error("RPC unavailable");
  try {
    await assert.rejects(new NodeActions(sdk, { targetKind: "cloud" }).run({ type: Run402Action.ProjectsProvision, name: "sponsored" }, { autoPrerequisites: true, approval: "yes" }), /RPC unavailable/);
    assert.ok(!calls.some(c => c.startsWith("allowance.faucet:")));
  } finally { testBalance = 0n; }
});

test("spent wallet's old faucet marker does not suppress funding", async () => {
  const calls: string[] = [];
  const sdk = fakeSdk({ calls, allowanceConfigured: true, tierActive: false, activeProject: null });
  sdk.allowance.status = async () => ({ configured: true, address: "0x0000000000000000000000000000000000000001", faucet_used: true });
  await new NodeActions(sdk, { targetKind: "cloud" }).run({ type: Run402Action.ProjectsProvision, name: "spent" }, { autoPrerequisites: true, approval: "yes" });
  assert.ok(calls.some(c => c.startsWith("allowance.faucet:")));
});

test("fresh provisioning survives faucet RPC lag without another drip or payment key", async () => {
  const calls: string[] = [];
  const sdk = fakeSdk({ calls, allowanceConfigured: false, tierActive: false, activeProject: null });
  const keys: Array<string | undefined> = [];
  const setTier = sdk.tier.set;
  sdk.tier.set = async (tier, input) => {
    keys.push(input?.idempotencyKey);
    if (keys.length === 1) throw new X402BalanceError("X402_INSUFFICIENT_FUNDS", "RPC lag", {});
    return setTier(tier, input);
  };
  const result = await new NodeActions(sdk, { targetKind: "cloud" }).run(
    { type: Run402Action.ProjectsProvision, name: "fresh" },
    { autoPrerequisites: true, approval: "yes", idempotencyKey: "fresh-test" },
  );
  assert.equal(result.result?.project_id, "prj_new");
  assert.equal(calls.filter(c => c.startsWith("allowance.faucet:")).length, 1);
  assert.equal(keys.length, 2);
  assert.ok(keys[0]);
  assert.equal(keys[0], keys[1]);
});

test("existing funds do not enable automatic insufficient-funds retries", async () => {
  const sdk = fakeSdk({ calls: [], allowanceConfigured: true, tierActive: false, activeProject: null });
  let calls = 0;
  sdk.tier.set = async () => { calls++; throw new X402BalanceError("X402_INSUFFICIENT_FUNDS", "spent", {}); };
  testBalance = 250_000n;
  try {
    await assert.rejects(new NodeActions(sdk, { targetKind: "cloud" }).run(
      { type: Run402Action.ProjectsProvision, name: "existing" }, { autoPrerequisites: true, approval: "yes" },
    ), /spent/);
    assert.equal(calls, 1);
  } finally { testBalance = 0n; }
});

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
    assert.equal(result.result?.project_id, null);
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
    await assert.rejects(actions.up({}, { approval: "yes" }), (err: any) => {
      assert.equal(err.code, "UP_PROJECT_REQUIRED");
      assert.equal(err.nextActions.length, 1);
      assert.equal(err.nextActions[0].type, "select_project");
      return true;
    });
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

test("up app apply reports propagation_pending for a fresh edge sentinel miss", async (t) => {
  const dir = mkdtempSync(join(process.cwd(), ".tmp-run402-app-up-propagation-pending-"));
  writeFileSync(join(dir, "run402.json"), JSON.stringify(appManifest({
    build: { mode: "local", commands: [] },
    release: {
      subdomains: { set: ["${input.name}"] },
      site: {
        replace: { "index.html": { data: "<h1>ready</h1>" } },
        public_paths: { mode: "implicit" },
      },
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
    deploySubdomainBindings: [{
      host: "kysigned6.run402.com",
      claimed_at: new Date().toISOString(),
      kvs_synced_at: null,
    }],
  });
  const fetchMock = mock.method(globalThis, "fetch", async () =>
    new Response(JSON.stringify({ code: "SUBDOMAIN_NOT_CONFIGURED" }), {
      status: 404,
      headers: {
        "content-type": "application/json",
        "x-run402-edge": "kvs-miss",
      },
    })
  );
  t.after(() => fetchMock.mock.restore());

  try {
    const actions = new NodeActions(sdk, { targetKind: "cloud", cwd: dir });
    const result = await actions.up(
      { name: "kysigned6", propagationWait: false },
      { approval: "yes" },
    );

    assert.equal(result.result?.app_result?.status, "propagation_pending");
    assert.equal(result.result?.app_result?.verify?.status, "propagation_pending");
    assert.equal(result.result?.app_result?.verify?.next_action?.command, "run402 up verify");
    assert.equal(result.result?.app_result?.verification.http[0]?.status, "propagation_pending");
    assert.equal(result.result?.app_result?.verification.http[0]?.actual_status, 404);
    assert.equal(result.result?.app_result?.diagnostics[0]?.code, "VERIFY_PROPAGATION_PENDING");
    assert.equal(calls.includes("project.apply:prj_new"), true);
  } finally {
    if (previous === undefined) delete process.env.KYSIGNED_ALLOWED_CREATORS;
    else process.env.KYSIGNED_ALLOWED_CREATORS = previous;
    rmSync(dir, { force: true, recursive: true });
  }
});

test("up verify reruns app HTTP checks without deploying", async (t) => {
  const dir = mkdtempSync(join(process.cwd(), ".tmp-run402-app-up-verify-only-"));
  mkdirSync(join(dir, ".run402"), { recursive: true });
  writeFileSync(join(dir, ".run402", "project.json"), JSON.stringify({
    schema_version: "run402.workspace-project.v1",
    project_id: "prj_ready",
    name: "ready",
    created_at: "2026-06-30T00:00:00.000Z",
  }));
  writeFileSync(join(dir, "run402.json"), JSON.stringify(appManifest()));
  const calls: string[] = [];
  const sdk = fakeSdk({
    calls,
    allowanceConfigured: true,
    tierActive: true,
    activeProject: null,
  });
  const fetchMock = mock.method(globalThis, "fetch", async () =>
    new Response("ok", { status: 200, headers: { "x-run402-release-id": "rel_observed", "x-run402-release-generation": "4" } })
  );
  t.after(() => fetchMock.mock.restore());

  try {
    const actions = new NodeActions(sdk, { targetKind: "cloud", cwd: dir });
    const result = await actions.up({ verifyOnly: true });
    assert.equal(result.mode, "verify");
    assert.equal(result.read_only, true);
    assert.equal(result.dry_run, false);
    assert.ok(result.steps.every(step => !step.mutation));

    assert.equal(result.result?.project_id, "prj_ready");
    assert.equal(result.result?.app_result?.status, "succeeded");
    assert.equal(result.result?.app_result?.verify?.status, "verified");
    assert.equal(result.result?.app_result?.verification.http[0]?.actual_status, 200);
    const observed = result.result?.app_result?.verification.http[0]?.observed_release;
    assert.equal(observed?.release_id, "rel_observed");
    assert.equal(observed?.generation, 4);
    assert.equal(observed?.source, "response_headers");
    assert.equal(observed?.unavailable_reason, null);
    assert.ok(observed?.url.startsWith("https://"));
    assert.ok(Number.isFinite(Date.parse(observed!.observed_at)));
    assert.ok(!calls.some((call) => call.startsWith("project.apply:")));
    assert.ok(calls.includes("projects.keys:prj_ready"));
    assert.ok(calls.includes("project:prj_ready"));
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("up app hashes content-tracked migrations from post-build sql_path output", async () => {
  const dir = mkdtempSync(join(process.cwd(), ".tmp-run402-app-up-content-migration-"));
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(join(dir, "scripts", "build.mjs"), `
import { mkdirSync, writeFileSync } from "node:fs";
mkdirSync("dist", { recursive: true });
writeFileSync("dist/seed.sql", "insert into seed values ('post-build');\\n");
`);
  writeFileSync(join(dir, "run402.json"), JSON.stringify(appManifest({
    build: {
      mode: "local",
      commands: [
        { id: "build", argv: [process.execPath, "scripts/build.mjs"] },
      ],
    },
    release: {
      database: {
        migrations: [{ name: "seed", sql_path: "dist/seed.sql" }],
      },
    },
    resources: {},
    secrets: {},
    verify: undefined,
  })));
  const calls: string[] = [];
  const appliedSpecs: unknown[] = [];
  const sdk = fakeSdk({
    calls,
    appliedSpecs,
    allowanceConfigured: true,
    tierActive: true,
    activeProject: null,
  });

  try {
    const actions = new NodeActions(sdk, { targetKind: "cloud", cwd: dir });
    await actions.up({ name: "seeded" }, { approval: "yes" });

    const migration = (appliedSpecs[0] as {
      database?: { migrations?: Array<{ name?: string; sql?: string }> };
    }).database?.migrations?.[0];
    assert.deepEqual(migration, {
      name: "seed",
      sql: "insert into seed values ('post-build');\n",
    });
    assert.ok(calls.includes("project.apply:prj_new"));
  } finally {
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

// A repo source is cloned into an OS temp dir. `cleanupDir` was returned for
// exactly that purpose and nothing read it, so every `run402 up <git-url>` left
// its full checkout behind — on success AND on failure. An agent looping
// deploys grows /tmp without bound and, on a fixed-allowance container, starts
// failing writes with no hint at the cause. These pin the cleanup on both paths.
function tempCheckouts(): string[] {
  return readdirSync(tmpdir()).filter((n) => n.startsWith("run402-app-source-"));
}

test("up removes the cloned checkout after a successful repo-source run", async () => {
  const repo = mkdtempSync(join(tmpdir(), "run402-app-up-source-repo-"));
  writeFileSync(join(repo, "run402.json"), JSON.stringify(appManifest()));
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "agent@example.com"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Run402 Agent"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["add", "run402.json"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repo, stdio: "ignore" });
  const before = tempCheckouts();
  try {
    const actions = new NodeActions(fakeSdk({ calls: [], allowanceConfigured: false, tierActive: false, activeProject: null }), { targetKind: "cloud" });
    await actions.up({ source: pathToFileURL(repo).href, name: "cleanup-ok" }, { mode: "check" });
    assert.deepEqual(tempCheckouts().filter((d) => !before.includes(d)), [], "checkout must not survive a successful run");
  } finally {
    rmSync(repo, { force: true, recursive: true });
  }
});

test("up removes the cloned checkout even when the run fails after cloning", async () => {
  // No manifest committed → the run fails at discovery, AFTER the clone
  // succeeded. This is the path that leaked in the wild.
  const repo = mkdtempSync(join(tmpdir(), "run402-app-up-source-repo-"));
  writeFileSync(join(repo, "README.md"), "no manifest here\n");
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "agent@example.com"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Run402 Agent"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["add", "README.md"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repo, stdio: "ignore" });
  const before = tempCheckouts();
  try {
    const actions = new NodeActions(fakeSdk({ calls: [], allowanceConfigured: false, tierActive: false, activeProject: null }), { targetKind: "cloud" });
    await assert.rejects(
      () => actions.up({ source: pathToFileURL(repo).href, name: "cleanup-fail" }, { mode: "check" }),
      (err: any) => err?.code === "UP_MANIFEST_REQUIRED",
    );
    assert.deepEqual(tempCheckouts().filter((d) => !before.includes(d)), [], "checkout must not survive a failed run");
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
    assert.equal(result.result?.project_id, null);
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

test("up check fails MANIFEST_FILE_MISSING when a function source path does not exist", async () => {
  const dir = mkdtempSync(join(tmpdir(), "run402-up-check-missing-fn-"));
  writeFileSync(join(dir, "run402.deploy.json"), JSON.stringify({
    site: { replace: { "index.html": { data: "<h1>hello</h1>" } } },
    functions: { replace: { api: { runtime: "node22", source: { path: "fn/api.mjs" } } } },
  }));
  const calls: string[] = [];
  const sdk = fakeSdk({ calls, allowanceConfigured: false, tierActive: false, activeProject: null });
  try {
    const actions = new NodeActions(sdk, { targetKind: "cloud", cwd: dir });
    await assert.rejects(
      () => actions.up({}, { mode: "check" }),
      (err: any) => {
        assert.equal(err.code, "MANIFEST_FILE_MISSING");
        assert.ok(String(err.message).includes(join(dir, "fn", "api.mjs")));
        assert.equal(err.details.manifest_path, join(dir, "run402.deploy.json"));
        assert.deepEqual(err.details.missing, [
          { field_path: "functions.replace.api.source", path: join(dir, "fn", "api.mjs"), kind: "function_source" },
        ]);
        assert.equal(err.nextActions[0].type, "create_file");
        assert.equal(err.nextActions[0].path, join(dir, "fn", "api.mjs"));
        assert.equal(err.details.next_actions[0].path, join(dir, "fn", "api.mjs"));
        return true;
      },
    );
    assert.deepEqual(calls, []);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("up check on a build-free run402.json validates the release slice's file references before any build", async () => {
  const dir = mkdtempSync(join(tmpdir(), "run402-up-check-app-missing-site-"));
  writeFileSync(join(dir, "run402.json"), JSON.stringify(appManifest({
    build: undefined,
    resources: {},
    secrets: {},
    release: {
      site: { replace: { "index.html": { path: "public/index.html" } } },
      database: { migrations: [{ id: "001_init", sql_path: "db/schema.sql" }] },
    },
  })));
  const calls: string[] = [];
  const sdk = fakeSdk({ calls, allowanceConfigured: false, tierActive: false, activeProject: null });
  try {
    const actions = new NodeActions(sdk, { targetKind: "cloud", cwd: dir });
    // The migration file is read first during normalization, so it is the one named.
    await assert.rejects(
      () => actions.up({ name: "app" }, { mode: "check" }),
      (err: any) => {
        assert.equal(err.code, "MANIFEST_FILE_MISSING");
        assert.equal(err.details.missing[0].kind, "migration_sql");
        assert.equal(err.details.missing[0].path, join(dir, "db", "schema.sql"));
        assert.equal(err.nextActions[0].type, "create_file");
        return true;
      },
    );
    mkdirSync(join(dir, "db"), { recursive: true });
    writeFileSync(join(dir, "db", "schema.sql"), "create table t (id int);\n");
    await assert.rejects(
      () => actions.up({ name: "app" }, { mode: "check" }),
      (err: any) => {
        assert.equal(err.code, "MANIFEST_FILE_MISSING");
        assert.deepEqual(err.details.missing, [
          { field_path: 'site.replace["index.html"]', path: join(dir, "public", "index.html"), kind: "site_file" },
        ]);
        return true;
      },
    );
    mkdirSync(join(dir, "public"), { recursive: true });
    writeFileSync(join(dir, "public", "index.html"), "<h1>ok</h1>\n");
    const result = await actions.up({ name: "app" }, { mode: "check" });
    assert.equal(result.result?.app_result?.status, "planned");
    assert.deepEqual(calls, []);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("up from a parent directory names manifests one directory down in UP_MANIFEST_REQUIRED", async () => {
  const dir = mkdtempSync(join(tmpdir(), "run402-up-nearby-"));
  mkdirSync(join(dir, "cairn"), { recursive: true });
  mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
  mkdirSync(join(dir, ".hidden"), { recursive: true });
  mkdirSync(join(dir, "docs"), { recursive: true });
  writeFileSync(join(dir, "cairn", "run402.json"), JSON.stringify({ site: { replace: { "index.html": { data: "x" } } } }));
  writeFileSync(join(dir, "node_modules", "pkg", "app.json"), "{}");
  writeFileSync(join(dir, ".hidden", "app.json"), "{}");
  const sdk = fakeSdk({ calls: [], allowanceConfigured: false, tierActive: false, activeProject: null });
  try {
    const actions = new NodeActions(sdk, { targetKind: "cloud", cwd: dir });
    await assert.rejects(
      () => actions.up({}, { mode: "check" }),
      (err: any) => {
        assert.equal(err.code, "UP_MANIFEST_REQUIRED");
        assert.match(err.message, /one directory down \(cairn\)/);
        assert.match(err.message, /run402\.json/);
        assert.deepEqual(err.details.nearby_manifests, [
          { path: join(dir, "cairn", "run402.json"), relative_dir: "cairn" },
        ]);
        const first = err.details.next_actions[0];
        assert.equal(first.type, "run_in_directory");
        assert.equal(first.command, "run402 up --check --dir cairn");
        assert.deepEqual(first.argv, ["run402", "up", "--check", "--dir", "cairn"]);
        assert.equal(first.path, join(dir, "cairn", "run402.json"));
        assert.equal(err.details.next_actions[1].type, "create_manifest");
        assert.equal(err.nextActions[0].type, "run_in_directory");
        return true;
      },
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("up with an explicit --manifest that does not exist fails MANIFEST_NOT_FOUND", async () => {
  const dir = mkdtempSync(join(tmpdir(), "run402-up-manifest-enoent-"));
  const sdk = fakeSdk({ calls: [], allowanceConfigured: false, tierActive: false, activeProject: null });
  try {
    const actions = new NodeActions(sdk, { targetKind: "cloud", cwd: dir });
    for (const name of ["run402.json", "missing.deploy.json"]) {
      await assert.rejects(
        () => actions.up({ manifest: name }, { mode: "check" }),
        (err: any) => {
          assert.equal(err.code, "MANIFEST_NOT_FOUND");
          assert.equal(err.details.path, join(dir, name));
          assert.equal(err.nextActions[0].type, "create_manifest");
          assert.equal(err.nextActions[0].path, join(dir, name));
          return true;
        },
      );
    }
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

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

test("up check accepts a release-shaped run402.json without treating it as an app manifest", async () => {
  const dir = mkdtempSync(join(tmpdir(), "run402-up-release-shaped-json-"));
  mkdirSync(join(dir, "site"), { recursive: true });
  writeFileSync(join(dir, "schema.sql"), "create table votes (id bigint primary key);\n");
  writeFileSync(join(dir, "site", "index.html"), "<h1>Voting booth</h1>\n");
  writeFileSync(join(dir, "probe.mjs"), "export default async () => new Response('ok');\n");
  writeFileSync(join(dir, "run402.json"), JSON.stringify({
    database: { migrations: [{ id: "001_init", sql_path: "schema.sql" }] },
    site: { replace: { "index.html": { path: "site/index.html" } } },
    functions: {
      replace: {
        probe: { runtime: "node22", source: { path: "probe.mjs" } },
      },
    },
    subdomains: { set: ["fizz-voting-booth"] },
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
    assert.equal(result.result?.manifest_path, join(dir, "run402.json"));
    assert.deepEqual(calls, []);
    assert.ok(result.steps.some((step) =>
      step.action === "deploy.discover" && step.details?.manifest_kind === "release"
    ));
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("up check reports a malformed app-shaped run402.json with path and repair", async () => {
  const dir = mkdtempSync(join(tmpdir(), "run402-up-invalid-app-json-"));
  const manifestPath = join(dir, "run402.json");
  const { release: _release, ...invalidApp } = appManifest();
  writeFileSync(manifestPath, JSON.stringify(invalidApp));
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
      (err: unknown) => {
        const e = err as {
          code?: string;
          details?: { manifest_path?: string; field_path?: string };
          nextActions?: Array<{ argv?: string[] }>;
        };
        assert.equal(e.code, "APP_SPEC_INVALID");
        assert.equal(e.details?.manifest_path, manifestPath);
        assert.equal(e.details?.field_path, "release");
        assert.deepEqual(e.nextActions?.[0]?.argv, ["run402", "up", "--manifest", manifestPath, "--check"]);
        return true;
      },
    );
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

test("up runs deploy-manifest verify.http checks after apply and surfaces verification.http[]", async (t) => {
  const dir = mkdtempSync(join(process.cwd(), ".tmp-run402-up-deploy-verify-"));
  writeFileSync(join(dir, "run402.deploy.json"), JSON.stringify({
    project_id: "prj_ready",
    site: { replace: { "index.html": { data: "<h1>ready</h1>" } } },
    verify: { http: [{ id: "home", path: "/", expect: { status: 200 } }] },
  }));
  const calls: string[] = [];
  const sdk = fakeSdk({
    calls,
    allowanceConfigured: true,
    tierActive: true,
    activeProject: null,
  });
  const fetched: string[] = [];
  const fetchMock = mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    fetched.push(String(input));
    return new Response("ok", { status: 200 });
  });
  t.after(() => fetchMock.mock.restore());

  try {
    const actions = new NodeActions(sdk, { targetKind: "cloud", cwd: dir });
    const result = await actions.up({});

    // Apply ran first, then verification against the project public origin.
    assert.ok(calls.includes("project.apply:prj_ready"));
    assert.deepEqual(fetched, ["https://prj_ready.run402.test/"]);
    assert.equal(result.result?.verify?.status, "verified");
    assert.deepEqual(result.result?.verification?.http.map(({ observed_release, ...entry }) => entry), [{
      id: "home",
      status: "succeeded",
      path: "/",
      expected_status: 200,
      actual_status: 200,
      propagation_wait_ms: 0,
    }]);
    const verifyStep = result.steps.find((step) => step.action === "app.verify");
    assert.ok(verifyStep, "verification step recorded");
    assert.equal(verifyStep?.state, "succeeded");
    // Ordering: the verify step comes after the deploy.apply step.
    const applyIndex = result.steps.findIndex((step) => step.action === "deploy.apply");
    const verifyIndex = result.steps.findIndex((step) => step.action === "app.verify");
    assert.ok(verifyIndex > applyIndex, "verify runs after apply");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("up verify.http prefers the deploy result's own site url over a missing keystore site_url", async (t) => {
  // A project provisioned in another workspace
  // has keys WITHOUT a cached site_url; verification resolved the origin
  // from the keystore only, fetched against null, and every check failed
  // with an unexplained actual_status: null. The deploy result's urls are
  // authoritative for the release that was just applied.
  const dir = mkdtempSync(join(process.cwd(), ".tmp-run402-up-deploy-verify-origin-"));
  writeFileSync(join(dir, "run402.deploy.json"), JSON.stringify({
    project_id: "prj_ready",
    site: { replace: { "index.html": { data: "<h1>ready</h1>" } } },
    verify: { http: [{ id: "home", path: "/", expect: { status: 200 } }] },
  }));
  const calls: string[] = [];
  const sdk = fakeSdk({
    calls,
    allowanceConfigured: true,
    tierActive: true,
    activeProject: null,
    keysSiteUrl: null,
    deployUrls: { site: "https://fresh-claim.run402.test", deployment: "https://dpl-x.sites.run402.test" },
  });
  const fetched: string[] = [];
  const fetchMock = mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    fetched.push(String(input));
    return new Response("ok", { status: 200 });
  });
  t.after(() => fetchMock.mock.restore());

  try {
    const actions = new NodeActions(sdk, { targetKind: "cloud", cwd: dir });
    const result = await actions.up({});

    assert.deepEqual(fetched, ["https://fresh-claim.run402.test/"]);
    assert.equal(result.result?.verify?.status, "verified");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("up verify.http with no resolvable origin fails loudly with a missing_public_origin diagnostic", async (t) => {
  // The failure must explain itself — an entry with actual_status: null and
  // no diagnostic reads as a mystery network error.
  const dir = mkdtempSync(join(process.cwd(), ".tmp-run402-up-deploy-verify-noorigin-"));
  writeFileSync(join(dir, "run402.deploy.json"), JSON.stringify({
    project_id: "prj_ready",
    site: { replace: { "index.html": { data: "<h1>ready</h1>" } } },
    verify: { http: [{ id: "home", path: "/", expect: { status: 200 } }] },
  }));
  const calls: string[] = [];
  const sdk = fakeSdk({
    calls,
    allowanceConfigured: true,
    tierActive: true,
    activeProject: null,
    keysSiteUrl: null,
    deployUrls: {},
  });
  const fetched: string[] = [];
  const fetchMock = mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    fetched.push(String(input));
    return new Response("ok", { status: 200 });
  });
  t.after(() => fetchMock.mock.restore());

  try {
    const actions = new NodeActions(sdk, { targetKind: "cloud", cwd: dir });
    const result = await actions.up({});

    assert.deepEqual(fetched, [], "no fetch without an origin");
    assert.equal(result.result?.verify?.status, "failed");
    const entry = result.result?.verification?.http?.[0] as Record<string, unknown> | undefined;
    assert.ok(entry, "check entry present");
    const diagnostic = entry?.diagnostic as Record<string, unknown> | undefined;
    assert.equal(diagnostic?.error, "missing_public_origin");
    assert.match(String(diagnostic?.hint ?? ""), /absolute `url`|subdomain/);
    // The agent must be told what to DO: claim a subdomain (which binds the
    // live release without any flag) or declare `subdomains.set` in the
    // manifest. With no project name known the command carries `<name>`.
    const nextAction = result.result?.verify?.next_action as Record<string, unknown> | null | undefined;
    assert.ok(nextAction, "verify.next_action present");
    assert.equal(nextAction?.type, "claim_subdomain");
    assert.equal(nextAction?.node_id, "verify.http.home");
    assert.equal(nextAction?.command, "run402 subdomains claim <name>");
    assert.deepEqual(nextAction?.argv, ["run402", "subdomains", "claim", "<name>"]);
    assert.match(String(nextAction?.message ?? ""), /"subdomains": \{ "set": \["<name>"\] \}/);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("claim_subdomain next action slugs the project name into a claimable label", () => {
  const action = claimSubdomainNextAction("My Cool App!", "home");
  assert.equal(action.type, "claim_subdomain");
  assert.equal(action.command, "run402 subdomains claim my-cool-app");
  assert.deepEqual(action.argv, ["run402", "subdomains", "claim", "my-cool-app"]);
  assert.match(String(action.message), /"subdomains": \{ "set": \["my-cool-app"\] \}/);
  assert.equal(subdomainSlugFromProjectName("ab"), null, "too short to claim");
  assert.equal(subdomainSlugFromProjectName(null), null);
  assert.equal(claimSubdomainNextAction(null, "x").command, "run402 subdomains claim <name>");
});

test("up verify reruns deploy-manifest verify.http checks without deploying", async (t) => {
  const dir = mkdtempSync(join(process.cwd(), ".tmp-run402-up-deploy-verify-only-"));
  writeFileSync(join(dir, "run402.deploy.json"), JSON.stringify({
    project_id: "prj_ready",
    site: { replace: { "index.html": { data: "<h1>ready</h1>" } } },
    verify: { http: [{ id: "home", path: "/", expect: { status: 200 } }] },
  }));
  const calls: string[] = [];
  const sdk = fakeSdk({
    calls,
    allowanceConfigured: true,
    tierActive: true,
    activeProject: null,
  });
  const fetchMock = mock.method(globalThis, "fetch", async () => new Response("ok", { status: 200 }));
  t.after(() => fetchMock.mock.restore());

  try {
    const actions = new NodeActions(sdk, { targetKind: "cloud", cwd: dir });
    const result = await actions.up({ verifyOnly: true });
    assert.equal(result.mode, "verify");
    assert.equal(result.read_only, true);
    assert.equal(result.dry_run, false);
    assert.ok(result.steps.every(step => !step.mutation));

    assert.equal(result.result?.project_id, "prj_ready");
    assert.equal(result.result?.verify?.status, "verified");
    assert.equal(result.result?.verification?.http[0]?.status, "succeeded");
    assert.equal(result.result?.verification?.http[0]?.actual_status, 200);
    const observed = result.result?.verification?.http[0]?.observed_release;
    assert.equal(observed?.release_id, null);
    assert.equal(observed?.generation, null);
    assert.equal(observed?.unavailable_reason, "headers_missing_or_invalid");
    assert.ok(!calls.some((call) => call.startsWith("project.apply:")), "verify-only must not deploy");
    assert.ok(calls.includes("projects.keys:prj_ready"));
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("up verify fails VERIFY_CHECKS_REQUIRED for a deploy manifest without a verify block", async () => {
  const dir = mkdtempSync(join(process.cwd(), ".tmp-run402-up-deploy-verify-missing-"));
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
    await assert.rejects(
      actions.up({ verifyOnly: true }),
      (err: unknown) => (err as { code?: string }).code === "VERIFY_CHECKS_REQUIRED",
    );
    assert.ok(!calls.some((call) => call.startsWith("project.apply:")));
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
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
      actions.up({ projectId: "prj_active" }, {
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
  deploySubdomainBindings?: Array<{ host: string; claimed_at: string; kvs_synced_at: string | null }>;
  /** null = keystore has keys but NO cached site_url (provisioned elsewhere). */
  keysSiteUrl?: string | null;
  deployUrls?: Record<string, string>;
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
        return { tier: "prototype", action: "start" };
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
        return {
          anon_key: "anon",
          service_key: "service",
          ...(opts.keysSiteUrl === null
            ? {}
            : { site_url: opts.keysSiteUrl ?? `https://${projectId}.run402.test` }),
        };
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
              urls: opts.deployUrls ?? {},
              diff: {},
              warnings: [],
              ...(opts.deploySubdomainBindings ? { subdomain_bindings: opts.deploySubdomainBindings } : {}),
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
            async resolve(_input?: unknown) {
              opts.calls.push(`project.apply.resolve:${projectId}`);
              return {
                hostname: "example.com",
                result: 200,
                match: "static_exact",
                authorized: true,
                fallback_state: "not_used",
              };
            },
          },
        ),
      };
    },
  } as never;
}

// principal-display-name (first-deploy-agent-dx): the gateway never seeds a
// display_name from a wallet subject, so `up` names a principal exactly when
// whoami reports null and keeps a chosen name untouched.
function identityAwareSdk(calls: string[], whoami: { display_name: string | null; subject: string | null; type?: string }) {
  const sdk = fakeSdk({ calls, allowanceConfigured: true, tierActive: true, activeProject: null }) as unknown as Record<string, unknown>;
  const set: string[] = [];
  sdk.orgs = {
    async whoami() {
      calls.push("orgs.whoami");
      return {
        principal: { id: "prn_1", type: whoami.type ?? "agent", display_name: whoami.display_name },
        active_authenticator: whoami.subject ? { kind: "siwx_eoa", public_subject: whoami.subject } : null,
        memberships: [],
      };
    },
    async setDisplayName(name: string) {
      calls.push(`orgs.setDisplayName:${name}`);
      set.push(name);
      return { principal: { id: "prn_1", type: "agent", display_name: name }, memberships: [] };
    },
  };
  sdk.rooms = {
    async forProject() { return { orgId: "org_1", roomKey: "prj_ready" }; },
    async registerPresence(_o: string, _r: string, opts: { requestedName?: string }) {
      calls.push(`rooms.registerPresence:${opts.requestedName ?? ""}`);
      return { presence_id: "prs_1", name: opts.requestedName ?? "anon" };
    },
  };
  return { sdk: sdk as never, set };
}

function identityWorkspace(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
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
  return dir;
}

const WALLET = "0x2804a3f59FDd33618B2cb711060550E4eCd6DDc0";
const CLIENT_MARKERS = [...CLIENT_DETECTION_ENV_VARS, "RUN402_AGENT_NAME"];
async function withClientEnv<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const k of CLIENT_MARKERS) { saved[k] = process.env[k]; delete process.env[k]; }
  Object.assign(process.env, env);
  try { return await fn(); } finally {
    for (const k of CLIENT_MARKERS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}



test("up keeps a chosen display_name and reports it as existing", async () => {
  const dir = identityWorkspace("run402-up-identity-chosen-");
  const calls: string[] = [];
  const { sdk, set } = identityAwareSdk(calls, { display_name: "Grok", subject: WALLET });
  try {
    const result = await withClientEnv({}, async () => {
      const actions = new NodeActions(sdk, { targetKind: "cloud", cwd: dir });
      return actions.up({}, { approval: "yes" });
    });
    assert.equal(result.result?.identity?.source, "existing");
    assert.equal(result.result?.identity?.display_name, "Grok");
    assert.equal(result.result?.identity?.detected, null);
    assert.deepEqual(result.result?.identity?.detection, { applied: false, reason: "nothing_detected" });
    assert.equal(set.length, 0, "an explicit name is never touched");
    assert.ok(calls.includes("rooms.registerPresence:Grok"));
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("the client-detection marker table covers every known client, grok included", () => {
  assert.deepEqual(KNOWN_CLIENT_MARKERS.map((entry) => entry.client), ["claude-code", "codex", "cursor", "grok"]);
  for (const entry of KNOWN_CLIENT_MARKERS) {
    for (const marker of entry.markers) {
      assert.equal(detectClientName({ [marker]: "1" }), entry.client, marker);
    }
  }
  assert.equal(detectClientName({}), null);
  assert.equal(detectClientName({ RUN402_CLIENT: "  " }), null, "a blank RUN402_CLIENT is absent");
  assert.equal(detectClientName({ RUN402_CLIENT: " grok ", CLAUDECODE: "1" }), "grok", "RUN402_CLIENT is checked before every marker");
});

test("up names an unnamed principal grok from a grok marker", async () => {
  const dir = identityWorkspace("run402-up-identity-grok-");
  const calls: string[] = [];
  const { sdk, set } = identityAwareSdk(calls, { display_name: null, subject: WALLET });
  try {
    const result = await withClientEnv({ GROK_CLI: "1" }, async () => {
      const actions = new NodeActions(sdk, { targetKind: "cloud", cwd: dir });
      return actions.up({}, { approval: "yes" });
    });
    assert.equal(result.result?.identity?.source, "detected");
    assert.equal(result.result?.identity?.detected, "grok");
    assert.deepEqual(result.result?.identity?.detection, { applied: true, reason: "applied" });
    assert.deepEqual(set, ["grok"]);
    assert.equal(result.result?.identity?.display_name, "grok");
    assert.ok(calls.includes("rooms.registerPresence:grok"));
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("up names an unnamed principal from RUN402_CLIENT when the client has no marker of its own", async () => {
  const dir = identityWorkspace("run402-up-identity-client-env-");
  const calls: string[] = [];
  const { sdk, set } = identityAwareSdk(calls, { display_name: null, subject: WALLET });
  try {
    const result = await withClientEnv({ RUN402_CLIENT: "grok" }, async () => {
      const actions = new NodeActions(sdk, { targetKind: "cloud", cwd: dir });
      return actions.up({}, { approval: "yes" });
    });
    assert.equal(result.result?.identity?.source, "detected");
    assert.equal(result.result?.identity?.detected, "grok");
    assert.deepEqual(set, ["grok"]);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("up reports a detected client it did not apply because the principal is already named", async () => {
  const dir = identityWorkspace("run402-up-identity-detected-not-applied-");
  const calls: string[] = [];
  const { sdk, set } = identityAwareSdk(calls, { display_name: "agent", subject: WALLET });
  try {
    const result = await withClientEnv({ GROK_AGENT: "1" }, async () => {
      const actions = new NodeActions(sdk, { targetKind: "cloud", cwd: dir });
      return actions.up({}, { approval: "yes" });
    });
    assert.equal(result.result?.identity?.source, "existing");
    assert.equal(result.result?.identity?.display_name, "agent");
    assert.equal(result.result?.identity?.detected, "grok");
    assert.deepEqual(result.result?.identity?.detection, { applied: false, reason: "name_already_set" });
    assert.equal(set.length, 0, "an existing name is never overwritten by a detected client");
    assert.ok(calls.includes("rooms.registerPresence:agent"), "presence is registered under the existing name");
    const skipped = result.steps.find((step) => step.action === "identity.name.set");
    assert.ok(skipped, "the not-applied detection is recorded as a step");
    assert.equal(skipped?.state, "skipped");
    assert.match(skipped?.description ?? "", /Detected client "grok" but the principal is already named "agent"/);
    assert.match(skipped?.description ?? "", /RUN402_AGENT_NAME=<name>/);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("up lets RUN402_AGENT_NAME override an existing display_name and reports it as explicit", async () => {
  const dir = identityWorkspace("run402-up-identity-env-override-");
  const calls: string[] = [];
  const { sdk, set } = identityAwareSdk(calls, { display_name: "agent", subject: WALLET });
  try {
    const result = await withClientEnv({ GROK_CLI: "1", RUN402_AGENT_NAME: "Grok" }, async () => {
      const actions = new NodeActions(sdk, { targetKind: "cloud", cwd: dir });
      return actions.up({}, { approval: "yes" });
    });
    assert.equal(result.result?.identity?.source, "explicit");
    assert.equal(result.result?.identity?.display_name, "Grok");
    assert.equal(result.result?.identity?.detected, "grok");
    assert.deepEqual(result.result?.identity?.detection, { applied: false, reason: "explicit_name_wins" });
    assert.deepEqual(set, ["Grok"]);
    assert.ok(calls.includes("rooms.registerPresence:Grok"));
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("up names an unnamed principal from a specifically detected client", async () => {
  const dir = identityWorkspace("run402-up-identity-unnamed-");
  const calls: string[] = [];
  const { sdk, set } = identityAwareSdk(calls, { display_name: null, subject: WALLET });
  try {
    const result = await withClientEnv({ CLAUDECODE: "1" }, async () => {
      const actions = new NodeActions(sdk, { targetKind: "cloud", cwd: dir });
      return actions.up({}, { approval: "yes" });
    });
    assert.equal(result.result?.identity?.source, "detected");
    assert.deepEqual(set, ["claude-code"]);
    assert.equal(result.result?.identity?.display_name, "claude-code");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("up names an unnamed principal grok when GROK_AGENT is set", async () => {
  const dir = identityWorkspace("run402-up-identity-grok-");
  const calls: string[] = [];
  const { sdk, set } = identityAwareSdk(calls, { display_name: null, subject: WALLET });
  try {
    const result = await withClientEnv({ GROK_AGENT: "1", GROK_SESSION_ID: "01abc" }, async () => {
      const actions = new NodeActions(sdk, { targetKind: "cloud", cwd: dir });
      return actions.up({}, { approval: "yes" });
    });
    assert.equal(result.result?.identity?.source, "detected");
    assert.deepEqual(set, ["grok"]);
    assert.equal(result.result?.identity?.display_name, "grok");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("up reads RUN402_AGENT_NAME before detection and reports it as explicit", async () => {
  const dir = identityWorkspace("run402-up-identity-env-");
  const calls: string[] = [];
  const { sdk, set } = identityAwareSdk(calls, { display_name: null, subject: WALLET });
  try {
    const result = await withClientEnv({ CLAUDECODE: "1", RUN402_AGENT_NAME: " Grok " }, async () => {
      const actions = new NodeActions(sdk, { targetKind: "cloud", cwd: dir });
      return actions.up({}, { approval: "yes" });
    });
    assert.equal(result.result?.identity?.source, "explicit");
    assert.deepEqual(set, ["Grok"]);
    assert.ok(calls.includes("rooms.registerPresence:Grok"));
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("up never persists a guess: an undetected runtime leaves the principal unnamed", async () => {
  const dir = identityWorkspace("run402-up-identity-undetected-");
  const calls: string[] = [];
  const { sdk, set } = identityAwareSdk(calls, { display_name: null, subject: WALLET });
  try {
    const result = await withClientEnv({}, async () => {
      const actions = new NodeActions(sdk, { targetKind: "cloud", cwd: dir });
      return actions.up({}, { approval: "yes" });
    });
    assert.equal(result.result?.identity?.source, "undetected");
    assert.equal(result.result?.identity?.display_name, null);
    assert.equal(set.length, 0, "nothing is written");
    assert.ok(calls.includes("rooms.registerPresence:agent"), "the room presence is a coordination label only");
    assert.equal(result.result?.deploy?.release_id, "rel_123", "the deploy still runs");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("up sets an explicit identityName over an unnamed principal", async () => {
  const dir = identityWorkspace("run402-up-identity-explicit-");
  const calls: string[] = [];
  const { sdk, set } = identityAwareSdk(calls, { display_name: null, subject: WALLET });
  try {
    const result = await withClientEnv({}, async () => {
      const actions = new NodeActions(sdk, { targetKind: "cloud", cwd: dir });
      return actions.up({ identityName: "Grok" }, { approval: "yes" });
    });
    assert.equal(result.result?.identity?.source, "explicit");
    assert.deepEqual(set, ["Grok"]);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("unlinked up never selects the global project, even with yes, plan, or interactive generic approval", async () => {
  const dir = mkdtempSync(join(tmpdir(), "run402-target-intent-"));
  writeFileSync(join(dir, "run402.json"), JSON.stringify({ site: { replace: { "index.html": { data: "new app" } } } }));
  try {
    for (const options of [{ approval: "yes" as const }, { mode: "plan" as const }, { approval: { mode: "interactive" as const, approve: async () => true } }]) {
      const calls: string[] = [];
      const actions = new NodeActions(fakeSdk({ calls, allowanceConfigured: false, tierActive: false, activeProject: "prj_unrelated_live" }), { targetKind: "cloud", cwd: dir });
      await assert.rejects(actions.up({}, options), (err: any) => {
        assert.equal(err.code, "UP_PROJECT_REQUIRED");
        assert.equal(err.nextActions.length, 1);
        assert.equal(err.nextActions[0].safe_to_auto_execute, false);
        return true;
      });
      assert.deepEqual(calls, []);
      assert.deepEqual(readdirSync(dir), ["run402.json"]);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("up checks conflicting explicit, manifest, link and API selectors before cold-wallet prerequisites", async () => {
  const dir = mkdtempSync(join(tmpdir(), "run402-target-conflicts-"));
  const calls: string[] = [];
  const actions = new NodeActions(fakeSdk({ calls, allowanceConfigured: false, tierActive: false, activeProject: "prj_unrelated_live" }), { targetKind: "cloud", cwd: dir });
  try {
    writeFileSync(join(dir, "run402.json"), JSON.stringify({ project_id: "prj_manifest", site: { replace: { "index.html": { data: "new" } } } }));
    await assert.rejects(actions.up({ projectId: "prj_other" }, { approval: "yes" }), { code: "RUN402_PROJECT_CONFLICT" });
    mkdirSync(join(dir, ".run402"));
    const link = { schema_version: "run402.workspace-project.v1", project_id: "prj_manifest", target: { kind: "cloud", api_base: "https://other.example.test" } };
    writeFileSync(join(dir, ".run402/project.json"), JSON.stringify(link));
    await assert.rejects(actions.up({ projectId: "prj_manifest" }, { approval: "yes" }), { code: "RUN402_WORKSPACE_LINK_CONFLICT" });
    assert.deepEqual(calls, []);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, ".run402/project.json"), "utf8")), link);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("four sibling apps produce one unranked selection action; parent links never select a child", async () => {
  const dir = mkdtempSync(join(tmpdir(), "run402-four-apps-"));
  const calls: string[] = [];
  const sdk = fakeSdk({ calls, allowanceConfigured: true, tierActive: true, activeProject: "prj_unrelated_live" });
  try {
    mkdirSync(join(dir, ".run402"));
    writeFileSync(join(dir, ".run402/project.json"), JSON.stringify({ schema_version: "run402.workspace-project.v1", project_id: "prj_parent" }));
    for (const name of ["alpha", "beta", "gamma", "delta"]) {
      mkdirSync(join(dir, name));
      writeFileSync(join(dir, name, "run402.json"), JSON.stringify({ site: { replace: { "index.html": { data: name } } } }));
    }
    await assert.rejects(new NodeActions(sdk, { cwd: dir }).up({}, { mode: "check" }), (err: any) => {
      const actions = err.nextActions ?? err.details.next_actions;
      assert.equal(actions.length, 1);
      assert.equal(actions[0].type, "select_application");
      assert.equal(actions[0].safe_to_auto_execute, false);
      assert.equal(actions[0].candidates.length, 4);
      for (const candidate of actions[0].candidates) {
        assert.equal(candidate.recommended, false);
        assert.ok(candidate.argv.includes("--check"));
      }
      return true;
    });
    await assert.rejects(new NodeActions(sdk, { cwd: dir }).up({ manifest: "beta/run402.json" }, { approval: "yes" }), { code: "UP_PROJECT_REQUIRED" });
    assert.deepEqual(calls, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("local preflight has nullable intent, real file evidence and deferred gateway checks; export is read-only", async () => {
  const dir = mkdtempSync(join(tmpdir(), "run402-preflight-evidence-"));
  const calls: string[] = [];
  try {
    writeFileSync(join(dir, "api.js"), "export default () => 'hello';");
    writeFileSync(join(dir, "run402.json"), JSON.stringify({ functions: { replace: { api: { source: { path: "api.js" }, config: { timeout_seconds: 5 } } } } }));
    const actions = new NodeActions(fakeSdk({ calls, allowanceConfigured: false, tierActive: false, activeProject: "prj_unrelated" }), { cwd: dir, targetKind: "cloud" });
    const checked = await actions.up({}, { mode: "check" });
    const preflight = checked.result?.preflight as any;
    assert.equal(checked.result?.project_id, null);
    assert.equal(preflight.target.source, "unresolved");
    assert.equal(preflight.gateway_validated, false);
    assert.equal(preflight.summary.file_references, 1);
    assert.equal(preflight.checks.find((c: any) => c.name === "quota").status, "deferred");
    assert.equal(JSON.stringify(checked).includes("placeholder"), false);
    const exported = await actions.up({}, { mode: "printManifest" });
    assert.deepEqual((exported.result?.manifest?.functions as any).replace.api.source, { path: "api.js" });
    assert.deepEqual(calls, []);
    assert.equal(existsSync(join(dir, ".run402")), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("selected app scan ignores a sibling bearer fixture and blocks its own source consistently", async () => {
  const root = mkdtempSync(join(tmpdir(), "run402-scan-scope-"));
  const calls: string[] = [];
  try {
    const dir = join(root, "app");
    const sibling = join(root, "unrelated");
    mkdirSync(dir); mkdirSync(sibling);
    writeFileSync(join(dir, "run402.json"), JSON.stringify({ site: { replace: { "index.html": "ok" } } }));
    writeFileSync(join(sibling, "test.js"), 'fetch("/", {headers:{Authorization:"Bearer fixture"}}); await getSession();');
    const actions = new NodeActions(fakeSdk({ calls, allowanceConfigured: false, tierActive: false, activeProject: "prj_unrelated" }), { cwd: root });
    await actions.up({ dir }, { mode: "check" });
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "bad.js"), "await getSession();");
    for (const options of [{ mode: "check" as const }, { approval: "yes" as const }]) {
      await assert.rejects(actions.up({ dir, name: "selected" }, options), (err: any) => {
        assert.equal(err.code, "R402_AUTH_PREFLIGHT_FAILED");
        assert.equal(err.details.app_root, dir);
        assert.equal(err.details.errors[0].file, "src/bad.js");
        return true;
      });
    }
    assert.deepEqual(calls, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("preflight reports missing SQL and site files together", async () => {
  const root = mkdtempSync(join(tmpdir(), "run402-missing-inputs-"));
  try {
    writeFileSync(join(root, "run402.json"), JSON.stringify({ database: { migrations: [{ name: "first", sql_path: "first.sql" }] }, site: { replace: { "index.html": { path: "index.html" } } } }));
    const calls: string[] = [];
    const actions = new NodeActions(fakeSdk({ calls, allowanceConfigured: false, tierActive: false, activeProject: null }), { cwd: root });
    await assert.rejects(actions.up({}, { mode: "check" }), (err: any) => {
      assert.equal(err.code, "MANIFEST_FILE_MISSING");
      assert.deepEqual(new Set(err.details.missing.map((item: any) => item.kind)), new Set(["migration_sql", "site_file"]));
      assert.equal(err.nextActions.length, 3);
      assert.deepEqual(err.nextActions.slice(0, 2).map((a: any) => a.type), ["create_file", "create_file"]);
      assert.equal(err.nextActions[2].type, "check_manifest");
      return true;
    });
    assert.deepEqual(calls, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const type of ["human", "unknown"]) {
  for (const display_name of ["agent", null]) {
    test(`up preserves ${type} principal ${display_name ?? "without name"} despite client/name input`, async () => {
      const dir = identityWorkspace("run402-up-preserve-human-");
      const calls: string[] = [];
      const { sdk, set } = identityAwareSdk(calls, { display_name, subject: WALLET, type });
      try {
        const result = await withClientEnv({ RUN402_CLIENT: "grok", RUN402_AGENT_NAME: "Grok" }, async () =>
          new NodeActions(sdk, { targetKind: "cloud", cwd: dir }).up({}, { approval: "yes" }));
        assert.deepEqual(set, []);
        assert.equal(result.result?.identity?.display_name, display_name);
        assert.equal(result.result?.identity?.principal?.type, type);
        assert.equal(result.result?.identity?.client?.detected, "grok");
        assert.equal(result.result?.identity?.detection?.reason, "principal_identity_preserved");
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  }
}

for (const { status, expected } of [{ status: 400, expected: 400 }, { status: 429, expected: 429 }, { status: 400, expected: 200 }, { status: 429, expected: 200 }]) {
  test(`function ${status} is compared to expected ${expected} despite CloudFront error header`, async (t) => {
    const dir = identityWorkspace("run402-up-function-status-");
    writeFileSync(join(dir, "run402.deploy.json"), JSON.stringify({ project_id: "prj_ready",
      site: { replace: { "index.html": { data: "ok" } } },
      verify: { http: [{ id: "function", url: "https://example.test/api/leave-light", expect: { status: expected } }] },
    }));
    const calls: string[] = [];
    const sdk = fakeSdk({ calls, allowanceConfigured: true, tierActive: true, activeProject: null });
    const response = new Response('{"error":"application_error"}', { status, headers: { "x-cache": "Error from cloudfront", "retry-after": "60" } });
    const fetchMock = mock.method(globalThis, "fetch", async () => response.clone());
    t.after(() => fetchMock.mock.restore());
    try {
      const result = await new NodeActions(sdk, { targetKind: "cloud", cwd: dir }).up({ verifyOnly: true });
      assert.equal(result.result?.verify?.status, status === expected ? "verified" : "failed");
      assert.equal(result.result?.verification?.http[0]?.actual_status, status);
      assert.equal(response.headers.get("retry-after"), "60");
      assert.equal(await response.text(), '{"error":"application_error"}');
      assert.ok(!calls.some(call => call.startsWith("project.apply:")));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

for (const state of ["not_repository", "unborn", "has_commit"] as const) {
  test(`source resolution distinguishes available files from Git state: ${state}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "run402-source-state-"));
    const dir = join(root, "app");
    mkdirSync(dir);
    try {
      // The unborn app is nested inside a parent with a real commit.
      if (state === "unborn") {
        execFileSync("git", ["init", "-q", root]);
        execFileSync("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "parent"]);
      }
      if (state !== "not_repository") execFileSync("git", ["init", "-q", dir]);
      writeFileSync(join(dir, "run402.json"), JSON.stringify(appManifest()));
      if (state === "has_commit") execFileSync("git", ["-C", dir, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "initial"]);
      const actions = new NodeActions(fakeSdk({ calls: [], allowanceConfigured: true, tierActive: true, activeProject: null }), { targetKind: "cloud", cwd: dir });
      const result = await actions.up({}, { mode: "check" });
      const source = result.steps.find(step => step.action === "app.source.resolve")?.details;
      assert.equal(source?.source_available, true);
      assert.equal(source?.git_state, state);
      assert.equal(source?.commit === null, state !== "has_commit");
      if (state === "unborn") {
        assert.throws(() => execFileSync("git", ["-C", dir, "rev-parse", "--verify", "HEAD"], { stdio: "pipe" }));
        assert.match(String(source?.git_message), /no commits/);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

for (const generation of ["7", "", "oops", "-1", "9007199254740992"]) {
  test(`deploy verification retains release headers without guessing generation: ${generation}`, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "run402-release-observation-"));
    writeFileSync(join(dir, "run402.deploy.json"), JSON.stringify({ project_id: "prj_ready", site: { replace: { "index.html": { data: "ok" } } }, verify: { http: [{ id: "home", url: "https://example.com/", expect: { status: 200 } }] } }));
    const fetchMock = mock.method(globalThis, "fetch", async () => new Response("ok", { status: 200, headers: { "x-run402-release-id": "rel_headers", "x-run402-release-generation": generation } }));
    t.after(() => { fetchMock.mock.restore(); rmSync(dir, { recursive: true, force: true }); });
    const actions = new NodeActions(fakeSdk({ calls: [], allowanceConfigured: true, tierActive: true, activeProject: null }), { targetKind: "cloud", cwd: dir });
    const result = await actions.up({ verifyOnly: true });
    const observation = result.result?.verification?.http[0]?.observed_release;
    assert.equal(observation?.release_id, "rel_headers");
    assert.equal(observation?.generation, generation === "7" ? 7 : null);
    assert.equal(observation?.unavailable_reason, generation === "7" ? null : "headers_missing_or_invalid");
    assert.equal(observation?.url, "https://example.com/");
    assert.equal(result.result?.verify?.status, "verified");
  });
}

test("workflow retains the original deploy recovery code and completed mutation steps", async () => {
 const { Run402DeployError } = await import("../errors.js");
 const dir=realpathSync(mkdtempSync(join(tmpdir(),"run402-recovery-")));
 writeFileSync(join(dir,"run402.json"),JSON.stringify({database:{migrations:[{id:"001",sql:"CREATE TABLE notes(id int);"}]}}));
 const sdk:any=fakeSdk({calls:[],allowanceConfigured:true,tierActive:true,activeProject:null});
 const error=new Run402DeployError("Review access",{code:"PUBLIC_ACCESS_POLICY_APPLY",phase:"plan",context:"test",body:{next_actions:[{type:"review_warnings",warning_codes:["PUBLIC_ACCESS_POLICY_APPLY"]}]}});
 sdk.project=async()=>({apply:async()=>{throw error;}});
 try {
  await assert.rejects(new NodeActions(sdk,{targetKind:"cloud",cwd:dir}).up({name:"recovery"},{approval:"yes"}), (caught:any)=>{
   assert.equal(caught,error);assert.equal(caught.code,"PUBLIC_ACCESS_POLICY_APPLY");assert.equal(caught.nextActions[0].type,"review_warnings");
   assert.ok(caught.body.workflow.steps.some((step:any)=>step.action==="projects.provision"&&step.state==="succeeded"&&step.mutation));return true;
  });
 } finally {rmSync(dir,{recursive:true,force:true});}
});
