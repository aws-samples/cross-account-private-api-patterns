#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { ProducerStack } from "../lib/producer-stack";
import { AwsSolutionsChecks, NagSuppressions } from "cdk-nag";

const app = new cdk.App();
const api = new ProducerStack(app, "mTLSProducerStack", {
    env: {
    //Required for ELBv2 access logging to work
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
cdk.Aspects.of(app).add(new AwsSolutionsChecks());
NagSuppressions.addStackSuppressions(api, [
  {
    id: "AwsSolutions-COG4",
    reason:
      "Token-based authorization is used in this solution rather than Cognito",
  },
  {
    id: "AwsSolutions-IAM4",
    reason:
      "AWS Managed Policies used in this solution are:  AWSLambdaBasicExecutionRole and AmazonAPIGatewayPushToCloudWatchLogs",
  },
  {
    id: "AwsSolutions-IAM5",
    reason:
      "IAM policy resources not scoped where the resource ID is not known ahead of time",
  },
  {
    id: "AwsSolutions-L1",
    reason: "Custom Resource is currently hardcoded to NodeJS 14",
  },
  {
    id: "AwsSolutions-APIG2",
    reason: "Request validation not currently enabled. "
  }
]);
