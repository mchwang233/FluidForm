FROM node:22-slim
WORKDIR /app
COPY server/package.json server/package-lock.json ./server/
RUN npm ci --prefix server
COPY server/tsconfig.json ./server/
COPY server/src ./server/src
COPY server/packages ./server/packages
COPY skills ./skills
RUN npm run --prefix server build && npm prune --omit=dev --prefix server
EXPOSE 8000
CMD ["node", "--disable-warning=ExperimentalWarning", "server/dist/main.js", "--host", "0.0.0.0", "--port", "8000"]
