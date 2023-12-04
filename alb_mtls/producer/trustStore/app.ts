import { ElasticLoadBalancingV2Client, CreateTrustStoreCommand, DescribeTrustStoresCommand} from '@aws-sdk/client-elastic-load-balancing-v2';
const elbv2 = new ElasticLoadBalancingV2Client({});

export const lambdaHandler = async (event: any, context: any) => {
    console.log('REQUEST RECEIVED:\n' + JSON.stringify(event));
    if (event.RequestType == 'Delete') {
        await sendResponse(event, context, 'SUCCESS', '');
        return;
    }
    try {
        const s3Bucket = process.env.BUCKET_NAME;
        const s3Key = process.env.BUCKET_KEY;
        const name = process.env.NAME;
        
        const params = {
            CaCertificatesBundleS3Bucket: s3Bucket,
            CaCertificatesBundleS3Key: s3Key,
            Name: name
        };
        const createCommand = new CreateTrustStoreCommand(params);
        const response = await elbv2.send(createCommand);
        const arn = response.TrustStores![0].TrustStoreArn!;

        let status = "CREATING";
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        while (status !== "ACTIVE") { 
            const describeParams = {
                TrustStoreArns: [
                    arn
                ]
            }
            const command = new DescribeTrustStoresCommand(describeParams);
            const result = await elbv2.send(command);
            await new Promise(resolve => setTimeout(resolve, 5000));
            status = result.TrustStores![0].Status!;
        }

        await sendResponse(event, context, 'SUCCESS', arn!);
    } catch (e) {
        console.log(e);
        await sendResponse(event, context, 'FAILED', '');
    }
};

const sendResponse = async (event: any, context: any, responseStatus: string, arn: string) => {
    const responseBody = JSON.stringify({
        Status: responseStatus,
        Reason: 'See the details in CloudWatch Log Stream: ' + context.logStreamName,
        PhysicalResourceId: arn,
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
