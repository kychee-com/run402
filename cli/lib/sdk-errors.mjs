/**
 * CLI-side SDK error translator.
 *
 * Maps SDK `Run402Error` subclasses into the CLI's existing error output
 * format: `{status: "error", http: ?, ...bodyFields}` on stderr, `process.exit(1)`.
 * Preserves specific behaviors:
 *   - `ProjectNotFound` → plain-text "Project <id> not found in local registry"
 *     with the "Hint: project IDs start with prj_" guidance when the id
 *     doesn't start with `prj_`.
 *   - HTML / non-JSON error bodies → `body_preview` field (first 500 chars),
 *     matching GH-84 behavior.
 *   - Network errors → `{status: "error", message: "..."}`.
 */

export function reportSdkError(err) {
  if (err?.name === "ProjectNotFound") {
    const id = err.projectId || "";
    const hint = id && !String(id).startsWith("prj_")
      ? ` Hint: project IDs start with "prj_". Check that the argument order is <project_id> <name>.`
      : "";
    console.error(`Project ${id} not found in local registry.${hint}`);
    process.exit(1);
  }

  const payload = { status: "error" };

  if (err?.status !== undefined && err?.status !== null) {
    payload.http = err.status;
    if (err.body && typeof err.body === "object") {
      Object.assign(payload, err.body);
    } else if (typeof err.body === "string") {
      payload.body_preview = err.body.slice(0, 500);
    }
  } else {
    payload.message = err?.message || String(err);
  }

  // Keep `status: "error"` as the outer envelope even if the response body
  // happened to contain its own `status` field (e.g. `{"status":"degraded"}`
  // from /health 503 responses). Downstream scripts match on this sentinel.
  payload.status = "error";

  console.error(JSON.stringify(payload));
  process.exit(1);
}
