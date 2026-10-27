FROM jdxcode/mise:2026.10.21 AS mise

# node and pnpm versions come from mise.toml and mise.lock
FROM debian:trixie-slim AS deps
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=mise /usr/local/bin/mise /usr/local/bin/mise
ENV MISE_DATA_DIR=/mise MISE_TRUSTED_CONFIG_PATHS=/app PATH=/mise/shims:$PATH
WORKDIR /app
COPY mise.toml mise.lock ./
RUN mise install --locked && cp "$(mise which node)" /usr/local/bin/node
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile

FROM debian:trixie-slim
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data
RUN useradd --create-home --uid 1000 node
COPY --from=deps /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
# the curated collection is kept here between restarts
RUN mkdir /data && chown node:node /data
VOLUME /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT}/health`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "src/main.ts"]
