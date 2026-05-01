FROM node:20-alpine

WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .

RUN mkdir -p client_sessions backups comprobantes

EXPOSE 3000 3001
