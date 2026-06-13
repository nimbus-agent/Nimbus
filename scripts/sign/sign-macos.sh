#!/usr/bin/env bash
# scripts/sign/sign-macos.sh — codesign (binaries) / productsign (.pkg) + notarize.
# Convention (matches sign-linux-gpg.sh): cert secrets present -> sign; else warn + exit 0.
# Required secrets when signing:
#   APPLE_CERT_P12_BASE64, APPLE_CERT_PASSWORD, APPLE_TEAM_ID,
#   APPLE_DEVELOPER_ID_APP, APPLE_DEVELOPER_ID_INSTALLER,
#   APPLE_NOTARY_ID, APPLE_NOTARY_PASSWORD   (notarytool Apple-ID creds)
set -euo pipefail

TARGET="${1:-}"
if [[ -z "$TARGET" ]]; then echo "usage: $0 <path>" >&2; exit 1; fi

if [[ -z "${APPLE_CERT_P12_BASE64:-}" || -z "${APPLE_TEAM_ID:-}" ]]; then
  echo "signing skipped: APPLE_CERT_P12_BASE64 / APPLE_TEAM_ID not set"
  exit 0
fi

KEYCHAIN="$(mktemp -d)/nimbus-signing.keychain-db"
KEYCHAIN_PW="$(uuidgen)"
cleanup() {
  rm -f "$KEYCHAIN.p12"
  security delete-keychain "$KEYCHAIN" >/dev/null 2>&1 || true
}
trap cleanup EXIT

security create-keychain -p "$KEYCHAIN_PW" "$KEYCHAIN"
security set-keychain-settings -lut 21600 "$KEYCHAIN"
security unlock-keychain -p "$KEYCHAIN_PW" "$KEYCHAIN"
echo "$APPLE_CERT_P12_BASE64" | base64 --decode > "$KEYCHAIN.p12"
security import "$KEYCHAIN.p12" -k "$KEYCHAIN" -P "${APPLE_CERT_PASSWORD:-}" \
  -T /usr/bin/codesign -T /usr/bin/productsign
security set-key-partition-list -S apple-tool:,apple: -k "$KEYCHAIN_PW" "$KEYCHAIN" >/dev/null
# Prepend our keychain to the user search list WITHOUT clobbering the existing
# ones. `list-keychains -s` takes each keychain as a SEPARATE argv entry, so the
# existing list must be split into distinct args (not one quoted string).
existing_keychains=()
while IFS= read -r kc; do
  kc="$(printf '%s' "$kc" | sed -E 's/^[[:space:]]*"?//; s/"?[[:space:]]*$//')"
  [[ -n "$kc" ]] && existing_keychains+=("$kc")
done < <(security list-keychains -d user)
security list-keychains -d user -s "$KEYCHAIN" "${existing_keychains[@]}"
rm -f "$KEYCHAIN.p12"

case "$TARGET" in
  *.pkg)
    SIGNED="${TARGET%.pkg}-signed.pkg"
    productsign --sign "${APPLE_DEVELOPER_ID_INSTALLER:?}" "$TARGET" "$SIGNED"
    mv "$SIGNED" "$TARGET"
    ;;
  *)
    codesign --force --timestamp --options runtime \
      --sign "${APPLE_DEVELOPER_ID_APP:?}" "$TARGET"
    ;;
esac

# Notarize + staple (best-effort: requires notary creds; skip if absent).
if [[ -n "${APPLE_NOTARY_ID:-}" && -n "${APPLE_NOTARY_PASSWORD:-}" ]]; then
  xcrun notarytool submit "$TARGET" --apple-id "$APPLE_NOTARY_ID" \
    --password "$APPLE_NOTARY_PASSWORD" --team-id "$APPLE_TEAM_ID" --wait
  xcrun stapler staple "$TARGET" || echo "stapler: target type not staple-able; skipping"
else
  echo "notarization skipped: APPLE_NOTARY_ID / APPLE_NOTARY_PASSWORD not set"
fi

echo "signed: $TARGET"
