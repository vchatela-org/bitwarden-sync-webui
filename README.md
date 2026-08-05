# Bitwarden Sync Web UI

A self-hosted **web UI for Bitwarden cloud → self-hosted vault synchronisation**, implemented as a
TypeScript/Node.js backend + React SPA, deployed as a Docker image into a k3s cluster.

The bash script `bitwarden_export.sh` at the repository root **remains the CLI fallback path and is
not modified**. This UI is a parallel implementation.

---

## How this maps to `bitwarden_export.sh`

| Bash function / concept | Web UI equivalent |
|---|---|
| `bw-val`, `bw-home-val` | `cloudProfileDir()` / `homeProfileDir()` in `config.ts`; env set per call in `bwCli.ts` |
| `bw-init` (login/unlock/sync state machine) | `bwInit()` in `session.ts` |
| `ensure_master_password` / `pw_out` | `secrets.ts` (RAM-only Map) + FIFO in `bwCli.ts` |
| `purge_vault_via_api` | `purge.ts` (PBKDF2 hash + POST /ciphers/purge) |
| `backup_user` / `backup_org` | Export steps in `runner.ts` |
| `import_user` / `import_org` | Import steps in `runner.ts` |
| `dedupe_org_collections` | `collections.ts` |
| `group_accounts` / `group_targets` | `buildAccountGroups()` in `config.ts` |
| `backup_files[]` / `backup_failed[]` | `backupFiles` / `backupFailed` Maps in `runner.ts` |
| `-b` / `-i` / `-u` CLI flags | Job `operations` + `targets` in the UI |

---

## Quick start (local development)

```bash
# 1. Install dependencies
cd webui
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
cd webui
npm run build
# Server binary: server/dist/index.js
# SPA assets:    server/dist/public/
```

---

## Running tests

```bash
cd webui
npm test
```

All tests are in `server/test/`. They run with Vitest and need no network or real `bw` binary.

---

## Docker build

```bash
docker build -t bitwarden-webui:latest webui/
```

Override the Bitwarden CLI version:

```bash
docker build --build-arg BW_CLI_VERSION=2026.7.0 -t bitwarden-webui:latest webui/
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
kubectl apply -k webui/deploy/

# 5. Watch rollout
kubectl -n bitwarden rollout status deployment/bitwarden-webui
```

---

## Configuration (`targets.json`)

The config file is mounted from a ConfigMap at `CONFIG_PATH` (default `/config/targets.json`).

```jsonc
{
  "cloudServerUrl": "https://vault.bitwarden.eu",     // EU region — do NOT use bitwarden.com
  "homeServerUrl":  "https://bitwarden.example.internal",
  "backupFolder":   "/backups",
  "bitwardenConfigDir": "/data/bitwarden",
  "users": [
    { "key": "val",    "email": "val@example.com",    "displayName": "Val" },
    { "key": "mathou", "email": "mathou@example.com" }
  ],
  "orgs": [
    {
      "key": "org",
      "name": "My Organisation",
      "owner": "val",                                // must be a key in users[]
      "saasId": "00000000-0000-0000-0000-000000000000",   // cloud org ID
      "homeId": "00000000-0000-0000-0000-000000000000"    // home-server org ID
    }
  ],
  "retention":  { "keepDaily": 7, "keepMonthly": 12 },
  "importGuard": { "minSourceRatio": 0.5, "blockOnEmptySource": true },
  "homeLogoutAfterImport": true
}
```

### Migrating from `.bitwarden-env`

```bash
cd webui
bash scripts/env-to-json.sh ../.bitwarden-env > /tmp/targets.json
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

If your home Bitwarden server uses a certificate from an internal CA:

1. Create a ConfigMap from your CA bundle:
   ```bash
   kubectl -n bitwarden create configmap internal-ca --from-file=ca.crt=/path/to/ca.crt
   ```
2. Uncomment the `ca-bundle` volume and `NODE_EXTRA_CA_CERTS` env var in `deploy/deployment.yaml`.

`NODE_EXTRA_CA_CERTS` is inherited by the `bw` CLI child process (which is also a Node program),
so both the server's `fetch()` calls to `/ciphers/purge` and the CLI's HTTPS connections use the
same CA bundle.

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP listen port |
| `CONFIG_PATH` | `/config/targets.json` | Path to targets.json |
| `DATA_DIR` | `/data` | Directory for CLI profiles + job history |
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
