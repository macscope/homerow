#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  fork-deploy.sh [--config path/to/config.env] [--repo owner/repo] [--ssh-key path/to/private_key]

Notes:
  - Requires GitHub CLI (`gh`) and authenticated session (`gh auth login`).
  - Can run inside or outside this repository.
  - Pushes non-empty values from config.env as repository secrets.
  - --repo is optional if config.env includes GITHUB_FORK_REPO.
  - Pushes SSH_PRIVATE_KEY from --ssh-key path, SSH_PRIVATE_KEY_PATH, or infra/id_ed25519 if found.
  - After pushing secrets, asks whether to trigger workflow "Deploy Mail Server".
EOF
}

error() {
  echo "[push-gh-secrets] $1" >&2
  exit 1
}

if REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"; then
  IN_GIT_REPO=1
  CONFIG_FILE="${REPO_ROOT}/config.env"
  DEFAULT_SSH_KEY_FILE="${REPO_ROOT}/infra/id_ed25519"
else
  IN_GIT_REPO=0
  REPO_ROOT="${PWD}"
  CONFIG_FILE="${PWD}/config.env"
  DEFAULT_SSH_KEY_FILE="${PWD}/infra/id_ed25519"
fi

TARGET_REPO=""
SSH_KEY_FILE=""
SSH_KEY_FLAG_SET=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --config)
      [ "$#" -ge 2 ] || error "--config requires a value."
      CONFIG_FILE="$2"
      shift 2
      ;;
    --repo)
      [ "$#" -ge 2 ] || error "--repo requires a value."
      TARGET_REPO="$2"
      shift 2
      ;;
    --ssh-key)
      [ "$#" -ge 2 ] || error "--ssh-key requires a value."
      SSH_KEY_FILE="$2"
      SSH_KEY_FLAG_SET=1
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      error "unknown argument: $1"
      ;;
  esac
done

command -v gh >/dev/null 2>&1 || error "GitHub CLI not found. Install `gh` first."
gh auth status >/dev/null 2>&1 || error "GitHub CLI is not authenticated. Run `gh auth login`."

[ -f "${CONFIG_FILE}" ] || error "config file not found: ${CONFIG_FILE}"

set -a
source "${CONFIG_FILE}"
set +a

if [ -z "${TARGET_REPO}" ]; then
  TARGET_REPO="${GITHUB_FORK_REPO:-}"
fi

if [ "${SSH_KEY_FLAG_SET}" -eq 0 ]; then
  if [ -n "${SSH_PRIVATE_KEY_PATH:-}" ]; then
    SSH_KEY_FILE="${SSH_PRIVATE_KEY_PATH}"
  else
    SSH_KEY_FILE="${DEFAULT_SSH_KEY_FILE}"
  fi
fi

if [ -z "${TARGET_REPO}" ] && [ "${IN_GIT_REPO}" -eq 0 ]; then
  error "missing target repository. Set --repo <owner/repo> or GITHUB_FORK_REPO in config.env."
fi

gh_args=()
if [ -n "${TARGET_REPO}" ]; then
  gh_args+=(--repo "${TARGET_REPO}")
fi

secrets=(
  DOMAIN
  EMAIL
  MAIL_PASSWORD
  RESTIC_PASSWORD
  HCLOUD_TOKEN
  CLOUDFLARE_TOKEN
  CLOUDFLARE_ZONE_ID
  S3_ACCESS_KEY
  S3_SECRET_KEY
  ACME_ENV
  VPS_STACK
  DNS_STACK
  STORAGE_STACK
  MAIL_PROVIDER_MODE
  MANAGE_MAIL_DNS
  HETZNER_SERVER_TYPE
  HETZNER_LOCATION
  HETZNER_REUSE_EXISTING_SERVER
  HETZNER_OBJECT_STORAGE_LOCATION
  UPSTREAM_IMAP_HOST
  UPSTREAM_IMAP_PORT
  UPSTREAM_IMAP_TLS
  UPSTREAM_IMAP_USER
  UPSTREAM_IMAP_PASSWORD
  UPSTREAM_SMTP_HOST
  UPSTREAM_SMTP_PORT
  UPSTREAM_SMTP_SECURE
  UPSTREAM_SMTP_USER
  UPSTREAM_SMTP_PASSWORD
  WEBMAIL_SUBDOMAIN
  TF_STATE_BUCKET_NAME
  TF_STATE_PREFIX
  SEED_INBOX
  SEED_INBOX_COUNT
  SEED_INBOX_INCLUDE_CATEGORIES
)

set_secret() {
  local name="$1"
  local value="$2"
  gh secret set "${name}" "${gh_args[@]}" --body "${value}" >/dev/null
  echo "[push-gh-secrets] set ${name}"
}

maybe_trigger_deploy_workflow() {
  local workflow_name="Deploy Mail Server"
  local answer="${PUSH_GH_SECRETS_DEPLOY_ANSWER:-}"

  if [ -z "${answer}" ]; then
    if [ -t 0 ]; then
      read -r -p "[push-gh-secrets] Trigger '${workflow_name}' workflow now? [y/N] " answer
    else
      echo "[push-gh-secrets] non-interactive shell: skipping deploy prompt."
      return 0
    fi
  fi

  case "${answer}" in
    y|Y|yes|YES)
      gh workflow run "${workflow_name}" "${gh_args[@]}" >/dev/null
      echo "[push-gh-secrets] triggered workflow '${workflow_name}'"
      ;;
    *)
      echo "[push-gh-secrets] skipped workflow trigger"
      ;;
  esac
}

for name in "${secrets[@]}"; do
  value="${!name:-}"
  if [ -n "${value}" ]; then
    set_secret "${name}" "${value}"
  fi
done

if [ -f "${SSH_KEY_FILE}" ]; then
  gh secret set SSH_PRIVATE_KEY "${gh_args[@]}" < "${SSH_KEY_FILE}" >/dev/null
  echo "[push-gh-secrets] set SSH_PRIVATE_KEY (from ${SSH_KEY_FILE})"
else
  echo "[push-gh-secrets] skipped SSH_PRIVATE_KEY (${SSH_KEY_FILE} not found)"
fi

maybe_trigger_deploy_workflow

echo "[push-gh-secrets] done"
