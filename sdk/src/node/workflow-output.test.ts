import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, rmSync, mkdirSync, symlinkSync, readdirSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prepareWorkflowOutput } from "./workflow-output.js";

test("curated output retains actual failure/recovery and stores only redacted detail", () => {
  const dir = mkdtempSync(join(tmpdir(), "run402-output-"));
  try {
    const original = { action: "up", mode: "apply", dry_run: false, target: "cloud", steps: [{ state: "done", result: { secret: "credential", serviceKey: "sensitive-service", anonKey: "sensitive-anon" } }], result: {
      project_id: "prj_test", deploy: { release_id: "rel_test", urls: { public: "https://test.example" } },
      verify: { status: "failed" }, repo: { status: "failed", reason: "backup_unavailable" },
      spec: { env: { SECRET: "credential" } }, plan: { summary: "one change", warnings: [{ code: "WARNING" }], effective_access: [{ table: "notes" }], site: { added: ["index.html"] } },
    } };
    const view = prepareWorkflowOutput(original, dir) as Record<string, any>;
    assert.equal(view.result.project_id, "prj_test");
    assert.equal(view.result.verify.status, "failed");
    assert.equal(view.result.repo.status, "failed");
    assert.equal(view.result.plan.warnings[0].code, "WARNING");
    assert.equal(view.result.plan.effective_access[0].table, "notes");
    assert.equal(view.result.spec, undefined);
    assert.equal(statSync(view.result_ref).mode & 0o777, 0o600);
    const detail = readFileSync(view.result_ref, "utf8");
    assert.doesNotMatch(detail, /credential|sensitive-service|sensitive-anon/);
    assert.match(detail, /index.html/);
    assert.equal(original.steps[0].result.secret, "credential", "does not mutate the typed SDK result");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("diagnostic storage failure retains the complete original result", () => {
  const dir = mkdtempSync(join(tmpdir(), "run402-output-"));
  try {
    mkdirSync(join(dir, "outside"));
    symlinkSync(join(dir, "outside"), join(dir, ".run402"));
    const result = { action: "up", mode: "apply", result: { spec: { text: "retain me" } } };
    assert.equal(prepareWorkflowOutput(result, dir), result);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("read-only output does not create diagnostic files", () => {
  const result = { mode: "check", dry_run: true, result: { spec: {} } };
  assert.equal(prepareWorkflowOutput(result, "/not-a-writable-workspace"), result);
});

test("MCP can use its existing result store with the same shared summary", () => {
  const result = { mode: "apply", result: { project_id: "p", app_graph: { nodes: [] } } };
  const view = prepareWorkflowOutput(result, "/unused", { storeDetails: () => ({ ref: "existing-store-ref", next_action: { type: "expand_result", ref: "existing-store-ref" } }) }) as Record<string, any>;
  assert.equal(view.result_ref, "existing-store-ref");
  assert.equal(view.next_actions[0].type, "expand_result");
  assert.equal(view.result.project_id, "p");
});

for (const outcome of [
  { status: "succeeded", verification: { strength: "http" }, snapshot: { status: "stored" } },
  { status: "partial", verification: { status: "failed" }, snapshot: { status: "failed" }, next_actions: [{ type: "retry_backup" }] },
  { status: "failed", code: "REST_PERMISSION_DENIED", category: "auth", next_actions: [{ type: "edit_request" }] },
  { status: "failed", code: "PAYMENT_AMBIGUOUS", mutation_state: "unknown", safe_to_retry: false, next_actions: [{ type: "reconcile_payment" }] },
]) test(`CLI and MCP summary preserve ${outcome.status}/${outcome.code ?? "deploy"} outcome`, () => {
  const dir = mkdtempSync(join(tmpdir(), "run402-output-parity-"));
  try {
    const original = { mode: "apply", target: "cloud", result: { ...outcome, spec: { large: "authored source" } } };
    const cli = prepareWorkflowOutput(original, dir) as Record<string, any>;
    const mcp = prepareWorkflowOutput(original, dir, { storeDetails: () => ({ ref: "mcp-ref", next_action: { type: "expand_result" } }) }) as Record<string, any>;
    assert.deepEqual(cli.result, mcp.result);
    assert.deepEqual(cli.result, outcome);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("diagnostics prune expired files and bound retention to 32 results", () => {
  const dir = mkdtempSync(join(tmpdir(), "run402-output-retention-"));
  try {
    const value = { mode: "apply", result: { status: "ready" } };
    const first = prepareWorkflowOutput(value, dir) as Record<string, any>;
    utimesSync(first.result_ref, new Date(0), new Date(0));
    for (let i = 0; i < 35; i++) prepareWorkflowOutput(value, dir);
    const names = readdirSync(join(dir, ".run402", "diagnostics"));
    assert.equal(names.length, 32);
    assert.ok(!names.some((name) => first.result_ref.endsWith(name)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("realistic release summaries bound repeated inventories while retaining denial and backup evidence", () => {
 const paths = Array.from({length: 20}, (_, i) => ({path:`/${i}`,state:"coherent",status:200,expected_release_id:"rel_1",observed_release_id:"rel_1"}));
 const report = {coherent:true, pending_count:0,path_count:20,paths};
 const value = {mode:"apply",result:{project_id:"prj_1",deploy:{release_id:"rel_1",urls:{site:"https://app.test"},diff:{is_noop:false,summary:{site_added:100},site:{added:Array(100).fill("file")}},warnings:[{code:"NOTICE"}],edge_coherence:report,activation_snapshot:{edge:report}},edge_coherence:{coherent:true,attempts:1,report},repo:{status:"failed",first_push_error:"backup unavailable"}}};
 const view = prepareWorkflowOutput(value,"/unused",{storeDetails:()=>({ref:"detail",next_action:{type:"expand_result"}})}) as any;
 assert.equal(view.result.deploy.release_id,"rel_1");assert.equal(view.result.repo.first_push_error,"backup unavailable");assert.equal(view.result.edge_coherence.coherent,true);
 assert.equal(view.result.deploy.activation_snapshot,undefined);assert.equal(view.result.deploy.edge_coherence,undefined);
 assert.ok(JSON.stringify(view).length<4000);assert.equal(view.result.deploy.warnings[0].code,"NOTICE");
});
