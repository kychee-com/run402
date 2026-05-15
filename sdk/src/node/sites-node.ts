/**
 * Node-only `sites.deployDir` convenience.
 *
 * **As of v1.34, this is a thin wrapper over `r.deploy.apply`** — bytes ride
 * through the unified CAS substrate, the deploy flows through the v2 plan/
 * commit endpoints, and the agent-observable result remains a
 * {@link SiteDeployResult}. Existing callers keep their input shape
 * (`{ project, dir, onEvent? }`), and `onEvent` receives the unified
 * `DeployEvent` shapes from the SDK's `deploy` namespace. The old `target`
 * option is still typed for compatibility, but unified deploy v2 does not
 * support target labels and passing one throws a `LocalError`.
 *
 * Imports `node:fs/promises` via `fileSetFromDir`, so this module remains
 * Node-only — V8 isolates use `r.deploy.apply` with in-memory byte sources.
 */

import { Sites, type SiteDeployResult } from "../namespaces/sites.js";
import { Deploy } from "../namespaces/deploy.js";
import { LocalError } from "../errors.js";
import type { Client } from "../kernel.js";
import type {
  ContentRef,
  DeployEvent as UnifiedDeployEvent,
} from "../namespaces/deploy.types.js";
import { summarizeDeployResult } from "../namespaces/deploy.types.js";
import { fileSetFromDir } from "./files.js";

export interface DeployDirOptions {
  /** Project ID the deployment is linked to. */
  project: string;
  /** Local directory to walk. Paths in the manifest are relative to this root. */
  dir: string;
  /**
   * @deprecated Unsupported by unified deploy v2. Passing this option throws
   * a `LocalError` so it is not silently ignored.
   */
  target?: string;
  /**
   * Optional progress callback. Errors thrown synchronously are caught and
   * dropped — a buggy consumer cannot abort the deploy.
   */
  onEvent?: (event: DeployEvent) => void;
}

export type DeployEvent = UnifiedDeployEvent;

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
    if (opts.target !== undefined) {
      throw new LocalError(
        "`sites.deployDir({ target })` is unsupported by unified deploy v2 and would otherwise be ignored.",
        "deploying site directory",
      );
    }

    const fileSet = await fileSetFromDir(opts.dir);
    const deploy = new Deploy(
      (this as unknown as { client: Client }).client,
    );

    const result = await deploy.apply(
      { project: opts.project, site: { replace: fileSet } },
      { onEvent: makeSafeEventForwarder(opts.onEvent) },
    );

    const out: SiteDeployResult = {
      deployment_id: pickFromUrls(result.urls, "deployment_id") ?? result.release_id,
      // v2 commit returns `urls = { project, release }` — no `site` key. Use
      // the live project URL as the canonical `url` for the legacy result
      // shape; fall back to `urls.site` for forward compat with any gateway
      // build that resurrects the old key, and `""` only as a last resort
      // (matches prior behaviour). See bug GH-130.
      url:
        pickFromUrls(result.urls, "project") ??
        pickFromUrls(result.urls, "site") ??
        "",
    };
    const summary = summarizeDeployResult(result);
    const cas = summary.site?.cas;
    if (
      typeof cas?.newly_uploaded_bytes === "number" &&
      typeof cas.reused_bytes === "number"
    ) {
      out.bytes_uploaded = cas.newly_uploaded_bytes;
      out.bytes_total = cas.newly_uploaded_bytes + cas.reused_bytes;
    }
    return out;
  }
}

function makeSafeEventForwarder(
  consumer: ((event: DeployEvent) => void) | undefined,
): (event: UnifiedDeployEvent) => void {
  if (!consumer) return () => {};
  return (event) => {
    try {
      consumer(event);
    } catch {
      /* swallow — buggy consumer must not abort the deploy */
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

// ─── Internal types ──────────────────────────────────────────────────────────
export type { ContentRef };
