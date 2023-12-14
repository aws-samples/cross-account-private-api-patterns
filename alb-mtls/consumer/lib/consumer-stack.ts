import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import {
  Vpc,
  FlowLog,
  FlowLogResourceType,
  Instance,
  InstanceType,
  InstanceClass,
  InstanceSize,
  MachineImage,
  InterfaceVpcEndpoint,
  InterfaceVpcEndpointService,
} from "aws-cdk-lib/aws-ec2";
import { CfnParameter } from "aws-cdk-lib";


export class ConsumerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const endpointService = new CfnParameter(this, "endpointService", {
      type: "String",
      description: "The Service Name of the producer VPC Endpoint Service.",
    });

    const vpc = new Vpc(this, "ConsumerVPC", {
      vpcName: "ConsumerVPC",
    });
    new FlowLog(this, "FlowLog", {
      resourceType: FlowLogResourceType.fromVpc(vpc),
    });
    
    new Instance(this, 'consumerInstance', {
      vpc,
      detailedMonitoring: true,
      instanceType: InstanceType.of(InstanceClass.T3, InstanceSize.MICRO),
      machineImage: MachineImage.latestAmazonLinux2023(),
      ssmSessionPermissions: true,
    });

    new InterfaceVpcEndpoint(this, 'VPCEndpoint', {
      vpc,
      service: new InterfaceVpcEndpointService(endpointService.valueAsString, 443),
      privateDnsEnabled: true,
      subnets: {
        availabilityZones: vpc.availabilityZones
      }
    });

  }
}
