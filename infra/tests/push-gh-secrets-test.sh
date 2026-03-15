#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="${ROOT_DIR}/scripts/fork-deploy.sh"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

BIN_DIR="${TMP_DIR}/bin"
LOG_FILE="${TMP_DIR}/gh.log"
mkdir -p "${BIN_DIR}"

cat > "${BIN_DIR}/gh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
if [ "\$1" = "auth" ] && [ "\$2" = "status" ]; then
  exit 0
fi
if [ "\$1" = "secret" ] && [ "\$2" = "set" ]; then
  name="\$3"
  echo "set:\${name} args:\$*" >> "${LOG_FILE}"
  cat >/dev/null || true
  exit 0
fi
if [ "\$1" = "workflow" ] && [ "\$2" = "run" ]; then
  echo "workflow:run args:\$*" >> "${LOG_FILE}"
  exit 0
fi
exit 1
EOF
chmod +x "${BIN_DIR}/gh"

CONFIG_FILE="${TMP_DIR}/config.env"
cat > "${CONFIG_FILE}" <<'EOF'
DOMAIN=example.com
EMAIL=admin@example.com
MAIL_PASSWORD=mail-secret
RESTIC_PASSWORD=backup-secret
HCLOUD_TOKEN=hc-token
CLOUDFLARE_TOKEN=cf-token
CLOUDFLARE_ZONE_ID=cf-zone
S3_ACCESS_KEY=s3-key
S3_SECRET_KEY=s3-secret
ACME_ENV=production
VPS_STACK=hetzner
DNS_STACK=cloudflare
STORAGE_STACK=hetzner-object-storage
MAIL_PROVIDER_MODE=external
MANAGE_MAIL_DNS=false
HETZNER_SERVER_TYPE=cx23
HETZNER_LOCATION=nbg1
HETZNER_REUSE_EXISTING_SERVER=false
HETZNER_OBJECT_STORAGE_LOCATION=nbg1
UPSTREAM_IMAP_HOST=imap.example.net
UPSTREAM_IMAP_PORT=993
UPSTREAM_IMAP_TLS=true
UPSTREAM_IMAP_USER=imap-user
UPSTREAM_IMAP_PASSWORD=imap-secret
UPSTREAM_SMTP_HOST=smtp.example.net
UPSTREAM_SMTP_PORT=587
UPSTREAM_SMTP_SECURE=false
UPSTREAM_SMTP_USER=smtp-user
UPSTREAM_SMTP_PASSWORD=smtp-secret
WEBMAIL_SUBDOMAIN=mailbox
TF_STATE_BUCKET_NAME=mail-state-example-com
TF_STATE_PREFIX=prod/example.com
SEED_INBOX=true
SEED_INBOX_COUNT=25
SEED_INBOX_INCLUDE_CATEGORIES=false
GITHUB_FORK_REPO=owner/repo
EOF

SSH_KEY_PATH="${TMP_DIR}/id_ed25519"
cat > "${SSH_KEY_PATH}" <<'EOF'
-----BEGIN OPENSSH PRIVATE KEY-----
test-private-key
-----END OPENSSH PRIVATE KEY-----
EOF
echo "SSH_PRIVATE_KEY_PATH=${SSH_KEY_PATH}" >> "${CONFIG_FILE}"

PATH="${BIN_DIR}:${PATH}" PUSH_GH_SECRETS_DEPLOY_ANSWER=y "${SCRIPT}" --config "${CONFIG_FILE}" >/dev/null

for name in DOMAIN EMAIL MAIL_PASSWORD RESTIC_PASSWORD HCLOUD_TOKEN CLOUDFLARE_TOKEN CLOUDFLARE_ZONE_ID S3_ACCESS_KEY S3_SECRET_KEY ACME_ENV VPS_STACK DNS_STACK STORAGE_STACK MAIL_PROVIDER_MODE MANAGE_MAIL_DNS HETZNER_SERVER_TYPE HETZNER_LOCATION HETZNER_REUSE_EXISTING_SERVER HETZNER_OBJECT_STORAGE_LOCATION UPSTREAM_IMAP_HOST UPSTREAM_IMAP_PORT UPSTREAM_IMAP_TLS UPSTREAM_IMAP_USER UPSTREAM_IMAP_PASSWORD UPSTREAM_SMTP_HOST UPSTREAM_SMTP_PORT UPSTREAM_SMTP_SECURE UPSTREAM_SMTP_USER UPSTREAM_SMTP_PASSWORD WEBMAIL_SUBDOMAIN TF_STATE_BUCKET_NAME TF_STATE_PREFIX SEED_INBOX SEED_INBOX_COUNT SEED_INBOX_INCLUDE_CATEGORIES SSH_PRIVATE_KEY; do
  grep -q "set:${name}" "${LOG_FILE}"
done

grep -q "set:DOMAIN args:secret set DOMAIN --repo owner/repo --body example.com" "${LOG_FILE}"
grep -q "set:SSH_PRIVATE_KEY args:secret set SSH_PRIVATE_KEY --repo owner/repo" "${LOG_FILE}"
grep -q "workflow:run args:workflow run Deploy Mail Server --repo owner/repo" "${LOG_FILE}"

echo "push-gh-secrets test: ok"
