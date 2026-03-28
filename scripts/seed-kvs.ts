/**
 * One-time KVS seed script — reads all subdomain→deployment_id mappings
 * from the database and populates the CloudFront KeyValueStore.
 *
 * Usage:
 *   CLOUDFRONT_KVS_ARN=arn:aws:... DATABASE_URL=postgres://... npx tsx scripts/seed-kvs.ts
 *
 * Or with AWS profile:
 *   AWS_PROFILE=kychee CLOUDFRONT_KVS_ARN=arn:aws:... DATABASE_URL=postgres://... npx tsx scripts/seed-kvs.ts
 */

import {
  CloudFrontKeyValueStoreClient,
  DescribeKeyValueStoreCommand,
  PutKeyCommand,
  ListKeysCommand,
} from "@aws-sdk/client-cloudfront-keyvaluestore";
import pg from "pg";

const KVS_ARN = process.env.CLOUDFRONT_KVS_ARN;
const DATABASE_URL = process.env.DATABASE_URL;

if (!KVS_ARN) {
  console.error("Missing CLOUDFRONT_KVS_ARN");
  process.exit(1);
}
if (!DATABASE_URL) {
  console.error("Missing DATABASE_URL");
  process.exit(1);
}

const kvsClient = new CloudFrontKeyValueStoreClient({ region: "us-east-1" });
const pgPool = new pg.Pool({ connectionString: DATABASE_URL });

async function main() {
  console.log("Seeding KVS from database...\n");

  // 1. Read all subdomain mappings from DB
  const dbResult = await pgPool.query(
    "SELECT name, deployment_id FROM internal.subdomains ORDER BY name",
  );
  console.log(`Database: ${dbResult.rows.length} subdomain(s)`);

  // 2. Read existing KVS entries
  const existing = new Map<string, string>();
  let nextToken: string | undefined;
  do {
    const res = await kvsClient.send(
      new ListKeysCommand({ KvsARN: KVS_ARN, NextToken: nextToken }),
    );
    for (const item of res.Items || []) {
      existing.set(item.Key!, item.Value!);
    }
    nextToken = res.NextToken;
  } while (nextToken);
  console.log(`KVS: ${existing.size} existing entry/entries\n`);

  // 3. Get current ETag
  const descRes = await kvsClient.send(
    new DescribeKeyValueStoreCommand({ KvsARN: KVS_ARN }),
  );
  let etag = descRes.ETag!;

  // 4. Put each mapping
  let added = 0;
  let skipped = 0;
  for (const row of dbResult.rows) {
    const name = row.name as string;
    const deploymentId = row.deployment_id as string;

    if (existing.get(name) === deploymentId) {
      skipped++;
      continue;
    }

    try {
      const res = await kvsClient.send(
        new PutKeyCommand({
          KvsARN: KVS_ARN,
          Key: name,
          Value: deploymentId,
          IfMatch: etag,
        }),
      );
      etag = res.ETag!;
      added++;
      console.log(`  + ${name} → ${deploymentId}`);
    } catch (err) {
      console.error(
        `  ✗ ${name}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  console.log(`\nDone: ${added} added, ${skipped} skipped (already correct)`);

  await pgPool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
