import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { Run402Action } from "../actions.js";
import { NodeActions } from "./actions-node.js";

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
  deployOptions?: Array<{ idempotencyKey?: string }>;
  deployPlanOptions?: Array<{ idempotencyKey?: string }>;
}) {
  return {
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
      async keys(projectId: string) {
        opts.calls.push(`projects.keys:${projectId}`);
        return { anon_key: "anon", service_key: "service" };
      },
    },
    async project(projectId: string) {
      opts.calls.push(`project:${projectId}`);
      return {
        apply: Object.assign(
          async (_spec?: unknown, input?: { idempotencyKey?: string }) => {
            opts.deployOptions?.push(input ?? {});
            opts.calls.push(`project.apply:${projectId}`);
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
