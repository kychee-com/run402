/**
 * Custom Subdomains Stack — CloudFront + KVS for {name}.run402.com
 *
 * Serves static assets for custom subdomains from CloudFront edge locations.
 * HTML requests fall through to the ALB gateway for fork badge injection.
 *
 * Uses CloudFront KeyValueStore to resolve subdomain → deployment ID at the edge,
 * and rewrites the URI to the S3 prefix (sites/{deployment_id}/{path}).
 */

import * as cdk from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as route53targets from "aws-cdk-lib/aws-route53-targets";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import { Construct } from "constructs";

const DOMAIN = "run402.com";
const ALB_DOMAIN = `api.${DOMAIN}`;

/** File extensions that are treated as static assets and served from S3/edge. */
const ASSET_EXTENSIONS = [
  "css", "js", "mjs", "png", "jpg", "jpeg", "gif", "svg", "ico",
  "woff", "woff2", "ttf", "eot", "webp", "avif", "map", "json",
  "webmanifest", "xml", "txt", "pdf", "zip", "wasm",
];

export class CustomSubdomainsStack extends cdk.Stack {
  /** KVS ARN — export for gateway to sync subdomain mappings. */
  public readonly kvsArn: string;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // =========================================================================
    // Import existing resources
    // =========================================================================
    const storageBucket = s3.Bucket.fromBucketName(
      this,
      "StorageBucket",
      `agentdb-storage-${this.account}`,
    );

    const hostedZone = route53.HostedZone.fromLookup(this, "Zone", {
      domainName: DOMAIN,
    });

    // =========================================================================
    // ACM Certificate for *.run402.com (must be in us-east-1 for CloudFront)
    // =========================================================================
    const cert = new acm.Certificate(this, "CustomSubdomainsCert", {
      domainName: `*.${DOMAIN}`,
      validation: acm.CertificateValidation.fromDns(hostedZone),
    });

    // =========================================================================
    // CloudFront KeyValueStore — subdomain → deployment_id mappings
    // =========================================================================
    const kvs = new cloudfront.KeyValueStore(this, "SubdomainKvs", {
      keyValueStoreName: "run402-subdomain-mappings",
      comment: "Maps custom subdomain names to deployment IDs for S3 routing",
    });

    this.kvsArn = kvs.keyValueStoreArn;

    // =========================================================================
    // CloudFront Function: KVS lookup + S3 URI rewrite (for assets)
    //
    // Extracts subdomain from Host header, looks up deployment ID in KVS,
    // rewrites URI to sites/{deployment_id}/{path}.
    // Returns 404 if subdomain is not in KVS.
    // =========================================================================
    const assetRoutingFunction = new cloudfront.Function(
      this,
      "AssetRouting",
      {
        functionName: "run402-custom-subdomain-assets",
        code: cloudfront.FunctionCode.fromInline(`
import cf from 'cloudfront';
var kvsHandle = cf.kvs();

async function handler(event) {
  var request = event.request;
  var host = (request.headers.host && request.headers.host.value) || '';

  // Extract subdomain: "myapp.run402.com" → "myapp"
  var dotIndex = host.indexOf('.');
  if (dotIndex < 1) {
    return {
      statusCode: 400,
      statusDescription: 'Bad Request',
      body: { encoding: 'text', data: 'Invalid host' },
    };
  }
  var subdomain = host.substring(0, dotIndex);

  // Look up deployment ID in KVS
  var deploymentId;
  try {
    deploymentId = await kvsHandle.get(subdomain);
  } catch (e) {
    // Key not found — return 404 with no-store so CloudFront doesn't cache it.
    // During KVS propagation (a few seconds after subdomain claim), this 404
    // is transient. The no-store header ensures the next request retries the
    // KVS lookup instead of serving a cached 404.
    return {
      statusCode: 404,
      statusDescription: 'Not Found',
      headers: { 'cache-control': { value: 'no-store' } },
      body: { encoding: 'text', data: 'Subdomain not configured' },
    };
  }

  // Rewrite URI to S3 prefix: /style.css → /sites/dpl_abc123/style.css
  request.uri = '/sites/' + deploymentId + request.uri;
  return request;
}
        `.trim()),
        runtime: cloudfront.FunctionRuntime.JS_2_0,
        keyValueStore: kvs,
      },
    );

    // =========================================================================
    // Origins
    // =========================================================================
    const s3Origin = origins.S3BucketOrigin.withOriginAccessControl(
      storageBucket,
    );

    const albOrigin = new origins.HttpOrigin(ALB_DOMAIN, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
    });

    // =========================================================================
    // CloudFront Distribution
    //
    // Default behavior → ALB (HTML, fork badge injection)
    // Asset behaviors → S3 via KVS routing function (immutable cache, invalidated on redeploy)
    // =========================================================================

    // Build additional behaviors for each asset extension pattern.
    // Uses CACHING_OPTIMIZED (respects S3 immutable headers) — freshness on redeploy
    // is handled by CloudFront invalidation in the gateway subdomain reassignment path.
    const additionalBehaviors: Record<string, cloudfront.BehaviorOptions> = {};
    for (const ext of ASSET_EXTENSIONS) {
      additionalBehaviors[`*.${ext}`] = {
        origin: s3Origin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        functionAssociations: [
          {
            function: assetRoutingFunction,
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
          },
        ],
      };
    }

    const distribution = new cloudfront.Distribution(
      this,
      "CustomSubdomainsDistribution",
      {
        defaultBehavior: {
          origin: albOrigin,
          viewerProtocolPolicy:
            cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        },
        additionalBehaviors,
        domainNames: [`*.${DOMAIN}`],
        certificate: cert,
      },
    );

    // =========================================================================
    // Route 53: *.run402.com → CloudFront
    //
    // Note: api.run402.com has an explicit A record in PodStack that takes
    // priority over this wildcard.
    // =========================================================================
    new route53.ARecord(this, "CustomWildcardA", {
      zone: hostedZone,
      recordName: "*",
      target: route53.RecordTarget.fromAlias(
        new route53targets.CloudFrontTarget(distribution),
      ),
    });

    new route53.AaaaRecord(this, "CustomWildcardAAAA", {
      zone: hostedZone,
      recordName: "*",
      target: route53.RecordTarget.fromAlias(
        new route53targets.CloudFrontTarget(distribution),
      ),
    });

    // =========================================================================
    // Outputs
    // =========================================================================
    new cdk.CfnOutput(this, "DistributionId", {
      value: distribution.distributionId,
      description: "Custom subdomains CloudFront distribution ID",
    });

    new cdk.CfnOutput(this, "DistributionDomain", {
      value: distribution.distributionDomainName,
      description: "Custom subdomains CloudFront domain",
    });

    new cdk.CfnOutput(this, "KvsArn", {
      value: kvs.keyValueStoreArn,
      description: "KeyValueStore ARN for subdomain mappings",
      exportName: "Run402-SubdomainKvsArn",
    });

    new cdk.CfnOutput(this, "KvsId", {
      value: kvs.keyValueStoreId,
      description: "KeyValueStore ID for subdomain mappings",
      exportName: "Run402-SubdomainKvsId",
    });
  }
}
