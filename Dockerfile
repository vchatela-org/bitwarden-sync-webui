# ─── Build stage: compile web SPA ────────────────────────────────────────────
FROM node:25-alpine AS web-builder
WORKDIR /app
COPY web/package.json ./web/
COPY package.json package-lock.json ./
RUN npm ci --workspace=web
COPY web/ ./web/
RUN npm run build --workspace=web

# ─── Build stage: compile TypeScript server ───────────────────────────────────
FROM node:25-alpine AS server-builder
WORKDIR /app
COPY server/package.json ./server/
COPY package.json package-lock.json ./
RUN npm ci --workspace=server
COPY server/ ./server/
RUN npm run build --workspace=server

# ─── Runtime stage ────────────────────────────────────────────────────────────
FROM node:25-alpine AS runtime

ARG BW_CLI_VERSION=2026.7.0
ARG UID=1000

# Install the Bitwarden CLI at a pinned version, then strip npm itself out of the
# runtime image: `bw` is a self-contained bundle invoked directly, npm is never
# called after this point, and npm vendors its own (frequently vulnerable) copies
# of tar/brace-expansion/sigstore/etc. that otherwise sit unused in the final image.
# Also apply pending Alpine package patches (e.g. libssl/libcrypto point fixes that
# lag the node:25-alpine base tag).
RUN npm install -g @bitwarden/cli@${BW_CLI_VERSION} \
 && bw --version \
 && echo "Installed bw $(bw --version)" \
 # CVE-2026-44705: patch the CLI's own vendored tmp@0.0.33 (pulled in by inquirer's
 # external-editor, an interactive-only feature this app never triggers) up to a
 # fixed release without waiting on an upstream @bitwarden/cli release. npm can't
 # dedupe the bump in place because external-editor pins "tmp": "^0.0.33", so it
 # demotes the old vulnerable copy into external-editor's own node_modules instead
 # of removing it. external-editor only calls tmp.tmpNameSync(), whose signature is
 # unchanged in 0.2.x, so deleting that shadow copy is safe: Node's module
 # resolution then walks up to the patched version above it, leaving a single
 # fixed copy on disk instead of a second vulnerable one hiding behind it.
 && npm install tmp@^0.2.6 --no-save --prefix /usr/local/lib/node_modules/@bitwarden/cli \
 && rm -rf /usr/local/lib/node_modules/@bitwarden/cli/node_modules/external-editor/node_modules/tmp \
 && npm uninstall -g npm corepack \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /root/.npm \
 && apk upgrade --no-cache

# Store the pinned version so the app can assert it at boot
ENV BW_CLI_PINNED_VERSION=${BW_CLI_VERSION}

WORKDIR /app

# Copy compiled server + pre-built SPA (in dist/public)
COPY --from=server-builder /app/server/dist ./dist
# Read at runtime by version.ts to report the app version alongside the bw CLI version
COPY --from=server-builder /app/server/package.json ./package.json
# npm workspaces hoist all dependencies to the root node_modules, not server/node_modules
COPY --from=server-builder /app/node_modules ./node_modules
COPY --from=web-builder /app/server/dist/public ./dist/public

# Create runtime directories that will be mount-points in the pod
# The actual data lives on PVCs; we just create the mount points.
RUN mkdir -p /backups /data /config /run/bw-fifo /tmp \
 && chown -R ${UID}:${UID} /app /backups /data /config /run/bw-fifo /tmp

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
