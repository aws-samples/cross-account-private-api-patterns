1. Create ACM Private CA, specify CN for domain (e.g. api.workshop.josharj.people.aws.dev)
2. Upload Certificate.pem to S3 bucket
3. Create Trust Store, point at uploaded Certificate.pem
4. Update Listener to use Trust Store & Verify mTLS
5. Generate client certificate against PCA: https://aws.amazon.com/blogs/security/use-acm-private-ca-for-amazon-api-gateway-mutual-tls/

```
openssl req -new -newkey rsa:2048 -days 365 -keyout my_client.key -out my_client.csr
```
```
aws acm-pca issue-certificate --certificate-authority-arn arn:aws:acm-pca:us-east-1:account_id:certificate-authority/certificate_authority_id --csr fileb://my_client.csr --signing-algorithm "SHA256WITHRSA" --validity Value=365,Type="DAYS" --template-arn arn:aws:acm-pca:::template/EndEntityCertificate/V1
```
```
aws acm-pca get-certificate -certificate-authority-arn arn:aws:acm-pca:us-east-1:account_id:certificate-authority/certificate_authority_id --certificate-arn arn:aws:acm-pca:us-east-1:account_id:certificate-authority/certificate_authority_id/certificate/certificate_id --output text
```

(optional) - if you set a passphrase on the key:

```
openssl rsa -in my_client.key -out client.key
```

6. Test using cert & host header
curl --key my_client.key --cert my_client.pem https:/api2.workshop.josharj.people.aws.dev/prod/get  -H 'x-apigw-api-id:q1n11yc5tc'

7. Or hit the API GW hostname directly: 
curl --key client.key --cert my_client.pem https://q1n11yc5tc.execute-api.eu-west-2.amazonaws.com/prod/get

