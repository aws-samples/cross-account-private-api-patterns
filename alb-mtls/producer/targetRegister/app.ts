import { EC2Client, DescribeNetworkInterfacesCommand, DescribeVpcEndpointsCommand } from '@aws-sdk/client-ec2';
import { ElasticLoadBalancingV2Client, RegisterTargetsCommand } from '@aws-sdk/client-elastic-load-balancing-v2';
const ec2 = new EC2Client({});
const elb = new ElasticLoadBalancingV2Client({});

export const lambdaHandler = async (event: any, context: any) => {
    console.log('REQUEST RECEIVED:\n' + JSON.stringify(event));
    if (event.RequestType == 'Delete') {
        await sendResponse(event, context, 'SUCCESS');
        return;
    }
    try {
        const describeEndpointsParams = {
            VpcEndpointIds: [process.env.vpceId!],
        };
        const describeEndpointsCommand = new DescribeVpcEndpointsCommand(describeEndpointsParams);
        const endpoints = await ec2.send(describeEndpointsCommand);
        const endpointArray: string[] = [];
        endpoints.VpcEndpoints![0].NetworkInterfaceIds?.map((it) => endpointArray.push(it));
        console.log(endpointArray);

        const describeEniParams = {
            NetworkInterfaceIds: endpointArray,
        };
        const describeEniCommand = new DescribeNetworkInterfacesCommand(describeEniParams);
        const enis = await ec2.send(describeEniCommand);
        console.log(enis);

        for (let ip = 0; ip < enis.NetworkInterfaces!.length!; ip++) {
            const addTargetParams = {
                TargetGroupArn: process.env.targetGroupArn!,
                Targets: [{ Id: enis.NetworkInterfaces![ip].PrivateIpAddress! }],
            };
            const addTargetCommand = new RegisterTargetsCommand(addTargetParams);
            await elb.send(addTargetCommand);
        }
        await sendResponse(event, context, 'SUCCESS');
    } catch (e) {
        console.log(e);
        await sendResponse(event, context, 'FAILED');
    }
};

const sendResponse = async (event: any, context: any, responseStatus: string) => {
    const responseBody = JSON.stringify({
        Status: responseStatus,
        Reason: 'See the details in CloudWatch Log Stream: ' + context.logStreamName,
        PhysicalResourceId: context.logStreamName,
        StackId: event.StackId,
        RequestId: event.RequestId,
        LogicalResourceId: event.LogicalResourceId,
    });

    console.log('RESPONSE BODY:\n', responseBody);

    const https = require('https');
    const url = require('url');

    const parsedUrl = url.parse(event.ResponseURL);
    const options = {
        hostname: parsedUrl.hostname,
        port: 443,
        path: parsedUrl.path,
        method: 'PUT',
        headers: {
            'content-type': '',
            'content-length': responseBody.length,
        },
    };

    console.log('SENDING RESPONSE...\n');

    const request = https.request(options, function (response: any) {
        console.log('STATUS: ' + response.statusCode);
        console.log('HEADERS: ' + JSON.stringify(response.headers));
        context.done();
    });

    request.on('error', function (error: any) {
        console.log('sendResponse Error:' + error);
        context.done();
    });
    request.write(responseBody);
    request.end();
};
