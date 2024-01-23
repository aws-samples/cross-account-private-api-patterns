import { EC2Client, ModifyVpcEndpointCommand} from '@aws-sdk/client-ec2';
const ec2 = new EC2Client({});

export const lambdaHandler = async (event: any, context: any) => {
    console.log('REQUEST RECEIVED:\n' + JSON.stringify(event));
    if (event.RequestType == 'Delete') {
        await sendResponse(event, context, 'SUCCESS');
        return;
    }
    try {
        const apiId = process.env.API?.split(".")[0].replace("https://", "");
        const params = {
            VpcEndpointId: process.env.VPCE,
            PolicyDocument: `{\"Statement\":[{\"Action\":\"execute-api:Invoke\",\"Effect\":\"Allow\",\"Principal\":{\"AWS\":\"*\"},\"Resource\":\"arn:aws:execute-api:${process.env.REGION}:${process.env.ACCOUNT}:${apiId}/*\"}],\"Version\":\"2012-10-17\"}`
        };
        const modifyVpceCommand = new ModifyVpcEndpointCommand(params);
        await ec2.send(modifyVpceCommand);

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
