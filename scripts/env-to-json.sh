#!/usr/bin/env bash
# env-to-json.sh — Convert a .bitwarden-env file to targets.json format.
# Usage: ./env-to-json.sh [path-to-.bitwarden-env] > targets.json
#
# Dependencies: bash, jq
set -euo pipefail

ENV_FILE="${1:-.bitwarden-env}"

if [ ! -f "$ENV_FILE" ]; then
  echo "❌ File not found: $ENV_FILE" >&2
  exit 1
fi

# Source the env file to load USERS, ORG_*, etc.
# shellcheck disable=SC1090
source "$ENV_FILE"

CLOUD_URL="${BITWARDEN_CLOUD_SERVER_URL:-https://vault.bitwarden.eu}"
HOME_URL="${BITWARDEN_SERVER_URL:-https://bitwarden.example.internal}"
BACKUP_DIR="${BACKUP_FOLDER:-/backups}"
CONFIG_DIR="${BITWARDEN_CONFIG_DIR:-/data/bitwarden}"

# Build users array
USERS_JSON=$(
  for key in "${!USERS[@]}"; do
    email="${USERS[$key]}"
    jq -n --arg k "$key" --arg e "$email" '{"key":$k,"email":$e}'
  done | jq -s '.'
)

# Build orgs array — "cloud"/"home" match the vault keys emitted below, and every
# org/user keeps syncing cloud -> home, exactly as the old fixed two-server model did.
ORGS_JSON=$(
  for key in "${!ORG_NAMES[@]}"; do
    name="${ORG_NAMES[$key]}"
    owner="${ORG_OWNERS[$key]:-}"
    saasId="${ORG_SAAS_IDS[$key]:-}"
    homeId="${ORG_HOME_IDS[$key]:-}"
    jq -n \
      --arg k "$key" \
      --arg n "$name" \
      --arg o "$owner" \
      --arg s "$saasId" \
      --arg h "$homeId" \
      '{"key":$k,"name":$n,"owner":$o,"from":"cloud","to":"home","orgIds":{"cloud":$s,"home":$h}}'
  done | jq -s '.'
)

USERS_JSON=$(echo "$USERS_JSON" | jq '[.[] | . + {"from":"cloud","to":"home"}]')

jq -n \
  --arg cloud "$CLOUD_URL" \
  --arg home "$HOME_URL" \
  --arg backup "$BACKUP_DIR" \
  --arg cfg "$CONFIG_DIR" \
  --argjson users "$USERS_JSON" \
  --argjson orgs "$ORGS_JSON" \
  '{
    vaults: [
      { key: "cloud", name: "Cloud", serverUrl: $cloud },
      { key: "home",  name: "Home",  serverUrl: $home }
    ],
    backupFolder:   $backup,
    bitwardenConfigDir: $cfg,
    users: $users,
    orgs:  $orgs,
    retention:   { keepDaily: 7,  keepMonthly: 12 },
    importGuard: { minSourceRatio: 0.5, blockOnEmptySource: true },
    homeLogoutAfterImport: true
  }'
