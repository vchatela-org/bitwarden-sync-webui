#!/bin/sh
# Entrypoint: harden process then start the server.
# Runs as non-root (uid 1000).

# Disable core dumps — a crash must not spill the master password or a
# decrypted vault to disk (mirrors the bash script's `ulimit -c 0`).
ulimit -c 0 2>/dev/null || true

exec "$@"
