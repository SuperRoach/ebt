FROM node:24-bookworm-slim

WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json tsconfig.json ./
# The root lockfile includes the client workspace; only its manifest is needed.
COPY client/package.json client/
COPY shared/ shared/
COPY server/package.json server/prisma7.config.ts server/
COPY server/prisma/ server/prisma/
COPY server/src/ server/src/
RUN npm ci --include=dev --workspace @ebt/server --workspace @ebt/shared --include-workspace-root

ENV NODE_ENV=production
EXPOSE 8080
CMD ["sh", "-c", "node --import tsx server/src/migrate.ts && exec node --import tsx server/src/main.ts"]
