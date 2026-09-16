import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeEdgeEvidence, mergeEdgeVerification } from "./edge-evidence.js";
import type { EdgeCoherenceReport } from "./deploy.types.js";
const report = (overrides: Partial<EdgeCoherenceReport> = {}): EdgeCoherenceReport => ({
  coherent: true, operation_id: "op_test", project_id: "prj_test", release_id: "rel_test", release_generation: 1,
  paths: [{ path: "/", host: "example.test", state: "coherent", observed_confidence: "identity",
    expected_release_id: "rel_test", observed_release_id: "rel_test", expected_release_generation: 1,
    observed_release_generation: 1, expected_sha256: "abc", observed_sha256: null, status: 200 }],
  pending_count: 0, paths_truncated: false, path_count: 1, total_path_count: 1, vantage: "gateway",
  probe_may_have_warmed_cache: true, pointer_updates: { kvs: undefined, cloudflare_kv: undefined, cloudfront_invalidation: undefined },
  next_actions: [], ...overrides,
});
test("older identity-only reports preserve null hash and unknown server timestamp", () => {
  const result = mergeEdgeVerification({ edge: { state: "converging" as const, pointer_updates: report().pointer_updates } }, report());
  assert.equal(result.edge.state, "coherent");
  assert.equal(result.edge_coherence.paths[0].observed_sha256, null);
  assert.equal(result.edge_coherence.paths[0].verification_basis, "release_identity");
  assert.equal(result.activation_snapshot?.checked_at, null);
  assert.equal(result.edge.checked_at, null);
  assert.ok(result.edge.received_at);
});
test("weak-only legacy coherence is inconclusive; contradictory hash fails", () => {
  const weak = report(); weak.paths[0].observed_confidence = "weak";
  assert.equal(normalizeEdgeEvidence(weak).coherent, false);
  assert.equal(normalizeEdgeEvidence(weak).paths[0].state, "unknown");
  const bad = report(); bad.paths[0].observed_sha256 = "wrong";
  assert.equal(normalizeEdgeEvidence(bad).coherent, false);
  assert.equal(normalizeEdgeEvidence(bad).paths[0].state, "error");
});
test("matching content hash and explicit empty probe basis are strong evidence", () => {
  const hash = report(); hash.paths[0].observed_confidence = "body_hash"; hash.paths[0].observed_sha256 = "abc";
  assert.equal(normalizeEdgeEvidence(hash).coherent, true);
  assert.equal(normalizeEdgeEvidence(report({ paths: [], path_count: 0, total_path_count: 0 })).coherent, false);
  assert.equal(normalizeEdgeEvidence(report({ paths: [], path_count: 0, total_path_count: 0, probe_basis: "no_mutable_paths" })).coherent, true);
});
