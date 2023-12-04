import axios from 'axios';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";

const secretManager = new SecretsManagerClient({});

export interface GetWidgetEvent {}

export const lambdaHandler = async (event: GetWidgetEvent) => {
    const input = {
        SecretId: process.env.API_KEY,
    };
    const command = new GetSecretValueCommand(input);
    const secretResponse = await secretManager.send(command);
    const response = await axios.get(process.env.apiUrl!, {
        headers: {
            'Authorization': secretResponse.SecretString
        }
    });
    return {
        statusCode: 200,
        body: JSON.stringify(response.data),
    };
};
