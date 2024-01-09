import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import { CfnParameter, CustomResource, Duration } from "aws-cdk-lib";
import * as custom from "aws-cdk-lib/custom-resources";
import { LogGroup } from "aws-cdk-lib/aws-logs";
import {
  AccessLogFormat,
  CfnAccount,
  Deployment,
  DomainName,
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
  CfnVPCEndpointService,
  CfnVPCEndpointServicePermissions,
} from "aws-cdk-lib/aws-ec2";
import {
  NetworkLoadBalancer,
  Protocol,
  TargetType,
  ApplicationLoadBalancer,
  CfnListener,
  ApplicationTargetGroup,
  CfnTrustStore
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
import { Certificate, CertificateValidation } from "aws-cdk-lib/aws-certificatemanager";
import { HostedZone } from "aws-cdk-lib/aws-route53";

export class ProducerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const resource = "widgets";

    // Required input parameters
    const consumerAccountId = new CfnParameter(this, "consumerAccountId", {
      type: "String",
      description: "The AWS Account ID of the producer account.",
    });

    const subdomain = new CfnParameter(this, "subdomain", {
      type: "String",
      description: "The domain name to create a default SSL certificate for the application load balancer e.g. mydomain.com",
    });

    const domain  = new CfnParameter(this, "domainName", {
      type: "String",
      description: "The domain name to create a subdomain for the service e.g. mtls.mydomain.com",
    });

    const hostedZoneId = new CfnParameter(this, "hostedZoneId", {
      type: "String",
      description: "The hosted zone to create the subdomain.",
    });

    // Basic networking setup
    const vpc = new Vpc(this, "mTLSVPC", {
      vpcName: "mTLSVPC",
    });
    new FlowLog(this, "mTLSFlowLog", {
      resourceType: FlowLogResourceType.fromVpc(vpc),
    });

    const privateApiEndpoint = vpc.addInterfaceEndpoint("mTLSApiEndpoint", {
      service: InterfaceVpcEndpointAwsService.APIGATEWAY,
    });

    //API Key for basic auth
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

    //PrivateLink configuration
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

    const cfnVPCEndpointService = new CfnVPCEndpointService(this, 'VPCEndpointService', {
      acceptanceRequired: false, // In a production environment, you may want to require manual acceptance
      networkLoadBalancerArns: [nlb.loadBalancerArn]
    });

    const cfnVPCEndpointServicePermissions = new CfnVPCEndpointServicePermissions(this, 'VPCEndpointServicePermissions', {
      serviceId: cfnVPCEndpointService.getAtt("ServiceId").toString(),
      allowedPrincipals: ['arn:aws:iam::' + consumerAccountId.valueAsString + ':root'],
    });

    const configurePrivateDNSRole = new Role(this, "configurePrivateDNSRole", {
      assumedBy: new ServicePrincipal("lambda.amazonaws.com").withSessionTags(),
    });
    configurePrivateDNSRole.addToPolicy(
      new PolicyStatement({
        resources: ["*"],
        actions: [
          "ec2:DescribeVpcEndpoints",
          "ec2:DescribeNetworkInterfaces",
          "ec2:ModifyVpcEndpointServiceConfiguration",
          "ec2:DescribeVpcEndpointServiceConfigurations",
          "ec2:StartVpcEndpointServicePrivateDnsVerification",
          "route53:ChangeResourceRecordSets",
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
        ],
      })
    );

    const configurePrivateDNSFn = new NodejsFunction(
      this,
      "configurePrivateDNSFunction",
      {
        runtime: Runtime.NODEJS_18_X,
        handler: "lambdaHandler",
        entry: "./configurePrivateDNS/app.ts",
        role: configurePrivateDNSRole,
        timeout: Duration.seconds(600), // domain verification process can take up to 10 minutes
        environment: {
          SERVICE_ID: cfnVPCEndpointService.getAtt("ServiceId").toString(),
          DNS_NAME: subdomain.valueAsString + "." + domain.valueAsString,
          ROOT_DNS: domain.valueAsString,
          HOSTED_ZONE_ID: hostedZoneId.valueAsString,
        },
      }
    );

    const configurePrivateDNSCRRole = new Role(this, "configurePrivateDNSCRRole", {
      assumedBy: new ServicePrincipal("lambda.amazonaws.com").withSessionTags(),
    });
    configurePrivateDNSCRRole.addToPolicy(
      new PolicyStatement({
        resources: ["*"],
        actions: [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
        ],
      })
    );

    const configurePrivateDNSProvider = new custom.Provider(
      this,
      "configurePrivateDNSProvider",
      {
        onEventHandler: configurePrivateDNSFn,
        role: configurePrivateDNSCRRole,
      }
    );

    const dnsService = new CustomResource(this, "configurePrivateDNS", {
      serviceToken: configurePrivateDNSProvider.serviceToken,
    });

    const vpcEndpointServiceName = new custom.AwsCustomResource(
      this,
      "vpcEndpointServiceName",
      {
        onCreate: {
          service: "EC2",
          action: "describeVpcEndpointServiceConfigurations",
          parameters: {
            ServiceIds: [cfnVPCEndpointService.getAtt("ServiceId").toString()],
          },
          physicalResourceId: custom.PhysicalResourceId.fromResponse(
            "ServiceConfigurations.0.ServiceName"
          ),
          outputPaths: ["ServiceConfigurations.0.ServiceName"],
        },
        policy: custom.AwsCustomResourcePolicy.fromSdkCalls({
          resources: custom.AwsCustomResourcePolicy.ANY_RESOURCE,
        }),
      }
    );
    const serviceName = vpcEndpointServiceName.getResponseField(
      "ServiceConfigurations.0.ServiceName"
    );

    const outputEndpointService = new cdk.CfnOutput(this, "ServiceName", {
      value: serviceName,
      exportName: "ServiceName",
    });

    const outputNlb = new cdk.CfnOutput(this, "ConsumerNLBArnOutput", {
      value: nlb.loadBalancerArn,
      exportName: "ConsumerNLBArn",
    });

    const nlbListener = nlb.addListener("HttpsListener", {
      port: 443,
    });

    //mTLS configuration
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

    const uploadCa = new BucketDeployment(this, "DeployCAFiles", {
      sources: [
        Source.asset("./ca")
      ],
      destinationBucket: caBucket,
    })

    const ts = new CfnTrustStore(this, 'TrustStore', {
      caCertificatesBundleS3Bucket: caBucket.bucketName,
      caCertificatesBundleS3Key:  "Certificate.pem",
      name: "alb-trust-store",
    })
    ts.node.addDependency(uploadCa)

    const hostedZone = HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
      zoneName: domain.valueAsString,
      hostedZoneId: hostedZoneId.valueAsString
    });

    const cert = new Certificate(this, 'Certificate', {
      domainName: subdomain.valueAsString + "." + domain.valueAsString,
      validation: CertificateValidation.fromDns(hostedZone),
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
      loadBalancerArn: alb.loadBalancerArn,
      mutualAuthentication: {
        mode: "verify",
        trustStoreArn: ts.getAtt("TrustStoreArn").toString()
      }
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

    // Producer API configuration
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

    const domainName = new DomainName(this, 'APIDomainName', {
      certificate: cert,
      domainName: subdomain.valueAsString + "." + domain.valueAsString
    });

    domainName.addBasePathMapping(api, {
        stage: api.deploymentStage,
    })
    domainName.node.addDependency(deployment)

    const outputAPI = new cdk.CfnOutput(this, "ApiUrl", {
      value: api.urlForPath(`/${resource}`),
      exportName: "ApiUrl",
    });
  }
}
