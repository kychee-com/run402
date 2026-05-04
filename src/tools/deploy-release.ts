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
    const release = await getSdk().deploy.getRelease(args.release_id, {
      project: args.project_id,
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
  migrations_applied: unknown[];
  events_url: string | null;
}): string {
  const siteTotal = release.site.totals?.paths ?? release.site.paths.length;
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
    `| site_paths_returned | ${release.site.paths.length} |`,
    `| site_paths_total | ${siteTotal} |`,
    `| functions | ${release.functions.length} |`,
    `| secrets | ${release.secrets.keys.length} keys |`,
    `| subdomains | ${release.subdomains.names.length} |`,
    `| migrations_applied | ${release.migrations_applied.length} |`,
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
}): string {
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
  ].join("\n");
}

function jsonSection(label: string, value: unknown): string {
  return [`### Raw ${label}`, ``, "```json", JSON.stringify(value, null, 2), "```"].join("\n");
}
