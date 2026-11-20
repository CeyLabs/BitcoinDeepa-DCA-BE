#!/bin/bash

# BitcoinDeepa User Balance Test Script (Ed25519-signed, same scheme as
# test-fund-transfer.sh). Read-only: it moves no sats.
# Usage: ./scripts/test-user-balance.sh <telegram_id>
# Example: ./scripts/test-user-balance.sh 7551840633
#
# Needs BITCOINDEEPA_API_URL, BITCOINDEEPA_WALLET_ID and the private key, either
# BITCOINDEEPA_PRIVATE_KEY_FILE (path to the PEM) or
# BITCOINDEEPA_PRIVATE_KEY_PEM (PEM text, multi-line or with literal \n).
# They are read from ENV_FILE (default .env), e.g. ENV_FILE=.env.dev for staging.
# DRY_RUN=1 prints the signed request without sending it.
# Requires OpenSSL 3+ (pkeyutl -rawin for Ed25519). macOS ships LibreSSL, which
# can't do it: Homebrew's openssl@3 is picked up automatically, or set OPENSSL.

set -euo pipefail

if [ "$#" -lt 1 ]; then
    echo "Usage: $0 <telegram_id>"
    echo "Example: ENV_FILE=.env.dev $0 7551840633"
    exit 1
fi

TELEGRAM_ID=$1
if ! [[ "$TELEGRAM_ID" =~ ^[0-9]+$ ]]; then
    echo "telegram_id must be a number, got: ${TELEGRAM_ID}"
    exit 1
fi

# Pick an OpenSSL that can sign Ed25519 (not the system LibreSSL on macOS)
OPENSSL="${OPENSSL:-openssl}"
if "$OPENSSL" version 2>/dev/null | grep -qi libressl; then
    for candidate in /opt/homebrew/opt/openssl@3/bin/openssl /usr/local/opt/openssl@3/bin/openssl; do
        if [ -x "$candidate" ]; then
            OPENSSL="$candidate"
            break
        fi
    done
fi
if "$OPENSSL" version 2>/dev/null | grep -qi libressl || ! command -v "$OPENSSL" > /dev/null; then
    echo "OpenSSL 3+ is required (found: $("$OPENSSL" version 2>/dev/null || echo none))."
    echo "Install it (brew install openssl@3) or set OPENSSL=/path/to/openssl"
    exit 1
fi
readonly OPENSSL

# Load the env file (set -a keeps quoted multi-line values intact)
ENV_FILE="${ENV_FILE:-.env}"
if [ -f "$ENV_FILE" ]; then
    set -a
    # shellcheck disable=SC1090
    case "$ENV_FILE" in
        */*) . "$ENV_FILE" ;;
        *)   . "./$ENV_FILE" ;;
    esac
    set +a
elif [ "$ENV_FILE" != ".env" ]; then
    echo "ENV_FILE not found: ${ENV_FILE}"
    exit 1
fi

: "${BITCOINDEEPA_API_URL:?BITCOINDEEPA_API_URL not set}"
: "${BITCOINDEEPA_WALLET_ID:?BITCOINDEEPA_WALLET_ID not set}"

TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

KEY_FILE="${BITCOINDEEPA_PRIVATE_KEY_FILE:-}"
if [ -z "$KEY_FILE" ]; then
    : "${BITCOINDEEPA_PRIVATE_KEY_PEM:?Set BITCOINDEEPA_PRIVATE_KEY_FILE or BITCOINDEEPA_PRIVATE_KEY_PEM}"
    KEY_FILE="$TMP_DIR/key.pem"
    printf '%b\n' "${BITCOINDEEPA_PRIVATE_KEY_PEM}" > "$KEY_FILE"
    chmod 600 "$KEY_FILE"
fi

ENDPOINT="/api/v1/userbalance"
METHOD="POST"
TIMESTAMP=$(date +%s)
NONCE=$("$OPENSSL" rand -hex 16)

# Serialize once: these exact bytes are hashed, signed and sent
# (same as JSON.stringify({ telegram_id }) in BitcoinDeepaService.getUserBalance)
REQUEST_BODY=$(printf '{"telegram_id":%s}' "$TELEGRAM_ID")
BODY_HASH=$(printf '%s' "$REQUEST_BODY" | "$OPENSSL" dgst -sha256 -r | cut -d' ' -f1)

# BDB-SEND-ED25519-V1 \n METHOD \n PATH \n QUERY (empty) \n TS \n NONCE \n sha256hex(body)
printf 'BDB-SEND-ED25519-V1\n%s\n%s\n\n%s\n%s\n%s' \
    "$METHOD" "$ENDPOINT" "$TIMESTAMP" "$NONCE" "$BODY_HASH" > "$TMP_DIR/message"
SIGNATURE=$("$OPENSSL" pkeyutl -sign -inkey "$KEY_FILE" -rawin -in "$TMP_DIR/message" | "$OPENSSL" base64 -A)

echo "========================================="
echo "BitcoinDeepa User Balance Test"
echo "========================================="
echo "Env file:     ${ENV_FILE}"
echo "API URL:      ${BITCOINDEEPA_API_URL}${ENDPOINT}"
echo "Wallet ID:    ${BITCOINDEEPA_WALLET_ID}"
echo "User:         ${TELEGRAM_ID}"
echo "Timestamp:    ${TIMESTAMP}"
echo "Nonce:        ${NONCE}"
echo "Request Body: ${REQUEST_BODY}"
echo "Body SHA-256: ${BODY_HASH}"
echo "Signature:    ${SIGNATURE}"
echo "========================================="

if [ "${DRY_RUN:-}" = "1" ]; then
    echo "DRY_RUN=1: not sent"
    exit 0
fi

echo "Sending request..."
# Headers and body go to files so the whole response can be printed untouched
CURL_STATUS=0
CURL_META=$(curl -sS -X POST "${BITCOINDEEPA_API_URL}${ENDPOINT}" \
    -H "Content-Type: application/json" \
    -H "X-Wallet-ID: ${BITCOINDEEPA_WALLET_ID}" \
    -H "X-Timestamp: ${TIMESTAMP}" \
    -H "X-Nonce: ${NONCE}" \
    -H "X-Signature: ${SIGNATURE}" \
    --data-binary "${REQUEST_BODY}" \
    --max-time 30 \
    -D "$TMP_DIR/headers" \
    -o "$TMP_DIR/body" \
    -w '%{http_code} %{time_total} %{size_download}') || CURL_STATUS=$?

if [ "$CURL_STATUS" -ne 0 ] && [ ! -s "$TMP_DIR/headers" ]; then
    echo "❌ Request failed (curl exit ${CURL_STATUS}, no response from ${BITCOINDEEPA_API_URL})"
    exit 1
fi

read -r HTTP_CODE TIME_TOTAL SIZE_DOWNLOAD <<< "$CURL_META"

echo "========================================="
echo "Response (HTTP ${HTTP_CODE}, ${TIME_TOTAL}s, ${SIZE_DOWNLOAD} bytes)"
echo "----- headers -----"
tr -d '\r' < "$TMP_DIR/headers" | sed '/^$/d'
echo "----- body (raw) -----"
if [ -s "$TMP_DIR/body" ]; then
    cat "$TMP_DIR/body"
    echo
else
    echo "(empty)"
fi
if command -v jq &> /dev/null && jq -e . "$TMP_DIR/body" > /dev/null 2>&1; then
    echo "----- body (JSON) -----"
    jq '.' "$TMP_DIR/body"
fi
echo "========================================="
if [ "$CURL_STATUS" -ne 0 ]; then
    echo "❌ Response was cut short (curl exit ${CURL_STATUS})"
    exit 1
fi

case "$HTTP_CODE" in
    200)     echo "✅ Balance fetched"; exit 0 ;;
    401|403) echo "❌ Rejected (${HTTP_CODE}): check the key, wallet id, clock or IP allowlist"; exit 1 ;;
    *)       echo "❌ Balance fetch failed with status ${HTTP_CODE}"; exit 1 ;;
esac
