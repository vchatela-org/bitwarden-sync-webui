#!/usr/bin/env bash
# env-to-json.sh — Convert a .bitwarden-env file to targets.json format.
# Usage: ./env-to-json.sh [path-to-.bitwarden-env] > targets.json
#
# The old env format assumed one identity per person shared across two fixed servers, so this
# emits two accounts per user ("<key>@cloud" and "<key>@home") with the same email, and one
# sync per user/org routing cloud -> home. Split the emails, adjust the routes or add
# "otp": "required" afterwards — that is exactly what the account model exists to allow.
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

# Two accounts per user — one per vault, same email to start with.
ACCOUNTS_JSON=$(
  for key in "${!USERS[@]}"; do
    email="${USERS[$key]}"
    jq -n --arg k "$key" --arg e "$email" \
      '[{"key":($k + "@cloud"),"vault":"cloud","email":$e,"displayName":$k},
        {"key":($k + "@home"), "vault":"home", "email":$e,"displayName":$k}]'
  done | jq -s 'add // []'
)

# Orgs keep one id per vault; the owner disappears — whichever account sits on a route's
# side is the one that logs in there.
ORGS_JSON=$(
  for key in "${!ORG_NAMES[@]}"; do
    name="${ORG_NAMES[$key]}"
    saasId="${ORG_SAAS_IDS[$key]:-}"
    homeId="${ORG_HOME_IDS[$key]:-}"
    jq -n --arg k "$key" --arg n "$name" --arg s "$saasId" --arg h "$homeId" \
      '{"key":$k,"name":$n,"ids":{"cloud":$s,"home":$h}}'
  done | jq -s '.'
)

# One personal sync per user, plus one org sync per org routed through its old owner.
USER_SYNCS_JSON=$(
  for key in "${!USERS[@]}"; do
    jq -n --arg k "$key" '{"key":$k,"from":($k + "@cloud"),"to":($k + "@home")}'
  done | jq -s '.'
)

ORG_SYNCS_JSON=$(
  for key in "${!ORG_NAMES[@]}"; do
    owner="${ORG_OWNERS[$key]:-}"
    jq -n --arg k "$key" --arg o "$owner" \
      '{"key":$k,"from":($o + "@cloud"),"to":($o + "@home"),"org":$k}'
  done | jq -s '.'
)

SYNCS_JSON=$(jq -n --argjson u "$USER_SYNCS_JSON" --argjson o "$ORG_SYNCS_JSON" '$u + $o')

jq -n \
  --arg cloud "$CLOUD_URL" \
  --arg home "$HOME_URL" \
  --arg backup "$BACKUP_DIR" \
  --arg cfg "$CONFIG_DIR" \
  --argjson accounts "$ACCOUNTS_JSON" \
  --argjson orgs "$ORGS_JSON" \
  --argjson syncs "$SYNCS_JSON" \
  '{
    vaults: [
      { key: "cloud", name: "Cloud", serverUrl: $cloud },
      { key: "home",  name: "Home",  serverUrl: $home }
    ],
    backupFolder:   $backup,
    bitwardenConfigDir: $cfg,
    accounts: $accounts,
    orgs:  $orgs,
    syncs: $syncs,
    retention:   { keepDaily: 7,  keepMonthly: 12 },
    importGuard: { minSourceRatio: 0.5, blockOnEmptySource: true },
    logoutAfterImport: true
  }'
