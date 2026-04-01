## ADDED Requirements

### Requirement: S3 operations use bounded concurrency

All S3 upload (PutObject) and copy (CopyObject) loops in `createDeployment` SHALL execute with bounded concurrency (default limit: 20) rather than sequentially.

#### Scenario: Inherit copy with 700 files
- **WHEN** an inherit deploy copies 700 files from the previous deployment
- **THEN** the copy completes in under 10 seconds (vs ~65 seconds sequential)

#### Scenario: Initial upload of 200 files
- **WHEN** a deploy uploads 200 files to S3
- **THEN** the upload completes in under 5 seconds

#### Scenario: Concurrency is bounded
- **WHEN** a deploy involves 1000+ S3 operations
- **THEN** at most 20 S3 API calls are in-flight concurrently

### Requirement: Per-file retry on transient S3 errors

Each individual S3 PutObject and CopyObject call SHALL be retried up to 2 times on failure before giving up. This handles transient S3 errors (throttling, network hiccups) without failing the entire deployment.

#### Scenario: Transient S3 error on one file out of 500
- **WHEN** the S3 CopyObject call fails once for file 150 out of 500
- **AND** the retry succeeds
- **THEN** the deployment completes successfully with all 500 files

#### Scenario: Persistent S3 error after retries
- **WHEN** the S3 CopyObject call fails 2 times for file 150 out of 500
- **THEN** the operation stops and reports the failure

### Requirement: S3 errors return JSON with partial progress and actionable message

If an S3 CopyObject or PutObject fails during a deploy after exhausting retries, the gateway SHALL return a JSON error response with details about the failure, including how many files were successfully processed and an actionable recovery message.

#### Scenario: S3 copy failure mid-loop
- **WHEN** the S3 CopyObject call fails for file 150 out of 500 after retries
- **THEN** the gateway returns HTTP 502 with JSON body `{"error": "Inherit copy failed (150/500 files copied). Retry the deploy, or remove inherit and include all files.", "copied": 150, "total": 500}`
- **AND** no deployment record is inserted into the database

#### Scenario: S3 upload failure
- **WHEN** the S3 PutObject call fails for a file during initial upload after retries
- **THEN** the gateway returns HTTP 502 with a JSON error describing which file failed

### Requirement: ALB idle timeout is 120 seconds

The Application Load Balancer idle timeout SHALL be configured to 120 seconds to prevent HTML timeout pages for legitimately long operations.

#### Scenario: Deploy with 500 inherited files under degraded S3 latency
- **WHEN** S3 CopyObject calls average 200ms each (degraded) and 500 files are being copied
- **AND** concurrency limit is 20
- **THEN** the operation completes in ~5 seconds, well within the 120-second ALB timeout
