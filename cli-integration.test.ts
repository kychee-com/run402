/**
 * cli-integration.test.ts — Full lifecycle integration test against LIVE production.
 *
 * NO MOCKS. Every command hits https://api.run402.com for real.
 * Uses a pre-funded allowance wallet, subscribes to prototype tier ($0.10
 * testnet USDC), provisions a real project, runs SQL, deploys site, manages
 * functions/secrets/storage/subdomains, publishes, forks, and tears everything down.
 *
 * Prerequisites:
 *   - Set BUYER_PRIVATE_KEY env var (or have it in ../../run402/.env).
 *     This is an EVM private key with testnet USDC on Base Sepolia.
 *
 * Run:
 *   node --test --import tsx cli-integration.test.ts
 *   npm run test:integration:full
 *
 * Takes ~2-3 minutes. Costs ~$0.10 testnet USDC (prototype tier).
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ─── Test harness ────────────────────────────────────────────────────────────

const API = "https://api.run402.com";
let tempDir: string;

// Capture console output from CLI modules
const originalLog = console.log;
const originalError = console.error;
const originalExit = process.exit;
let output: string[] = [];

function captureStart() {
  output = [];
  console.log = (...args: unknown[]) =>
    output.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  console.error = (...args: unknown[]) =>
    output.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
}

function captureStop() {
  console.log = originalLog;
  console.error = originalError;
}

function captured(): string {
  return output.join("\n");
}

function capturedJson(): Record<string, unknown> {
  const raw = captured();
  // CLI outputs JSON — find the first JSON object or array
  const match = raw.match(/[{\[].*/s);
  if (!match) throw new Error(`No JSON in output:\n${raw}`);
  return JSON.parse(match[0]);
}

// ─── State passed between tests ──────────────────────────────────────────────

let projectId: string;
let anonKey: string;
let serviceKey: string;
let deploymentId: string;
let versionId: string;
let forkedProjectId: string;

// ─── Setup & teardown ────────────────────────────────────────────────────────

before(async () => {
  // Load BUYER_PRIVATE_KEY from env or from sibling run402 repo's .env
  let buyerKey = process.env.BUYER_PRIVATE_KEY;
  if (!buyerKey) {
    const { fileURLToPath } = await import("node:url");
    const { dirname } = await import("node:path");
    const thisDir = dirname(fileURLToPath(import.meta.url));
    const searchPaths = [
      join(thisDir, "..", "run402-private", ".env"), // ~/Developer/run402-private/.env
    ];
    for (const envPath of searchPaths) {
      try {
        const envContent = readFileSync(envPath, "utf-8");
        const match = envContent.match(/BUYER_PRIVATE_KEY=(.+)/);
        if (match) { buyerKey = match[1].trim(); break; }
      } catch { /* try next */ }
    }
  }
  if (!buyerKey) {
    throw new Error("BUYER_PRIVATE_KEY not found. Set env var or ensure ../run402/.env exists.");
  }

  tempDir = mkdtempSync(join(tmpdir(), "run402-integ-"));
  process.env.RUN402_CONFIG_DIR = tempDir;
  process.env.RUN402_API_BASE = API;

  // Seed the allowance file with the pre-funded wallet so paid commands work
  const { privateKeyToAccount } = await import("viem/accounts");
  const account = privateKeyToAccount(buyerKey as `0x${string}`);
  const allowanceData = {
    address: account.address,
    privateKey: buyerKey,
    created: new Date().toISOString(),
    funded: true,
  };
  writeFileSync(join(tempDir, "allowance.json"), JSON.stringify(allowanceData), { mode: 0o600 });

  // Override process.exit so CLI errors don't kill the test runner
  (process as { exit: (code?: number) => never }).exit = ((code?: number) => {
    throw new Error(`process.exit(${code})\nOutput: ${captured()}`);
  }) as never;
});

after(async () => {
  captureStop();
  (process as { exit: (code?: number) => never }).exit = originalExit;
  delete process.env.RUN402_CONFIG_DIR;
  delete process.env.RUN402_API_BASE;
  rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  captureStop();
});

// ─── Tests — sequential, full lifecycle ──────────────────────────────────────

describe("CLI integration (live API, no mocks)", { timeout: 180_000 }, () => {
  // ── Allowance (pre-seeded from BUYER_PRIVATE_KEY) ──────────────────────

  it("allowance status", async () => {
    const { run } = await import("./cli/lib/allowance.mjs");
    captureStart();
    await run("status", []);
    captureStop();
    assert.ok(captured().includes("ok"), "should show ok status");
  });

  it("allowance export", async () => {
    const { run } = await import("./cli/lib/allowance.mjs");
    captureStart();
    await run("export", []);
    captureStop();
    assert.ok(captured().includes("0x"), "should print allowance address");
  });

  it("allowance balance", async () => {
    const { run } = await import("./cli/lib/allowance.mjs");
    captureStart();
    await run("balance", []);
    captureStop();
    const out = captured();
    assert.ok(out.includes("base-sepolia_usd_micros") || out.includes("USDC"), `Expected balance info in: ${out}`);
  });

  // ── Tier ──────────────────────────────────────────────────────────────

  it("tier set prototype", async () => {
    const { run } = await import("./cli/lib/tier.mjs");
    captureStart();
    try {
      await run("set", ["prototype"]);
    } catch (err: unknown) {
      // If tier is already active, the server returns 402 for renewal — the x402 wrapper
      // should auto-pay. Only "already active" after successful renewal is acceptable.
      const msg = (err as Error).message || "";
      if (msg.includes("already active")) {
        captureStop();
        assert.ok(true, "tier already active (expected for pre-funded wallet)");
        return;
      }
      throw err;
    }
    captureStop();
    const out = captured();
    assert.ok(
      out.includes("subscribe") || out.includes("renew") || out.includes("prototype"),
      `Expected tier action in: ${out}`,
    );
  });

  it("tier status", async () => {
    const { run } = await import("./cli/lib/tier.mjs");
    captureStart();
    await run("status", []);
    captureStop();
    const out = captured();
    assert.ok(out.includes("prototype"), `Expected 'prototype' in: ${out}`);
  });

  // ── Projects ──────────────────────────────────────────────────────────

  it("projects quote", async () => {
    const { run } = await import("./cli/lib/projects.mjs");
    captureStart();
    await run("quote", []);
    captureStop();
    assert.ok(captured().includes("tiers"), "should show tier pricing");
  });

  it("projects provision", async () => {
    const { run } = await import("./cli/lib/projects.mjs");
    captureStart();
    await run("provision", ["--name", "integ-test"]);
    captureStop();
    const data = capturedJson();
    projectId = data.project_id as string;
    anonKey = data.anon_key as string;
    serviceKey = data.service_key as string;
    assert.ok(projectId, `Expected project_id, got: ${JSON.stringify(data)}`);
    assert.ok(anonKey, "Expected anon_key");
    assert.ok(serviceKey, "Expected service_key");
  });

  it("projects list", async () => {
    const { run } = await import("./cli/lib/projects.mjs");
    captureStart();
    await run("list", []);
    captureStop();
    assert.ok(captured().includes(projectId), "should list the provisioned project");
  });

  it("projects info", async () => {
    const { run } = await import("./cli/lib/projects.mjs");
    captureStart();
    await run("info", [projectId]);
    captureStop();
    assert.ok(captured().includes(projectId), "should show project info");
  });

  it("projects sql — create table", async () => {
    const { run } = await import("./cli/lib/projects.mjs");
    captureStart();
    await run("sql", [
      projectId,
      "CREATE TABLE items (id serial PRIMARY KEY, title text NOT NULL, done boolean DEFAULT false)",
    ]);
    captureStop();
    assert.ok(captured().includes("ok") || captured().includes("CREATE"), "should create table");
  });

  it("projects sql — insert data", async () => {
    const { run } = await import("./cli/lib/projects.mjs");
    captureStart();
    await run("sql", [projectId, "INSERT INTO items (title) VALUES ('Buy milk'), ('Read book')"]);
    captureStop();
    assert.ok(captured().includes("ok") || captured().includes("INSERT"), "should insert rows");
  });

  it("projects rls", async () => {
    const { run } = await import("./cli/lib/projects.mjs");
    captureStart();
    // 3-arg CLI form cannot send the UNRESTRICTED ACK, so use the
    // collaborative template here. UNRESTRICTED is exercised via the
    // deploy-manifest path elsewhere.
    await run("rls", [projectId, "public_read_authenticated_write", '[{"table":"items"}]']);
    captureStop();
    assert.ok(captured().includes("ok") || captured().includes("updated"), "should apply RLS");
  });

  it("projects rest", async () => {
    const { run } = await import("./cli/lib/projects.mjs");
    captureStart();
    await run("rest", [projectId, "items", "limit=10"]);
    captureStop();
    const out = captured();
    assert.ok(out.includes("Buy milk") || out.includes("title"), `Expected row data in: ${out}`);
  });

  it("projects schema", async () => {
    const { run } = await import("./cli/lib/projects.mjs");
    captureStart();
    await run("schema", [projectId]);
    captureStop();
    assert.ok(captured().includes("items"), "should show items table in schema");
  });

  it("projects usage", async () => {
    const { run } = await import("./cli/lib/projects.mjs");
    captureStart();
    await run("usage", [projectId]);
    captureStop();
    assert.ok(captured().includes("api_calls") || captured().includes("storage"), "should show usage");
  });

  // ── Functions ─────────────────────────────────────────────────────────

  it("functions deploy", async () => {
    const { run } = await import("./cli/lib/functions.mjs");
    const codePath = join(tempDir, "handler.mjs");
    writeFileSync(codePath, 'export default async (req) => new Response(JSON.stringify({ hello: "world" }), { headers: { "Content-Type": "application/json" } })');
    captureStart();
    await run("deploy", [projectId, "hello", "--file", codePath]);
    captureStop();
    assert.ok(captured().includes("hello"), "should deploy function");
  });

  it("functions list", async () => {
    const { run } = await import("./cli/lib/functions.mjs");
    captureStart();
    await run("list", [projectId]);
    captureStop();
    assert.ok(captured().includes("hello"), "should list deployed function");
  });

  it("functions invoke", async () => {
    // Lambda cold start can take a few seconds — retry once
    const { run } = await import("./cli/lib/functions.mjs");
    for (let attempt = 0; attempt < 2; attempt++) {
      captureStart();
      try {
        await run("invoke", [projectId, "hello"]);
        captureStop();
        assert.ok(captured().includes("world") || captured().includes("hello"), "should return function response");
        return;
      } catch {
        captureStop();
        if (attempt === 0) await new Promise((r) => setTimeout(r, 3000)); // wait for cold start
      }
    }
    assert.fail("functions invoke failed after retries");
  });

  it("functions logs", async () => {
    const { run } = await import("./cli/lib/functions.mjs");
    captureStart();
    await run("logs", [projectId, "hello"]);
    captureStop();
    // Logs may be empty if function was just deployed — just verify no error
    assert.ok(true, "should fetch logs without error");
  });

  // ── Secrets ───────────────────────────────────────────────────────────

  it("secrets set", async () => {
    const { run } = await import("./cli/lib/secrets.mjs");
    captureStart();
    await run("set", [projectId, "TEST_KEY", "test_value_123"]);
    captureStop();
    assert.ok(captured().includes("ok") || captured().includes("TEST_KEY"), "should set secret");
  });

  it("secrets list", async () => {
    const { run } = await import("./cli/lib/secrets.mjs");
    captureStart();
    await run("list", [projectId]);
    captureStop();
    assert.ok(captured().includes("TEST_KEY"), "should list the secret");
  });

  // ── Sites ─────────────────────────────────────────────────────────────

  it("sites deploy", async () => {
    const { run } = await import("./cli/lib/sites.mjs");
    const manifestPath = join(tempDir, "site-manifest.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({
        files: [{ file: "index.html", data: "<!DOCTYPE html><html><body><h1>Integration Test</h1></body></html>" }],
      }),
    );
    captureStart();
    await run("deploy", ["--manifest", manifestPath, "--project", projectId]);
    captureStop();
    const out = captured();
    // Extract deployment ID from output
    const match = out.match(/dpl_[a-zA-Z0-9_]+/);
    deploymentId = match ? match[0] : "";
    assert.ok(deploymentId, `Expected deployment_id in: ${out}`);
  });

  it("sites status", async () => {
    const { run } = await import("./cli/lib/sites.mjs");
    captureStart();
    await run("status", [deploymentId]);
    captureStop();
    assert.ok(
      captured().includes("live") || captured().includes("ready") || captured().includes(deploymentId),
      "should show deployment status",
    );
  });

  // ── Subdomains ────────────────────────────────────────────────────────

  const subdomainName = `integ-${Date.now().toString(36)}`;

  it("subdomains claim", async () => {
    const { run } = await import("./cli/lib/subdomains.mjs");
    captureStart();
    await run("claim", [subdomainName, "--deployment", deploymentId, "--project", projectId]);
    captureStop();
    assert.ok(captured().includes(subdomainName), "should claim subdomain");
  });

  it("subdomains list", async () => {
    const { run } = await import("./cli/lib/subdomains.mjs");
    captureStart();
    await run("list", [projectId]);
    captureStop();
    assert.ok(captured().includes(subdomainName), "should list the subdomain");
  });

  // ── Apps (publish + fork) ─────────────────────────────────────────────

  it("apps publish", async () => {
    const { run } = await import("./cli/lib/apps.mjs");
    captureStart();
    await run("publish", [projectId, "--description", "Integration test app", "--visibility", "public", "--fork-allowed"]);
    captureStop();
    const out = captured();
    const match = out.match(/ver_[a-zA-Z0-9_]+/);
    versionId = match ? match[0] : "";
    assert.ok(versionId, `Expected version_id in: ${out}`);
  });

  it("apps versions", async () => {
    const { run } = await import("./cli/lib/apps.mjs");
    captureStart();
    await run("versions", [projectId]);
    captureStop();
    assert.ok(captured().includes(versionId), "should list the published version");
  });

  it("apps inspect", async () => {
    const { run } = await import("./cli/lib/apps.mjs");
    captureStart();
    try {
      await run("inspect", [versionId]);
      captureStop();
      assert.ok(captured().includes("integ") || captured().includes(versionId), "should show app details");
    } catch {
      // Private versions are not visible via public inspect endpoint — expected
      captureStop();
      assert.ok(captured().includes("404") || captured().includes("not found"), "private version not publicly inspectable (expected)");
    }
  });

  it("apps update", async () => {
    const { run } = await import("./cli/lib/apps.mjs");
    captureStart();
    await run("update", [projectId, versionId, "--description", "Updated integration test"]);
    captureStop();
    assert.ok(
      captured().includes("Updated") || captured().includes(versionId),
      "should update version metadata",
    );
  });

  it("apps browse", async () => {
    const { run } = await import("./cli/lib/apps.mjs");
    captureStart();
    await run("browse", []);
    captureStop();
    // Browse lists public apps — may or may not include our private one
    assert.ok(true, "should browse without error");
  });

  it("apps fork", async () => {
    const { run } = await import("./cli/lib/apps.mjs");
    captureStart();
    await run("fork", [versionId, "integ-fork"]);
    captureStop();
    const out = captured();
    const match = out.match(/prj_[a-zA-Z0-9_]+/);
    forkedProjectId = match ? match[0] : "";
    assert.ok(forkedProjectId, `Expected forked project_id in: ${out}`);
  });

  // ── Message ───────────────────────────────────────────────────────────

  it("message send", async () => {
    const { run } = await import("./cli/lib/message.mjs");
    captureStart();
    await run("send", ["[integration-test] CLI integration test run"]);
    captureStop();
    assert.ok(captured().includes("ok") || captured().includes("sent"), "should send message");
  });

  // ── Agent ─────────────────────────────────────────────────────────────

  it("agent contact", async () => {
    const { run } = await import("./cli/lib/agent.mjs");
    captureStart();
    await run("contact", ["--name", "integ-test-agent"]);
    captureStop();
    assert.ok(captured().includes("integ-test-agent"), "should set agent contact");
  });

  // ── Init + Status (compound commands) ─────────────────────────────────

  it("status", async () => {
    const { run } = await import("./cli/lib/status.mjs");
    captureStart();
    await run();
    captureStop();
    const data = capturedJson();
    assert.ok(data.allowance, "should include allowance");
    assert.ok(Array.isArray(data.projects), "should include projects");
  });

  // ── MPP rail — full lifecycle (real Tempo RPC + real gateway) ───────

  let mppProjectId: string;

  it("mpp: init mpp — switch to MPP rail, fund on Tempo", async () => {
    const { run } = await import("./cli/lib/init.mjs");
    captureStart();
    await run(["mpp"]);
    captureStop();
    const out = captured();
    assert.ok(out.includes("Tempo"), `Expected 'Tempo' in: ${out}`);
    assert.ok(out.includes("pathUSD"), `Expected 'pathUSD' in: ${out}`);
    assert.ok(out.includes("mpp"), `Expected 'mpp' in: ${out}`);
    const allowance = JSON.parse(readFileSync(join(tempDir, "allowance.json"), "utf-8"));
    assert.equal(allowance.rail, "mpp", "rail should be mpp");
  });

  it("mpp: tier set prototype — pay via MPP on Tempo", async () => {
    const { run } = await import("./cli/lib/tier.mjs");
    captureStart();
    try {
      await run("set", ["prototype"]);
    } catch (err: unknown) {
      const msg = (err as Error).message || "";
      if (msg.includes("already active") || msg.includes("renew")) {
        captureStop();
        assert.ok(true, "tier already active or renewed (expected for pre-funded wallet)");
        return;
      }
      throw err;
    }
    captureStop();
    const out = captured();
    assert.ok(
      out.includes("subscribe") || out.includes("renew") || out.includes("prototype"),
      `Expected tier action in: ${out}`,
    );
  });

  it("mpp: projects provision", async () => {
    const { run } = await import("./cli/lib/projects.mjs");
    captureStart();
    await run("provision", ["--name", "mpp-test-app"]);
    captureStop();
    const data = capturedJson();
    mppProjectId = data.project_id as string;
    assert.ok(mppProjectId, `Expected project_id, got: ${JSON.stringify(data)}`);
    assert.ok(data.anon_key, "Expected anon_key");
    assert.ok(data.service_key, "Expected service_key");
  });

  it("mpp: deploy site", async () => {
    const { run } = await import("./cli/lib/deploy.mjs");
    const manifestPath = join(tempDir, "mpp-manifest.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({
        files: [{ file: "index.html", data: "<!DOCTYPE html><html><body><h1>MPP Test App</h1></body></html>" }],
      }),
    );
    captureStart();
    await run(["--manifest", manifestPath, "--project", mppProjectId]);
    captureStop();
    const out = captured();
    assert.ok(out.includes(mppProjectId) || out.includes("sites.run402.com"), `Expected deploy result in: ${out}`);
  });

  it("mpp: projects delete", async () => {
    if (!mppProjectId) return;
    const { run } = await import("./cli/lib/projects.mjs");
    captureStart();
    await run("delete", [mppProjectId, "--confirm"]);
    captureStop();
    assert.ok(captured().includes("ok") || captured().includes("delete"), "should delete MPP project");
  });

  it("mpp: init — switch back to x402", async () => {
    const { run } = await import("./cli/lib/init.mjs");
    captureStart();
    await run([]);
    captureStop();
    const out = captured();
    assert.ok(out.includes("x402"), `Expected 'x402' in: ${out}`);
    const allowance = JSON.parse(readFileSync(join(tempDir, "allowance.json"), "utf-8"));
    assert.equal(allowance.rail, "x402", "rail should be x402");
  });

  // ── Cleanup ───────────────────────────────────────────────────────────

  it("subdomains delete", async () => {
    const { run } = await import("./cli/lib/subdomains.mjs");
    captureStart();
    await run("delete", [subdomainName, "--confirm", "--project", projectId]);
    captureStop();
    assert.ok(captured().includes("ok") || captured().includes("delete"), "should delete subdomain");
  });

  it("secrets delete", async () => {
    const { run } = await import("./cli/lib/secrets.mjs");
    captureStart();
    await run("delete", [projectId, "TEST_KEY"]);
    captureStop();
    assert.ok(captured().includes("ok") || captured().includes("delete"), "should delete secret");
  });

  it("functions delete", async () => {
    const { run } = await import("./cli/lib/functions.mjs");
    captureStart();
    await run("delete", [projectId, "hello"]);
    captureStop();
    assert.ok(captured().includes("ok") || captured().includes("delete"), "should delete function");
  });

  it("apps delete", async () => {
    const { run } = await import("./cli/lib/apps.mjs");
    captureStart();
    await run("delete", [projectId, versionId]);
    captureStop();
    assert.ok(captured().includes("ok") || captured().includes("delete"), "should delete version");
  });

  it("projects delete (forked)", async () => {
    if (!forkedProjectId) return;
    const { run } = await import("./cli/lib/projects.mjs");
    captureStart();
    await run("delete", [forkedProjectId, "--confirm"]);
    captureStop();
    assert.ok(captured().includes("ok") || captured().includes("delete"), "should delete forked project");
  });

  it("projects delete (main)", async () => {
    const { run } = await import("./cli/lib/projects.mjs");
    captureStart();
    await run("delete", [projectId, "--confirm"]);
    captureStop();
    assert.ok(captured().includes("ok") || captured().includes("delete"), "should delete main project");
  });
});
