import {
    EC2Client,
    ModifyVpcEndpointServiceConfigurationCommand,
    StartVpcEndpointServicePrivateDnsVerificationCommand,
    DescribeVpcEndpointServiceConfigurationsCommand
} from '@aws-sdk/client-ec2';
import { 
    Route53Client,
    ChangeResourceRecordSetsCommand,
    ChangeAction,
    RRType
} from '@aws-sdk/client-route-53';

const ec2 = new EC2Client({});
const route53 = new Route53Client({});

export const lambdaHandler = async (event: any, context: any) => {
    console.log('REQUEST RECEIVED:\n' + JSON.stringify(event));
    if (event.RequestType == 'Delete') {
        await sendResponse(event, context, 'SUCCESS', '');
        return;
    }
    try {
        const params = {
            ServiceId: process.env.SERVICE_ID,
            PrivateDnsName: process.env.DNS_NAME
        };
        const modifyVpceCommand = new ModifyVpcEndpointServiceConfigurationCommand(params);
        await ec2.send(modifyVpceCommand);

        const describeParams = {
            ServiceIds: [process.env.SERVICE_ID!]
        }

        let dnsValue = ""
        let dnsName = ""
        let serviceName = ""

        while (true) {
            const describeCommand = new DescribeVpcEndpointServiceConfigurationsCommand(describeParams);
            const result = await ec2.send(describeCommand);
            if (result.ServiceConfigurations![0].ServiceState == 'Available') {
                dnsValue = result.ServiceConfigurations![0].PrivateDnsNameConfiguration?.Value!;
                dnsName = result.ServiceConfigurations![0].PrivateDnsNameConfiguration?.Name!;
                serviceName = result.ServiceConfigurations![0].ServiceName!;                
                break;
            }
            await new Promise(resolve => setTimeout(resolve, 5000));
        }

        const createRoute53RecordParams = {
            HostedZoneId: process.env.HOSTED_ZONE_ID!,
            ChangeBatch: {
                Changes: [
                    {
                        Action: ChangeAction.CREATE,
                        ResourceRecordSet: {
                            Name: dnsName,
                            Type: RRType.TXT,
                            TTL: 300,
                            ResourceRecords: [
                                {
                                    Value: dnsValue
                                }
                            ]
                        }
                    }
                ]
            }
        }
        const createRoute53RecordCommand = new ChangeResourceRecordSetsCommand(createRoute53RecordParams);
        await route53.send(createRoute53RecordCommand);

        const verifyDnsParams = {
            ServiceId: process.env.SERVICE_ID,
        }

        const startEndpointDnsVerificationCommand = new StartVpcEndpointServicePrivateDnsVerificationCommand(verifyDnsParams);
        await ec2.send(startEndpointDnsVerificationCommand);

        while (true) {
            const describeCommand = new DescribeVpcEndpointServiceConfigurationsCommand(describeParams);
            const result = await ec2.send(describeCommand);
            if (result.ServiceConfigurations![0].PrivateDnsNameConfiguration?.State! == 'verified') {
                break;

            }
            await new Promise(resolve => setTimeout(resolve, 5000));
        }

        await sendResponse(event, context, 'SUCCESS', serviceName);
    } catch (e) {
        console.log(e);
        await sendResponse(event, context, 'FAILED', '');
    }
};

const sendResponse = async (event: any, context: any, responseStatus: string, serviceName: string) => {
    const responseBody = JSON.stringify({
        Status: responseStatus,
        Reason: 'See the details in CloudWatch Log Stream: ' + context.logStreamName,
        PhysicalResourceId: context.logStreamName,
        StackId: event.StackId,
        RequestId: event.RequestId,
        LogicalResourceId: event.LogicalResourceId,
        ServiceName: serviceName
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
