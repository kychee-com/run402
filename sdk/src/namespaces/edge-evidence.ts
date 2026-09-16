import type { EdgeBlock, EdgeCoherenceReport } from "./deploy.types.js";

/** Conservatively interpret evidence from both current and older gateways. */
export function normalizeEdgeEvidence(report: EdgeCoherenceReport): EdgeCoherenceReport {
  const paths = report.paths.map((path) => {
    const identity = path.observed_release_id === path.expected_release_id
      && path.observed_release_generation === path.expected_release_generation;
    const hash = !!path.expected_sha256 && !!path.observed_sha256
      && path.expected_sha256 === path.observed_sha256;
    const conflict = !!path.expected_sha256 && !!path.observed_sha256
      && path.expected_sha256 !== path.observed_sha256;
    const basis = path.verification_basis ?? (path.observed_confidence === "identity"
      ? "release_identity" : path.observed_confidence === "body_hash" ? "content_hash" : "weak_metadata");
    const strong = basis === "release_identity" ? identity : basis === "content_hash" ? hash : false;
    if (path.state === "coherent" && (conflict || !strong)) {
      return { ...path, verification_basis: basis,
        state: conflict ? "error" as const : "unknown" as const,
        error: conflict ? "Conflicting release identity and content hash evidence." : "Strong verification evidence is unavailable." };
    }
    return { ...path, verification_basis: basis };
  });
  const noMutable = (report.verification_basis ?? report.probe_basis) === "no_mutable_paths"
    && report.total_path_count === 0 && paths.length === 0;
  const coherent = report.coherent && (noMutable || (paths.length > 0 && paths.every(p => p.state === "coherent")));
  return { ...report, paths, coherent,
    pending_count: Math.max(report.pending_count, paths.filter(p => p.state !== "coherent").length) };
}

/** Replace activation-time status with the latest verification; keep history explicit. */
export function mergeEdgeVerification<T extends { edge?: EdgeBlock }>(deploy: T, raw: EdgeCoherenceReport) {
  const report = normalizeEdgeEvidence(raw);
  const receivedAt = new Date().toISOString();
  const state: EdgeBlock["state"] = report.coherent ? "coherent" : report.paths.some(p => p.state === "stale_prior_release") ? "converging" : "unknown";
  return { ...deploy,
    ...(deploy.edge ? { activation_snapshot: { edge: deploy.edge, checked_at: deploy.edge.checked_at ?? null } } : {}),
    edge: { ...deploy.edge, state, pointer_updates: report.pointer_updates,
      checked_at: report.checked_at ?? null, received_at: receivedAt },
    edge_coherence: report,
  };
}
