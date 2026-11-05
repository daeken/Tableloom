# syntax=docker/dockerfile:1
# Keep the manifest list aligned with workspace packages when adding a module.
FROM node:24-bookworm-slim AS manifests
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json ./apps/server/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY packages/core/package.json ./packages/core/package.json
COPY packages/module-sdk/package.json ./packages/module-sdk/package.json
COPY systems/cyberpunk-red/package.json ./systems/cyberpunk-red/package.json
COPY systems/kids-on-bikes/package.json ./systems/kids-on-bikes/package.json
COPY systems/kids-on-brooms/package.json ./systems/kids-on-brooms/package.json

FROM manifests AS dependencies
RUN npm ci --no-audit --no-fund

FROM dependencies AS build
COPY tsconfig.json ./
COPY apps ./apps
COPY packages ./packages
COPY systems ./systems
RUN npm run build

FROM manifests AS production-dependencies
ENV NODE_ENV=production
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3001 DATA_DIR=/app/data
WORKDIR /app
# Includes workspace manifests/nested dependencies, but no TypeScript sources.
COPY --from=production-dependencies /app/ ./
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY LICENSE ./LICENSE
RUN mkdir -p /app/data && chown node:node /app/data && chmod 700 /app/data
USER node
VOLUME ["/app/data"]
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD ["node", "apps/server/dist/container-healthcheck.js"]
CMD ["node", "apps/server/dist/index.js"]
