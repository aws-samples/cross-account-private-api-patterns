import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";

const secretManager = new SecretsManagerClient({});

export const lambdaHandler = async (
  event: any,
  context: any,
  callback: any
) => {
  const token = event.authorizationToken;
  const input = {
    SecretId: process.env.API_KEY,
  };
  const command = new GetSecretValueCommand(input);
  const response = await secretManager.send(command);

  switch (token) {
    case response.SecretString:
      callback(null, generatePolicy("user", "Allow", event.methodArn));
      break;
    default:
      callback("Error: Invalid token");
  }
};

const generatePolicy = (
  principalId: string,
  effect: string,
  resource: string
): any => {
  let authResponse: any = {};

  authResponse.principalId = principalId;
  if (effect && resource) {
    let policyDocument: any = {};
    policyDocument.Version = "2012-10-17";
    policyDocument.Statement = [];
    let statementOne: any = {};
    statementOne.Action = "execute-api:Invoke";
    statementOne.Effect = effect;
    statementOne.Resource = resource;
    policyDocument.Statement[0] = statementOne;
    authResponse.policyDocument = policyDocument;
  }

  return authResponse;
};
