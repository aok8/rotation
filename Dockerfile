FROM node:24-bookworm-slim AS build
WORKDIR /app

COPY server/package.json server/package-lock.json ./server/
COPY web/package.json web/package-lock.json ./web/
RUN npm --prefix server ci && npm --prefix web ci

COPY server ./server
COPY web ./web
RUN npm --prefix web run build && npm --prefix server run build && npm --prefix server prune --omit=dev

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=3000 DATA_DIR=/app/data WEB_DIST_DIR=/app/web/dist
WORKDIR /app
COPY --from=build --chown=node:node /app/server/package.json ./server/package.json
COPY --from=build --chown=node:node /app/server/node_modules ./server/node_modules
COPY --from=build --chown=node:node /app/server/dist ./server/dist
COPY --from=build --chown=node:node /app/web/dist ./web/dist
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/dist/index.js"]
