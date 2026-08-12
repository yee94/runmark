FROM oven/bun:1.3.14-alpine AS builder

WORKDIR /src

COPY package.json bun.lock tsconfig.json ./
COPY packages ./packages
RUN bun install --frozen-lockfile
RUN bun build packages/server/src/index.ts --outdir /out --target bun --minify

FROM oven/bun:1.3.14-alpine

WORKDIR /app

COPY --from=builder --chown=bun:bun /out/index.js ./server.js
COPY --chown=bun:bun packages/server/public ./public
COPY --chown=bun:bun docker-entrypoint.sh /usr/local/bin/runmark-entrypoint
RUN mkdir -p /app/data && chown -R bun:bun /app
RUN chmod +x /usr/local/bin/runmark-entrypoint

ENV AGENT_TRACKER_PORT=3456 \
    AGENT_TRACKER_DB_PATH=/app/data/agent-tracker.db \
    AGENT_TRACKER_PUBLIC_DIR=/app/public \
    AGENT_TRACKER_LOG_FILE=/app/data/agent-tracker.log \
    AGENT_TRACKER_CURSOR_SYNC_ENABLED=false \
    AGENT_TRACKER_UPDATE_ENABLED=false \
    AGENT_TRACKER_UPDATE_STATE_PATH=/app/data/update-state.json

USER bun

EXPOSE 3456
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["bun", "-e", "const port=process.env.AGENT_TRACKER_PORT??'3456';const response=await fetch(`http://127.0.0.1:${port}/health`);if(!response.ok)process.exit(1)"]

ENTRYPOINT ["/usr/local/bin/runmark-entrypoint"]
CMD ["bun", "server.js"]
