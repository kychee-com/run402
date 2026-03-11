# llms.txt Access Logs

## Overview

CloudFront standard access logs are enabled on the run402.com distribution. Every request (including agent fetches of `/llms.txt` and `/openapi.json`) is logged to S3 with User-Agent, path, timestamp, status code, and bytes transferred.

GA4 only tracks human visitors who execute JavaScript. Agents fetching raw files never execute JS, so CloudFront logs are the only way to measure agent traffic.

## Infrastructure

- **Log bucket**: Created by `infra/lib/site-stack.ts` (`AccessLogBucket`)
- **Prefix**: `cf-logs/`
- **Retention**: 90 days (lifecycle rule auto-deletes)
- **Format**: CloudFront standard access log (tab-separated, gzipped)

## Querying with Athena

### 1. Create the table (one-time setup)

```sql
CREATE EXTERNAL TABLE IF NOT EXISTS cf_logs (
  `date` DATE,
  `time` STRING,
  x_edge_location STRING,
  sc_bytes BIGINT,
  c_ip STRING,
  cs_method STRING,
  cs_host STRING,
  cs_uri_stem STRING,
  sc_status INT,
  cs_referer STRING,
  cs_user_agent STRING,
  cs_uri_query STRING,
  cs_cookie STRING,
  x_edge_result_type STRING,
  x_edge_request_id STRING,
  x_host_header STRING,
  cs_protocol STRING,
  cs_bytes BIGINT,
  time_taken FLOAT,
  x_forwarded_for STRING,
  ssl_protocol STRING,
  ssl_cipher STRING,
  x_edge_response_result_type STRING,
  cs_protocol_version STRING,
  fle_status STRING,
  fle_encrypted_fields INT,
  c_port INT,
  time_to_first_byte FLOAT,
  x_edge_detailed_result_type STRING,
  sc_content_type STRING,
  sc_content_len BIGINT,
  sc_range_start BIGINT,
  sc_range_end BIGINT
)
ROW FORMAT DELIMITED FIELDS TERMINATED BY '\t'
LOCATION 's3://agentdb-site-accesslogbucketda470295-jaz7qij2zfjq/cf-logs/'
TBLPROPERTIES ('skip.header.line.count'='2');
```

Bucket name: `agentdb-site-accesslogbucketda470295-jaz7qij2zfjq`

### 2. Example queries

```sql
-- llms.txt fetches per day
SELECT date, count(*) AS hits
FROM cf_logs
WHERE cs_uri_stem = '/llms.txt'
GROUP BY date ORDER BY date;

-- openapi.json fetches per day
SELECT date, count(*) AS hits
FROM cf_logs
WHERE cs_uri_stem = '/openapi.json'
GROUP BY date ORDER BY date;

-- User-Agent breakdown for llms.txt
SELECT cs_user_agent, count(*) AS hits
FROM cf_logs
WHERE cs_uri_stem = '/llms.txt'
GROUP BY cs_user_agent ORDER BY hits DESC
LIMIT 50;

-- All agent-relevant file fetches (non-HTML)
SELECT cs_uri_stem, count(*) AS hits
FROM cf_logs
WHERE cs_uri_stem IN ('/llms.txt', '/openapi.json', '/status/v1.json')
GROUP BY cs_uri_stem ORDER BY hits DESC;

-- Top referrers for llms.txt
SELECT cs_referer, count(*) AS hits
FROM cf_logs
WHERE cs_uri_stem = '/llms.txt' AND cs_referer != '-'
GROUP BY cs_referer ORDER BY hits DESC
LIMIT 20;
```

## Cost

- CloudFront standard logs: free
- S3 storage: ~$0.02/GB/month (log volume is tiny)
- Athena queries: $5/TB scanned (pennies for these queries)
