#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WEBMAIL_SRC_DIR="${ROOT_DIR}/webmail/src"
MAIL_CLIENT="${ROOT_DIR}/webmail/src/lib/mail-client.ts"
WEBMAIL_MODULE="${ROOT_DIR}/modules/webmail.nix"
SYNC_MODULE="${ROOT_DIR}/modules/sync-engine.nix"

assert_contains() {
  local file="$1"
  local expected="$2"
  if ! grep -Fq "$expected" "$file"; then
    echo "expected '$expected' in $file" >&2
    exit 1
  fi
}

assert_not_contains() {
  local file="$1"
  local unexpected="$2"
  if grep -Fq "$unexpected" "$file"; then
    echo "did not expect '$unexpected' in $file" >&2
    exit 1
  fi
}

assert_contains "${MAIL_CLIENT}" "upstreamSendMessage("
assert_contains "${MAIL_CLIENT}" "upstreamAppendMessage("
assert_contains "${MAIL_CLIENT}" "upstreamMoveMessages("
assert_contains "${MAIL_CLIENT}" "upstreamSetFlags("
assert_not_contains "${MAIL_CLIENT}" "new ImapFlow("
assert_not_contains "${MAIL_CLIENT}" "nodemailer.createTransport("
assert_not_contains "${WEBMAIL_SRC_DIR}/lib/takeout-import-worker.ts" "import { ImapFlow } from \"imapflow\";"

if rg -n "ImapFlow|nodemailer\\.createTransport\\(" "${WEBMAIL_SRC_DIR}" >/dev/null; then
  echo "expected webmail/src to delegate all IMAP/SMTP writes to sync-engine" >&2
  rg -n "ImapFlow|nodemailer\\.createTransport\\(" "${WEBMAIL_SRC_DIR}" >&2
  exit 1
fi

assert_contains "${WEBMAIL_MODULE}" 'SYNC_ENGINE_URL = syncEngineApiUrl;'
assert_contains "${WEBMAIL_MODULE}" 'SYNC_ENGINE_API_TOKEN = "${settings.imapPassword}";'
assert_contains "${SYNC_MODULE}" 'SYNC_ENGINE_API_PORT = toString syncEngineApiPort;'
assert_contains "${SYNC_MODULE}" 'SYNC_ENGINE_API_TOKEN=${settings.imapPassword}'

echo "webmail upstream boundary test: ok"
