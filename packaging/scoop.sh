#!/usr/bin/env bash
# Write the Scoop manifest for an already-published release.
#
#   packaging/scoop.sh <version> [outdir]
#   packaging/scoop.sh 1.4.0 dist
#
# The manifest points at the Windows zip -- the folder with both executables
# in it, which is what Scoop wants: something it can unpack into its own
# apps directory and shim, rather than an installer that writes to PATH and
# the Start menu on its own. `snyvi app` finds snyvi-app.exe beside itself,
# so the window comes with the command as it does in the zip.
#
# As with packaging/homebrew.sh, the hash is not computed here. It is read
# from the .sha256 the release workflow uploaded beside the zip, so the
# manifest can only claim what the release published; a missing asset stops
# this rather than writing a manifest nobody can install.
#
# `autoupdate` is the same URL with $version in it and the hash read from the
# same .sha256, so a bucket that runs Scoop's own checkver can bump itself
# without this script; the release workflow just gets there first.
set -euo pipefail

version=${1:?usage: scoop.sh <version> [outdir]}
version=${version#v}
out=${2:-dist}
repo=${SNYVI_REPO:-snymrova/snyvi}
name=snyvi-$version-x86_64-pc-windows-msvc
base=https://github.com/$repo/releases/download/v$version

url=$base/$name.zip.sha256
sum=$(curl -fsSL "$url" | awk '{print $1; exit}') || {
  echo "scoop.sh: no checksum at $url" >&2; exit 1; }
[[ $sum =~ ^[0-9a-f]{64}$ ]] || {
  echo "scoop.sh: $url did not contain a sha256: $sum" >&2; exit 1; }

mkdir -p "$out"
cat > "$out/snyvi.json" <<JSON
{
    "version": "$version",
    "description": "A fast, beautiful viewer for the documents your agents produce",
    "homepage": "https://mrova.rocks/snyvi",
    "license": "MIT",
    "url": "$base/$name.zip",
    "hash": "$sum",
    "extract_dir": "$name",
    "bin": "snyvi.exe",
    "pre_uninstall": [
        "if (Test-Path \"\$dir\\\\snyvi.exe\") { & \"\$dir\\\\snyvi.exe\" stop 2>\$null }",
        "Stop-Process -Name snyvi-app, snyvi -Force -ErrorAction SilentlyContinue"
    ],
    "notes": [
        "snyvi init-claude --auto   connects Claude Code; snyvi init <agent> for the others",
        "snyvi app                  opens the window; snyvi send FILE.md prints a link"
    ],
    "checkver": {
        "github": "https://github.com/$repo"
    },
    "autoupdate": {
        "url": "https://github.com/$repo/releases/download/v\$version/snyvi-\$version-x86_64-pc-windows-msvc.zip",
        "extract_dir": "snyvi-\$version-x86_64-pc-windows-msvc",
        "hash": {
            "url": "\$url.sha256"
        }
    }
}
JSON
echo "$out/snyvi.json"
