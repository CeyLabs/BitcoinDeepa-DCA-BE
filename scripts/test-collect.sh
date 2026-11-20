#!/bin/bash

# BitcoinDeepa Collect API Test Script (Ed25519-signed, same scheme as
# test-fund-transfer.sh). Wallet endpoints of the bot's docs/collect-api.md
# (dca-backend-integration.md §4.7).
#
# Usage:
#   ./scripts/test-collect.sh create <payer_telegram_id> <amount_sats> [memo] [external_id]
#   ./scripts/test-collect.sh get    <collect_id>
#   ./scripts/test-collect.sh watch  <collect_id>     # poll every 3s until final
#   ./scripts/test-collect.sh cancel <collect_id>
# Example:
#   ENV_FILE=.env.dev ./scripts/test-collect.sh create 7551840633 1000 "Collect test"
#
# <payer_telegram_id> is the numeric Telegram ID of the user to charge. It is
# not in the body: it goes in the X-BDB-User header and on the seventh line of
# the signed text (BDB-COLLECT-ED25519-V1), and the two must match exactly. The
# user must have logged in through /api/v1/init, else 403 payer_not_linked.
# external_id defaults to a new UUID: a new one for each charge, the same one
# on a retry (200 instead of 201).
#
# `create` names a REAL user to charge and the bot sends them no chat message.
# Treat it as able to move that user's sats. The wallet needs
# `can_collect: true` on the bot.
#
# get / watch / cancel use the send signed text (BDB-SEND-ED25519-V1), with no
# X-BDB-User.
#
# Needs BITCOINDEEPA_API_URL, BITCOINDEEPA_WALLET_ID and the private key, either
# BITCOINDEEPA_PRIVATE_KEY_FILE (path to the PEM) or
# BITCOINDEEPA_PRIVATE_KEY_PEM (PEM text, multi-line or with literal \n).
# They are read from ENV_FILE (default .env), e.g. ENV_FILE=.env.dev for staging.
# DRY_RUN=1 prints the signed request without sending it.
# Requires OpenSSL 3+ (pkeyutl -rawin for Ed25519). macOS ships LibreSSL, which
# can't do it: Homebrew's openssl@3 is picked up automatically, or set OPENSSL.

set -euo pipefail

usage() {
    echo "Usage: $0 create <payer_telegram_id> <amount_sats> [memo] [external_id]"
    echo "       $0 get    <collect_id>"
    echo "       $0 watch  <collect_id>"
    echo "       $0 cancel <collect_id>"
    echo "Example: ENV_FILE=.env.dev $0 create 7551840633 1000 \"Collect test\""
    exit 1
}

[ "$#" -ge 1 ] || usage
ACTION=$1
shift

json_escape() {
    local s=$1
    s=${s//\\/\\\\}
    s=${s//\"/\\\"}
    printf '%s' "$s"
}

BASE_ENDPOINT="/api/v1/collect"

case "$ACTION" in
    create)
        [ "$#" -ge 2 ] || usage
        PAYER=$1
        AMOUNT=$2
        MEMO=${3:-"Collect API test"}
        EXTERNAL_ID=${4:-}

        # Signed and sent as X-BDB-User, so it has to be the plain numeric ID
        if ! [[ "$PAYER" =~ ^[1-9][0-9]*$ ]]; then
            echo "payer_telegram_id must be a numeric Telegram ID, got: ${PAYER}"
            exit 1
        fi
        # No leading zeros: the value goes into the JSON body as a number
        if ! [[ "$AMOUNT" =~ ^[1-9][0-9]*$ ]]; then
            echo "amount_sats must be a whole number above 0, got: ${AMOUNT}"
            exit 1
        fi
        if [[ "$MEMO" =~ [[:cntrl:]] ]]; then
            echo "memo must not contain control characters or newlines"
            exit 1
        fi
        if [ -z "$EXTERNAL_ID" ]; then
            if command -v uuidgen > /dev/null; then
                EXTERNAL_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')
            else
                EXTERNAL_ID="test-$(date +%s)-$RANDOM$RANDOM"
            fi
        fi
        if ! [[ "$EXTERNAL_ID" =~ ^[A-Za-z0-9._:-]{8,128}$ ]]; then
            echo "external_id must be 8-128 characters of [A-Za-z0-9._:-], got: ${EXTERNAL_ID}"
            exit 1
        fi

        METHOD="POST"
        ENDPOINT="$BASE_ENDPOINT"
        # No "to": the payer is named by X-BDB-User and the signed text
        REQUEST_BODY=$(printf '{"amount":%s,"memo":"%s","external_id":"%s"}' \
            "$AMOUNT" "$(json_escape "$MEMO")" "$EXTERNAL_ID")
        ;;
    get|watch|cancel)
        [ "$#" -ge 1 ] || usage
        COLLECT_ID=$1
        if ! [[ "$COLLECT_ID" =~ ^[A-Za-z0-9_-]+$ ]]; then
            echo "collect_id looks wrong (expected col-...), got: ${COLLECT_ID}"
            exit 1
        fi
        if [ "$ACTION" = "cancel" ]; then
            METHOD="POST"
            ENDPOINT="${BASE_ENDPOINT}/${COLLECT_ID}/cancel"
            REQUEST_BODY='{}'
        else
            METHOD="GET"
            ENDPOINT="${BASE_ENDPOINT}/${COLLECT_ID}"
            REQUEST_BODY=''
        fi
        ;;
    *)
        usage
        ;;
esac

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

if [ "$ACTION" = "watch" ] && ! command -v jq > /dev/null; then
    echo "watch needs jq (brew install jq)"
    exit 1
fi

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

# Sign the request: every call gets a new timestamp and nonce (the bot rejects
# a reused nonce). The exact body bytes are hashed, signed and sent.
# create (8 lines):
#   BDB-COLLECT-ED25519-V1 \n METHOD \n PATH \n QUERY (empty) \n TS \n NONCE \n PAYER \n sha256hex(body)
# get / watch / cancel (7 lines):
#   BDB-SEND-ED25519-V1 \n METHOD \n PATH \n QUERY (empty) \n TS \n NONCE \n sha256hex(body)
sign_request() {
    TIMESTAMP=$(date +%s)
    NONCE=$("$OPENSSL" rand -hex 16)
    BODY_HASH=$(printf '%s' "$REQUEST_BODY" | "$OPENSSL" dgst -sha256 -r | cut -d' ' -f1)
    if [ "$ACTION" = "create" ]; then
        printf 'BDB-COLLECT-ED25519-V1\n%s\n%s\n\n%s\n%s\n%s\n%s' \
            "$METHOD" "$ENDPOINT" "$TIMESTAMP" "$NONCE" "$PAYER" "$BODY_HASH" > "$TMP_DIR/message"
    else
        printf 'BDB-SEND-ED25519-V1\n%s\n%s\n\n%s\n%s\n%s' \
            "$METHOD" "$ENDPOINT" "$TIMESTAMP" "$NONCE" "$BODY_HASH" > "$TMP_DIR/message"
    fi
    SIGNATURE=$("$OPENSSL" pkeyutl -sign -inkey "$KEY_FILE" -rawin -in "$TMP_DIR/message" | "$OPENSSL" base64 -A)
}

# Sends the signed request. Headers and body go to files so the whole response
# can be printed untouched. Sets HTTP_CODE, TIME_TOTAL, SIZE_DOWNLOAD.
send_request() {
    local curl_status=0 curl_meta
    local -a args=(-sS -X "$METHOD" "${BITCOINDEEPA_API_URL}${ENDPOINT}"
        -H "Content-Type: application/json"
        -H "X-Wallet-ID: ${BITCOINDEEPA_WALLET_ID}"
        -H "X-Timestamp: ${TIMESTAMP}"
        -H "X-Nonce: ${NONCE}"
        -H "X-Signature: ${SIGNATURE}"
        --max-time 30
        -D "$TMP_DIR/headers"
        -o "$TMP_DIR/body"
        -w '%{http_code} %{time_total} %{size_download}')
    if [ -n "$REQUEST_BODY" ]; then
        args+=(--data-binary "$REQUEST_BODY")
    fi
    # Must equal the seventh line of the signed text
    if [ "$ACTION" = "create" ]; then
        args+=(-H "X-BDB-User: ${PAYER}")
    fi
    : > "$TMP_DIR/headers"
    : > "$TMP_DIR/body"
    curl_meta=$(curl "${args[@]}") || curl_status=$?

    if [ "$curl_status" -ne 0 ] && [ ! -s "$TMP_DIR/headers" ]; then
        echo "❌ Request failed (curl exit ${curl_status}, no response from ${BITCOINDEEPA_API_URL})"
        exit 1
    fi
    read -r HTTP_CODE TIME_TOTAL SIZE_DOWNLOAD <<< "$curl_meta"
    if [ "$curl_status" -ne 0 ]; then
        echo "❌ Response was cut short (curl exit ${curl_status}, HTTP ${HTTP_CODE})"
        exit 1
    fi
}

body_is_json() {
    command -v jq > /dev/null && jq -e . "$TMP_DIR/body" > /dev/null 2>&1
}

# One line about the request in the response body
summary() {
    jq -r '"id=\(.id) status=\(.status) paid=\(.paid) amount=\(.amount) expires_at=\(.expires_at)"
        + (if .transfer then " transfer=\(.transfer.id):\(.transfer.status)" else "" end)' "$TMP_DIR/body"
}

# 0 while the request can still change (the doc's polling rule), 1 once final
still_open() {
    jq -e '
        .status == "pending"
        or (.status == "approved" and (.paid | not)
            and ((.transfer.status // "") | IN("processing", "in_flight")))
    ' "$TMP_DIR/body" > /dev/null
}

sign_request

echo "========================================="
echo "BitcoinDeepa Collect Test: ${ACTION}"
echo "========================================="
echo "Env file:     ${ENV_FILE}"
echo "API URL:      ${METHOD} ${BITCOINDEEPA_API_URL}${ENDPOINT}"
echo "Wallet ID:    ${BITCOINDEEPA_WALLET_ID}"
if [ "$ACTION" = "create" ]; then
    echo "X-BDB-User:   ${PAYER} (payer)"
    echo "Amount:       ${AMOUNT} sats"
    echo "Memo:         ${MEMO}"
    echo "External ID:  ${EXTERNAL_ID}"
else
    echo "Collect ID:   ${COLLECT_ID}"
fi
echo "Timestamp:    ${TIMESTAMP}"
echo "Nonce:        ${NONCE}"
echo "Request Body: ${REQUEST_BODY:-(empty)}"
echo "Body SHA-256: ${BODY_HASH}"
echo "Signature:    ${SIGNATURE}"
echo "========================================="

if [ "${DRY_RUN:-}" = "1" ]; then
    echo "DRY_RUN=1: not sent"
    exit 0
fi

echo "Sending request..."
send_request

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
HAS_JSON=0
if body_is_json; then
    HAS_JSON=1
    echo "----- body (JSON) -----"
    jq '.' "$TMP_DIR/body"
fi
echo "========================================="

case "$HTTP_CODE" in
    200|201) ;;
    401)
        echo "❌ Rejected (401): check the key, wallet id, clock or IP allowlist"
        exit 1
        ;;
    *)
        CODE=""
        if [ "$HAS_JSON" = "1" ]; then
            CODE=$(jq -r '.code // empty' "$TMP_DIR/body")
        fi
        case "$CODE" in
            collect_not_allowed)   HINT="the wallet needs can_collect: true on the bot" ;;
            collector_not_allowed) HINT="the wallet's bot user is missing or banned" ;;
            payer_not_linked)      HINT="the payer has not logged in through /api/v1/init" ;;
            recipient_not_found)   HINT="the user has no bot wallet (never started the bot or logged in through init)" ;;
            idempotency_conflict)  HINT="this external_id was used with a different user, amount or memo" ;;
            in_progress)           HINT="the same request is being handled right now: try again" ;;
            request_closed)        HINT="already answered, cancelled or expired" ;;
            rate_limited)          HINT="at most 10 requests per wallet per user per hour" ;;
            amount_too_large)      HINT="above the wallet's max_amount" ;;
            self_collect)          HINT="the payer is the wallet's own user" ;;
            not_found)             HINT="no such request for this wallet" ;;
            "")                    HINT="check the key, wallet id, clock or IP allowlist" ;;
            *)                     HINT="" ;;
        esac
        echo "❌ ${ACTION} failed with status ${HTTP_CODE}${CODE:+ (${CODE})}${HINT:+: ${HINT}}"
        exit 1
        ;;
esac

if [ "$HAS_JSON" != "1" ]; then
    echo "✅ ${ACTION} ok (HTTP ${HTTP_CODE})"
    exit 0
fi

case "$ACTION" in
    create)
        NEW_ID=$(jq -r '.id' "$TMP_DIR/body")
        if [ "$HTTP_CODE" = "201" ]; then
            echo "✅ Request created: $(summary)"
        else
            echo "✅ Existing request returned (same external_id): $(summary)"
        fi
        echo "   Watch:  $0 watch ${NEW_ID}"
        echo "   Cancel: $0 cancel ${NEW_ID}"
        ;;
    get)
        echo "✅ $(summary)"
        ;;
    cancel)
        echo "✅ Cancelled: $(summary)"
        ;;
    watch)
        echo "$(date +%H:%M:%S) $(summary)"
        while still_open; do
            sleep 3
            sign_request
            send_request
            if [ "$HTTP_CODE" != "200" ] || ! body_is_json; then
                echo "❌ Poll failed with status ${HTTP_CODE}"
                cat "$TMP_DIR/body"
                echo
                exit 1
            fi
            echo "$(date +%H:%M:%S) $(summary)"
        done
        echo "========================================="
        jq '.' "$TMP_DIR/body"
        if [ "$(jq -r '.paid' "$TMP_DIR/body")" = "true" ]; then
            echo "✅ Paid"
        else
            echo "❌ Final without payment: status $(jq -r '.status' "$TMP_DIR/body"), transfer $(jq -r '.transfer.status // "none"' "$TMP_DIR/body")"
            exit 1
        fi
        ;;
esac
