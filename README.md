# Bitwarden Sync Web UI

[![CodeQL](https://github.com/vchatela-org/bitwarden-sync-webui/actions/workflows/codeql.yml/badge.svg)](https://github.com/vchatela-org/bitwarden-sync-webui/actions/workflows/codeql.yml)
[![GHCR Publish](https://github.com/vchatela-org/bitwarden-sync-webui/actions/workflows/ghcr-publish.yml/badge.svg)](https://github.com/vchatela-org/bitwarden-sync-webui/actions/workflows/ghcr-publish.yml)
[![Docker Build & Push](https://github.com/vchatela-org/bitwarden-sync-webui/actions/workflows/docker-build-push.yml/badge.svg)](https://github.com/vchatela-org/bitwarden-sync-webui/actions/workflows/docker-build-push.yml)
[![Dependabot](https://img.shields.io/badge/Dependabot-enabled-brightgreen?logo=dependabot)](.github/dependabot.yml)
[![Vulnerabilities](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/vchatela-org/bitwarden-sync-webui/badges/vuln-badge.json)](https://github.com/vchatela-org/bitwarden-sync-webui/actions/workflows/ghcr-publish.yml)

A self-hosted **web UI for syncing Bitwarden vaults between any number of Bitwarden instances**
(cloud regions, self-hosted servers, or a mix), implemented as a TypeScript/Node.js backend +
React SPA, deployed as a Docker image into a k3s cluster.

Each user or org target declares its own source (`from`) and destination (`to`) vault, so a single
deployment can sync different targets between different instance pairs at once (e.g. one target
`eu → com`, another `com → selfhosted`) — see [Configuration](#configuration-targetsjson).

---

## Quick start (local development)

```bash
# 1. Install dependencies
npm install

# 2. Set required environment variables
export UI_PASSWORD=mysecretpassword
export SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")
export CONFIG_PATH=./config/targets.json   # see config/targets.json.example

# 3. Start backend + Vite dev server together
npm run dev

# Server:  http://localhost:3000
# Vite:    http://localhost:5173  (proxies /api → :3000)
```

> During development the Vite dev server at `:5173` proxies `/api` to the backend at `:3000`.
> For production, the compiled SPA is served directly from the Node process.

---

## Building for production

```bash
npm run build
# Server binary: server/dist/index.js
# SPA assets:    server/dist/public/
```

---

## Running tests

```bash
npm test
```

All tests are in `server/test/`. They run with Vitest and need no network or real `bw` binary.

---

## Docker build

```bash
docker build -t bitwarden-webui:latest .
```

Override the Bitwarden CLI version:

```bash
docker build --build-arg BW_CLI_VERSION=2026.7.0 -t bitwarden-webui:latest .
```

The published image is also available at `ghcr.io/vchatela-org/bitwarden-sync-webui` (tags: `latest`
and semver versions) — see [Packages](https://github.com/vchatela-org/bitwarden-sync-webui/pkgs/container/bitwarden-sync-webui).

### Docker Compose

- `docker-compose.yml` — production stack, pulls the published GHCR image.
- `docker-compose.dev.yml` — local development stack, builds the image from source.

```bash
# Production (pulls ghcr.io/vchatela-org/bitwarden-sync-webui:latest)
docker compose up

# Development (builds from source)
docker compose -f docker-compose.dev.yml up --build
```

---

## Deploying to k3s

```bash
# 1. Create namespace
kubectl create namespace bitwarden

# 2. Edit deploy/configmap.yaml with your targets
# 3. Create real secrets (do NOT commit):
kubectl -n bitwarden create secret generic bitwarden-webui-secrets \
  --from-literal=UI_PASSWORD_HASH="$(node -e "import('argon2').then(a=>a.hash('yourpassword')).then(console.log)")" \
  --from-literal=SESSION_SECRET="$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")"

# 4. Apply manifests
kubectl apply -k deploy/

# 5. Watch rollout
kubectl -n bitwarden rollout status deployment/bitwarden-webui
```

---

## Configuration (`targets.json`)

The config file is mounted from a ConfigMap at `CONFIG_PATH` (default `/config/targets.json`).

```jsonc
{
  "vaults": [
    // Any number of named Bitwarden instances — each target below picks its own pair.
    { "key": "cloud", "name": "Cloud", "serverUrl": "https://vault.bitwarden.eu" },  // EU region — do NOT use bitwarden.com
    { "key": "home",  "name": "Home",  "serverUrl": "https://bitwarden.example.internal" }
  ],
  "backupFolder":   "/backups",
  "bitwardenConfigDir": "/data/bitwarden",
  "users": [
    { "key": "val",    "email": "val@example.com",    "displayName": "Val", "from": "cloud", "to": "home" },
    { "key": "mathou", "email": "mathou@example.com", "from": "cloud", "to": "home" }
  ],
  "orgs": [
    {
      "key": "org",
      "name": "My Organisation",
      "owner": "val",                                // must be a key in users[]
      "from": "cloud",
      "to": "home",
      "orgIds": {
        "cloud": "00000000-0000-0000-0000-000000000000",   // org ID on the cloud vault
        "home":  "00000000-0000-0000-0000-000000000000"    // org ID on the home vault
      }
    }
  ],
  "retention":  { "keepDaily": 7, "keepMonthly": 12 },
  "importGuard": { "minSourceRatio": 0.5, "blockOnEmptySource": true },
  "homeLogoutAfterImport": true
}
```

Add more entries to `vaults` and point targets' `from`/`to` at them to support more instance pairs.

### Migrating from `.bitwarden-env`

```bash
bash scripts/env-to-json.sh /path/to/.bitwarden-env > /tmp/targets.json
# Review /tmp/targets.json, then add it to a ConfigMap
```

---

## Generating the UI password hash

```bash
node -e "import('argon2').then(a => a.hash('your-ui-password')).then(console.log)"
```

Set the result as `UI_PASSWORD_HASH`. For development, set `UI_PASSWORD=plaintext` instead.

---

## Mounting an internal CA

If any of your self-hosted Bitwarden instances uses a certificate from an internal CA:

1. Create a ConfigMap from your CA bundle:
   ```bash
   kubectl -n bitwarden create configmap internal-ca --from-file=ca.crt=/path/to/ca.crt
   ```
2. Uncomment the `ca-bundle` volume and `NODE_EXTRA_CA_CERTS` env var in `deploy/deployment.yaml`.

`NODE_EXTRA_CA_CERTS` is inherited by the `bw` CLI child process (which is also a Node program),
so both the server's `fetch()` calls to `/ciphers/purge` and the CLI's HTTPS connections use the
same CA bundle.

---

## Backup item counts

Each backup a job produces gets a `.meta.json` sidecar recording the item, folder and collection
counts plus the SHA-256 of the password-protected export. The dashboard's **Items protected** tile
and the per-set **Items** column read from it.

Backups predating sidecars (or produced by older external tooling) have no sidecar, so the counts
fall back to the export itself. The account-key export (`*_encrypted.json`) keeps a
plain-text JSON envelope, so its `items`/`folders`/`collections` arrays can be counted without the
vault password even though every field inside them is ciphertext. `countSource` on each set says
which source was used.

The fallback reads file contents rather than just the directory listing, so results are cached in
`$DATA_DIR/backup-counts.json`, keyed on each file's size and mtime. The first `/api/backups` call
after a restart with an empty cache reads every export once (a few seconds over ~100 MB on a network
mount); later calls are served from the cache. Deleting the cache file is safe — it rebuilds.

The password-protected export (`*_encrypted_pass.json`) is a single opaque blob and yields no counts,
so a set that has lost its account-key export shows `—`.

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP listen port |
| `CONFIG_PATH` | `/config/targets.json` | Path to targets.json |
| `DATA_DIR` | `/data` | Directory for CLI profiles, job history + backup count cache |
| `UI_PASSWORD_HASH` | — | Argon2id hash of the UI password (preferred) |
| `UI_PASSWORD` | — | Plaintext UI password (dev only) |
| `SESSION_SECRET` | random | Cookie signing secret — set in production |
| `LOG_LEVEL` | `info` | Log verbosity |
| `NODE_EXTRA_CA_CERTS` | — | Path to extra CA bundle (for internal TLS) |
| `TRUST_PROXY` | — | Set `1` when behind an HTTP reverse proxy |
| `BW_CLI_PINNED_VERSION` | (from Dockerfile build arg) | Asserted at boot |
| `BW_FIFO_DIR` | `/run/bw-fifo` | tmpfs directory for password FIFOs |
| `PASSWORD_TTL_MS` | `900000` | Idle TTL for cached master passwords (15 min) |

---

## Security notes

- Master passwords live **in RAM only**, never on disk, never in any env var, never in any log line.
  They reach the `bw` CLI through a FIFO (mode 0600) and are cleared when the job ends.
- The UI password is verified with Argon2id (constant-time).
- Session cookies are `HttpOnly`, `SameSite=Strict`, `Secure` (when behind TLS).
- CSRF token required on all mutating requests.
- `readOnlyRootFilesystem: true` — the only writable paths are the PVC mounts and the two `emptyDir` volumes.
- Core dumps disabled in the entrypoint (`ulimit -c 0`).
