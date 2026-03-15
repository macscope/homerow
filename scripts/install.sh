#!/usr/bin/env bash
set -e

if REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"; then
    :
else
    REPO_ROOT="${PWD}"
fi

[ -f "${REPO_ROOT}/flake.nix" ] || { echo "[install] run this command from inside the homerow repository." >&2; exit 1; }
cd "${REPO_ROOT}"

GREEN='\033[0;32m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m'

log() { echo -e "${BLUE}[INFO]${NC} $1"; }
success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }
warn() { echo -e "${RED}[WARN]${NC} $1"; }

validate_bool() {
    local name="$1"
    local value="$2"

    case "$value" in
        true|false)
            ;;
        *)
            error "Invalid ${name}='${value}'. Use 'true' or 'false'."
            ;;
    esac
}

validate_port() {
    local name="$1"
    local value="$2"

    if ! [[ "$value" =~ ^[0-9]+$ ]] || [ "$value" -lt 1 ] || [ "$value" -gt 65535 ]; then
        error "Invalid ${name}='${value}'. Use a TCP port between 1 and 65535."
    fi
}

STRICT_CONFIG_MODE="${INSTALL_STRICT_CONFIG:-0}"
INSTALL_CONFIG_FILE="${INSTALL_CONFIG_FILE:-${DEPLOY_CONFIG_FILE:-${REPO_ROOT}/config.env}}"

if [ "${STRICT_CONFIG_MODE}" = "1" ] && [ "${DEPLOY_SKIP_UPDATE_CHECK:-}" != "1" ]; then
    "${REPO_ROOT}/scripts/print-update-notice.sh" "${REPO_ROOT}" || true
fi

run_timed_step() {
    local label="$1"
    shift
    local started_at=$SECONDS
    log "Starting: ${label}"
    "$@"
    local elapsed=$((SECONDS - started_at))
    log "Finished: ${label} (${elapsed}s)"
}

wait_for_ssh_ready() {
    local host="$1"
    local private_key="$2"
    local timeout_seconds="$3"
    local poll_interval_seconds="${4:-5}"

    local started_at=$SECONDS
    local attempts=0

    while true; do
        attempts=$((attempts + 1))
        if ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no -i "${private_key}" "root@${host}" "echo ready" >/dev/null 2>&1; then
            local elapsed=$((SECONDS - started_at))
            log "SSH is ready after ${elapsed}s (${attempts} checks)."
            return 0
        fi

        local elapsed=$((SECONDS - started_at))
        if [ "$elapsed" -ge "$timeout_seconds" ]; then
            error "Timed out waiting for SSH on ${host} after ${elapsed}s (${attempts} checks)."
        fi

        if [ $((attempts % 6)) -eq 0 ]; then
            log "Waiting for SSH on ${host}... elapsed=${elapsed}s timeout=${timeout_seconds}s"
        fi
        sleep "${poll_interval_seconds}"
    done
}

rollout_webmail_slots() {
    local host="$1"
    local private_key="$2"

    log "Applying rolling webmail restart (blue/green) on ${host}..."
    ssh -o StrictHostKeyChecking=no -i "${private_key}" "root@${host}" bash -s <<'REMOTE'
set -euo pipefail

wait_webmail_health() {
    local port="$1"
    local max_attempts="${2:-90}"
    local attempt
    local status_line

    for attempt in $(seq 1 "${max_attempts}"); do
        if exec 3<>"/dev/tcp/127.0.0.1/${port}" 2>/dev/null; then
            printf 'GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n' >&3 || true
            status_line="$(head -n 1 <&3 || true)"
            exec 3>&- 3<&- || true

            if echo "${status_line}" | grep -q " 200 "; then
                return 0
            fi
        fi
        sleep 1
    done

    return 1
}

restart_slot() {
    local unit="$1"
    local port="$2"

    systemctl restart "${unit}"
    if ! wait_webmail_health "${port}" 90; then
        journalctl -u "${unit}" -n 120 --no-pager >&2 || true
        return 1
    fi
}

systemctl daemon-reload
systemctl start custom-webmail-auth-bootstrap

if ! systemctl is-active --quiet custom-webmail-green; then
    systemctl start custom-webmail-green
fi
if ! wait_webmail_health 3002 90; then
    journalctl -u custom-webmail-green -n 120 --no-pager >&2 || true
    exit 1
fi

restart_slot custom-webmail-blue 3001
restart_slot custom-webmail-green 3002
systemctl reload nginx

systemctl is-active --quiet custom-webmail-blue
systemctl is-active --quiet custom-webmail-green
REMOTE
}

TEMP_EXTRA=""
TEMP_FLAKE=""
TEMP_TF_BACKEND_VPS=""
TEMP_TF_BACKEND_DNS=""
TEMP_TF_BACKEND_STORAGE=""
TEMP_TF_STATE_VERIFY_LOG=""
TEMP_DEPLOY_SSH_PRIVATE_KEY=""
TEMP_DEPLOY_SSH_PUBLIC_KEY=""
TF_IMPORT_TIMEOUT_SECONDS="${TF_IMPORT_TIMEOUT_SECONDS:-120}"
cleanup() {
    [ -n "$TEMP_EXTRA" ] && rm -rf "$TEMP_EXTRA" || true
    [ -n "$TEMP_FLAKE" ] && rm -rf "$TEMP_FLAKE" || true
    [ -n "$TEMP_TF_BACKEND_VPS" ] && rm -f "$TEMP_TF_BACKEND_VPS" || true
    [ -n "$TEMP_TF_BACKEND_DNS" ] && rm -f "$TEMP_TF_BACKEND_DNS" || true
    [ -n "$TEMP_TF_BACKEND_STORAGE" ] && rm -f "$TEMP_TF_BACKEND_STORAGE" || true
    [ -n "$TEMP_TF_STATE_VERIFY_LOG" ] && rm -f "$TEMP_TF_STATE_VERIFY_LOG" || true
    [ -n "$TEMP_DEPLOY_SSH_PRIVATE_KEY" ] && rm -f "$TEMP_DEPLOY_SSH_PRIVATE_KEY" || true
    [ -n "$TEMP_DEPLOY_SSH_PUBLIC_KEY" ] && rm -f "$TEMP_DEPLOY_SSH_PUBLIC_KEY" || true
}
trap cleanup EXIT

extract_existing_hash() {
    if [ -f "modules/settings.nix" ]; then
        sed -n 's/^[[:space:]]*hashedPassword = "\(.*\)";/\1/p' modules/settings.nix | head -n1
    fi
}

hash_matches_password() {
    local hash="$1"
    local password="$2"

    # SHA-512 crypt format: $6$salt$hash
    if [[ "$hash" != \$6\$* ]]; then
        return 1
    fi

    local salt
    salt=$(echo "$hash" | awk -F'$' '{print $3}')
    if [ -z "$salt" ]; then
        return 1
    fi

    local computed
    computed=$(echo -n "$password" | nix run nixpkgs#mkpasswd -- -m sha-512 -S "$salt" -s)
    [ "$computed" = "$hash" ]
}

find_existing_hcloud_ssh_key_id() {
    local public_key_path="$1"
    local api_url="https://api.hetzner.cloud/v1/ssh_keys?per_page=50"

    [ -n "${HCLOUD_TOKEN:-}" ] || return 0
    [ -f "$public_key_path" ] || return 0
    command -v curl >/dev/null 2>&1 || return 0
    command -v jq >/dev/null 2>&1 || return 0

    local public_key normalized_public_key
    public_key="$(tr -d '\r\n' < "$public_key_path")"
    [ -n "$public_key" ] || return 0
    normalized_public_key="$(echo "$public_key" | awk '{print $1 " " $2}')"
    [ -n "$normalized_public_key" ] || return 0

    # Query the first pages and reuse the first SSH key with identical public key.
    local page response id
    for page in 1 2 3 4 5; do
        response="$(curl -fsSL \
            -H "Authorization: Bearer ${HCLOUD_TOKEN}" \
            "${api_url}&page=${page}" 2>/dev/null)" || return 0

        id="$(echo "$response" | jq -r --arg key "$normalized_public_key" '.ssh_keys[] | select((.public_key | split(" ")[:2] | join(" ")) == $key) | .id' | head -n1)"
        if [ -n "$id" ]; then
            echo "$id"
            return 0
        fi

        if [ "$(echo "$response" | jq -r '.ssh_keys | length')" -eq 0 ]; then
            return 0
        fi
    done
}

find_existing_hcloud_server() {
    local server_name="${1:-mail-server}"
    local api_url="https://api.hetzner.cloud/v1/servers?name=${server_name}"

    [ -n "${HCLOUD_TOKEN:-}" ] || return 0
    command -v curl >/dev/null 2>&1 || return 0
    command -v jq >/dev/null 2>&1 || return 0

    local response server_id server_ipv4
    response="$(curl -fsSL \
        -H "Authorization: Bearer ${HCLOUD_TOKEN}" \
        "${api_url}" 2>/dev/null)" || return 0

    server_id="$(echo "$response" | jq -r '.servers[0].id // empty')"
    server_ipv4="$(echo "$response" | jq -r '.servers[0].public_net.ipv4.ip // empty')"

    if [ -n "$server_id" ] && [ -n "$server_ipv4" ]; then
        echo "${server_id} ${server_ipv4}"
    fi
}

sanitize_bucket_name() {
    local raw="$1"
    local cleaned
    cleaned="$(echo "$raw" \
        | tr '[:upper:]' '[:lower:]' \
        | sed -E 's/[^a-z0-9-]+/-/g; s/^-+//; s/-+$//; s/-+/-/g')"
    if [ ${#cleaned} -lt 3 ]; then
        cleaned="mail-backup-${cleaned}"
    fi
    echo "${cleaned:0:63}"
}

normalize_state_prefix() {
    local raw="$1"
    local normalized
    normalized="$(echo "$raw" | sed -E 's#^/+##; s#/+$##; s#//+#/#g')"
    echo "$normalized"
}

write_s3_backend_config() {
    local backend_file="$1"
    local bucket_name="$2"
    local key_path="$3"
    local location="$4"
    local endpoint="https://${location}.your-objectstorage.com"

    cat > "$backend_file" <<EOF
bucket = "${bucket_name}"
key = "${key_path}"
region = "${location}"
access_key = "${S3_ACCESS_KEY}"
secret_key = "${S3_SECRET_KEY}"
endpoints = { s3 = "${endpoint}" }
skip_credentials_validation = true
skip_requesting_account_id = true
skip_region_validation = true
EOF
}

cloudflare_find_record_id() {
    local type="$1"
    local name="$2"
    local content="${3:-}"
    local api_url="https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/dns_records?type=${type}&name=${name}&per_page=100"
    local cf_connect_timeout="${CLOUDFLARE_API_CONNECT_TIMEOUT_SECONDS:-10}"
    local cf_max_time="${CLOUDFLARE_API_MAX_TIME_SECONDS:-30}"
    local cf_retries="${CLOUDFLARE_API_RETRIES:-3}"

    [ -n "${CLOUDFLARE_TOKEN:-}" ] || return 0
    command -v curl >/dev/null 2>&1 || return 0
    command -v jq >/dev/null 2>&1 || return 0
    log "Cloudflare lookup: type=${type} name=${name}"

    local response=""
    local attempt
    for ((attempt = 1; attempt <= cf_retries; attempt++)); do
        log "Cloudflare API request (${attempt}/${cf_retries}) for ${type} ${name}"
        response="$(curl -fsSL \
            --connect-timeout "${cf_connect_timeout}" \
            --max-time "${cf_max_time}" \
            -H "Authorization: Bearer ${CLOUDFLARE_TOKEN}" \
            -H "Content-Type: application/json" \
            "${api_url}" 2>/dev/null)" && break
        warn "Cloudflare API request failed for ${type} ${name} (attempt ${attempt}/${cf_retries})"
        sleep 1
    done

    if [ -z "${response}" ]; then
        warn "Cloudflare lookup timed out/failed for ${type} ${name}; continuing without import hint."
        return 0
    fi

    if [ -n "$content" ]; then
        echo "$response" | jq -r --arg content "$content" '.result[] | select(.content == $content) | .id' | head -n1
        return 0
    fi

    echo "$response" | jq -r '.result[0].id // empty'
}

terraform_import_if_exists() {
    local dir="$1"
    local resource_addr="$2"
    local import_id="$3"
    if [ -z "$import_id" ]; then
        log "Skipping import for ${resource_addr} (no existing id found)."
        return 0
    fi

    [ -n "$import_id" ] || return 0
    if terraform_state_has_resource "$dir" "$resource_addr"; then
        log "Skipping import for ${resource_addr}: already present in Terraform state."
        return 0
    fi

    local import_log import_exit
    import_log="$(mktemp)"
    set +e
    if command -v timeout >/dev/null 2>&1; then
        timeout "${TF_IMPORT_TIMEOUT_SECONDS}" terraform -chdir="$dir" import -input=false -no-color "$resource_addr" "$import_id" >"${import_log}" 2>&1
    elif command -v gtimeout >/dev/null 2>&1; then
        gtimeout "${TF_IMPORT_TIMEOUT_SECONDS}" terraform -chdir="$dir" import -input=false -no-color "$resource_addr" "$import_id" >"${import_log}" 2>&1
    else
        terraform -chdir="$dir" import -input=false -no-color "$resource_addr" "$import_id" >"${import_log}" 2>&1
    fi
    import_exit=$?
    set -e

    if [ "$import_exit" -eq 0 ]; then
        rm -f "${import_log}"
        return 0
    fi

    log "Terraform import skipped for ${resource_addr} (${import_id}) due to non-zero exit (${import_exit})."
    cat "${import_log}" >&2
    rm -f "${import_log}"
}

terraform_state_has_resource() {
    local dir="$1"
    local resource_addr="$2"
    terraform -chdir="$dir" state list 2>/dev/null | grep -Fxq "$resource_addr"
}

terraform_verify_state_bucket() {
    local tf_state_dir="$1"
    local verify_exit_code=0

    TEMP_TF_STATE_VERIFY_LOG="$(mktemp)"
    set +e
    terraform -chdir="$tf_state_dir" plan -input=false -no-color -target=minio_s3_bucket.terraform_state -detailed-exitcode >"${TEMP_TF_STATE_VERIFY_LOG}" 2>&1
    verify_exit_code=$?
    set -e

    if [ "$verify_exit_code" -eq 0 ]; then
        log "Terraform state bucket verified."
        return 0
    fi

    if [ "$verify_exit_code" -eq 2 ]; then
        log "Terraform state bucket drift detected. Re-applying terraform-state stack..."
        terraform -chdir="$tf_state_dir" apply -auto-approve -target=minio_s3_bucket.terraform_state

        set +e
        terraform -chdir="$tf_state_dir" plan -input=false -no-color -target=minio_s3_bucket.terraform_state -detailed-exitcode >"${TEMP_TF_STATE_VERIFY_LOG}" 2>&1
        verify_exit_code=$?
        set -e

        if [ "$verify_exit_code" -eq 0 ]; then
            log "Terraform state bucket verified after reconciliation."
            return 0
        fi
    fi

    cat "${TEMP_TF_STATE_VERIFY_LOG}" >&2
    error "Terraform state bucket verification failed for ${TF_STATE_BUCKET_NAME}."
}

SEED_INBOX_OVERRIDE_SET="${SEED_INBOX+x}"
SEED_INBOX_OVERRIDE_VALUE="${SEED_INBOX:-}"
SEED_INBOX_COUNT_OVERRIDE_SET="${SEED_INBOX_COUNT+x}"
SEED_INBOX_COUNT_OVERRIDE_VALUE="${SEED_INBOX_COUNT:-}"
SEED_INBOX_INCLUDE_CATEGORIES_OVERRIDE_SET="${SEED_INBOX_INCLUDE_CATEGORIES+x}"
SEED_INBOX_INCLUDE_CATEGORIES_OVERRIDE_VALUE="${SEED_INBOX_INCLUDE_CATEGORIES:-}"

if [ -f "${INSTALL_CONFIG_FILE}" ]; then
log "Loading configuration from ${INSTALL_CONFIG_FILE}..."
source "${INSTALL_CONFIG_FILE}"

if [ -n "${SEED_INBOX_OVERRIDE_SET}" ]; then
    SEED_INBOX="${SEED_INBOX_OVERRIDE_VALUE}"
fi
if [ -n "${SEED_INBOX_COUNT_OVERRIDE_SET}" ]; then
    SEED_INBOX_COUNT="${SEED_INBOX_COUNT_OVERRIDE_VALUE}"
fi
if [ -n "${SEED_INBOX_INCLUDE_CATEGORIES_OVERRIDE_SET}" ]; then
    SEED_INBOX_INCLUDE_CATEGORIES="${SEED_INBOX_INCLUDE_CATEGORIES_OVERRIDE_VALUE}"
fi
else
    if [ "${STRICT_CONFIG_MODE}" = "1" ]; then
        error "missing config file at ${INSTALL_CONFIG_FILE}."
    fi
    log "No config.env found. Switching to interactive mode."
fi

get_input() {
    local var_name=$1
    local prompt=$2
    if [ -z "${!var_name}" ]; then
        if [ "${STRICT_CONFIG_MODE}" = "1" ]; then
            error "missing required variable ${var_name} in ${INSTALL_CONFIG_FILE}."
        fi
        read -p "$prompt: " val
        eval "$var_name=\"$val\""
    fi
}

if [ "${STRICT_CONFIG_MODE}" = "1" ]; then
    required_vars=(
        DOMAIN
        MAIL_PASSWORD
        RESTIC_PASSWORD
        HCLOUD_TOKEN
        CLOUDFLARE_TOKEN
        CLOUDFLARE_ZONE_ID
        S3_ACCESS_KEY
        S3_SECRET_KEY
    )

    missing=()
    for var_name in "${required_vars[@]}"; do
        if [ -z "${!var_name:-}" ]; then
            missing+=("${var_name}")
        fi
    done

    if [ "${#missing[@]}" -gt 0 ]; then
        error "missing required variables in ${INSTALL_CONFIG_FILE}: ${missing[*]}"
    fi
fi

get_input "DOMAIN" "Enter your domain"
get_input "MAIL_PASSWORD" "Enter Mail Admin Password"
get_input "RESTIC_PASSWORD" "Enter Backup Encryption Password"

VPS_STACK=${VPS_STACK:-"hetzner"}
DNS_STACK=${DNS_STACK:-"cloudflare"}
STORAGE_STACK=${STORAGE_STACK:-"hetzner-object-storage"}
HETZNER_SERVER_TYPE=${HETZNER_SERVER_TYPE:-${SERVER_TYPE:-"cx23"}}
HETZNER_LOCATION=${HETZNER_LOCATION:-${LOCATION:-"nbg1"}}
HETZNER_OBJECT_STORAGE_LOCATION=${HETZNER_OBJECT_STORAGE_LOCATION:-${S3_LOCATION:-$HETZNER_LOCATION}}
EMAIL=${EMAIL:-"admin@$DOMAIN"}
ACME_ENV=${ACME_ENV:-"production"}
WEBMAIL_SUBDOMAIN=${WEBMAIL_SUBDOMAIN:-"webmail"}
MAIL_PROVIDER_MODE=${MAIL_PROVIDER_MODE:-"local"}
TF_STATE_STACK=${TF_STATE_STACK:-"hetzner-object-storage"}
HETZNER_REUSE_EXISTING_SERVER=${HETZNER_REUSE_EXISTING_SERVER:-"true"}
SEED_INBOX=${SEED_INBOX:-"false"}
SEED_INBOX_COUNT=${SEED_INBOX_COUNT:-"12"}
SEED_INBOX_INCLUDE_CATEGORIES=${SEED_INBOX_INCLUDE_CATEGORIES:-"false"}
SKIP_NPM_DEPS_HASH_VERIFICATION=${SKIP_NPM_DEPS_HASH_VERIFICATION:-"false"}
SSH_PRIVATE_KEY_PATH_SET="${SSH_PRIVATE_KEY_PATH+x}"
SSH_PRIVATE_KEY_PATH=${SSH_PRIVATE_KEY_PATH:-""}
SSH_PUBLIC_KEY_PATH=""
SSH_PRIVATE_KEY=${SSH_PRIVATE_KEY:-""}

if [ -n "${SSH_PRIVATE_KEY_PATH}" ] && [[ "${SSH_PRIVATE_KEY_PATH}" != /* ]]; then
    SSH_PRIVATE_KEY_PATH="$(pwd)/${SSH_PRIVATE_KEY_PATH}"
fi

VPS_STACK_DIR="infra/vps/${VPS_STACK}"
DNS_STACK_DIR="infra/dns/${DNS_STACK}"
STORAGE_STACK_DIR="infra/storage/${STORAGE_STACK}"
TF_STATE_STACK_DIR="infra/terraform-state/${TF_STATE_STACK}"

[ -d "$VPS_STACK_DIR" ] || error "Unknown VPS stack '$VPS_STACK'."
[ -d "$DNS_STACK_DIR" ] || error "Unknown DNS stack '$DNS_STACK'."
[ -d "$STORAGE_STACK_DIR" ] || error "Unknown storage stack '$STORAGE_STACK'."
[ -d "$TF_STATE_STACK_DIR" ] || error "Unknown TF_STATE_STACK '$TF_STATE_STACK'."

case "$VPS_STACK" in
    hetzner)
        get_input "HCLOUD_TOKEN" "Enter Hetzner Cloud Token"
        ;;
    *)
        error "Unsupported VPS_STACK='$VPS_STACK'. Supported values: hetzner."
        ;;
esac

case "$DNS_STACK" in
    cloudflare)
        get_input "CLOUDFLARE_TOKEN" "Enter Cloudflare Token"
        get_input "CLOUDFLARE_ZONE_ID" "Enter Cloudflare Zone ID"
        ;;
    *)
        error "Unsupported DNS_STACK='$DNS_STACK'. Supported values: cloudflare."
        ;;
esac

case "$STORAGE_STACK" in
    hetzner-object-storage)
        get_input "S3_ACCESS_KEY" "Enter S3 Access Key"
        get_input "S3_SECRET_KEY" "Enter S3 Secret Key"
        ;;
    *)
        error "Unsupported STORAGE_STACK='$STORAGE_STACK'. Supported values: hetzner-object-storage."
        ;;
esac

if [ "$ACME_ENV" != "production" ] && [ "$ACME_ENV" != "staging" ]; then
    error "Invalid ACME_ENV='$ACME_ENV'. Use 'production' or 'staging'."
fi

if [ -z "$WEBMAIL_SUBDOMAIN" ]; then
    error "WEBMAIL_SUBDOMAIN must not be empty."
fi

if [ "$WEBMAIL_SUBDOMAIN" = "mail" ]; then
    error "WEBMAIL_SUBDOMAIN='mail' is not supported. Use a different subdomain (for example: webmail)."
fi

case "${MAIL_PROVIDER_MODE}" in
    local|external)
        ;;
    *)
        error "Invalid MAIL_PROVIDER_MODE='${MAIL_PROVIDER_MODE}'. Use 'local' or 'external'."
        ;;
esac

if [ "${MAIL_PROVIDER_MODE}" = "external" ]; then
    get_input "UPSTREAM_IMAP_HOST" "Enter upstream IMAP host"
    get_input "UPSTREAM_SMTP_HOST" "Enter upstream SMTP host"
fi

if [ -z "${MANAGE_MAIL_DNS:-}" ]; then
    if [ "${MAIL_PROVIDER_MODE}" = "local" ]; then
        MANAGE_MAIL_DNS="true"
    else
        MANAGE_MAIL_DNS="false"
    fi
fi
validate_bool "MANAGE_MAIL_DNS" "${MANAGE_MAIL_DNS}"

if [ "${MAIL_PROVIDER_MODE}" = "local" ] && [ "${MANAGE_MAIL_DNS}" != "true" ]; then
    error "MANAGE_MAIL_DNS must stay true when MAIL_PROVIDER_MODE=local."
fi

UPSTREAM_IMAP_HOST=${UPSTREAM_IMAP_HOST:-""}
UPSTREAM_IMAP_PORT=${UPSTREAM_IMAP_PORT:-""}
UPSTREAM_IMAP_TLS=${UPSTREAM_IMAP_TLS:-""}
UPSTREAM_IMAP_USER=${UPSTREAM_IMAP_USER:-""}
UPSTREAM_IMAP_PASSWORD=${UPSTREAM_IMAP_PASSWORD:-""}
UPSTREAM_SMTP_HOST=${UPSTREAM_SMTP_HOST:-""}
UPSTREAM_SMTP_PORT=${UPSTREAM_SMTP_PORT:-""}
UPSTREAM_SMTP_SECURE=${UPSTREAM_SMTP_SECURE:-""}
UPSTREAM_SMTP_USER=${UPSTREAM_SMTP_USER:-""}
UPSTREAM_SMTP_PASSWORD=${UPSTREAM_SMTP_PASSWORD:-""}

if [ "${MAIL_PROVIDER_MODE}" = "local" ]; then
    UPSTREAM_IMAP_HOST=${UPSTREAM_IMAP_HOST:-"127.0.0.1"}
    UPSTREAM_IMAP_PORT=${UPSTREAM_IMAP_PORT:-"993"}
    UPSTREAM_IMAP_TLS=${UPSTREAM_IMAP_TLS:-"true"}
    UPSTREAM_IMAP_USER=${UPSTREAM_IMAP_USER:-"${EMAIL}"}
    UPSTREAM_IMAP_PASSWORD=${UPSTREAM_IMAP_PASSWORD:-"${MAIL_PASSWORD}"}
    UPSTREAM_SMTP_HOST=${UPSTREAM_SMTP_HOST:-"127.0.0.1"}
    UPSTREAM_SMTP_PORT=${UPSTREAM_SMTP_PORT:-"465"}
    UPSTREAM_SMTP_SECURE=${UPSTREAM_SMTP_SECURE:-"true"}
    UPSTREAM_SMTP_USER=${UPSTREAM_SMTP_USER:-"${EMAIL}"}
    UPSTREAM_SMTP_PASSWORD=${UPSTREAM_SMTP_PASSWORD:-"${MAIL_PASSWORD}"}
else
    [ -n "${UPSTREAM_IMAP_HOST}" ] || error "UPSTREAM_IMAP_HOST is required when MAIL_PROVIDER_MODE=external."
    [ -n "${UPSTREAM_SMTP_HOST}" ] || error "UPSTREAM_SMTP_HOST is required when MAIL_PROVIDER_MODE=external."
    UPSTREAM_IMAP_PORT=${UPSTREAM_IMAP_PORT:-"993"}
    UPSTREAM_IMAP_TLS=${UPSTREAM_IMAP_TLS:-"true"}
    UPSTREAM_IMAP_USER=${UPSTREAM_IMAP_USER:-"${EMAIL}"}
    UPSTREAM_IMAP_PASSWORD=${UPSTREAM_IMAP_PASSWORD:-"${MAIL_PASSWORD}"}
    UPSTREAM_SMTP_PORT=${UPSTREAM_SMTP_PORT:-"587"}
    UPSTREAM_SMTP_SECURE=${UPSTREAM_SMTP_SECURE:-"false"}
    UPSTREAM_SMTP_USER=${UPSTREAM_SMTP_USER:-"${UPSTREAM_IMAP_USER}"}
    UPSTREAM_SMTP_PASSWORD=${UPSTREAM_SMTP_PASSWORD:-"${UPSTREAM_IMAP_PASSWORD}"}
fi

validate_port "UPSTREAM_IMAP_PORT" "${UPSTREAM_IMAP_PORT}"
validate_port "UPSTREAM_SMTP_PORT" "${UPSTREAM_SMTP_PORT}"
validate_bool "UPSTREAM_IMAP_TLS" "${UPSTREAM_IMAP_TLS}"
validate_bool "UPSTREAM_SMTP_SECURE" "${UPSTREAM_SMTP_SECURE}"

case "${HETZNER_REUSE_EXISTING_SERVER}" in
    true|false)
        ;;
    *)
        error "Invalid HETZNER_REUSE_EXISTING_SERVER='${HETZNER_REUSE_EXISTING_SERVER}'. Use 'true' or 'false'."
        ;;
esac

case "${SEED_INBOX}" in
    true|false)
        ;;
    *)
        error "Invalid SEED_INBOX='${SEED_INBOX}'. Use 'true' or 'false'."
        ;;
esac

if ! [[ "${SEED_INBOX_COUNT}" =~ ^[0-9]+$ ]] || [ "${SEED_INBOX_COUNT}" -lt 1 ]; then
    error "Invalid SEED_INBOX_COUNT='${SEED_INBOX_COUNT}'. Use a positive integer."
fi

case "${SEED_INBOX_INCLUDE_CATEGORIES}" in
    true|false)
        ;;
    *)
        error "Invalid SEED_INBOX_INCLUDE_CATEGORIES='${SEED_INBOX_INCLUDE_CATEGORIES}'. Use 'true' or 'false'."
        ;;
esac

case "${SKIP_NPM_DEPS_HASH_VERIFICATION}" in
    true|false)
        ;;
    *)
        error "Invalid SKIP_NPM_DEPS_HASH_VERIFICATION='${SKIP_NPM_DEPS_HASH_VERIFICATION}'. Use 'true' or 'false'."
        ;;
esac

USE_USER_MANAGED_SSH_KEY=false
if [ -n "${SSH_PRIVATE_KEY_PATH_SET}" ]; then
    USE_USER_MANAGED_SSH_KEY=true
fi

TF_STATE_BUCKET_NAME=${TF_STATE_BUCKET_NAME:-"mail-tfstate-${DOMAIN//./-}"}
TF_STATE_BUCKET_NAME="$(sanitize_bucket_name "$TF_STATE_BUCKET_NAME")"
TF_STATE_PREFIX=${TF_STATE_PREFIX:-"${DOMAIN}"}
TF_STATE_PREFIX="$(normalize_state_prefix "$TF_STATE_PREFIX")"
if [ -z "$TF_STATE_PREFIX" ]; then
    error "TF_STATE_PREFIX must not be empty."
fi

if [ "${INSTALL_ONLY_VALIDATE_CONFIG:-0}" = "1" ]; then
    log "Configuration validation passed."
    exit 0
fi

if [ "$ACME_ENV" = "staging" ]; then
    log "ACME environment: staging (test certs, browser will not trust them)."
else
    log "ACME environment: production (trusted Let's Encrypt certificates)."
fi

WORKSPACE_SSH_PUBLIC_KEY_PATH="$(pwd)/infra/id_ed25519.pub"

if [ -n "${SSH_PRIVATE_KEY}" ]; then
    if [ "${USE_USER_MANAGED_SSH_KEY}" = "true" ]; then
        log "SSH_PRIVATE_KEY is set; ignoring SSH_PRIVATE_KEY_PATH for this run."
    fi

    TEMP_DEPLOY_SSH_PRIVATE_KEY="$(mktemp)"
    TEMP_DEPLOY_SSH_PUBLIC_KEY="${TEMP_DEPLOY_SSH_PRIVATE_KEY}.pub"
    printf '%s\n' "${SSH_PRIVATE_KEY}" > "${TEMP_DEPLOY_SSH_PRIVATE_KEY}"
    ssh-keygen -y -f "${TEMP_DEPLOY_SSH_PRIVATE_KEY}" > "${TEMP_DEPLOY_SSH_PUBLIC_KEY}"
    SSH_PRIVATE_KEY_PATH="${TEMP_DEPLOY_SSH_PRIVATE_KEY}"
    SSH_PUBLIC_KEY_PATH="${TEMP_DEPLOY_SSH_PUBLIC_KEY}"
elif [ "${USE_USER_MANAGED_SSH_KEY}" = "true" ]; then
    if [ -z "${SSH_PRIVATE_KEY_PATH}" ]; then
        error "SSH_PRIVATE_KEY_PATH is set but empty. Set it to an existing private key path."
    fi
    SSH_PUBLIC_KEY_PATH="${SSH_PRIVATE_KEY_PATH}.pub"
    [ -f "${SSH_PRIVATE_KEY_PATH}" ] || error "Custom SSH private key not found: ${SSH_PRIVATE_KEY_PATH}"
    if [ ! -f "${SSH_PUBLIC_KEY_PATH}" ]; then
        log "Deriving SSH public key from provided private key..."
        ssh-keygen -y -f "${SSH_PRIVATE_KEY_PATH}" > "${SSH_PUBLIC_KEY_PATH}"
    fi
else
    error "SSH key not provided. Set SSH_PRIVATE_KEY (content) or SSH_PRIVATE_KEY_PATH (path to existing private key)."
fi
chmod 600 "${SSH_PRIVATE_KEY_PATH}"
chmod 644 "${SSH_PUBLIC_KEY_PATH}"
mkdir -p "$(dirname "${WORKSPACE_SSH_PUBLIC_KEY_PATH}")"
cp "${SSH_PUBLIC_KEY_PATH}" "${WORKSPACE_SSH_PUBLIC_KEY_PATH}"
SSH_AUTHORIZED_KEY="$(cat "${WORKSPACE_SSH_PUBLIC_KEY_PATH}")"

log "Generating Password Hash..."
EXISTING_HASH=$(extract_existing_hash || true)
if [ -n "$EXISTING_HASH" ] && hash_matches_password "$EXISTING_HASH" "$MAIL_PASSWORD"; then
    HASHED_PASS="$EXISTING_HASH"
    log "Reusing existing password hash (password unchanged)."
else
    HASHED_PASS=$(echo -n "$MAIL_PASSWORD" | nix run nixpkgs#mkpasswd -- -m sha-512 -s)
fi

log "Writing Nix settings..."
cat > modules/settings.nix <<EOF
{
  domain = "${DOMAIN}";
  email = "${EMAIL}";
  mailProviderMode = "${MAIL_PROVIDER_MODE}";
  hashedPassword = "${HASHED_PASS}";
  imapPassword = "${MAIL_PASSWORD}"; # Added for automated internal service login
  manageMailDns = ${MANAGE_MAIL_DNS};
  upstreamImapHost = "${UPSTREAM_IMAP_HOST}";
  upstreamImapPort = ${UPSTREAM_IMAP_PORT};
  upstreamImapTls = ${UPSTREAM_IMAP_TLS};
  upstreamImapUser = "${UPSTREAM_IMAP_USER}";
  upstreamImapPassword = "${UPSTREAM_IMAP_PASSWORD}";
  upstreamSmtpHost = "${UPSTREAM_SMTP_HOST}";
  upstreamSmtpPort = ${UPSTREAM_SMTP_PORT};
  upstreamSmtpSecure = ${UPSTREAM_SMTP_SECURE};
  upstreamSmtpUser = "${UPSTREAM_SMTP_USER}";
  upstreamSmtpPassword = "${UPSTREAM_SMTP_PASSWORD}";
  sshAuthorizedKey = ''
${SSH_AUTHORIZED_KEY}
'';
  hostName = "mail";
  acmeEnvironment = "${ACME_ENV}";
  webmailSubdomain = "${WEBMAIL_SUBDOMAIN}";
}
EOF

log "Writing Terraform variables..."
TEMP_TF_BACKEND_VPS="$(mktemp)"
TEMP_TF_BACKEND_DNS="$(mktemp)"
TEMP_TF_BACKEND_STORAGE="$(mktemp)"
write_s3_backend_config "$TEMP_TF_BACKEND_VPS" "${TF_STATE_BUCKET_NAME}" "${TF_STATE_PREFIX}/vps-${VPS_STACK}.tfstate" "${HETZNER_OBJECT_STORAGE_LOCATION}"
write_s3_backend_config "$TEMP_TF_BACKEND_DNS" "${TF_STATE_BUCKET_NAME}" "${TF_STATE_PREFIX}/dns-${DNS_STACK}.tfstate" "${HETZNER_OBJECT_STORAGE_LOCATION}"
write_s3_backend_config "$TEMP_TF_BACKEND_STORAGE" "${TF_STATE_BUCKET_NAME}" "${TF_STATE_PREFIX}/storage-${STORAGE_STACK}.tfstate" "${HETZNER_OBJECT_STORAGE_LOCATION}"

VPS_STATE_MANAGES_SERVER=false
if [ "$VPS_STACK" = "hetzner" ]; then
    terraform -chdir="$VPS_STACK_DIR" init -input=false -migrate-state -force-copy -backend-config="$TEMP_TF_BACKEND_VPS" >/dev/null 2>&1 || true
    if terraform_state_has_resource "$VPS_STACK_DIR" "hcloud_server.mail[0]"; then
        VPS_STATE_MANAGES_SERVER=true
        log "Terraform state already manages hcloud_server.mail[0]; refusing auto-reuse mode for safety."
    fi
fi

if [ "$VPS_STACK" = "hetzner" ]; then
    EXISTING_HCLOUD_SSH_KEY_ID="${HETZNER_EXISTING_SSH_KEY_ID:-}"
    EXISTING_HCLOUD_SERVER_ID="${HETZNER_EXISTING_SERVER_ID:-}"
    EXISTING_HCLOUD_SERVER_IPV4="${HETZNER_EXISTING_SERVER_IPV4:-}"
    if [ "$VPS_STATE_MANAGES_SERVER" = "true" ]; then
        if [ -n "$EXISTING_HCLOUD_SERVER_ID" ] || [ -n "$EXISTING_HCLOUD_SERVER_IPV4" ]; then
            error "Refusing existing server reuse variables because Terraform state already manages hcloud_server.mail[0]. Remove HETZNER_EXISTING_SERVER_ID/HETZNER_EXISTING_SERVER_IPV4."
        fi
    else
        if [ -n "$EXISTING_HCLOUD_SERVER_ID" ] || [ -n "$EXISTING_HCLOUD_SERVER_IPV4" ]; then
            if [ -z "$EXISTING_HCLOUD_SERVER_ID" ] || [ -z "$EXISTING_HCLOUD_SERVER_IPV4" ]; then
                error "Set both HETZNER_EXISTING_SERVER_ID and HETZNER_EXISTING_SERVER_IPV4, or neither."
            fi
        fi

        if [ -z "$EXISTING_HCLOUD_SERVER_ID" ] || [ -z "$EXISTING_HCLOUD_SERVER_IPV4" ]; then
            if [ "$HETZNER_REUSE_EXISTING_SERVER" != "true" ]; then
                log "Skipping auto-reuse of existing Hetzner server (HETZNER_REUSE_EXISTING_SERVER=false)."
                EXISTING_SERVER_INFO=""
            else
                EXISTING_SERVER_INFO="$(find_existing_hcloud_server "mail-server")"
            fi
            if [ -n "$EXISTING_SERVER_INFO" ]; then
                EXISTING_HCLOUD_SERVER_ID="$(echo "$EXISTING_SERVER_INFO" | awk '{print $1}')"
                EXISTING_HCLOUD_SERVER_IPV4="$(echo "$EXISTING_SERVER_INFO" | awk '{print $2}')"
            fi
        elif [ "$HETZNER_REUSE_EXISTING_SERVER" != "true" ]; then
            log "Skipping existing Hetzner server reuse (HETZNER_REUSE_EXISTING_SERVER=false)."
        else
            log "Reusing explicitly configured Hetzner server: id=${EXISTING_HCLOUD_SERVER_ID} ipv4=${EXISTING_HCLOUD_SERVER_IPV4}"
        fi
    fi

    if [ -n "$EXISTING_HCLOUD_SSH_KEY_ID" ]; then
        log "Reusing existing Hetzner SSH key id: ${EXISTING_HCLOUD_SSH_KEY_ID}"
    else
        log "Auto-reuse of existing Hetzner SSH keys is disabled by default to protect state-managed resources."
        log "Set HETZNER_EXISTING_SSH_KEY_ID explicitly to reuse an unmanaged key."
    fi

    cat > "$VPS_STACK_DIR/terraform.tfvars" <<EOF
domain = "${DOMAIN}"
hcloud_token = "${HCLOUD_TOKEN}"
server_type = "${HETZNER_SERVER_TYPE}"
location = "${HETZNER_LOCATION}"
ssh_public_key_path = "${SSH_PUBLIC_KEY_PATH}"
EOF

    if [ -n "$EXISTING_HCLOUD_SSH_KEY_ID" ]; then
        echo "existing_ssh_key_id = ${EXISTING_HCLOUD_SSH_KEY_ID}" >> "$VPS_STACK_DIR/terraform.tfvars"
    fi

    if [ -n "$EXISTING_HCLOUD_SERVER_ID" ] && [ -n "$EXISTING_HCLOUD_SERVER_IPV4" ]; then
        log "Reusing existing Hetzner server id: ${EXISTING_HCLOUD_SERVER_ID} (${EXISTING_HCLOUD_SERVER_IPV4})"
        cat >> "$VPS_STACK_DIR/terraform.tfvars" <<EOF
existing_server_id = ${EXISTING_HCLOUD_SERVER_ID}
existing_server_ipv4 = "${EXISTING_HCLOUD_SERVER_IPV4}"
EOF
    fi
fi

if [ "$DNS_STACK" = "cloudflare" ]; then
    cat > "$DNS_STACK_DIR/terraform.tfvars" <<EOF
domain = "${DOMAIN}"
cloudflare_token = "${CLOUDFLARE_TOKEN}"
cloudflare_zone_id = "${CLOUDFLARE_ZONE_ID}"
webmail_subdomain = "${WEBMAIL_SUBDOMAIN}"
manage_mail_dns = ${MANAGE_MAIL_DNS}
EOF
fi

if [ "$STORAGE_STACK" = "hetzner-object-storage" ]; then
    BACKUP_BUCKET_NAME="${BACKUP_BUCKET_NAME:-mail-backup-${DOMAIN//./-}}"
    BACKUP_BUCKET_NAME="$(sanitize_bucket_name "$BACKUP_BUCKET_NAME")"

    cat > "$STORAGE_STACK_DIR/terraform.tfvars" <<EOF
location = "${HETZNER_OBJECT_STORAGE_LOCATION}"
s3_access_key = "${S3_ACCESS_KEY}"
s3_secret_key = "${S3_SECRET_KEY}"
bucket_name = "${BACKUP_BUCKET_NAME}"
EOF
fi

if [ "$TF_STATE_STACK" = "hetzner-object-storage" ]; then
    cat > "$TF_STATE_STACK_DIR/terraform.tfvars" <<EOF
location = "${HETZNER_OBJECT_STORAGE_LOCATION}"
s3_access_key = "${S3_ACCESS_KEY}"
s3_secret_key = "${S3_SECRET_KEY}"
bucket_name = "${TF_STATE_BUCKET_NAME}"
EOF
fi

if [ "${SKIP_NPM_DEPS_HASH_VERIFICATION}" = "true" ]; then
    log "Skipping Nix npm dependency hash refresh/verification (SKIP_NPM_DEPS_HASH_VERIFICATION=true)."
else
    log "Refreshing Nix npm dependency hashes..."
    ./scripts/refresh-npm-deps-hashes.sh
fi

log "Preparing filtered deploy source..."
TEMP_FLAKE=$(mktemp -d)
TEMP_FLAKE=$(cd "$TEMP_FLAKE" && pwd -P)
rsync -a \
    --exclude '.git' \
    --exclude 'takeout' \
    --exclude 'webmail/playwright-report' \
    --exclude 'webmail/test-results' \
    --exclude 'webmail/.playwright' \
    "$(pwd)/" "${TEMP_FLAKE}/"
FLAKE_REF="path:${TEMP_FLAKE}#mailserver"

log "Provisioning Infrastructure..."

log "Setting up Terraform remote state: ${TF_STATE_BUCKET_NAME}"
run_timed_step "terraform init (${TF_STATE_STACK_DIR})" terraform -chdir="$TF_STATE_STACK_DIR" init -backend=false
terraform_import_if_exists "$TF_STATE_STACK_DIR" "minio_s3_bucket.terraform_state" "${TF_STATE_BUCKET_NAME}"
run_timed_step "terraform apply (${TF_STATE_STACK_DIR})" terraform -chdir="$TF_STATE_STACK_DIR" apply -auto-approve
terraform_verify_state_bucket "$TF_STATE_STACK_DIR"

log "Applying VPS stack: ${VPS_STACK}"
run_timed_step "terraform init (${VPS_STACK_DIR})" terraform -chdir="$VPS_STACK_DIR" init -input=false -migrate-state -force-copy -backend-config="$TEMP_TF_BACKEND_VPS"
run_timed_step "terraform apply (${VPS_STACK_DIR})" terraform -chdir="$VPS_STACK_DIR" apply -auto-approve
SERVER_IP=$(terraform -chdir="$VPS_STACK_DIR" output -raw server_ip)

log "Applying DNS stack: ${DNS_STACK}"
run_timed_step "terraform init (${DNS_STACK_DIR})" terraform -chdir="$DNS_STACK_DIR" init -input=false -migrate-state -force-copy -backend-config="$TEMP_TF_BACKEND_DNS"
if [ "$DNS_STACK" = "cloudflare" ]; then
    log "Checking existing Cloudflare DNS records for import..."
    WEBMAIL_A_RECORD_ID="$(cloudflare_find_record_id "A" "${WEBMAIL_SUBDOMAIN}.${DOMAIN}")"
    if [ -n "$WEBMAIL_A_RECORD_ID" ]; then terraform_import_if_exists "$DNS_STACK_DIR" "cloudflare_record.webmail_a" "${CLOUDFLARE_ZONE_ID}/${WEBMAIL_A_RECORD_ID}"; fi

    if [ "${MANAGE_MAIL_DNS}" = "true" ]; then
        MAIL_A_RECORD_ID="$(cloudflare_find_record_id "A" "mail.${DOMAIN}")"
        RSPAMD_A_RECORD_ID="$(cloudflare_find_record_id "A" "rspamd.${DOMAIN}")"
        MX_RECORD_ID="$(cloudflare_find_record_id "MX" "${DOMAIN}" "mail.${DOMAIN}")"
        SPF_RECORD_ID="$(cloudflare_find_record_id "TXT" "${DOMAIN}" "v=spf1 mx a:mail.${DOMAIN} -all")"
        DMARC_RECORD_ID="$(cloudflare_find_record_id "TXT" "_dmarc.${DOMAIN}" "v=DMARC1; p=quarantine; rua=mailto:admin@${DOMAIN}")"

        if [ -n "$MAIL_A_RECORD_ID" ]; then terraform_import_if_exists "$DNS_STACK_DIR" "cloudflare_record.mail_a[0]" "${CLOUDFLARE_ZONE_ID}/${MAIL_A_RECORD_ID}"; fi
        if [ -n "$RSPAMD_A_RECORD_ID" ]; then terraform_import_if_exists "$DNS_STACK_DIR" "cloudflare_record.rspamd_a[0]" "${CLOUDFLARE_ZONE_ID}/${RSPAMD_A_RECORD_ID}"; fi
        if [ -n "$MX_RECORD_ID" ]; then terraform_import_if_exists "$DNS_STACK_DIR" "cloudflare_record.mx[0]" "${CLOUDFLARE_ZONE_ID}/${MX_RECORD_ID}"; fi
        if [ -n "$SPF_RECORD_ID" ]; then terraform_import_if_exists "$DNS_STACK_DIR" "cloudflare_record.spf[0]" "${CLOUDFLARE_ZONE_ID}/${SPF_RECORD_ID}"; fi
        if [ -n "$DMARC_RECORD_ID" ]; then terraform_import_if_exists "$DNS_STACK_DIR" "cloudflare_record.dmarc[0]" "${CLOUDFLARE_ZONE_ID}/${DMARC_RECORD_ID}"; fi
    fi
fi
run_timed_step "terraform apply (${DNS_STACK_DIR})" terraform -chdir="$DNS_STACK_DIR" apply -auto-approve -var="mail_server_ipv4=${SERVER_IP}"

log "Applying storage stack: ${STORAGE_STACK}"
run_timed_step "terraform init (${STORAGE_STACK_DIR})" terraform -chdir="$STORAGE_STACK_DIR" init -input=false -migrate-state -force-copy -backend-config="$TEMP_TF_BACKEND_STORAGE"
if [ "$STORAGE_STACK" = "hetzner-object-storage" ] && [ -n "${BACKUP_BUCKET_NAME:-}" ]; then
    terraform_import_if_exists "$STORAGE_STACK_DIR" "minio_s3_bucket.backups" "${BACKUP_BUCKET_NAME}"
fi
run_timed_step "terraform apply (${STORAGE_STACK_DIR})" terraform -chdir="$STORAGE_STACK_DIR" apply -auto-approve
BUCKET_URL=$(terraform -chdir="$STORAGE_STACK_DIR" output -raw s3_bucket_url)

log "Preparing secure secret deployment..."
TEMP_EXTRA=$(mktemp -d)

mkdir -p "$TEMP_EXTRA/etc/ssh"
cp "${SSH_PRIVATE_KEY_PATH}" "$TEMP_EXTRA/etc/ssh/ssh_host_ed25519_key"
chmod 600 "$TEMP_EXTRA/etc/ssh/ssh_host_ed25519_key"

mkdir -p "$TEMP_EXTRA/root"
echo "$BUCKET_URL" > "$TEMP_EXTRA/root/restic-repo"
echo "$RESTIC_PASSWORD" > "$TEMP_EXTRA/root/restic-password"
cat > "$TEMP_EXTRA/root/restic-env" <<EOF
AWS_ACCESS_KEY_ID=$S3_ACCESS_KEY
AWS_SECRET_ACCESS_KEY=$S3_SECRET_KEY
EOF

chmod 600 "$TEMP_EXTRA/root/restic-repo"
chmod 600 "$TEMP_EXTRA/root/restic-password"
chmod 600 "$TEMP_EXTRA/root/restic-env"

SSH_READY_TIMEOUT_SECONDS="${SSH_READY_TIMEOUT_SECONDS:-600}"
log "Checking server SSH readiness at ${SERVER_IP} (timeout ${SSH_READY_TIMEOUT_SECONDS}s)..."
wait_for_ssh_ready "${SERVER_IP}" "${SSH_PRIVATE_KEY_PATH}" "${SSH_READY_TIMEOUT_SECONDS}" 5

IS_NIXOS=$(ssh -o StrictHostKeyChecking=no -i "${SSH_PRIVATE_KEY_PATH}" root@$SERVER_IP "grep -i nixos /etc/os-release" 2>/dev/null || true)

if [ -n "$IS_NIXOS" ]; then
    log "✨ Existing NixOS detected. Performing safe update..."
    # Set the SSH options via environment variable for nixos-rebuild
    export NIX_SSHOPTS="-i ${SSH_PRIVATE_KEY_PATH} -o StrictHostKeyChecking=no"
    run_timed_step "nixos-rebuild switch (${SERVER_IP})" nix run nixpkgs#nixos-rebuild -- switch \
        --flake "$FLAKE_REF" \
        --target-host root@$SERVER_IP \
        --build-host root@$SERVER_IP \
        --fast
else
    log "🚀 No NixOS detected. Running fresh installation (nixos-anywhere)..."
    run_timed_step "nixos-anywhere install (${SERVER_IP})" nix run github:nix-community/nixos-anywhere -- \
        --build-on-remote \
        --ssh-option "IdentityFile=${SSH_PRIVATE_KEY_PATH}" \
        --extra-files "$TEMP_EXTRA" \
        --flake "$FLAKE_REF" \
        root@$SERVER_IP
fi

run_timed_step "rolling webmail restart (${SERVER_IP})" rollout_webmail_slots "${SERVER_IP}" "${SSH_PRIVATE_KEY_PATH}"

if [ "$SEED_INBOX" = "true" ]; then
    log "Seeding inbox for development/test usage (count=${SEED_INBOX_COUNT})..."
    if [ ! -d "webmail/node_modules" ]; then
        log "Installing webmail npm dependencies for seeding..."
        (cd webmail && npm install)
    fi

    SEED_SKIP_CATEGORY_ASSIGNMENTS="true"
    if [ "$SEED_INBOX_INCLUDE_CATEGORIES" = "true" ]; then
        SEED_SKIP_CATEGORY_ASSIGNMENTS="false"
    fi

    (
        cd webmail
        E2E_BASE_URL="https://${WEBMAIL_SUBDOMAIN}.${DOMAIN}" \
        E2E_EMAIL="${EMAIL}" \
        E2E_PASSWORD="${MAIL_PASSWORD}" \
        E2E_SMTP_HOST="${UPSTREAM_SMTP_HOST}" \
        E2E_SMTP_PORT="${UPSTREAM_SMTP_PORT}" \
        E2E_SMTP_USER="${UPSTREAM_SMTP_USER}" \
        E2E_SMTP_PASSWORD="${UPSTREAM_SMTP_PASSWORD}" \
        E2E_SEED_COUNT="${SEED_INBOX_COUNT}" \
        E2E_SEED_SKIP_CATEGORY_ASSIGNMENTS="${SEED_SKIP_CATEGORY_ASSIGNMENTS}" \
        npm run seed:e2e
    )
fi

success "Deployment/Update Complete!"
echo "------------------------------------------------"
echo "Webmail:    https://${WEBMAIL_SUBDOMAIN}.$DOMAIN"
echo "Mail Mode:  ${MAIL_PROVIDER_MODE}"
if [ "${MAIL_PROVIDER_MODE}" = "local" ]; then
  echo "Rspamd:     https://rspamd.$DOMAIN"
else
  echo "Upstream:   IMAP ${UPSTREAM_IMAP_HOST}:${UPSTREAM_IMAP_PORT} | SMTP ${UPSTREAM_SMTP_HOST}:${UPSTREAM_SMTP_PORT}"
fi
echo "Username:   $EMAIL"
echo "Backup:     Configured to $BUCKET_URL"
echo "ACME Env:   $ACME_ENV"
if [ "$ACME_ENV" = "staging" ]; then
  echo "WARNING:    Staging certs are not trusted. Set ACME_ENV=production when ready."
fi
echo "------------------------------------------------"
