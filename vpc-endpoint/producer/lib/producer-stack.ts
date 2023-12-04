import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import { CfnParameter } from "aws-cdk-lib";
import { LogGroup } from "aws-cdk-lib/aws-logs";
import {
  AccessLogFormat,
  CfnAccount,
  Deployment,
  EndpointType,
  LambdaRestApi,
  LogGroupLogDestination,
  MethodLoggingLevel,
  RequestValidator,
  TokenAuthorizer,
} from "aws-cdk-lib/aws-apigateway";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import {
  AnyPrincipal,
  Effect,
  ManagedPolicy,
  PolicyDocument,
  PolicyStatement,
  Role,
  ServicePrincipal,
} from "aws-cdk-lib/aws-iam";
import { Runtime } from "aws-cdk-lib/aws-lambda";

export class ProducerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const resource = "widgets";

    const vpce = new CfnParameter(this, "ConsumerVPCe", {
      type: "String",
      description: "ID of the VPC Endpoint in the consumer account",
    });

    const secretArn = new CfnParameter(this, "ApiKeySecretArn", {
      type: "String",
      description: "ARN of the Secrets Manager secret used for authentication",
    });

    const apiResourcePolicy = new PolicyDocument({
      statements: [
        new PolicyStatement({
          actions: ["execute-api:Invoke"],
          principals: [new AnyPrincipal()],
          effect: Effect.ALLOW,
          resources: ["execute-api:/*"],
        }),
        new PolicyStatement({
          actions: ["execute-api:Invoke"],
          principals: [new AnyPrincipal()],
          effect: Effect.DENY,
          resources: ["execute-api:/*"],
          conditions: {
            StringNotEquals: {
              "aws:SourceVpce": vpce.valueAsString,
            },
          },
        }),
      ],
    });

    const apiHandler = new NodejsFunction(this, "ProducerApiFunction", {
      runtime: Runtime.NODEJS_16_X,
      handler: "lambdaHandler",
      entry: "./api/app.ts",
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
        resources: [secretArn.valueAsString],
        actions: ["secretsmanager:GetSecretValue"],
      })
    );

    const authorizerFn = new NodejsFunction(this, "AuthorizerFunction", {
      runtime: Runtime.NODEJS_16_X,
      handler: "lambdaHandler",
      entry: "./authorizer/app.ts",
      environment: {
        API_KEY: secretArn.valueAsString,
      },
      role: authorizerFnRole,
    });

    const authorizer = new TokenAuthorizer(this, "Authorizer", {
      handler: authorizerFn,
    });

    const prdLogGroup = new LogGroup(this, "PrdLogs");
    const api = new LambdaRestApi(this, "ProducerApi", {
      handler: apiHandler,
      proxy: false,
      endpointConfiguration: {
        types: [EndpointType.PRIVATE],
      },
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
      policy: apiResourcePolicy,
    });

    const items = api.root.addResource(resource);
    items.addMethod("GET");

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

    const requestValidator = new RequestValidator(
      this,
      "ConsumerRequestValidator",
      {
        restApi: api,
        requestValidatorName: "prdValidator",
        validateRequestBody: false,
        validateRequestParameters: false,
      }
    );

    const deployment = new Deployment(this, "Deployment", { api });

    const outputAPI = new cdk.CfnOutput(this, "ApiUrl", {
      value: api.urlForPath(`/${resource}`),
      exportName: "ApiUrl",
    });
  }
}
