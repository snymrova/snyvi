#!/usr/bin/env bash
# Build a .deb around an already-built static snyvi binary.
#
#   packaging/deb.sh <binary> <version> <debian-arch> [outdir]
#   packaging/deb.sh target/x86_64-unknown-linux-musl/release/snyvi 0.4.0 amd64 dist
#
# The binary is static (musl), so the package declares no dependencies: it
# installs on any Debian or Ubuntu of that architecture and pulls in nothing.
# dpkg-deb is the only tool needed, which is why this is a script and not
# another crate in the build.
set -euo pipefail

bin=${1:?usage: deb.sh <binary> <version> <arch> [outdir]}
version=${2:?}
arch=${3:?}
out=${4:-dist}
maintainer=${DEB_MAINTAINER:-"snymrova <sunny@ohmydog.rocks>"}

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
root=$(dirname "$here")
[ -x "$bin" ] || { echo "deb.sh: $bin is not an executable" >&2; exit 1; }

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
chmod 755 "$stage"   # mktemp -d is 0700; the package root must not be

install -Dm755 "$bin"                    "$stage/usr/bin/snyvi"
install -Dm644 "$here/snyvi.service"     "$stage/usr/lib/systemd/user/snyvi.service"
install -Dm644 "$here/snyvi.desktop"     "$stage/usr/share/applications/snyvi.desktop"
install -Dm644 "$root/icons/icon.png"    "$stage/usr/share/icons/hicolor/256x256/apps/snyvi.png"
install -Dm644 "$here/copyright"         "$stage/usr/share/doc/snyvi/copyright"
install -Dm644 "$root/README.md"         "$stage/usr/share/doc/snyvi/README.md"
gzip -9n "$stage/usr/share/doc/snyvi/README.md"

# Dates come from SOURCE_DATE_EPOCH when set, so two builds of the same tag
# produce the same bytes.
epoch=${SOURCE_DATE_EPOCH:-$(date +%s)}
{
  echo "snyvi ($version) unstable; urgency=medium"
  echo
  echo "  * snyvi $version. Release notes:"
  echo "    https://github.com/snymrova/snyvi/releases/tag/v$version"
  echo
  echo " -- $maintainer  $(date -R -u -d "@$epoch")"
} | gzip -9n > "$stage/usr/share/doc/snyvi/changelog.Debian.gz"
chmod 644 "$stage/usr/share/doc/snyvi/changelog.Debian.gz"

mkdir -p "$stage/DEBIAN"
cat > "$stage/DEBIAN/control" <<EOF
Package: snyvi
Version: $version
Architecture: $arch
Maintainer: $maintainer
Installed-Size: $(du -ks --exclude=DEBIAN "$stage" | cut -f1)
Section: utils
Priority: optional
Homepage: https://github.com/snymrova/snyvi
Description: fast, beautiful viewer for the documents your agents produce
 snyvi receives Markdown and source files from coding agents such as Claude
 Code and shows them rendered, filed under the project and workflow they came
 from. It also browses a folder straight from disk.
 .
 The channel is one way: agents send, snyvi shows. Nothing is ever read back
 out, and the daemon listens on the loopback interface only.
 .
 A single static binary with its own UI, fonts and syntax grammars embedded.
 No runtime, no dependencies, no network access.
EOF

cat > "$stage/DEBIAN/postinst" <<'EOF'
#!/bin/sh
set -e
if [ "$1" = configure ] && [ -n "$2" ]; then
  echo "snyvi: the daemon keeps running the old binary until it is restarted."
  echo "snyvi:   systemctl --user restart snyvi   (or: snyvi restart)"
fi
EOF
chmod 755 "$stage/DEBIAN/postinst"

# md5sums covers every shipped file, so `dpkg -V snyvi` can verify the install.
(cd "$stage" && find . -path ./DEBIAN -prune -o -type f -print0 \
  | sed -z 's|^\./||' | sort -z | xargs -0 md5sum > DEBIAN/md5sums)
chmod 644 "$stage/DEBIAN/md5sums"

mkdir -p "$out"
deb="$out/snyvi_${version}_${arch}.deb"
dpkg-deb --root-owner-group --build "$stage" "$deb" >/dev/null
echo "$deb"
