/**
 * Backfill tags on existing published apps via the admin API.
 * Requires service_key for each project that owns the published version.
 *
 * Since we don't have service keys for old projects, this script
 * re-publishes with tags by using the admin faucet + deploy flow.
 *
 * Actually — the published versions reference project_ids that may still be active
 * (pinned). We need to call PATCH /admin/v1/projects/:id/versions/:versionId
 * with the project's service_key. But we don't have the service keys stored.
 *
 * Simplest approach: delete old test versions and re-run publish-demos.ts with tags.
 */
import { config } from "dotenv";
config();

const BASE_URL = process.env.BASE_URL || "https://api.run402.com";

async function main() {
  console.log("=== Check Published Apps ===\n");

  const res = await fetch(`${BASE_URL}/v1/apps`);
  const data = await res.json();
  const apps = data.apps || [];

  console.log(`Found ${apps.length} published apps:\n`);
  for (const app of apps) {
    const tags = app.tags || [];
    console.log(`  ${app.name} (${app.id}) — ${app.table_count} tables, tags: [${tags.join(", ")}]`);
  }

  console.log("\nTo add tags, re-run publish-demos.ts (it now includes tags).");
  console.log("Old test versions (fork-debug, fork-test) can be cleaned up via DB.");
}

main().catch(err => { console.error("Error:", err); process.exit(1); });
