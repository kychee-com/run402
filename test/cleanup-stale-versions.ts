/**
 * Clean up stale published versions via admin endpoint.
 * Keeps only the newest version of each curated app name.
 */
import { config } from "dotenv";
config();

const BASE_URL = process.env.BASE_URL || "https://api.run402.com";
const ADMIN_KEY = process.env.ADMIN_KEY || "";

const KEEP_NAMES = new Set(["todo-starter", "guestbook", "link-board", "inventory-tracker"]);

async function main() {
  if (!ADMIN_KEY) {
    console.error("Missing ADMIN_KEY in .env");
    process.exit(1);
  }

  console.log("=== Cleanup Stale Versions ===\n");

  const res = await fetch(`${BASE_URL}/v1/apps`);
  const data = await res.json();
  const apps = data.apps || [];

  console.log(`Found ${apps.length} published versions\n`);

  const seen = new Set<string>();
  let deleted = 0;

  for (const app of apps) {
    if (KEEP_NAMES.has(app.name) && !seen.has(app.name)) {
      seen.add(app.name);
      console.log(`  KEEP: ${app.name} (${app.id}) [${(app.tags || []).join(", ")}]`);
      continue;
    }

    // Delete this version
    console.log(`  DELETE: ${app.name} (${app.id})`);
    // Need a valid service_key for the admin route — but admin/v1/app-versions uses admin key only
    const delRes = await fetch(`${BASE_URL}/v1/admin/app-versions/${app.id}`, {
      method: "DELETE",
      headers: { "X-Admin-Key": ADMIN_KEY },
    });
    if (delRes.ok) {
      deleted++;
    } else {
      console.error(`    Failed: ${delRes.status} ${await delRes.text()}`);
    }
  }

  console.log(`\nDeleted ${deleted} stale versions`);

  // Verify
  const verifyRes = await fetch(`${BASE_URL}/v1/apps`);
  const verifyData = await verifyRes.json();
  console.log(`Remaining: ${verifyData.total} published apps`);
  for (const app of verifyData.apps) {
    console.log(`  ${app.name}: [${(app.tags || []).join(", ")}]`);
  }
}

main().catch(err => { console.error("Error:", err.message || err); process.exit(1); });
