FROM node:24-bookworm-slim AS build
ENV PUPPETEER_SKIP_DOWNLOAD=true
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts
FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends chromium ca-certificates && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node sources ./sources
RUN mkdir results && chown node:node results
USER node
EXPOSE 3000
CMD ["node","dist/main.js"]
