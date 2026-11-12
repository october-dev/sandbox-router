# Self-hosted Sandbox Router: the API and worker in one process.
#   docker build -t sandbox-router .
#   docker run -e DATABASE_URL=... -e ADMIN_TOKEN=... -e E2B_API_KEY=... -p 8787:8787 sandbox-router
FROM node:26-slim

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
RUN npx --yes pnpm@10.34.9 install --frozen-lockfile --prod --filter "@sr/server..." \
  && npm cache clean --force

ENV NODE_ENV=production PORT=8787
EXPOSE 8787
USER node
CMD ["node", "packages/server/src/self-hosted.ts"]
