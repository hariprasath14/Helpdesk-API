# One image for the API and the worker, in every environment (the temporary dev server now, ECS
# later). What runs is chosen by the command: node dist/server.js (default), node dist/worker.js,
# or node dist/db/migrate.js up. All settings come from environment variables (src/config).

FROM node:24.22.1-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: no Git hooks (husky) or other install scripts inside the image.
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:24.22.1-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
# Files uploaded with STORAGE_DRIVER=local (./storage); a volume is mounted here.
RUN mkdir -p /app/storage && chown node:node /app/storage
USER node
EXPOSE 4000
CMD ["node", "dist/server.js"]
