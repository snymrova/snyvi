#!/usr/bin/env bash
# Sign snyvi.app with Mrova's Developer ID, have Apple notarize it, and staple
# the ticket to it, in place.
#
#   packaging/notarize.sh dist/snyvi-1.23.0-aarch64-apple-darwin/snyvi.app
#
# app.sh signs the bundle ad hoc, which is all Apple silicon needs to run it.
# A download opened from Safari is checked by Gatekeeper as well, and an ad
# hoc bundle is "from an unidentified developer": the reader is sent to System
# Settings to let it open. Signed with a Developer ID under the hardened
# runtime, notarized and stapled, it opens after the one "downloaded from the
# internet" question, offline too, since the ticket travels inside it.
#
# From the environment, all five or none:
#   MACOS_CERT_P12       base64 of the .p12: the Developer ID Application
#                        certificate, its key and Apple's G2 intermediate
#   MACOS_CERT_PASSWORD  the .p12's password
#   APPLE_API_KEY_P8     an App Store Connect API key (the .p8's text)
#   APPLE_API_KEY_ID     its id
#   APPLE_API_ISSUER     its issuer id
# With none of them -- a fork, a local run -- the bundle stays as app.sh left
# it and this says so; a release is never stopped for want of them. With some
# and not all, that is a mistake in the repository's secrets, and it stops.
set -euo pipefail

app=${1:?usage: notarize.sh <snyvi.app>}
[ -d "$app/Contents/MacOS" ] || { echo "notarize.sh: $app is not a bundle" >&2; exit 1; }

have=0
for v in MACOS_CERT_P12 MACOS_CERT_PASSWORD APPLE_API_KEY_P8 APPLE_API_KEY_ID APPLE_API_ISSUER; do
  [ -n "${!v:-}" ] && have=$((have + 1))
done
if [ "$have" = 0 ]; then
  echo "::warning::no Developer ID in this repository's secrets: $app stays signed ad hoc, and Gatekeeper will call it unidentified"
  exit 0
fi
[ "$have" = 5 ] || { echo "notarize.sh: $have of the five signing secrets are set; all five or none" >&2; exit 1; }

work=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/notarize.XXXXXX")
kc="$work/sign.keychain-db"
cleanup() {
  security delete-keychain "$kc" 2>/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT

# A keychain of its own, for this run only, holding the one identity.
pw=$(openssl rand -hex 24)
security create-keychain -p "$pw" "$kc"
security set-keychain-settings -lut 3600 "$kc"
security unlock-keychain -p "$pw" "$kc"
printf '%s' "$MACOS_CERT_P12" | base64 --decode > "$work/cert.p12"
security import "$work/cert.p12" -k "$kc" -f pkcs12 -P "$MACOS_CERT_PASSWORD" -T /usr/bin/codesign >/dev/null
rm -f "$work/cert.p12"
security set-key-partition-list -S apple-tool:,apple: -s -k "$pw" "$kc" >/dev/null
# codesign looks for an identity in the search list: this one first.
# shellcheck disable=SC2046
security list-keychains -d user -s "$kc" $(security list-keychains -d user | tr -d '"')
id=$(security find-identity -v -p codesigning "$kc" | sed -n 's/.*"\(Developer ID Application: [^"]*\)".*/\1/p' | head -n1)
[ -n "$id" ] || { echo "notarize.sh: the .p12 holds no Developer ID Application identity" >&2; exit 1; }
echo "signing as $id"

# Inside out: each executable, then the bundle that seals them. --deep is
# for verifying, not signing. The hardened runtime is what notarization
# requires; no entitlements beyond it -- the window's WebKit is the
# system's, in processes of its own.
sign() { codesign --force --options runtime --timestamp --sign "$id" "$@"; }
for exe in "$app"/Contents/MacOS/*; do sign "$exe"; done
sign "$app"
codesign --verify --deep --strict --verbose=2 "$app"

# To Apple and back. --wait holds until the verdict, usually a few minutes.
printf '%s' "$APPLE_API_KEY_P8" > "$work/key.p8"
ditto -c -k --keepParent "$app" "$work/snyvi.zip"
auth=(--key "$work/key.p8" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER")
xcrun notarytool submit "$work/snyvi.zip" "${auth[@]}" --wait --timeout 30m --output-format json > "$work/verdict.json" || true
status=$(plutil -extract status raw "$work/verdict.json" 2>/dev/null || echo "no verdict")
sub=$(plutil -extract id raw "$work/verdict.json" 2>/dev/null || echo "")
echo "notarization: $status${sub:+ ($sub)}"
if [ "$status" != "Accepted" ]; then
  cat "$work/verdict.json" >&2 || true
  # Apple's log says which file and why: printed, since it is the only way to know.
  [ -n "$sub" ] && xcrun notarytool log "$sub" "${auth[@]}" >&2 || true
  exit 1
fi

# The ticket goes inside the bundle, so Gatekeeper need not ask Apple.
xcrun stapler staple "$app"
xcrun stapler validate "$app"
spctl --assess --type execute --verbose=2 "$app"
