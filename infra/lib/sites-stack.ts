/**
 * AgentDB Sites Stack — CloudFront + ACM + Route53 for *.sites.run402.com
 *
 * Serves static site deployments from the shared S3 bucket (agentdb-storage-*).
 * Each deployment gets a unique subdomain: {dpl-id}.sites.run402.com
 * A CloudFront Function handles subdomain → S3 prefix routing and SPA fallback.
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
const SITES_SUBDOMAIN = "sites";

export class SitesStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // =========================================================================
    // Import existing S3 bucket (from PodStack)
    // =========================================================================
    const storageBucket = s3.Bucket.fromBucketName(
      this,
      "StorageBucket",
      `agentdb-storage-${this.account}`,
    );

    // =========================================================================
    // Route 53 Hosted Zone
    // =========================================================================
    const hostedZone = route53.HostedZone.fromLookup(this, "Zone", {
      domainName: DOMAIN,
    });

    // =========================================================================
    // ACM Certificate for *.sites.run402.com
    // =========================================================================
    const cert = new acm.Certificate(this, "SitesCert", {
      domainName: `*.${SITES_SUBDOMAIN}.${DOMAIN}`,
      validation: acm.CertificateValidation.fromDns(hostedZone),
    });

    // =========================================================================
    // CloudFront Function: subdomain routing + SPA fallback
    //
    // Extracts deployment ID from Host header, maps to S3 prefix.
    // For paths without file extensions, rewrites to /index.html (SPA fallback).
    // =========================================================================
    const routingFunction = new cloudfront.Function(this, "SitesRouting", {
      functionName: "agentdb-sites-routing",
      code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var request = event.request;
  var host = request.headers.host.value;

  // Extract subdomain: "dpl-xxx.sites.run402.com" → "dpl-xxx"
  var parts = host.split('.');
  if (parts.length < 3) {
    return {
      statusCode: 400,
      statusDescription: 'Bad Request',
      body: { encoding: 'text', data: 'Invalid host' },
    };
  }
  var subdomain = parts[0];

  // Convert DNS hyphens back to underscores for S3 prefix
  var deploymentId = subdomain.replace(/-/g, '_');

  // Determine if this is a file request (has extension) or SPA route
  var uri = request.uri;
  var lastSegment = uri.split('/').pop();
  var hasExtension = lastSegment.indexOf('.') > 0;

  // SPA fallback: paths without extensions serve index.html
  if (!hasExtension && uri !== '/') {
    uri = '/index.html';
  }

  // Rewrite URI to S3 prefix: /style.css → /sites/dpl_xxx/style.css
  request.uri = '/sites/' + deploymentId + uri;

  return request;
}
      `.trim()),
      runtime: cloudfront.FunctionRuntime.JS_2_0,
    });

    // =========================================================================
    // CloudFront Distribution
    // =========================================================================
    const distribution = new cloudfront.Distribution(this, "SitesDistribution", {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(storageBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        functionAssociations: [
          {
            function: routingFunction,
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
          },
        ],
      },
      domainNames: [`*.${SITES_SUBDOMAIN}.${DOMAIN}`],
      certificate: cert,
      defaultRootObject: "index.html",
    });

    // =========================================================================
    // Route 53: *.sites.run402.com → CloudFront
    // =========================================================================
    new route53.ARecord(this, "SitesWildcardA", {
      zone: hostedZone,
      recordName: `*.${SITES_SUBDOMAIN}`,
      target: route53.RecordTarget.fromAlias(
        new route53targets.CloudFrontTarget(distribution),
      ),
    });

    new route53.AaaaRecord(this, "SitesWildcardAAAA", {
      zone: hostedZone,
      recordName: `*.${SITES_SUBDOMAIN}`,
      target: route53.RecordTarget.fromAlias(
        new route53targets.CloudFrontTarget(distribution),
      ),
    });

    // =========================================================================
    // Outputs
    // =========================================================================
    new cdk.CfnOutput(this, "SitesDistributionId", {
      value: distribution.distributionId,
      description: "Sites CloudFront distribution ID",
    });

    new cdk.CfnOutput(this, "SitesDomain", {
      value: `*.${SITES_SUBDOMAIN}.${DOMAIN}`,
      description: "Sites wildcard domain",
    });
  }
}
