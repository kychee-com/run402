FROM node:22-alpine AS builder

WORKDIR /app

# Copy workspace root
COPY package.json tsconfig.base.json ./

# Copy shared package
COPY packages/shared/package.json packages/shared/
COPY packages/shared/tsconfig.json packages/shared/
COPY packages/shared/src packages/shared/src/

# Copy gateway package
COPY packages/gateway/package.json packages/gateway/
COPY packages/gateway/tsconfig.json packages/gateway/

# Install all workspace deps
RUN npm install --workspaces

# Copy gateway source
COPY packages/gateway/src packages/gateway/src/

# Build shared then gateway
RUN npm run build -w packages/shared
RUN npm run build -w packages/gateway

# --- Production stage ---
FROM node:22-alpine

WORKDIR /app

COPY package.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/gateway/package.json packages/gateway/

RUN npm install --workspaces --omit=dev

COPY --from=builder /app/packages/shared/dist packages/shared/dist/
COPY --from=builder /app/packages/gateway/dist packages/gateway/dist/

# Copy init.sql for Lambda custom resource
COPY packages/gateway/src/db/init.sql packages/gateway/dist/db/init.sql

ENV NODE_ENV=production
ENV PORT=4022

EXPOSE 4022

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:4022/health || exit 1

CMD ["node", "packages/gateway/dist/server.js"]
