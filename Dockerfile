# Minimal image for the lying-rpc Devcon workshop proxy.
# UPSTREAM_RPC is intentionally NOT baked into the image; set it at `docker run`
# or in docker-compose.yml so one image serves any upstream.

FROM node:22-alpine

WORKDIR /app

# Install deps first so this layer caches across source edits.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY server.js ./

ENV PORT=8545
EXPOSE 8545

CMD ["node", "server.js"]
