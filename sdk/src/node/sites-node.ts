/**
 * Node-only `sites.deployDir` convenience.
 *
 * **As of v1.34, this is a thin wrapper over `r.deploy.apply`** — bytes ride
 * through the unified CAS substrate, the deploy flows through the v2 plan/
 * commit endpoints, and the agent-observable result remains a
 * {@link SiteDeployResult}. Existing callers keep their input shape
 * (`{ project, dir, target?, onEvent? }`) and their legacy event consumers
 * keep working: the wrapper synthesizes both the unified `DeployEvent`
 * shapes (from the SDK's `deploy` namespace) and the legacy phase events
 * (`{ phase: "plan"|"upload"|"commit"|"poll", ... }`) for the deprecation
 * window.
 *
 * Imports `node:fs/promises` via `fileSetFromDir`, so this module remains
 * Node-only — V8 isolates use `r.deploy.apply` with in-memory byte sources.
 */

import { Sites, type SiteDeployResult } from "../namespaces/sites.js";
import { Deploy } from "../namespaces/deploy.js";
import type { Client } from "../kernel.js";
import type {
  ContentRef,
  DeployEvent as UnifiedDeployEvent,
} from "../namespaces/deploy.types.js";
import { fileSetFromDir } from "./files.js";

export interface DeployDirOptions {
  /** Project ID the deployment is linked to. */
  project: string;
  /** Local directory to walk. Paths in the manifest are relative to this root. */
  dir: string;
  /** Deployment target label, e.g. `"production"`. */
  target?: string;
  /**
   * Optional progress callback. The wrapper invokes it with **both** the
   * legacy phase event shapes (for back-compat with v1.32-era consumers)
   * and the new unified `DeployEvent` shapes from the v2 deploy namespace.
   * Errors thrown synchronously are caught and dropped — a buggy consumer
   * cannot abort the deploy.
   */
  onEvent?: (event: DeployEvent) => void;
}

/**
 * Discriminated union of progress events. The legacy variants (`phase:`)
 * are kept for the v1.32-era event consumers; new code should switch on
 * `type:` and consume the {@link UnifiedDeployEvent} shapes from
 * `@run402/sdk`. The wrapper emits both for the deprecation window.
 */
export type DeployEvent = LegacyDeployEvent | UnifiedDeployEvent;

/** Legacy event shapes preserved for v1.32-era consumers. */
export type LegacyDeployEvent =
  | { phase: "plan"; manifest_size: number }
  | {
      phase: "upload";
      file: string;
      sha256: string;
      done: number;
      total: number;
    }
  | { phase: "commit" }
  | { phase: "poll"; status: string; elapsed_ms: number };

/**
 * Sites namespace enriched with the Node-only `deployDir` convenience.
 * All existing `Sites` methods are inherited unchanged.
 */
export class NodeSites extends Sites {
  /**
   * Deploy every file under `dir` as a static site. Walks the tree (skipping
   * `.git`/`node_modules`/`.DS_Store`, rejecting symlinks), produces an
   * `FsFileSource`-backed `FileSet`, and delegates to `r.deploy.apply` —
   * which uploads only the bytes the gateway doesn't already have, applies
   * the new release atomically, and polls the operation until terminal.
   */
  async deployDir(opts: DeployDirOptions): Promise<SiteDeployResult> {
    const fileSet = await fileSetFromDir(opts.dir);
    const manifestSize = Object.keys(fileSet).length;

    const deploy = new Deploy(
      (this as unknown as { client: Client }).client,
    );

    const synth = makeLegacyEventSynth(opts.onEvent, manifestSize);

    const result = await deploy.apply(
      { project: opts.project, site: { replace: fileSet } },
      { onEvent: synth },
    );

    const out: SiteDeployResult = {
      deployment_id: pickFromUrls(result.urls, "deployment_id") ?? result.release_id,
      url: pickFromUrls(result.urls, "site") ?? "",
    };
    return out;
  }
}

// ─── Legacy event synthesis ──────────────────────────────────────────────────

/**
 * Build a unified-event listener that mirrors the unified events to the
 * caller verbatim AND synthesizes the legacy phase events alongside.
 */
function makeLegacyEventSynth(
  consumer: ((event: DeployEvent) => void) | undefined,
  manifestSize: number,
): (event: UnifiedDeployEvent) => void {
  if (!consumer) return () => {};

  const safe = (e: DeployEvent): void => {
    try {
      consumer(e);
    } catch {
      /* swallow — buggy consumer must not abort the deploy */
    }
  };

  let pollStart: number | null = null;
  let commitEmitted = false;

  return (event) => {
    safe(event);

    switch (event.type) {
      case "plan.diff":
        safe({ phase: "plan", manifest_size: manifestSize });
        break;
      case "content.upload.progress":
        safe({
          phase: "upload",
          file: event.label,
          sha256: event.sha256,
          done: event.done,
          total: event.total,
        });
        break;
      case "commit.phase":
        if (!commitEmitted) {
          commitEmitted = true;
          safe({ phase: "commit" });
        }
        if (
          (event.phase === "schema-settle" ||
            event.phase === "activate" ||
            event.phase === "ready") &&
          event.status === "started"
        ) {
          if (pollStart === null) pollStart = Date.now();
          safe({
            phase: "poll",
            status: event.phase,
            elapsed_ms: Date.now() - pollStart,
          });
        }
        break;
      default:
        break;
    }
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function pickFromUrls(
  urls: Record<string, string> | undefined,
  key: string,
): string | undefined {
  if (!urls) return undefined;
  return urls[key];
}

// ─── Internal types preserved for compatibility ──────────────────────────────
// Re-exported so existing tests / external consumers that import them
// continue to compile during the deprecation window. New code should use the
// `ContentRef` + `FileSet` types from `@run402/sdk`.
export type { ContentRef };
