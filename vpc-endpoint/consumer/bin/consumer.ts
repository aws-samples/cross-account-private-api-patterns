#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { ConsumerApiStack } from "../lib/consumer-api-stack";
import { ConsumerVpcStack } from "../lib/consumer-vpc-stack";
import { AwsSolutionsChecks, NagSuppressions } from "cdk-nag";

const app = new cdk.App();
const vpc = new ConsumerVpcStack(app, "ConsumerVpcStack", {
  env: {
    //Required for ELBv2 access logging to work
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});

const api = new ConsumerApiStack(app, "ConsumerApiStack", {
  env: {
    //Required for Vpc.FromLookup to work
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
cdk.Aspects.of(app).add(new AwsSolutionsChecks());
NagSuppressions.addStackSuppressions(vpc, [
  {
    id: "AwsSolutions-L1",
    reason: "Custom resource is currently hardcoded to NodeJS 14",
  },
  {
    id: "AwsSolutions-IAM5",
    reason:
      "IAM policy resources not scoped where the resource ID is not known ahead of time",
  },
  {
    id: "AwsSolutions-IAM4",
    reason:
      "AWS Managed Policies used in this solution are:  AWSLambdaBasicExecutionRole",
  },
]);
NagSuppressions.addStackSuppressions(api, [
  {
    id: "AwsSolutions-COG4",
    reason:
      "Token-based authorization is used in this solution rather than Cognito",
  },
  {
    id: "AwsSolutions-IAM4",
    reason:
      "AWS Managed Policies used in this solution are:  AWSLambdaBasicExecutionRole, AWSLambdaVPCAccessExecutionRole, AmazonAPIGatewayPushToCloudWatchLogs",
  },
  {
    id: "AwsSolutions-IAM5",
    reason: "Custom Resource IAM Policy",
  },
  {
    id: "AwsSolutions-L1",
    reason: "Custom Resource is currently hardcoded to NodeJS 14",
  },
]);
