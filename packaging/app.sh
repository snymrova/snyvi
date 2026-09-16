#!/usr/bin/env bash
# Build snyvi.app around already-built binaries.
#
#   packaging/app.sh <snyvi> <snyvi-app> <version> [outdir]
#   packaging/app.sh target/release/snyvi target/release/snyvi-app 0.16.0 dist
#
# The macOS download is the application bundle and nothing beside it. Both
# executables are inside: snyvi-app, which the bundle runs when it is opened,
# and snyvi -- the daemon, the CLI, the MCP server, the hook -- which the
# window hands over to when it is started with no URL, so a double-click on
# the icon starts the daemon and opens the viewer with nothing else installed.
# The command line is a symlink to that inner snyvi (the README says where),
# and `snyvi app` from it finds the window beside the real file.
#
# Only the layout is done here; the two things that need a Mac are done when
# there is one and skipped when there is not. The icon is compiled from the
# PNGs by iconutil, and the bundle is signed with an ad-hoc signature by
# codesign: not an identity, which needs an Apple developer account, but the
# signature Apple silicon requires before it will run an executable at all.
# Without it the bundle is still a bundle, which is what the Linux CI checks.
set -euo pipefail

snyvi=${1:?usage: app.sh <snyvi> <snyvi-app> <version> [outdir]}
app=${2:?}
version=${3:?}
out=${4:-dist}

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
root=$(dirname "$here")
[ -x "$snyvi" ] || { echo "app.sh: $snyvi is not an executable" >&2; exit 1; }
[ -x "$app" ] || { echo "app.sh: $app is not an executable" >&2; exit 1; }

bundle="$out/snyvi.app"
rm -rf "$bundle"
mkdir -p "$bundle/Contents/MacOS" "$bundle/Contents/Resources"
install -m755 "$app"   "$bundle/Contents/MacOS/snyvi-app"
install -m755 "$snyvi" "$bundle/Contents/MacOS/snyvi"
printf 'APPL????' > "$bundle/Contents/PkgInfo"

# Every size the Finder and the Dock draw, each at 1x and 2x. The 2x of one
# size is the 1x of the next, so eight PNGs make an iconset; 1024 is the one
# size not drawn, so the largest slot's 2x is left out rather than upscaled.
if command -v iconutil >/dev/null; then
  set=$(mktemp -d)/snyvi.iconset
  mkdir -p "$set"
  for px in 16 32 128 256 512; do
    cp "$root/icons/$px.png" "$set/icon_${px}x${px}.png"
    two=$((px * 2))
    [ -f "$root/icons/$two.png" ] && cp "$root/icons/$two.png" "$set/icon_${px}x${px}@2x.png"
  done
  iconutil -c icns "$set" -o "$bundle/Contents/Resources/snyvi.icns"
  rm -rf "$(dirname "$set")"
else
  echo "app.sh: no iconutil here, so no icon; the bundle is otherwise complete" >&2
fi

# CFBundleURLTypes is what makes snyvi:// links open here. Launch Services
# reads it when the bundle is first seen (put in Applications, or opened
# once) and from then on hands such a link to the running app, or starts it
# for one. Said here rather than in the plist: an XML comment cannot hold
# a double dash, and one did, which no Mac ever read but plistlib refused.
cat > "$bundle/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleExecutable</key><string>snyvi-app</string>
  <key>CFBundleIconFile</key><string>snyvi</string>
  <key>CFBundleIdentifier</key><string>rocks.ohmydog.snyvi</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>snyvi</string>
  <key>CFBundleDisplayName</key><string>snyvi</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$version</string>
  <key>CFBundleVersion</key><string>$version</string>
  <key>LSMinimumSystemVersion</key><string>10.15</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSSupportsAutomaticGraphicsSwitching</key><true/>
  <key>CFBundleURLTypes</key>
  <array>
    <dict>
      <key>CFBundleURLName</key><string>rocks.ohmydog.snyvi</string>
      <key>CFBundleURLSchemes</key><array><string>snyvi</string></array>
      <key>CFBundleTypeRole</key><string>Viewer</string>
    </dict>
  </array>
</dict>
</plist>
PLIST

if command -v codesign >/dev/null; then
  codesign --force --deep --sign - "$bundle"
else
  echo "app.sh: no codesign here, so the bundle is unsigned" >&2
fi

echo "$bundle"
