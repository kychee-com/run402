import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

/**
 * MCP release observability tools. These wrap read-only apikey-gated SDK
 * calls; unlike deploy apply/resume/list/events, they do not preflight wallet
 * allowance auth.
 */

export const deployReleaseGetSchema = {
  project_id: z
    .string()
    .describe("Project ID that owns the release."),
  release_id: z
    .string()
    .describe("Release ID to inspect, e.g. rel_..."),
  site_limit: z
    .number()
    .int()
    .positive()
    .max(25_000)
    .optional()
    .describe("Maximum site path entries to include. Gateway default: 5000."),
};

export const deployReleaseActiveSchema = {
  project_id: z
    .string()
    .describe("Project ID to inspect."),
  site_limit: z
    .number()
    .int()
    .positive()
    .max(25_000)
    .optional()
    .describe("Maximum site path entries to include. Gateway default: 5000."),
};

export const deployReleaseDiffSchema = {
  project_id: z
    .string()
    .describe("Project ID to inspect."),
  from: z
    .string()
    .describe("Diff source target: empty, active, or a release id."),
  to: z
    .string()
    .describe("Diff target: active or a release id."),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Maximum entries per site diff bucket. Gateway default: 1000."),
};

export async function handleDeployReleaseGet(args: {
  project_id: string;
  release_id: string;
  site_limit?: number;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const release = await getSdk().deploy.getRelease({
      project: args.project_id,
      releaseId: args.release_id,
      siteLimit: args.site_limit,
    });
    return {
      content: [
        { type: "text", text: formatInventory("Release Inventory", release) },
        { type: "text", text: jsonSection("Release", release) },
      ],
    };
  } catch (err) {
    return mapSdkError(err, "fetching release inventory");
  }
}

export async function handleDeployReleaseActive(args: {
  project_id: string;
  site_limit?: number;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const release = await getSdk().deploy.getActiveRelease({
      project: args.project_id,
      siteLimit: args.site_limit,
    });
    return {
      content: [
        { type: "text", text: formatInventory("Active Release Inventory", release) },
        { type: "text", text: jsonSection("Release", release) },
      ],
    };
  } catch (err) {
    return mapSdkError(err, "fetching active release inventory");
  }
}

export async function handleDeployReleaseDiff(args: {
  project_id: string;
  from: string;
  to: string;
  limit?: number;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const diff = await getSdk().deploy.diff({
      project: args.project_id,
      from: args.from,
      to: args.to,
      limit: args.limit,
    });
    return {
      content: [
        { type: "text", text: formatDiff(diff) },
        { type: "text", text: jsonSection("Diff", diff) },
      ],
    };
  } catch (err) {
    return mapSdkError(err, "diffing releases");
  }
}

function formatInventory(title: string, release: {
  release_id: string | null;
  project_id: string;
  status: string | null;
  state_kind: string;
  effective: boolean;
  site: { paths: unknown[]; totals?: { paths?: number } };
  functions: unknown[];
  secrets: { keys: string[] };
  subdomains: { names: string[] };
  routes?: { entries?: unknown[] };
  migrations_applied: unknown[];
  warnings?: unknown[];
  events_url: string | null;
  release_generation?: number | null;
  static_manifest_sha256?: string | null;
  static_manifest_metadata?: { file_count?: number; total_bytes?: number } | null;
}): string {
  const siteTotal = release.site.totals?.paths ?? release.site.paths.length;
  const routeCount = Array.isArray(release.routes?.entries) ? release.routes.entries.length : 0;
  return [
    `## ${title}`,
    ``,
    `| Field | Value |`,
    `|-------|-------|`,
    `| project_id | \`${release.project_id}\` |`,
    `| release_id | ${release.release_id ? `\`${release.release_id}\`` : "none"} |`,
    `| status | ${release.status ?? "none"} |`,
    `| state_kind | ${release.state_kind} |`,
    `| effective | ${release.effective ? "true" : "false"} |`,
    `| release_generation | ${release.release_generation ?? "none"} |`,
    `| static_manifest_sha256 | ${release.static_manifest_sha256 ? `\`${release.static_manifest_sha256}\`` : "none"} |`,
    `| static_manifest_files_bytes | ${release.static_manifest_metadata ? `${release.static_manifest_metadata.file_count ?? 0}/${release.static_manifest_metadata.total_bytes ?? 0}` : "metadata unavailable"} |`,
    `| site_paths_returned | ${release.site.paths.length} |`,
    `| site_paths_total | ${siteTotal} |`,
    `| functions | ${release.functions.length} |`,
    `| secrets | ${release.secrets.keys.length} keys |`,
    `| subdomains | ${release.subdomains.names.length} |`,
    `| routes | ${routeCount} |`,
    `| migrations_applied | ${release.migrations_applied.length} |`,
    `| warnings | ${release.warnings?.length ?? 0} |`,
    `| events_url | ${release.events_url ? `\`${release.events_url}\`` : "none"} |`,
  ].join("\n");
}

function formatDiff(diff: {
  from_release_id: string | null;
  to_release_id: string | null;
  summary: string;
  is_noop: boolean;
  warnings: unknown[];
  migrations: { applied_between_releases: string[] };
  site: { added: unknown[]; removed: unknown[]; changed: unknown[] };
  functions: { added: unknown[]; removed: unknown[]; changed: unknown[] };
  secrets: { added: unknown[]; removed: unknown[] };
  subdomains: { added: unknown[]; removed: unknown[] };
  routes?: { added: unknown[]; removed: unknown[]; changed: unknown[] };
  static_assets?: {
    unchanged?: number;
    changed?: number;
    added?: number;
    removed?: number;
    newly_uploaded_cas_bytes?: number;
    reused_cas_bytes?: number;
    deployment_copy_bytes_eliminated?: number;
    legacy_immutable_warnings?: unknown[];
    previous_immutable_failures?: unknown[];
    cas_authorization_failures?: unknown[];
  };
}): string {
  const routeDiff = diff.routes ?? { added: [], removed: [], changed: [] };
  const staticAssets = diff.static_assets;
  return [
    `## Release Diff`,
    ``,
    `| Field | Value |`,
    `|-------|-------|`,
    `| from_release_id | ${diff.from_release_id ? `\`${diff.from_release_id}\`` : "none"} |`,
    `| to_release_id | ${diff.to_release_id ? `\`${diff.to_release_id}\`` : "none"} |`,
    `| is_noop | ${diff.is_noop ? "true" : "false"} |`,
    `| summary | ${diff.summary} |`,
    `| warnings | ${diff.warnings.length} |`,
    `| migrations_applied_between_releases | ${diff.migrations.applied_between_releases.length} |`,
    `| site_added_removed_changed | ${diff.site.added.length}/${diff.site.removed.length}/${diff.site.changed.length} |`,
    `| functions_added_removed_changed | ${diff.functions.added.length}/${diff.functions.removed.length}/${diff.functions.changed.length} |`,
    `| secrets_added_removed | ${diff.secrets.added.length}/${diff.secrets.removed.length} |`,
    `| subdomains_added_removed | ${diff.subdomains.added.length}/${diff.subdomains.removed.length} |`,
    `| routes_added_removed_changed | ${routeDiff.added.length}/${routeDiff.removed.length}/${routeDiff.changed.length} |`,
    `| static_assets_unchanged_changed_added_removed | ${staticAssets ? `${staticAssets.unchanged ?? 0}/${staticAssets.changed ?? 0}/${staticAssets.added ?? 0}/${staticAssets.removed ?? 0}` : "not returned"} |`,
    `| static_assets_cas_bytes_new_reused_eliminated | ${staticAssets ? `${staticAssets.newly_uploaded_cas_bytes ?? 0}/${staticAssets.reused_cas_bytes ?? 0}/${staticAssets.deployment_copy_bytes_eliminated ?? 0}` : "not returned"} |`,
    `| static_assets_warning_counts | ${staticAssets ? `${staticAssets.legacy_immutable_warnings?.length ?? 0}/${staticAssets.previous_immutable_failures?.length ?? 0}/${staticAssets.cas_authorization_failures?.length ?? 0}` : "not returned"} |`,
  ].join("\n");
}

function jsonSection(label: string, value: unknown): string {
  return [`### Raw ${label}`, ``, "```json", JSON.stringify(value, null, 2), "```"].join("\n");
}
