# Build from the repository root with -f apps/site/Dockerfile.
# Marketing has no database credentials, media worker or private sharing routes.
FROM node:24.14.1-bookworm-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm install --global pnpm@11.25.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY patches ./patches
COPY apps/site/package.json ./apps/site/package.json
COPY packages/contracts/package.json ./packages/contracts/package.json
COPY packages/reveal/package.json ./packages/reveal/package.json
COPY packages/design/package.json ./packages/design/package.json
COPY packages/web-ui/package.json ./packages/web-ui/package.json
RUN pnpm --filter @peekalo/site... install --frozen-lockfile --ignore-scripts
COPY apps/site ./apps/site
COPY packages/contracts ./packages/contracts
COPY packages/reveal ./packages/reveal
COPY packages/design ./packages/design
COPY packages/web-ui ./packages/web-ui
RUN pnpm --filter @peekalo/site build

FROM node:24.14.1-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
COPY --from=builder --chown=node:node /app/apps/site/.next/standalone ./
COPY --from=builder --chown=node:node /app/apps/site/.next/static ./apps/site/.next/static
COPY --from=builder --chown=node:node /app/apps/site/public ./apps/site/public
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=6s --start-period=30s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/site/server.js"]
