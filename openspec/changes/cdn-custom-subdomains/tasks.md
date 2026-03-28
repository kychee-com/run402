## 1. ACM Certificate

- [x] 1.1 Create ACM certificate for `*.run402.com` in us-east-1 with DNS validation via Route53 hosted zone (CDK in infra)

## 2. CloudFront KeyValueStore

- [x] 2.1 Create CloudFront KeyValueStore resource in CDK
- [x] 2.2 Write a one-time seed script that reads all subdomain→deployment_id mappings from the database and populates the KVS

## 3. CloudFront Function

- [x] 3.1 Write CloudFront Function (JS 2.0) that extracts subdomain from Host header, looks up deployment ID in KVS, and rewrites URI to `sites/{deployment_id}/{path}`. Return 404 if subdomain not found in KVS.
- [x] 3.2 Unit test the CloudFront Function logic (subdomain extraction, URI rewriting, 404 handling)

## 4. CloudFront Distribution

- [x] 4.1 Create CloudFront distribution for `*.run402.com` in CDK with S3 origin (OAC) for asset behavior and ALB origin for default behavior
- [x] 4.2 Configure asset cache behavior: path patterns for static file extensions (`*.css`, `*.js`, `*.png`, `*.jpg`, `*.gif`, `*.svg`, `*.ico`, `*.woff`, `*.woff2`, `*.webp`, `*.map`), associate CloudFront Function on viewer-request, use CACHING_OPTIMIZED policy
- [x] 4.3 Configure default cache behavior: ALB origin, CachingDisabled policy (or short TTL), forward Host header
- [x] 4.4 Attach ACM certificate and set `*.run402.com` as alternate domain name

## 5. Gateway KVS Sync

- [x] 5.1 Add AWS CloudFront KeyValueStore SDK client to gateway (or use `@aws-sdk/client-cloudfront-keyvaluestore`)
- [x] 5.2 Add KVS put call to `createOrUpdateSubdomain()` after database upsert — fire-and-forget with error logging
- [x] 5.3 Add KVS delete call to `deleteSubdomain()` after database delete
- [x] 5.4 Add KVS delete calls to `deleteProjectSubdomains()` for each deleted name
- [x] 5.5 Add KVS store ID as config (env var `CLOUDFRONT_KVS_ARN` or similar)

## 6. Reconciliation Job

- [x] 6.1 Implement periodic reconciliation (every 5 minutes) that diffs `internal.subdomains` against KVS entries and corrects drift (add missing, update stale, remove orphaned)
- [x] 6.2 Log drift corrections and count for monitoring

## 7. Gateway Middleware Cleanup

- [x] 7.1 Simplify subdomain middleware: keep HTML serving path (fork badge injection), update asset responses to use short TTL (60s) as fallback for any asset requests that still reach the gateway

## 8. DNS Cutover

- [x] 8.1 Create Route53 wildcard A/AAAA records for `*.run402.com` pointing to the new CloudFront distribution
- [x] 8.2 Verify `api.run402.com` explicit A record takes priority over the wildcard (test with dig/nslookup)

## 9. Testing

- [x] 9.1 E2E test: deploy site, claim subdomain, fetch asset via `{name}.run402.com` — assert immutable cache headers and CloudFront response headers
- [x] 9.2 E2E test: fetch HTML via `{name}.run402.com/` — assert `max-age=60` and fork badge present (if forkable)
- [x] 9.3 E2E test: redeploy site, fetch same asset URL — assert new content served (not stale)
- [x] 9.4 Integration test: claim subdomain, verify KVS entry exists via CloudFront API
- [x] 9.5 Integration test: delete subdomain, verify KVS entry removed
- [x] 9.6 Verify `api.run402.com/health` still resolves to ALB (no CloudFront headers)

## 10. Documentation

- [x] 10.1 Update `llms.txt` and `llms-cli.txt` if any subdomain behavior visible to agents changes
- [x] 10.2 Update `CLAUDE.md` deployment section with CloudFront KVS details
