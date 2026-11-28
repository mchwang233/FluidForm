# The web console is a capability package FluidForm serves itself: its page is built here.
FROM node:22-slim AS web
WORKDIR /app
COPY frontend/package.json frontend/package-lock.json ./frontend/
RUN npm ci --prefix frontend
COPY frontend ./frontend
COPY server/packages/web/capability.json ./server/packages/web/capability.json
RUN npm run --prefix frontend package

FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    bubblewrap socat passt python3 python3-venv git curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY server/package.json server/package-lock.json ./server/
RUN npm ci --prefix server
COPY server/tsconfig.json server/entry.mjs ./server/
COPY server/src ./server/src
COPY server/packages ./server/packages
COPY --from=web /app/server/packages/web/site ./server/packages/web/site
COPY skills ./skills
RUN npm run --prefix server build && npm prune --omit=dev --prefix server \
  && mkdir -p /app/.fluidform /app/workspaces && chown -R node:node /app
USER node
EXPOSE 8000
CMD ["node", "--disable-warning=ExperimentalWarning", "server/dist/src/main.js", "--host", "0.0.0.0", "--port", "8000"]
