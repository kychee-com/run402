#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { PodStack } from "../lib/pod-stack.js";

const app = new cdk.App();

new PodStack(app, "AgentDB-Pod01", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: "us-east-1",
  },
  description: "AgentDB Pod 01 — Aurora + ECS + ALB + S3",
});

app.synth();
