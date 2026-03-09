import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class StatusProbeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Import the site bucket by name from SiteStack output
    const bucketName = cdk.Fn.importValue("Run402-SiteBucketName");
    const siteBucket = s3.Bucket.fromBucketName(this, "SiteBucket", bucketName);

    // Lambda function
    const fn = new lambda.Function(this, "Probe", {
      functionName: "Run402-StatusProbe",
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: "index.handler",
      code: lambda.Code.fromAsset(path.join(__dirname, "../status-probe")),
      memorySize: 128,
      timeout: cdk.Duration.seconds(15),
      environment: {
        SITE_BUCKET: bucketName,
        STATUS_KEY: "status/v1.json",
        HISTORY_PREFIX: "status/history/",
      },
    });

    // Grant S3 read/write on status/* prefix
    siteBucket.grantRead(fn, "status/*");
    siteBucket.grantPut(fn, "status/*");

    // EventBridge rule: every 1 minute
    new events.Rule(this, "Schedule", {
      schedule: events.Schedule.rate(cdk.Duration.minutes(1)),
      targets: [new targets.LambdaFunction(fn)],
    });
  }
}
