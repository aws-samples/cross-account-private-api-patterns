import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import { CfnParameter, CustomResource, Fn } from "aws-cdk-lib";
import { NetworkLoadBalancer } from "aws-cdk-lib/aws-elasticloadbalancingv2";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup } from "aws-cdk-lib/aws-logs";
import {
  AccessLogFormat,
  CfnAccount,
  ConnectionType,
  Deployment,
  Integration,
  IntegrationType,
  LogGroupLogDestination,
  MethodLoggingLevel,
  RequestValidator,
  RestApi,
  TokenAuthorizer,
  VpcLink,
} from "aws-cdk-lib/aws-apigateway";
import {
  Vpc,
  SecurityGroup,
  Peer,
  Port,
  SubnetType,
} from "aws-cdk-lib/aws-ec2";
import {
  Role,
  ServicePrincipal,
  ManagedPolicy,
  PolicyStatement,
} from "aws-cdk-lib/aws-iam";
import { Runtime } from "aws-cdk-lib/aws-lambda";
import { Provider } from "aws-cdk-lib/custom-resources";

export class ConsumerApiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);

    const targetApiUrl = new CfnParameter(this, "targetApiUrl", {
      type: "String",
      description: "The URI of the target private API to be invoked.",
    });

    const producerAccountId = new CfnParameter(this, "producerAccountId", {
      type: "String",
      description: "The AWS Account ID of the producer account.",
    });

    const nlbArn = Fn.importValue("ConsumerNLBArn");
    const vpce = Fn.importValue("ConsumerVPCe");
    const secretArn = Fn.importValue("ApiKeySecretArn");

    const nlb = NetworkLoadBalancer.fromNetworkLoadBalancerAttributes(
      this,
      "ALB",
      {
        loadBalancerArn: nlbArn,
      }
    );

    const modifyPolicyRole = new Role(this, "modifyPolicyRole", {
      assumedBy: new ServicePrincipal("lambda.amazonaws.com").withSessionTags(),
    });
    modifyPolicyRole.addToPolicy(
      new PolicyStatement({
        resources: ["*"],
        actions: [
          "ec2:ModifyVpcEndpoint",
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
        ],
      })
    );

    const modifyPolicyRoleFn = new NodejsFunction(
      this,
      "ModifyPolicyRoleFunction",
      {
        runtime: Runtime.NODEJS_16_X,
        handler: "lambdaHandler",
        entry: "./endpointPolicy/app.ts",
        role: modifyPolicyRole,
        environment: {
          VPCE: vpce,
          ACCOUNT: producerAccountId.valueAsString,
          REGION: this.region,
          API: targetApiUrl.valueAsString,
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

    const customVpcePolicyUpdate = new Provider(
      this,
      "CustomVpcePolicyUpdate",
      {
        onEventHandler: modifyPolicyRoleFn,
        role: customResourceRole,
      }
    );

    new CustomResource(this, "VpcePolicyUpdate", {
      serviceToken: customVpcePolicyUpdate.serviceToken,
    });

    const link = new VpcLink(this, "ConsumerVPCLink", {
      targets: [nlb],
    });

    const integration = new Integration({
      type: IntegrationType.HTTP_PROXY,
      integrationHttpMethod: "ANY",
      options: {
        connectionType: ConnectionType.VPC_LINK,
        vpcLink: link,
      },
      uri: targetApiUrl,
    });

    const authorizerFnRole = new Role(this, "authorizerFnRole", {
      assumedBy: new ServicePrincipal("lambda.amazonaws.com").withSessionTags(),
    });
    authorizerFnRole.addToPolicy(
      new PolicyStatement({
        resources: ["*"],
        actions: [
          "kms:Decrypt",
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
        ],
      })
    );
    authorizerFnRole.addToPolicy(
      new PolicyStatement({
        resources: [secretArn],
        actions: ["secretsmanager:GetSecretValue"],
      })
    );

    const authorizerFn = new NodejsFunction(this, "AuthorizerFunction", {
      runtime: Runtime.NODEJS_16_X,
      handler: "lambdaHandler",
      entry: "./authorizer/app.ts",
      environment: {
        API_KEY: secretArn,
      },
      role: authorizerFnRole,
    });

    const authorizer = new TokenAuthorizer(this, "Authorizer", {
      handler: authorizerFn,
    });

    const prdLogGroup = new LogGroup(this, "PrdLogs");
    const api = new RestApi(this, "ConsumerApi", {
      defaultIntegration: integration,
      defaultMethodOptions: {
        authorizer,
      },
      deployOptions: {
        accessLogDestination: new LogGroupLogDestination(prdLogGroup),
        accessLogFormat: AccessLogFormat.jsonWithStandardFields(),
        methodOptions: {
          "/*/*": {
            loggingLevel: MethodLoggingLevel.ERROR,
          },
        },
      },
    });
    api.root.addMethod("ANY");

    const role = new Role(this, "CloudWatchRole", {
      assumedBy: new ServicePrincipal("apigateway.amazonaws.com"),
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName(
          "service-role/AmazonAPIGatewayPushToCloudWatchLogs"
        ),
      ],
    });

    const cloudWatchAccount = new CfnAccount(this, "Account", {
      cloudWatchRoleArn: role.roleArn,
    });

    api.node.addDependency(cloudWatchAccount);

    const deployment = new Deployment(this, "Deployment", { api });

    const requestValidator = new RequestValidator(
      this,
      "ProducerRequestValidator",
      {
        restApi: api,
        requestValidatorName: "prdValidator",
        validateRequestBody: false,
        validateRequestParameters: false,
      }
    );

    const vpc = Vpc.fromLookup(this, "VPC", {
      vpcName: "ConsumerVPC",
    });

    const lambdaSecurityGroup = new SecurityGroup(this, "lambdaSecurityGroup", {
      vpc,
      allowAllOutbound: true,
      disableInlineRules: true,
    });
    lambdaSecurityGroup.addIngressRule(
      Peer.ipv4(vpc.vpcCidrBlock),
      Port.allTraffic()
    );

    const lambdaConsumerRole = new Role(this, "lambdaConsumerRole", {
      assumedBy: new ServicePrincipal("lambda.amazonaws.com").withSessionTags(),
    });
    lambdaConsumerRole.addToPolicy(
      new PolicyStatement({
        resources: ["*"],
        actions: [
          "ec2:CreateNetworkInterface",
          "ec2:DescribeNetworkInterfaces",
          "ec2:DeleteNetworkInterface",
          "ec2:AssignPrivateIpAddresses",
          "ec2:UnassignPrivateIpAddresses",
          "kms:Decrypt",
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
        ],
      })
    );
    lambdaConsumerRole.addToPolicy(
      new PolicyStatement({
        resources: [secretArn],
        actions: ["secretsmanager:GetSecretValue"],
      })
    );

    const lambdaConsumer = new NodejsFunction(this, "ConsumerFunction", {
      runtime: Runtime.NODEJS_16_X,
      handler: "lambdaHandler",
      entry: "./lambdaConsumer/app.ts",
      environment: {
        apiUrl: targetApiUrl.valueAsString,
        API_KEY: secretArn,
      },
      role: lambdaConsumerRole,
      vpc: vpc,
      vpcSubnets: vpc.selectSubnets({
        subnetType: SubnetType.PRIVATE_WITH_EGRESS,
      }),
      securityGroups: [lambdaSecurityGroup],
    });
  }
}
