#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
ROOT_DIR="$(cd "${INFRA_DIR}/.." && pwd)"
TMP_DIR="$(mktemp -d)"
VPS_DIR="${TMP_DIR}/vps/hetzner"
DNS_DIR="${TMP_DIR}/dns/cloudflare"
STORAGE_DIR="${TMP_DIR}/storage/hetzner-object-storage"
SSH_PUB_KEY="${TMP_DIR}/id_ed25519.pub"

VALID_HCLOUD_TOKEN="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
VALID_CLOUDFLARE_TOKEN="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
VALID_CLOUDFLARE_ZONE_ID="cccccccccccccccccccccccccccccccc"

MISSING_HCLOUD_LOG="$(mktemp)"
MISSING_CF_LOG="$(mktemp)"
MISSING_S3_LOG="$(mktemp)"
INVALID_WEBMAIL_SUBDOMAIN_LOG="$(mktemp)"
EXISTING_SSH_KEY_PLAN_LOG="$(mktemp)"
EXISTING_SERVER_PLAN_LOG="$(mktemp)"
EXTERNAL_DNS_PLAN_LOG="$(mktemp)"
trap 'rm -rf "${TMP_DIR}"; rm -f "${MISSING_HCLOUD_LOG}" "${MISSING_CF_LOG}" "${MISSING_S3_LOG}" "${INVALID_WEBMAIL_SUBDOMAIN_LOG}" "${EXISTING_SSH_KEY_PLAN_LOG}" "${EXISTING_SERVER_PLAN_LOG}" "${EXTERNAL_DNS_PLAN_LOG}"' EXIT

mkdir -p "${TMP_DIR}/vps" "${TMP_DIR}/dns" "${TMP_DIR}/storage"
cp -R "${INFRA_DIR}/vps/hetzner" "${TMP_DIR}/vps/"
cp -R "${INFRA_DIR}/dns/cloudflare" "${TMP_DIR}/dns/"
cp -R "${INFRA_DIR}/storage/hetzner-object-storage" "${TMP_DIR}/storage/"
cat > "${SSH_PUB_KEY}" <<'EOF'
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIG7K8bAxY3QK2l4LJw0Xl6p0B9n5q2wJb5n5p6m7n8o9 test@example
EOF

# Backend behavior is validated in dedicated install tests; provider tests run without remote backends.
sed -i.bak '/backend "s3" {}/d' "${VPS_DIR}/main.tf"
sed -i.bak '/backend "s3" {}/d' "${DNS_DIR}/main.tf"
sed -i.bak '/backend "s3" {}/d' "${STORAGE_DIR}/main.tf"
rm -f "${VPS_DIR}/main.tf.bak" "${DNS_DIR}/main.tf.bak" "${STORAGE_DIR}/main.tf.bak"
find "${TMP_DIR}" -name '.terraform' -type d -prune -exec rm -rf {} +
find "${TMP_DIR}" -name '.terraform.lock.hcl' -type f -delete
find "${TMP_DIR}" -name '*.tfstate' -type f -delete
find "${TMP_DIR}" -name '*.tfstate.*' -type f -delete

terraform -chdir="${VPS_DIR}" init -backend=false -input=false -no-color >/dev/null
terraform -chdir="${DNS_DIR}" init -backend=false -input=false -no-color >/dev/null
terraform -chdir="${STORAGE_DIR}" init -backend=false -input=false -no-color >/dev/null

if ! rg -q 'ignore_changes\s*=\s*\[ssh_keys\]' "${VPS_DIR}/main.tf"; then
  echo "expected hcloud_server.mail lifecycle.ignore_changes to include ssh_keys to avoid destructive server replacement on key drift" >&2
  exit 1
fi

terraform -chdir="${VPS_DIR}" plan \
  -input=false \
  -refresh=false \
  -lock=false \
  -no-color \
  -var='domain=example.com' \
  -var="hcloud_token=${VALID_HCLOUD_TOKEN}" \
  -var='server_type=cx23' \
  -var='location=nbg1' \
  -var="ssh_public_key_path=${SSH_PUB_KEY}" >/dev/null

terraform -chdir="${VPS_DIR}" plan \
  -input=false \
  -refresh=false \
  -lock=false \
  -no-color \
  -var='domain=example.com' \
  -var="hcloud_token=${VALID_HCLOUD_TOKEN}" \
  -var='server_type=cx23' \
  -var='location=nbg1' \
  -var="ssh_public_key_path=${SSH_PUB_KEY}" \
  -var='existing_ssh_key_id=12345' >"${EXISTING_SSH_KEY_PLAN_LOG}"
if grep -q "hcloud_ssh_key.admin" "${EXISTING_SSH_KEY_PLAN_LOG}"; then
  echo "expected vps plan to skip hcloud_ssh_key resource when existing_ssh_key_id is provided" >&2
  exit 1
fi

terraform -chdir="${VPS_DIR}" plan \
  -input=false \
  -refresh=false \
  -lock=false \
  -no-color \
  -var='domain=example.com' \
  -var="hcloud_token=${VALID_HCLOUD_TOKEN}" \
  -var='ssh_public_key_path='"${SSH_PUB_KEY}" \
  -var='existing_server_id=99999' \
  -var='existing_server_ipv4=203.0.113.10' >"${EXISTING_SERVER_PLAN_LOG}"
if grep -q "hcloud_server.mail" "${EXISTING_SERVER_PLAN_LOG}" || grep -q "hcloud_rdns.mail_ptr" "${EXISTING_SERVER_PLAN_LOG}" || grep -q "hcloud_ssh_key.admin" "${EXISTING_SERVER_PLAN_LOG}"; then
  echo "expected vps plan to skip server, rdns, and ssh key resources when existing_server_id is provided" >&2
  exit 1
fi

if terraform -chdir="${VPS_DIR}" plan \
  -input=false \
  -refresh=false \
  -lock=false \
  -no-color \
  -var='domain=example.com' \
  -var='hcloud_token=' \
  -var='ssh_public_key_path='"${SSH_PUB_KEY}" >"${MISSING_HCLOUD_LOG}" 2>&1; then
  echo "expected vps plan failure when hcloud_token is missing" >&2
  exit 1
fi
grep -q "hcloud_token must not be empty." "${MISSING_HCLOUD_LOG}"

terraform -chdir="${DNS_DIR}" plan \
  -input=false \
  -refresh=false \
  -lock=false \
  -no-color \
  -var='domain=example.com' \
  -var="cloudflare_token=${VALID_CLOUDFLARE_TOKEN}" \
  -var="cloudflare_zone_id=${VALID_CLOUDFLARE_ZONE_ID}" \
  -var='webmail_subdomain=webmail' \
  -var='mail_server_ipv4=203.0.113.10' >/dev/null

terraform -chdir="${DNS_DIR}" plan \
  -input=false \
  -refresh=false \
  -lock=false \
  -no-color \
  -var='domain=example.com' \
  -var="cloudflare_token=${VALID_CLOUDFLARE_TOKEN}" \
  -var="cloudflare_zone_id=${VALID_CLOUDFLARE_ZONE_ID}" \
  -var='webmail_subdomain=webmail' \
  -var='manage_mail_dns=false' \
  -var='mail_server_ipv4=203.0.113.10' >"${EXTERNAL_DNS_PLAN_LOG}"
if grep -q "cloudflare_record.mail_a" "${EXTERNAL_DNS_PLAN_LOG}" || grep -q "cloudflare_record.rspamd_a" "${EXTERNAL_DNS_PLAN_LOG}" || grep -q "cloudflare_record.mx" "${EXTERNAL_DNS_PLAN_LOG}" || grep -q "cloudflare_record.spf" "${EXTERNAL_DNS_PLAN_LOG}" || grep -q "cloudflare_record.dmarc" "${EXTERNAL_DNS_PLAN_LOG}"; then
  echo "expected dns plan to skip mail-specific records when manage_mail_dns is false" >&2
  exit 1
fi
grep -q "cloudflare_record.webmail_a" "${EXTERNAL_DNS_PLAN_LOG}"

if terraform -chdir="${DNS_DIR}" plan \
  -input=false \
  -refresh=false \
  -lock=false \
  -no-color \
  -var='domain=example.com' \
  -var='cloudflare_token=' \
  -var="cloudflare_zone_id=${VALID_CLOUDFLARE_ZONE_ID}" \
  -var='mail_server_ipv4=203.0.113.10' >"${MISSING_CF_LOG}" 2>&1; then
  echo "expected dns plan failure when cloudflare_token is missing" >&2
  exit 1
fi
grep -q "cloudflare_token must not be empty." "${MISSING_CF_LOG}"

if terraform -chdir="${DNS_DIR}" plan \
  -input=false \
  -refresh=false \
  -lock=false \
  -no-color \
  -var='domain=example.com' \
  -var="cloudflare_token=${VALID_CLOUDFLARE_TOKEN}" \
  -var="cloudflare_zone_id=${VALID_CLOUDFLARE_ZONE_ID}" \
  -var='webmail_subdomain=mail' \
  -var='mail_server_ipv4=203.0.113.10' >"${INVALID_WEBMAIL_SUBDOMAIN_LOG}" 2>&1; then
  echo "expected dns plan failure when webmail_subdomain is mail" >&2
  exit 1
fi
grep -q "webmail_subdomain must not be 'mail'" "${INVALID_WEBMAIL_SUBDOMAIN_LOG}"

terraform -chdir="${STORAGE_DIR}" plan \
  -input=false \
  -refresh=false \
  -lock=false \
  -no-color \
  -var='location=nbg1' \
  -var='bucket_name=mail-backup-example-com' \
  -var='s3_access_key=access-key' \
  -var='s3_secret_key=secret-key' >/dev/null

if terraform -chdir="${STORAGE_DIR}" plan \
  -input=false \
  -refresh=false \
  -lock=false \
  -no-color \
  -var='location=nbg1' \
  -var='bucket_name=mail-backup-example-com' \
  -var='s3_access_key=' \
  -var='s3_secret_key=secret-key' >"${MISSING_S3_LOG}" 2>&1; then
  echo "expected storage plan failure when s3_access_key is missing" >&2
  exit 1
fi
grep -q "s3_access_key must not be empty." "${MISSING_S3_LOG}"
