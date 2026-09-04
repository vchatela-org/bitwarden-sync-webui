#!/bin/sh
# Entrypoint: harden process then start the server.
# Runs as non-root (uid 1000).

# Disable core dumps — a crash must not spill the master password or a
# decrypted vault to disk (mirrors the bash script's `ulimit -c 0`).
ulimit -c 0 2>/dev/null || true

# The bw CLI version this image was built against is baked in at build time (from
# docker/bw-cli/package.json, or a BW_CLI_VERSION build arg). Export it so the
# server can warn at boot if the installed CLI drifts from the pin. An explicitly
# provided BW_CLI_PINNED_VERSION always wins.
if [ -z "${BW_CLI_PINNED_VERSION:-}" ] && [ -r /etc/bw-cli-version ]; then
  BW_CLI_PINNED_VERSION="$(cat /etc/bw-cli-version)"
  export BW_CLI_PINNED_VERSION
fi

exec "$@"
