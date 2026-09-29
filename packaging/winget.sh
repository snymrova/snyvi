#!/usr/bin/env bash
# Write the winget manifests for an already-published release.
#
#   packaging/winget.sh <version> [outdir]
#   packaging/winget.sh 1.7.0 dist
#
# Prints the directory it wrote, which is laid out as it is in
# microsoft/winget-pkgs -- manifests/s/snymrova/snyvi/<version>/ -- so the
# release workflow copies it across as it stands.
#
# winget is on every Windows 11 and every current Windows 10, where Scoop is
# a thing to install first. And a download winget makes is not marked as
# coming from the internet, so the installer runs without the SmartScreen
# page an unsigned executable gets from a browser download.
#
# The manifests point at the installer, not the zip: winget's model is an
# installer it runs silently and an entry in Apps & features it can find
# again, which is what packaging/windows.iss already is. `inno` tells winget
# the silent switches; the ProductCode is that file's AppId with Inno's _is1
# after it, which is how `winget upgrade` and `winget uninstall` find an
# install made from the double-clicked installer too.
#
# As with packaging/scoop.sh, the hash is read from the .sha256 the release
# workflow uploaded, never computed here, so the manifest can only claim what
# the release published.
set -euo pipefail
# The heredocs below expand $version and the rest, so a backtick in them is a
# command run on whoever's machine this is: quote commands with "", never ``.

version=${1:?usage: winget.sh <version> [outdir]}
version=${version#v}
out=${2:-dist}
repo=${SNYVI_REPO:-snymrova/snyvi}
id=snymrova.snyvi
schema=1.10.0
file=snyvi-$version-x86_64-pc-windows-msvc-setup.exe
base=https://github.com/$repo/releases/download/v$version

url=$base/$file.sha256
sum=$(curl -fsSL "$url" | awk '{print $1; exit}') || {
  echo "winget.sh: no checksum at $url" >&2; exit 1; }
[[ $sum =~ ^[0-9a-f]{64}$ ]] || {
  echo "winget.sh: $url did not contain a sha256: $sum" >&2; exit 1; }

# The release's own date, from GitHub, so a manifest written again later
# still says the day it shipped.
date=$(curl -fsSL "https://api.github.com/repos/$repo/releases/tags/v$version" |
  sed -n 's/.*"published_at": *"\([0-9-]\{10\}\)T.*/\1/p' | head -1)

dir=$out/manifests/s/snymrova/snyvi/$version
mkdir -p "$dir"

cat > "$dir/$id.yaml" <<YAML
# yaml-language-server: \$schema=https://aka.ms/winget-manifest.version.$schema.schema.json
PackageIdentifier: $id
PackageVersion: $version
DefaultLocale: en-US
ManifestType: version
ManifestVersion: $schema
YAML

cat > "$dir/$id.installer.yaml" <<YAML
# yaml-language-server: \$schema=https://aka.ms/winget-manifest.installer.$schema.schema.json
PackageIdentifier: $id
PackageVersion: $version
InstallerType: inno
Scope: user
InstallModes:
- interactive
- silent
- silentWithProgress
UpgradeBehavior: install
Commands:
- snyvi
ProductCode: '{77914D41-28F1-4AB8-AA82-692BB637B9B2}_is1'
${date:+ReleaseDate: $date
}AppsAndFeaturesEntries:
- DisplayName: snyvi
  Publisher: snymrova
  ProductCode: '{77914D41-28F1-4AB8-AA82-692BB637B9B2}_is1'
Installers:
- Architecture: x64
  InstallerUrl: $base/$file
  InstallerSha256: ${sum^^}
ManifestType: installer
ManifestVersion: $schema
YAML

cat > "$dir/$id.locale.en-US.yaml" <<YAML
# yaml-language-server: \$schema=https://aka.ms/winget-manifest.defaultLocale.$schema.schema.json
PackageIdentifier: $id
PackageVersion: $version
PackageLocale: en-US
Publisher: snymrova
PublisherUrl: https://github.com/snymrova
PublisherSupportUrl: https://github.com/$repo/issues
PackageName: snyvi
PackageUrl: https://mrova.rocks/snyvi
License: MIT
LicenseUrl: https://github.com/$repo/blob/main/LICENSE
ShortDescription: A fast, beautiful viewer for the documents your agents produce
Description: |-
  snyvi opens every Markdown file your coding agents write -- plans, specs,
  reviews -- in a window of its own, as it is written. Connect Claude Code
  with the installer's checkbox, or with "snyvi init-claude --auto"; and
  "snyvi send FILE.md" opens any file by hand.
Moniker: snyvi
Tags:
- markdown
- viewer
- claude-code
- ai-agents
- documents
ReleaseNotesUrl: https://github.com/$repo/releases/tag/v$version
ManifestType: defaultLocale
ManifestVersion: $schema
YAML

echo "$dir"
