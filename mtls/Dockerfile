FROM nginx:alpine

COPY ./nginx.conf /etc/nginx/conf.d/default.conf

COPY ./server.key /etc/ssl/server.key
COPY ./server.crt /etc/ssl/server.crt
COPY ./client.crt /etc/ssl/client.crt
