/**
 * CloudFront KeyValueStore sync — keeps edge subdomain→deployment_id mappings
 * in sync with the database.
 *
 * The KVS is read by a CloudFront Function at the edge to route asset requests
 * to the correct S3 prefix. The gateway updates it on subdomain mutations.
 *
 * Write-through: every subdomain claim/delete updates KVS immediately.
 * Reconciliation: a periodic job diffs DB vs KVS and corrects drift.
 */

import {
  CloudFrontKeyValueStoreClient,
  DescribeKeyValueStoreCommand,
  PutKeyCommand,
  DeleteKeyCommand,
  ListKeysCommand,
} from "@aws-sdk/client-cloudfront-keyvaluestore";
import {
  CloudFrontClient,
  CreateInvalidationCommand,
} from "@aws-sdk/client-cloudfront";
// SigV4a is required for CloudFront KVS API — import to ensure it's available
import "@aws-sdk/signature-v4a";

// Read directly from env to avoid circular mock issues in tests
const CLOUDFRONT_KVS_ARN = process.env.CLOUDFRONT_KVS_ARN || "";
const CLOUDFRONT_DISTRIBUTION_ID = process.env.CLOUDFRONT_CUSTOM_DISTRIBUTION_ID || "";
import { pool } from "../db/pool.js";
import { sql } from "../db/sql.js";

const kvsClient = CLOUDFRONT_KVS_ARN
  ? new CloudFrontKeyValueStoreClient({ region: "us-east-1" })
  : null;

const cfClient = CLOUDFRONT_DISTRIBUTION_ID
  ? new CloudFrontClient({ region: "us-east-1" })
  : null;

/** Current ETag for the KVS (required for mutations). */
let currentETag: string | undefined;

async function getETag(): Promise<string> {
  if (currentETag) return currentETag;
  if (!kvsClient) throw new Error("KVS not configured");

  const res = await kvsClient.send(
    new DescribeKeyValueStoreCommand({ KvsARN: CLOUDFRONT_KVS_ARN }),
  );
  currentETag = res.ETag!;
  return currentETag;
}

/**
 * Put a subdomain → deployment_id mapping in the KVS.
 * Fire-and-forget: logs errors but does not throw.
 */
export async function kvsPut(
  name: string,
  deploymentId: string,
): Promise<void> {
  if (!kvsClient) return;
  try {
    const etag = await getETag();
    const res = await kvsClient.send(
      new PutKeyCommand({
        KvsARN: CLOUDFRONT_KVS_ARN,
        Key: name,
        Value: deploymentId,
        IfMatch: etag,
      }),
    );
    currentETag = res.ETag;
  } catch (err) {
    currentETag = undefined; // force refresh on next call
    console.error(
      `KVS put failed (${name} → ${deploymentId}):`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Delete a subdomain mapping from the KVS.
 * Fire-and-forget: logs errors but does not throw.
 */
export async function kvsDelete(name: string): Promise<void> {
  if (!kvsClient) return;
  try {
    const etag = await getETag();
    const res = await kvsClient.send(
      new DeleteKeyCommand({
        KvsARN: CLOUDFRONT_KVS_ARN,
        Key: name,
        IfMatch: etag,
      }),
    );
    currentETag = res.ETag;
  } catch (err) {
    currentETag = undefined;
    // Key not found is fine (idempotent delete)
    const code = (err as { name?: string }).name;
    if (code === "ResourceNotFoundException") return;
    console.error(
      `KVS delete failed (${name}):`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Invalidate CloudFront edge cache for a custom subdomain.
 * Called on subdomain reassignment so redeployed assets are served immediately.
 * Fire-and-forget: logs errors but does not throw.
 */
export async function cfInvalidate(subdomain: string): Promise<void> {
  if (!cfClient) return;
  try {
    await cfClient.send(
      new CreateInvalidationCommand({
        DistributionId: CLOUDFRONT_DISTRIBUTION_ID,
        InvalidationBatch: {
          CallerReference: `${subdomain}-${Date.now()}`,
          Paths: { Quantity: 1, Items: ["/*"] },
        },
      }),
    );
    console.log(`  CloudFront invalidation created for ${subdomain}`);
  } catch (err) {
    console.error(
      `CloudFront invalidation failed (${subdomain}):`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Reconcile KVS with the database. Runs periodically to fix drift.
 *
 * - Adds missing entries (DB has, KVS doesn't)
 * - Updates stale entries (DB and KVS disagree on deployment_id)
 * - Removes orphaned entries (KVS has, DB doesn't)
 */
export async function kvsReconcile(): Promise<void> {
  if (!kvsClient) return;

  try {
    // 1. Load all DB mappings
    const dbResult = await pool.query(
      sql(`SELECT name, deployment_id FROM internal.subdomains`),
    );
    const dbMap = new Map<string, string>();
    for (const row of dbResult.rows) {
      dbMap.set(row.name as string, row.deployment_id as string);
    }

    // 2. Load all KVS entries
    const kvsMap = new Map<string, string>();
    let nextToken: string | undefined;
    do {
      const res = await kvsClient.send(
        new ListKeysCommand({
          KvsARN: CLOUDFRONT_KVS_ARN,
          NextToken: nextToken,
        }),
      );
      for (const item of res.Items || []) {
        kvsMap.set(item.Key!, item.Value!);
      }
      nextToken = res.NextToken;
    } while (nextToken);

    let added = 0;
    let updated = 0;
    let removed = 0;

    // 3. Add missing / update stale
    for (const [name, deploymentId] of dbMap) {
      const kvsValue = kvsMap.get(name);
      if (!kvsValue) {
        await kvsPut(name, deploymentId);
        added++;
      } else if (kvsValue !== deploymentId) {
        await kvsPut(name, deploymentId);
        updated++;
      }
    }

    // 4. Remove orphaned
    for (const [name] of kvsMap) {
      if (!dbMap.has(name)) {
        await kvsDelete(name);
        removed++;
      }
    }

    const total = added + updated + removed;
    if (total > 0) {
      console.log(
        `KVS reconciliation: ${added} added, ${updated} updated, ${removed} removed`,
      );
    }
  } catch (err) {
    console.error(
      "KVS reconciliation failed:",
      err instanceof Error ? err.message : err,
    );
  }
}

// ---------- Periodic reconciliation ----------

const RECONCILE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
let reconcileTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start the periodic reconciliation loop. Call once at startup.
 */
export function startKvsReconciliation(): void {
  if (!kvsClient) return;
  if (reconcileTimer) return;

  // Run initial reconciliation after a short delay (let server finish starting)
  setTimeout(() => kvsReconcile(), 10_000);

  reconcileTimer = setInterval(() => kvsReconcile(), RECONCILE_INTERVAL_MS);
  console.log("KVS reconciliation started (every 5 minutes)");
}
