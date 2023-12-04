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
} from "aws-cdk-lib/aws-ec2";


export class ConsumerVpcStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = new Vpc(this, "ConsumerVPC", {
      vpcName: "ConsumerVPC",
    });
    new FlowLog(this, "FlowLog", {
      resourceType: FlowLogResourceType.fromVpc(vpc),
    });
    
    new Instance(this, 'consumerInstance', {
      vpc,
      instanceType: InstanceType.of(InstanceClass.T4G, InstanceSize.MICRO),
      machineImage: MachineImage.latestAmazonLinux2023(),
      ssmSessionPermissions: true,
    });
  }
}
