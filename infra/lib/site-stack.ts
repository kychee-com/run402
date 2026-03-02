import * as cdk from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as route53targets from "aws-cdk-lib/aws-route53-targets";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import * as path from "path";
import { fileURLToPath } from "url";

const DOMAIN = "run402.com";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class SiteStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // =========================================================================
    // S3 Bucket (private, OAC for CloudFront)
    // =========================================================================
    const siteBucket = new s3.Bucket(this, "SiteBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // =========================================================================
    // Route 53 Hosted Zone
    // =========================================================================
    const hostedZone = route53.HostedZone.fromLookup(this, "Zone", {
      domainName: DOMAIN,
    });

    // =========================================================================
    // ACM Certificate (run402.com + www.run402.com)
    // =========================================================================
    const cert = new acm.Certificate(this, "SiteCert", {
      domainName: DOMAIN,
      subjectAlternativeNames: [`www.${DOMAIN}`],
      validation: acm.CertificateValidation.fromDns(hostedZone),
    });

    // =========================================================================
    // CloudFront Function: redirect www → apex
    // =========================================================================
    const wwwRedirect = new cloudfront.Function(this, "WwwRedirect", {
      code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var host = event.request.headers.host.value;
  if (host.startsWith('www.')) {
    return {
      statusCode: 301,
      statusDescription: 'Moved Permanently',
      headers: { location: { value: 'https://${DOMAIN}' + event.request.uri } },
    };
  }
  return event.request;
}
      `.trim()),
      runtime: cloudfront.FunctionRuntime.JS_2_0,
    });

    // =========================================================================
    // CloudFront Distribution
    // =========================================================================
    const distribution = new cloudfront.Distribution(this, "Distribution", {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy:
          cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        functionAssociations: [
          {
            function: wwwRedirect,
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
          },
        ],
      },
      domainNames: [DOMAIN, `www.${DOMAIN}`],
      certificate: cert,
      defaultRootObject: "index.html",
    });

    // =========================================================================
    // Route 53 Records → CloudFront
    // =========================================================================
    // Apex: run402.com
    new route53.ARecord(this, "ApexA", {
      zone: hostedZone,
      target: route53.RecordTarget.fromAlias(
        new route53targets.CloudFrontTarget(distribution),
      ),
    });
    new route53.AaaaRecord(this, "ApexAAAA", {
      zone: hostedZone,
      target: route53.RecordTarget.fromAlias(
        new route53targets.CloudFrontTarget(distribution),
      ),
    });

    // WWW: www.run402.com
    new route53.ARecord(this, "WwwA", {
      zone: hostedZone,
      recordName: "www",
      target: route53.RecordTarget.fromAlias(
        new route53targets.CloudFrontTarget(distribution),
      ),
    });
    new route53.AaaaRecord(this, "WwwAAAA", {
      zone: hostedZone,
      recordName: "www",
      target: route53.RecordTarget.fromAlias(
        new route53targets.CloudFrontTarget(distribution),
      ),
    });

    // =========================================================================
    // Deploy site/ to S3 + invalidate CloudFront
    // =========================================================================
    new s3deploy.BucketDeployment(this, "Deploy", {
      sources: [s3deploy.Source.asset(path.join(__dirname, "../../site-dist"))],
      destinationBucket: siteBucket,
      distribution,
      distributionPaths: ["/*"],
    });

    // =========================================================================
    // GitHub Actions OIDC → IAM Role (for CI/CD site deploys)
    // =========================================================================
    const ghProvider = iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
      this,
      "GitHubOidc",
      `arn:aws:iam::${this.account}:oidc-provider/token.actions.githubusercontent.com`,
    );

    const deployRole = new iam.Role(this, "SiteDeployRole", {
      roleName: "run402-site-deploy",
      assumedBy: new iam.WebIdentityPrincipal(
        ghProvider.openIdConnectProviderArn,
        {
          StringEquals: {
            "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          },
          StringLike: {
            "token.actions.githubusercontent.com:sub":
              "repo:MajorTal/run402:ref:refs/heads/main",
          },
        },
      ),
      inlinePolicies: {
        SiteDeploy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: [
                "s3:PutObject",
                "s3:DeleteObject",
                "s3:ListBucket",
                "s3:GetObject",
              ],
              resources: [
                siteBucket.bucketArn,
                `${siteBucket.bucketArn}/*`,
              ],
            }),
            new iam.PolicyStatement({
              actions: ["cloudfront:CreateInvalidation"],
              resources: [
                `arn:aws:cloudfront::${this.account}:distribution/${distribution.distributionId}`,
              ],
            }),
          ],
        }),
      },
    });

    // =========================================================================
    // Outputs
    // =========================================================================
    new cdk.CfnOutput(this, "SiteUrl", {
      value: `https://${DOMAIN}`,
      description: "Website URL",
    });
    new cdk.CfnOutput(this, "DistributionId", {
      value: distribution.distributionId,
      description: "CloudFront distribution ID",
    });
    new cdk.CfnOutput(this, "BucketName", {
      value: siteBucket.bucketName,
      description: "Site S3 bucket",
    });
    new cdk.CfnOutput(this, "DeployRoleArn", {
      value: deployRole.roleArn,
      description: "GitHub Actions deploy role ARN",
    });
  }
}
