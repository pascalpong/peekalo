# Build from the repository root. No backend credentials are needed at build time.
FROM node:24.14.1-bookworm-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm install --global pnpm@11.25.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY patches ./patches
COPY apps/web/package.json ./apps/web/package.json
COPY packages/contracts/package.json ./packages/contracts/package.json
COPY packages/reveal/package.json ./packages/reveal/package.json
COPY packages/design/package.json ./packages/design/package.json
COPY packages/web-ui/package.json ./packages/web-ui/package.json
RUN pnpm --filter @peekalo/web... install --frozen-lockfile --ignore-scripts
COPY apps/web ./apps/web
COPY packages/contracts ./packages/contracts
COPY packages/reveal ./packages/reveal
COPY packages/design ./packages/design
COPY packages/web-ui ./packages/web-ui
# Turbopack traces Sharp under a hashed .next alias. Preserve its normal pnpm
# alias too, so the independent startup preflight can require the same binary.
RUN pnpm --filter @peekalo/web build \
    && cp -P apps/web/node_modules/sharp apps/web/.next/standalone/apps/web/node_modules/sharp

FROM node:24.14.1-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000 \
    FFMPEG_PATH=/usr/bin/ffmpeg FFPROBE_PATH=/usr/bin/ffprobe
RUN apt-get update && apt-get install --yes --no-install-recommends ffmpeg ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=builder --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=node:node /app/apps/web/public ./apps/web/public
COPY --chown=node:node scripts/check-hosting-runtime.mjs ./scripts/check-hosting-runtime.mjs
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=6s --start-period=30s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sh", "-c", "node scripts/check-hosting-runtime.mjs && exec node apps/web/server.js"]
