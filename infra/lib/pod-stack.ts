import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as rds from "aws-cdk-lib/aws-rds";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as route53targets from "aws-cdk-lib/aws-route53-targets";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as logs from "aws-cdk-lib/aws-logs";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";

const DOMAIN = "run402.com";
const API_SUBDOMAIN = "api";
const MAX_SCHEMAS = 2000;

export class PodStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // =========================================================================
    // VPC: 2 AZs, public + private subnets, NO NAT Gateway
    // =========================================================================
    const vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        {
          name: "Public",
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: "Private",
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
      ],
    });

    // =========================================================================
    // Security Groups
    // =========================================================================
    const albSg = new ec2.SecurityGroup(this, "AlbSg", {
      vpc,
      description: "ALB — inbound HTTPS from internet",
      allowAllOutbound: true,
    });
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), "HTTPS");
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), "HTTP redirect");

    const ecsSg = new ec2.SecurityGroup(this, "EcsSg", {
      vpc,
      description: "ECS tasks — inbound from ALB only",
      allowAllOutbound: true,
    });
    ecsSg.addIngressRule(albSg, ec2.Port.tcp(4022), "Gateway from ALB");

    const auroraSg = new ec2.SecurityGroup(this, "AuroraSg", {
      vpc,
      description: "Aurora — inbound from ECS only",
      allowAllOutbound: false,
    });
    auroraSg.addIngressRule(ecsSg, ec2.Port.tcp(5432), "Postgres from ECS");

    // =========================================================================
    // Secrets Manager
    // =========================================================================
    const dbSecret = new secretsmanager.Secret(this, "DbSecret", {
      secretName: "agentdb/db-credentials",
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: "postgres" }),
        generateStringKey: "password",
        excludePunctuation: true,
        passwordLength: 32,
      },
    });

    const jwtSecret = new secretsmanager.Secret(this, "JwtSecret", {
      secretName: "agentdb/jwt-secret",
      generateSecretString: {
        excludePunctuation: false,
        passwordLength: 64,
      },
    });

    const sellerSecret = new secretsmanager.Secret(this, "SellerSecret", {
      secretName: "agentdb/seller-wallet",
      description: "Seller wallet private key and address for x402 payments",
    });

    // =========================================================================
    // Aurora Serverless v2 (Postgres 16)
    // =========================================================================
    const auroraCluster = new rds.DatabaseCluster(this, "Aurora", {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_16_4,
      }),
      credentials: rds.Credentials.fromSecret(dbSecret),
      defaultDatabaseName: "agentdb",
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [auroraSg],
      serverlessV2MinCapacity: 0.5,
      serverlessV2MaxCapacity: 2,
      writer: rds.ClusterInstance.serverlessV2("Writer", {
        publiclyAccessible: false,
      }),
      storageEncrypted: true,
      backup: {
        retention: cdk.Duration.days(7),
      },
      removalPolicy: cdk.RemovalPolicy.SNAPSHOT,
    });

    // =========================================================================
    // S3 Bucket (storage)
    // =========================================================================
    const storageBucket = new s3.Bucket(this, "StorageBucket", {
      bucketName: `agentdb-storage-${this.account}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      lifecycleRules: [
        {
          id: "expire-old-archived",
          prefix: "archived/",
          expiration: cdk.Duration.days(90),
        },
      ],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // =========================================================================
    // ECR Repository
    // =========================================================================
    const ecrRepo = new ecr.Repository(this, "GatewayRepo", {
      repositoryName: "agentdb-gateway",
      lifecycleRules: [
        { maxImageCount: 10, description: "Keep last 10 images" },
      ],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // =========================================================================
    // ECS Cluster + Fargate Service
    // =========================================================================
    const cluster = new ecs.Cluster(this, "Cluster", {
      vpc,
      containerInsights: true,
    });

    const taskDef = new ecs.FargateTaskDefinition(this, "TaskDef", {
      cpu: 512,
      memoryLimitMiB: 1024,
    });

    // Grant task role access to secrets and S3
    dbSecret.grantRead(taskDef.taskRole);
    jwtSecret.grantRead(taskDef.taskRole);
    sellerSecret.grantRead(taskDef.taskRole);
    storageBucket.grantReadWrite(taskDef.taskRole);

    const logGroup = new logs.LogGroup(this, "GatewayLogs", {
      logGroupName: "/agentdb/gateway",
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Build PostgREST schema list
    const schemaList = Array.from({ length: MAX_SCHEMAS }, (_, i) =>
      `p${String(i + 1).padStart(4, "0")}`
    ).join(",");

    // --- Gateway container ---
    const gatewayContainer = taskDef.addContainer("gateway", {
      image: ecs.ContainerImage.fromEcrRepository(ecrRepo, "latest"),
      essential: true,
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: "gateway",
        logGroup,
      }),
      environment: {
        PORT: "4022",
        POSTGREST_URL: "http://localhost:3000",
        NETWORK: "eip155:84532",
        FACILITATOR_URL: "https://x402.org/facilitator",
        S3_BUCKET: storageBucket.bucketName,
        S3_REGION: this.region,
        MAX_SCHEMA_SLOTS: String(MAX_SCHEMAS),
        RATE_LIMIT_PER_SEC: "100",
        DB_HOST: auroraCluster.clusterEndpoint.hostname,
        DB_PORT: "5432",
        DB_NAME: "agentdb",
      },
      secrets: {
        DB_PASSWORD: ecs.Secret.fromSecretsManager(dbSecret, "password"),
        DB_USER: ecs.Secret.fromSecretsManager(dbSecret, "username"),
        JWT_SECRET: ecs.Secret.fromSecretsManager(jwtSecret),
        SELLER_ADDRESS: ecs.Secret.fromSecretsManager(sellerSecret, "address"),
      },
      healthCheck: {
        command: ["CMD-SHELL", "wget -qO- http://localhost:4022/health || exit 1"],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
      },
    });

    gatewayContainer.addPortMappings({ containerPort: 4022 });

    // --- PostgREST sidecar ---
    const postgrestContainer = taskDef.addContainer("postgrest", {
      image: ecs.ContainerImage.fromRegistry("postgrest/postgrest:v12.2.3"),
      essential: true,
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: "postgrest",
        logGroup,
      }),
      environment: {
        PGRST_DB_SCHEMAS: schemaList,
        PGRST_DB_ANON_ROLE: "anon",
        PGRST_DB_PRE_REQUEST: "internal.pre_request",
        PGRST_SERVER_PORT: "3000",
        PGRST_DB_URI: `postgres://authenticator:authenticator@${auroraCluster.clusterEndpoint.hostname}:5432/agentdb`,
      },
      secrets: {
        PGRST_JWT_SECRET: ecs.Secret.fromSecretsManager(jwtSecret),
      },
    });

    // PostgREST listens on 3000 but only gateway (localhost) accesses it
    postgrestContainer.addPortMappings({ containerPort: 3000 });

    const fargateService = new ecs.FargateService(this, "Service", {
      cluster,
      taskDefinition: taskDef,
      desiredCount: 2,
      assignPublicIp: true, // No NAT gateway, so public subnet + public IP
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [ecsSg],
      circuitBreaker: { rollback: true },
      minHealthyPercent: 50,
      maxHealthyPercent: 200,
    });

    // =========================================================================
    // ALB
    // =========================================================================
    // Look up hosted zone (must exist)
    const hostedZone = route53.HostedZone.fromLookup(this, "Zone", {
      domainName: DOMAIN,
    });

    // ACM certificate
    const cert = new acm.Certificate(this, "Cert", {
      domainName: `*.${DOMAIN}`,
      subjectAlternativeNames: [DOMAIN],
      validation: acm.CertificateValidation.fromDns(hostedZone),
    });

    const alb = new elbv2.ApplicationLoadBalancer(this, "Alb", {
      vpc,
      internetFacing: true,
      securityGroup: albSg,
    });

    // HTTPS listener
    const httpsListener = alb.addListener("Https", {
      port: 443,
      certificates: [cert],
    });

    httpsListener.addTargets("Gateway", {
      port: 4022,
      targets: [fargateService],
      healthCheck: {
        path: "/health",
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
    });

    // HTTP → HTTPS redirect
    alb.addListener("HttpRedirect", {
      port: 80,
      defaultAction: elbv2.ListenerAction.redirect({
        protocol: "HTTPS",
        port: "443",
        permanent: true,
      }),
    });

    // Route 53 record
    new route53.ARecord(this, "ApiRecord", {
      zone: hostedZone,
      recordName: API_SUBDOMAIN,
      target: route53.RecordTarget.fromAlias(
        new route53targets.LoadBalancerTarget(alb),
      ),
    });

    // =========================================================================
    // Outputs
    // =========================================================================
    new cdk.CfnOutput(this, "AlbDns", {
      value: alb.loadBalancerDnsName,
      description: "ALB DNS name",
    });

    new cdk.CfnOutput(this, "ApiUrl", {
      value: `https://${API_SUBDOMAIN}.${DOMAIN}`,
      description: "API URL",
    });

    new cdk.CfnOutput(this, "AuroraEndpoint", {
      value: auroraCluster.clusterEndpoint.hostname,
      description: "Aurora cluster endpoint",
    });

    new cdk.CfnOutput(this, "EcrRepoUri", {
      value: ecrRepo.repositoryUri,
      description: "ECR repository URI",
    });

    new cdk.CfnOutput(this, "StorageBucketName", {
      value: storageBucket.bucketName,
      description: "S3 storage bucket",
    });
  }
}
