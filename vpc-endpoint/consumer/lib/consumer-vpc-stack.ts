import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as custom from "aws-cdk-lib/custom-resources";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { CfnParameter, CustomResource } from "aws-cdk-lib";
import {
  Vpc,
  FlowLog,
  FlowLogResourceType,
  InterfaceVpcEndpointAwsService,
} from "aws-cdk-lib/aws-ec2";
import {
  NetworkLoadBalancer,
  NetworkTargetGroup,
  Protocol,
  TargetType,
} from "aws-cdk-lib/aws-elasticloadbalancingv2";
import {
  Role,
  ServicePrincipal,
  PolicyStatement,
  AccountPrincipal,
} from "aws-cdk-lib/aws-iam";
import { Code, Runtime, Function } from "aws-cdk-lib/aws-lambda";
import {
  Bucket,
  BlockPublicAccess,
  BucketEncryption,
  ObjectOwnership,
} from "aws-cdk-lib/aws-s3";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
import { Key } from "aws-cdk-lib/aws-kms";

export class ConsumerVpcStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const producerAccountId = new CfnParameter(this, "producerAccountId", {
      type: "String",
      description: "The AWS Account ID of the producer account.",
    });

    const vpc = new Vpc(this, "ConsumerVPC", {
      vpcName: "ConsumerVPC",
    });
    new FlowLog(this, "FlowLog", {
      resourceType: FlowLogResourceType.fromVpc(vpc),
    });

    const privateApiEndpoint = vpc.addInterfaceEndpoint("ConsumerApiEndpoint", {
      service: InterfaceVpcEndpointAwsService.APIGATEWAY,
    });

    const outputVPCe = new cdk.CfnOutput(this, "ConsumerVPCe", {
      value: privateApiEndpoint.vpcEndpointId,
      exportName: "ConsumerVPCe",
    });

    const key = new Key(this, "APIKeyKMSKey", {
      enableKeyRotation: true,
    });
    const apiSecret = new Secret(this, "CrossAccountAPIKey", {
      generateSecretString: {
        passwordLength: 32,
        excludePunctuation: true,
      },
      encryptionKey: key,
    });

    const rotationLambda = new Function(this, "RotationLambda", {
      code: Code.fromAsset("rotation"),
      runtime: Runtime.PYTHON_3_8,
      handler: "main.lambda_handler",
    });

    apiSecret.addRotationSchedule("RotationSchedule", {
      automaticallyAfter: cdk.Duration.days(7),
      rotationLambda: rotationLambda,
    });

    apiSecret.grantRead(new AccountPrincipal(producerAccountId.valueAsString));
    apiSecret.grantRead(new ServicePrincipal("lambda"));
    apiSecret.grantWrite(rotationLambda);

    const outputSecretArn = new cdk.CfnOutput(this, "ApiKeySecretArn", {
      value: apiSecret.secretFullArn!,
      exportName: "ApiKeySecretArn",
    });

    const nlbAccessLogs = new Bucket(this, "NLBAccessLogsBucket", {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: BucketEncryption.S3_MANAGED,
      serverAccessLogsPrefix: "logs",
      objectOwnership: ObjectOwnership.OBJECT_WRITER,
    });

    const nlb = new NetworkLoadBalancer(this, "ConsumerNLB", {
      vpc,
      internetFacing: false,
      crossZoneEnabled: true,
    });
    nlb.logAccessLogs(nlbAccessLogs, "consumerAccessLogs");

    const outputNlb = new cdk.CfnOutput(this, "ConsumerNLBArn", {
      value: nlb.loadBalancerArn,
      exportName: "ConsumerNLBArn",
    });

    const listener = nlb.addListener("HttpsListener", {
      port: 443,
    });

    const tg = new NetworkTargetGroup(this, "ApiTargetGroup", {
      targetType: TargetType.IP,
      port: 443,
      protocol: Protocol.TCP,
      healthCheck: {
        enabled: true,
        protocol: Protocol.HTTPS,
        path: "/ping",
      },
      vpc,
    });

    const ipTargetRegisterRole = new Role(this, "ipTargetRegisterRole", {
      assumedBy: new ServicePrincipal("lambda.amazonaws.com").withSessionTags(),
    });
    ipTargetRegisterRole.addToPolicy(
      new PolicyStatement({
        resources: ["*"],
        actions: [
          "ec2:DescribeVpcEndpoints",
          "ec2:DescribeNetworkInterfaces",
          "elasticloadbalancing:RegisterTargets",
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
        ],
      })
    );

    const ipTargetRegisterFn = new NodejsFunction(
      this,
      "IpTargetRegisterFunction",
      {
        runtime: Runtime.NODEJS_16_X,
        handler: "lambdaHandler",
        entry: "./targetRegister/app.ts",
        role: ipTargetRegisterRole,
        environment: {
          vpceId: privateApiEndpoint.vpcEndpointId,
          targetGroupArn: tg.targetGroupArn,
        },
      }
    );

    const customResourceRole = new Role(this, "customResourceRole", {
      assumedBy: new ServicePrincipal("lambda.amazonaws.com").withSessionTags(),
    });
    customResourceRole.addToPolicy(
      new PolicyStatement({
        resources: ["*"],
        actions: [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
        ],
      })
    );

    const customIpRegisterProvider = new custom.Provider(
      this,
      "CustomIpRegisterProvider",
      {
        onEventHandler: ipTargetRegisterFn,
        role: customResourceRole,
      }
    );

    new CustomResource(this, "IpTargetRegister", {
      serviceToken: customIpRegisterProvider.serviceToken,
    });

    listener.addTargetGroups("AddApiTargetGroup", tg);
  }
}
