#!/usr/bin/env bash
# Write the Homebrew cask for an already-published release.
#
#   packaging/homebrew.sh <version> [outdir]
#   packaging/homebrew.sh 1.0.0 dist
#
# A cask rather than a formula, because the macOS download already is an
# application: packaging/app.sh puts both executables inside snyvi.app, and a
# formula that reaches into a bundle to pull one out would be describing the
# download as something it is not.
#
# The cask is also the answer to Gatekeeper, but not for free. Homebrew
# quarantines what it downloads exactly as a browser does, and the bundle is
# signed ad-hoc, so an installed cask would be refused on first open like any
# other download. The postflight below takes the attribute off -- the same
# `xattr` the guide gives the reader to type -- on the argument that
# installing from this tap by name is the reader's consent, given once, in a
# command they were already typing. Notarising the bundle would make this
# unnecessary and needs a paid developer account; until then this is the
# honest version of it.
#
# The two hashes are not computed here. They are read from the .sha256 files
# the release workflow uploaded beside the tarballs, so the cask can only ever
# claim what the release actually published; if an asset is missing this stops
# rather than writing a cask nobody can install.
set -euo pipefail

version=${1:?usage: homebrew.sh <version> [outdir]}
version=${version#v}
out=${2:-dist}
repo=${SNYVI_REPO:-snymrova/snyvi}
base=https://github.com/$repo/releases/download/v$version

# Read one architecture's hash out of the .sha256 beside its tarball. sha256sum
# writes "<hash>  <filename>"; take the first field and check it is a hash and
# not, say, GitHub's 404 page.
hash_for() {
  local target=$1 url sum
  url=$base/snyvi-$version-$target.tar.gz.sha256
  sum=$(curl -fsSL "$url" | awk '{print $1; exit}') || {
    echo "homebrew.sh: no checksum at $url" >&2; exit 1; }
  [[ $sum =~ ^[0-9a-f]{64}$ ]] || {
    echo "homebrew.sh: $url did not contain a sha256: $sum" >&2; exit 1; }
  echo "$sum"
}

arm=$(hash_for aarch64-apple-darwin)
intel=$(hash_for x86_64-apple-darwin)

mkdir -p "$out"
cat > "$out/snyvi.rb" <<CASK
cask "snyvi" do
  arch arm: "aarch64", intel: "x86_64"

  version "$version"
  sha256 arm:   "$arm",
         intel: "$intel"

  url "https://github.com/$repo/releases/download/v#{version}/snyvi-#{version}-#{arch}-apple-darwin.tar.gz",
      verified: "github.com/$repo/"
  name "snyvi"
  desc "Fast, beautiful viewer for the documents your agents produce"
  homepage "https://mrova.rocks/snyvi"

  depends_on macos: ">= :big_sur"

  app "snyvi-#{version}-#{arch}-apple-darwin/snyvi.app"
  # The command line, from inside the bundle that was just installed. One
  # download carries the window and the CLI, so \`brew install --cask snyvi\`
  # leaves the reader with both \`snyvi\` and something to double-click.
  binary "#{appdir}/snyvi.app/Contents/MacOS/snyvi"

  # See the header of packaging/homebrew.sh: ad-hoc signed, so without this the
  # first open is refused as coming from an unidentified developer.
  postflight do
    system_command "/usr/bin/xattr",
                   args: ["-dr", "com.apple.quarantine", "#{appdir}/snyvi.app"]
  end

  # The daemon outlives the window, and an upgrade that swaps the binary under
  # a running one leaves the old code serving. Stop it first; \`snyvi stop\` is
  # the same command the reader would type.
  uninstall quit:   "rocks.ohmydog.snyvi",
            script: {
              executable:   "#{appdir}/snyvi.app/Contents/MacOS/snyvi",
              args:         ["stop"],
              must_succeed: false,
            }

  # The library is the reader's documents. It is never removed by an
  # uninstall, only by \`brew zap\`, which says out loud that it deletes data.
  zap trash: [
    "~/Library/Application Support/snyvi",
    "~/Library/Application Support/rocks.ohmydog.snyvi",
    "~/Library/Saved Application State/rocks.ohmydog.snyvi.savedState",
    "~/Library/WebKit/rocks.ohmydog.snyvi",
  ]
end
CASK

echo "$out/snyvi.rb"
