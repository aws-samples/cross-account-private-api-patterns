# NGINX Reverse Proxy with mTLS Termination

This Dockerfile builds an nginx reverse proxy that acts as the termination for mTLS-based connections and will establish a standard TLS connection to the backend resource

## Instructions

First generate the client and server SSL certificates to be used by the mTLS handshake. Be sure to specify the Common Name field for the domain you wish to verify (e.g. local.dev)

### Server

```
openssl genrsa -out server.key 2048
openssl req -new -key server.key -out server.csr
```

```
openssl x509 -req -days 3650 -in server.csr -signkey server.key -out server.crt
```

### Client

```
openssl genrsa -out client.key 2048
openssl req -new -key client.key -out client.csr
```

```
openssl x509 -req -days 3650 -in client.csr -signkey client.key -out client.crt
```

### NGINX

Update the nginx.conf file to replace the proxy URL location with the URL of your backend resource.

### Docker

Build the docker image which will copy the nginx config and ssl certs

```
docker build . -t mtls
```

## Testing

To test it locally, run an instance of the docker image built in the last step and make an HTTPS request to localhost supplying the client certificate. Make sure you have the DNS name you are using added to your hosts file (e.g. local.dev).

```
docker run -p 8080:443 mtls
```

```
curl --key client.key --cert client.crt --cacert server.crt  https://local.dev:8080
```

## Deployment

This container image can then be deployed on any container orchestration platform such as Amazon ECS or EKS.
