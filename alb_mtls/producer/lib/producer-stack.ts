import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import { CfnParameter, CustomResource, Duration } from "aws-cdk-lib";
import * as custom from "aws-cdk-lib/custom-resources";
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
  AccountPrincipal
} from "aws-cdk-lib/aws-iam";
import { Code, Runtime, Function } from "aws-cdk-lib/aws-lambda";
import {
  Vpc,
  FlowLog,
  FlowLogResourceType,
  InterfaceVpcEndpointAwsService,
  SecurityGroup,
  Port,
  Peer,
} from "aws-cdk-lib/aws-ec2";
import {
  NetworkLoadBalancer,
  NetworkTargetGroup,
  Protocol,
  TargetType,
  ApplicationLoadBalancer,
  CfnListener,
  ApplicationTargetGroup
} from "aws-cdk-lib/aws-elasticloadbalancingv2";
import { AlbTarget } from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets'
import {
  Bucket,
  BlockPublicAccess,
  BucketEncryption,
  ObjectOwnership,
} from "aws-cdk-lib/aws-s3";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
import { Key } from "aws-cdk-lib/aws-kms";
import { BucketDeployment, Source } from "aws-cdk-lib/aws-s3-deployment"
import { PrivateCertificate } from "aws-cdk-lib/aws-certificatemanager";
import { CertificateAuthority } from "aws-cdk-lib/aws-acmpca";

export class ProducerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const resource = "widgets";

    const consumerAccountId = new CfnParameter(this, "consumerAccountId", {
      type: "String",
      description: "The AWS Account ID of the producer account.",
    });

    const domainName = new CfnParameter(this, "domainName", {
      type: "String",
      description: "The domain name to create an SSL certificate for the application load balancer.",
    });

    const privateCAID = new CfnParameter(this, "privateCAID", {
      type: "String",
      description: "The private CA ID to use to issue the certificate.",
    });

    const vpc = new Vpc(this, "mTLSVPC", {
      vpcName: "mTLSVPC",
    });
    new FlowLog(this, "mTLSFlowLog", {
      resourceType: FlowLogResourceType.fromVpc(vpc),
    });

    const privateApiEndpoint = vpc.addInterfaceEndpoint("mTLSApiEndpoint", {
      service: InterfaceVpcEndpointAwsService.APIGATEWAY,
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

    apiSecret.grantRead(new AccountPrincipal(consumerAccountId.valueAsString));
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

    const nlbListener = nlb.addListener("HttpsListener", {
      port: 443,
    });

    const albAccessLogs = new Bucket(this, "ALBAccessLogsBucket", {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: BucketEncryption.S3_MANAGED,
      serverAccessLogsPrefix: "logs",
      objectOwnership: ObjectOwnership.OBJECT_WRITER,
    });

    const albSecGroup = new SecurityGroup(this, "albSecGroup", {
      vpc,
      allowAllOutbound: true,
    })
    
    const alb = new ApplicationLoadBalancer(this, "ConsumerALB", {
      vpc,
      internetFacing: false,
      securityGroup: albSecGroup,
    })
    alb.logAccessLogs(albAccessLogs, "albAccessLogs")
    alb.connections.allowFrom(Peer.ipv4(vpc.vpcCidrBlock), Port.tcp(443))

    nlbListener.addTargets('ALBTargets', {
      targets: [new AlbTarget(alb, 443)],
      port: 443,
    });

    const tg = new ApplicationTargetGroup(this, "ApiTargetGroup", {
      targetType: TargetType.IP,
      port: 443,
      healthCheck: {
        enabled: true,
        protocol: Protocol.HTTPS,
        path: "/ping",
      },
      vpc,
    });

    const trustStoreFnRole = new Role(this, "trustStoreFnRole", {
      assumedBy: new ServicePrincipal("lambda.amazonaws.com").withSessionTags(),
    });
    trustStoreFnRole.addToPolicy(
      new PolicyStatement({
        resources: ["*"],
        actions: [
          "elasticloadbalancing:CreateTrustStore",
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
        ],
      })
    );

    const caBucket = new Bucket(this, "CABucket", {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: BucketEncryption.S3_MANAGED,
      serverAccessLogsPrefix: "logs",
      objectOwnership: ObjectOwnership.OBJECT_WRITER,
    })

    new BucketDeployment(this, "DeployCAFiles", {
      sources: [
        Source.asset("./ca")
      ],
      destinationBucket: caBucket,
    })

    const trustStoreFn = new NodejsFunction(
      this,
      "TrustStoreFunction",
      {
        runtime: Runtime.NODEJS_18_X,
        handler: "lambdaHandler",
        entry: "./trustStore/app.ts",
        role: trustStoreFnRole,
        timeout: Duration.seconds(120),
        environment: {
          BUCKET_NAME: caBucket.bucketName,
          BUCKET_KEY: "Certificate.pem",
          NAME: "alb-trust-store"
        },
        //bundle to grab latest sdk rather than default runtime version
        bundling: {
          externalModules: [],
        },
      }
    );
    caBucket.grantRead(trustStoreFn)

    const tsCustomResourceRole = new Role(this, "TrustStoreCustomResourceRole", {
      assumedBy: new ServicePrincipal("lambda.amazonaws.com").withSessionTags(),
    });
    tsCustomResourceRole.addToPolicy(
      new PolicyStatement({
        resources: ["*"],
        actions: [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
        ],
      })
    );

    const tsCustomProvider = new custom.Provider(
      this,
      "TrustStoreCustomProvider",
      {
        onEventHandler: trustStoreFn,
        role: tsCustomResourceRole,
      }
    );

    const ts = new CustomResource(this, "TrustStoreCreate", {
      serviceToken: tsCustomProvider.serviceToken,
    });

    const cert = new PrivateCertificate(this, 'PrivateCertificate', {
      domainName: domainName.valueAsString,
      certificateAuthority: CertificateAuthority.fromCertificateAuthorityArn(this, 'CA',
      `arn:aws:acm-pca:${process.env.CDK_DEFAULT_REGION}:${process.env.CDK_DEFAULT_ACCOUNT}:certificate-authority/` + privateCAID.valueAsString),
    });

    const albListener = new CfnListener(this, 'ALBListener', {
      port: 443,
      protocol: "HTTPS",
      
      certificates: [{certificateArn: cert.certificateArn}],
      defaultActions: [{
        type: "forward",
        targetGroupArn: tg.targetGroupArn,
        forwardConfig: {
          targetGroups: [{
            targetGroupArn: tg.targetGroupArn,
            weight: 100
          }]
        }
      }],
      loadBalancerArn: alb.loadBalancerArn
      //todo: uncomment once supported in cdk
      // ,mutualAuthentication: {
      //   mode: "verify",
      //   trustStoreArn: ts.getAtt("PhysicalResourceId").toString()
      // }
    })

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
        runtime: Runtime.NODEJS_18_X,
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
              "aws:SourceVpce": privateApiEndpoint.vpcEndpointId,
            },
          },
        }),
      ],
    });

    const apiHandler = new NodejsFunction(this, "ProducerApiFunction", {
      runtime: Runtime.NODEJS_18_X,
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
        resources: [apiSecret.secretFullArn!],
        actions: ["secretsmanager:GetSecretValue"],
      })
    );

    const authorizerFn = new NodejsFunction(this, "AuthorizerFunction", {
      runtime: Runtime.NODEJS_16_X,
      handler: "lambdaHandler",
      entry: "./authorizer/app.ts",
      environment: {
        API_KEY: apiSecret.secretFullArn!,
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
