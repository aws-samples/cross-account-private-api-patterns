#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
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
  {
    id: "AwsSolutions-EC29",
    reason:
      "Standalone instace just for testing",
  },
]);
