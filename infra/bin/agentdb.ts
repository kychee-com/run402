#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { PodStack } from "../lib/pod-stack.js";
import { SiteStack } from "../lib/site-stack.js";
import { SitesStack } from "../lib/sites-stack.js";

const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT || "472210437512",
  region: "us-east-1",
};

new PodStack(app, "AgentDB-Pod01", {
  env,
  description: "AgentDB Pod 01 — Aurora + ECS + ALB + S3",
});

new SiteStack(app, "AgentDB-Site", {
  env,
  description: "AgentDB Site — S3 + CloudFront static website",
});

new SitesStack(app, "AgentDB-Sites", {
  env,
  description: "AgentDB Sites — CloudFront + wildcard DNS for deployed static sites",
});

app.synth();
