FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/bridge/package.json apps/bridge/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/widget/package.json apps/widget/package.json
COPY apps/sample-host/package.json apps/sample-host/package.json
COPY packages/core/package.json packages/core/package.json
RUN npm ci
COPY . .
ARG API_URL=http://api:4000
ARG WIDGET_ORIGIN=http://localhost:4000
ENV API_URL=$API_URL
ENV WIDGET_ORIGIN=$WIDGET_ORIGIN
RUN npm run build \
    && cp -R apps/web/.next/static apps/web/.next/standalone/apps/web/.next/static \
    && cp -R apps/web/public apps/web/.next/standalone/apps/web/public
ENV NODE_ENV=production
USER node
EXPOSE 3000 4000
