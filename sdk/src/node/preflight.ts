import type { ContentSource, ReleaseSpec } from "../namespaces/deploy.types.js";
import { guessContentType } from "../namespaces/deploy.js";
import { collectLocalFileReferences, collectAuthoringFileReferences } from "./deploy-manifest.js";
import { scanDeploymentSources } from "./source-scan.js";

/**
 * The content type a site entry will ship with: an explicit `contentType`
 * on a wrapper, `FsFileSource` or `ContentRef` wins; otherwise the path's
 * extension decides, exactly as the deploy planner infers it.
 */
function siteEntryContentType(path: string, source: ContentSource): string {
  if (source && typeof source === "object" && !(source instanceof Uint8Array) && !(source instanceof ArrayBuffer)) {
    const explicit = (source as { contentType?: unknown }).contentType;
    if (typeof explicit === "string" && explicit.length > 0) return explicit;
  }
  return guessContentType(path);
}

/**
 * `summary.site` for `--check`: how many paths the site slice ships and a
 * per-content-type tally, so "can I ship a .webp?" is answered by the
 * preflight rather than by reading the SDK.
 */
export function summarizeSiteInventory(spec: Partial<ReleaseSpec>): { paths: number; by_content_type: Record<string, number> } {
  const entries = spec.site?.replace ?? spec.site?.patch?.put ?? {};
  const by_content_type: Record<string, number> = {};
  for (const [path, source] of Object.entries(entries)) {
    const type = siteEntryContentType(path, source as ContentSource);
    by_content_type[type] = (by_content_type[type] ?? 0) + 1;
  }
  const sorted = Object.fromEntries(Object.entries(by_content_type).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return { paths: Object.keys(entries).length, by_content_type: sorted };
}

export interface LocalPreflightTarget {
  project_id: string | null;
  project_name: string | null;
  source: "explicit" | "workspace_link" | "manifest" | "create" | "unresolved";
}

export function describeLocalPreflight(input: {
  appRoot: string; manifestPath: string | null; spec?: Partial<ReleaseSpec>; authoring?: unknown;
  entryPoint?: "up" | "deploy apply"; target: LocalPreflightTarget; buildDeferred?: boolean; apiBase?: string; profile?: string;
}) {
  const spec = input.spec ?? {};
  const refs = input.authoring ? collectAuthoringFileReferences(input.authoring, input.appRoot) : collectLocalFileReferences(spec);
  const scan = scanDeploymentSources(spec, input.appRoot);
  const warningRoutes = (spec.routes?.replace ?? []).filter((route) => route.target.type === "function" && spec.functions?.replace && !spec.functions.replace[route.target.name]);
  const checks = [
    { name: "manifest", status: "passed", scope: input.manifestPath, evidence_count: 1 },
    { name: "target_agreement", status: "passed", scope: input.appRoot, evidence_count: input.target.project_id ? 1 : 0 },
    { name: "file_references", status: input.buildDeferred ? "deferred" : "passed", scope: input.appRoot, evidence_count: input.buildDeferred ? 0 : refs.length, ...(input.buildDeferred ? { reason: "Build commands may produce these files. No build was executed." } : {}) },
    { name: "source_scan", status: process.env.RUN402_DEPLOY_SKIP_SCAN === "1" ? "skipped" : "passed", scope: scan.scan_root, evidence_count: scan.checked_files, reason: process.env.RUN402_DEPLOY_SKIP_SCAN === "1" ? "Explicit RUN402_DEPLOY_SKIP_SCAN override." : "Selected application source and explicit file references; unrelated applications excluded." },
    ...["remote_policy", "quota", "cost", "secret_existence", "migration_registry", "content_presence", "base_release_drift"].map((name) => ({ name, status: "deferred", scope: "gateway", evidence_count: 0, reason: "Requires gateway --plan review." })),
  ];
  return {
    app_root: input.appRoot, manifest_path: input.manifestPath, gateway_validated: false as const,
    target: { ...input.target, api_base: input.apiBase ?? null, profile: input.profile ?? null }, checks,
    warnings: [...scan.findings.filter((finding) => finding.severity !== "error"), ...warningRoutes.map((route) => ({ code: "LOCAL_ROUTE_TARGET_UNDECLARED", message: "Route references a function absent from functions.replace; review this target.", pattern: route.pattern }))],
    summary: { file_references: input.buildDeferred ? null : refs.length, site: summarizeSiteInventory(spec), functions: Object.keys(spec.functions?.replace ?? spec.functions?.patch?.set ?? {}).length, migrations: spec.database?.migrations?.length ?? 0, routes: spec.routes?.replace?.length ?? 0 },
    next_actions: input.target.project_id ? [{ type: "review_plan", ...(input.manifestPath ? { argv: ["run402", ...(input.entryPoint === "deploy apply" ? ["deploy", "apply"] : ["up"]), "--manifest", input.manifestPath, "--project", input.target.project_id, "--plan"] } : { sdk_call: "project(project_id).apply.plan(spec)" }), why: "Review gateway-authoritative policy, cost and current state." }] : [{ type: "select_project", safe_to_auto_execute: false, why: input.target.source === "create" ? "Create intent is selected; the new project must exist before gateway plan review." : "Choose an existing project or an explicit new-project name before deploying." }],
  };
}
