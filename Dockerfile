# ─── Build stage: compile web SPA ────────────────────────────────────────────
FROM node:22-alpine AS web-builder
WORKDIR /app
COPY web/package.json ./web/
COPY package.json ./
RUN npm install --workspace=web
COPY web/ ./web/
RUN npm run build --workspace=web

# ─── Build stage: compile TypeScript server ───────────────────────────────────
FROM node:22-alpine AS server-builder
WORKDIR /app
COPY server/package.json ./server/
COPY package.json ./
RUN npm install --workspace=server
COPY server/ ./server/
RUN npm run build --workspace=server

# ─── Runtime stage ────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime

ARG BW_CLI_VERSION=2025.12.0
ARG UID=1000

# Install the Bitwarden CLI at a pinned version
RUN npm install -g @bitwarden/cli@${BW_CLI_VERSION} \
 && bw --version \
 && echo "Installed bw $(bw --version)"

# Store the pinned version so the app can assert it at boot
ENV BW_CLI_PINNED_VERSION=${BW_CLI_VERSION}

WORKDIR /app

# Copy compiled server + pre-built SPA (in dist/public)
COPY --from=server-builder /app/server/dist ./dist
COPY --from=server-builder /app/server/node_modules ./node_modules
COPY --from=web-builder /app/server/dist/public ./dist/public

# Create runtime directories that will be mount-points in the pod
# The actual data lives on PVCs; we just create the mount points.
RUN mkdir -p /backups /data /config /run/bw-fifo /tmp \
 && chown -R ${UID}:${UID} /app /run/bw-fifo /tmp

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

USER ${UID}

ENV PORT=3000 \
    CONFIG_PATH=/config/targets.json \
    DATA_DIR=/data \
    BW_FIFO_DIR=/run/bw-fifo \
    NODE_OPTIONS=--no-deprecation

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/health || exit 1

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "dist/index.js"]
