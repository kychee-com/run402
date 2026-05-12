FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY cli/package.json cli/package.json
COPY sdk/package.json sdk/package.json
COPY functions/package.json functions/package.json
RUN npm ci
COPY tsconfig.json ./
COPY core/ core/
COPY sdk/ sdk/
COPY functions/ functions/
COPY src/ src/
RUN npm run build

FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist dist/
COPY --from=build /app/core/dist core/dist/
COPY --from=build /app/sdk/dist sdk/dist/
COPY --from=build /app/sdk/core-dist sdk/core-dist/
ENTRYPOINT ["node", "dist/index.js"]
