#!/usr/bin/env bash
# Build a .deb around an already-built snyvi binary.
#
#   packaging/deb.sh [--desktop] <binary> <version> <debian-arch> [outdir]
#   packaging/deb.sh target/x86_64-unknown-linux-musl/release/snyvi 0.4.0 amd64 dist
#   packaging/deb.sh --desktop target/release/snyvi 0.4.0 amd64 dist
#
# Two packages come out of one script, because two binaries cannot be one
# package. The default is the static (musl) build: it declares no dependencies
# at all and installs on any Debian or Ubuntu of that architecture. --desktop
# packages the `--features desktop` build, which is a native WebKitGTK window
# and is therefore linked against the distribution's webkit and gtk.
#
# Those dependencies are read out of the binary by dpkg-shlibdeps rather than
# written by hand, so the package states exactly what the build needs and
# cannot claim a glibc baseline the build did not have.
#
# Both ship the same paths, so they conflict with and replace each other: a
# machine has one snyvi or the other, never both.
#
# dpkg-deb is the only tool the default path needs, which is why this is a
# script and not another crate in the build; --desktop adds dpkg-dev for
# dpkg-shlibdeps.
set -euo pipefail

desktop=0
if [ "${1:-}" = --desktop ]; then desktop=1; shift; fi

bin=${1:?usage: deb.sh [--desktop] <binary> <version> <arch> [outdir]}
version=${2:?}
arch=${3:?}
out=${4:-dist}
maintainer=${DEB_MAINTAINER:-"snymrova <sunny@mrova.rocks>"}

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
root=$(dirname "$here")
[ -x "$bin" ] || { echo "deb.sh: $bin is not an executable" >&2; exit 1; }

pkg=snyvi
other=snyvi-desktop
if [ "$desktop" = 1 ]; then pkg=snyvi-desktop; other=snyvi; fi

# What the desktop build links against, straight from the binary. Run before
# staging so a missing dpkg-dev fails before anything is written.
depends=
if [ "$desktop" = 1 ]; then
  command -v dpkg-shlibdeps >/dev/null \
    || { echo "deb.sh: --desktop needs dpkg-shlibdeps (apt install dpkg-dev)" >&2; exit 1; }
  binabs=$(readlink -f "$bin")
  shlib=$(mktemp -d)
  mkdir -p "$shlib/debian"
  printf 'Source: %s\n\nPackage: %s\nArchitecture: any\n' "$pkg" "$pkg" > "$shlib/debian/control"
  depends=$(cd "$shlib" && dpkg-shlibdeps -O --ignore-missing-info "$binabs" 2>/dev/null \
    | sed -n 's/^shlibs:Depends=//p')
  rm -rf "$shlib"
  [ -n "$depends" ] || { echo "deb.sh: dpkg-shlibdeps read no dependencies from $bin" >&2; exit 1; }
fi

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
chmod 755 "$stage"   # mktemp -d is 0700; the package root must not be

install -Dm755 "$bin"                    "$stage/usr/bin/snyvi"
install -Dm644 "$here/snyvi.service"     "$stage/usr/lib/systemd/user/snyvi.service"
install -Dm644 "$here/snyvi.desktop"     "$stage/usr/share/applications/snyvi.desktop"
install -Dm644 "$root/icons/icon.png"    "$stage/usr/share/icons/hicolor/256x256/apps/snyvi.png"
install -Dm644 "$here/copyright"         "$stage/usr/share/doc/$pkg/copyright"
install -Dm644 "$root/README.md"         "$stage/usr/share/doc/$pkg/README.md"
gzip -9n "$stage/usr/share/doc/$pkg/README.md"

# Dates come from SOURCE_DATE_EPOCH when set, so two builds of the same tag
# produce the same bytes.
epoch=${SOURCE_DATE_EPOCH:-$(date +%s)}
{
  echo "$pkg ($version) unstable; urgency=medium"
  echo
  echo "  * snyvi $version. Release notes:"
  echo "    https://github.com/snymrova/snyvi/releases/tag/v$version"
  echo
  echo " -- $maintainer  $(date -R -u -d "@$epoch")"
} | gzip -9n > "$stage/usr/share/doc/$pkg/changelog.Debian.gz"
chmod 644 "$stage/usr/share/doc/$pkg/changelog.Debian.gz"

mkdir -p "$stage/DEBIAN"
{
  echo "Package: $pkg"
  echo "Version: $version"
  echo "Architecture: $arch"
  echo "Maintainer: $maintainer"
  if [ -n "$depends" ]; then echo "Depends: $depends"; fi
  echo "Conflicts: $other"
  echo "Replaces: $other"
  echo "Installed-Size: $(du -ks --exclude=DEBIAN "$stage" | cut -f1)"
  echo "Section: utils"
  echo "Priority: optional"
  echo "Homepage: https://github.com/snymrova/snyvi"
  echo "Description: fast, beautiful viewer for the documents your agents produce"
  echo " snyvi receives Markdown and source files from coding agents such as Claude"
  echo " Code and shows them rendered, filed under the project and workflow they came"
  echo " from. It also browses a folder straight from disk."
  echo " ."
  echo " The channel is one way: agents send, snyvi shows. Nothing is ever read back"
  echo " out, and the daemon listens on the loopback interface only."
  echo " ."
  if [ "$desktop" = 1 ]; then
    echo " This build opens the viewer in a native window (WebKitGTK) instead of a"
    echo " browser tab, so it links against the distribution's webkit and gtk and"
    echo " installs on the release it was built for. The UI, fonts and syntax"
    echo " grammars are still embedded in the binary; it still needs no network."
    echo " ."
    echo " For a binary that depends on nothing and runs on any Debian or Ubuntu,"
    echo " install the snyvi package instead and read in a browser window."
  else
    echo " A single static binary with its own UI, fonts and syntax grammars embedded."
    echo " No runtime, no dependencies, no network access."
    echo " ."
    echo " For the viewer in a native window rather than a browser one, install the"
    echo " snyvi-desktop package instead."
  fi
} > "$stage/DEBIAN/control"

cat > "$stage/DEBIAN/postinst" <<'EOF'
#!/bin/sh
set -e
if [ "$1" = configure ] && [ -n "$2" ]; then
  echo "snyvi: the daemon keeps running the old binary until it is restarted."
  echo "snyvi:   systemctl --user restart snyvi   (or: snyvi restart)"
fi
EOF
chmod 755 "$stage/DEBIAN/postinst"

# md5sums covers every shipped file, so `dpkg -V` can verify the install.
(cd "$stage" && find . -path ./DEBIAN -prune -o -type f -print0 \
  | sed -z 's|^\./||' | sort -z | xargs -0 md5sum > DEBIAN/md5sums)
chmod 644 "$stage/DEBIAN/md5sums"

mkdir -p "$out"
deb="$out/${pkg}_${version}_${arch}.deb"
dpkg-deb --root-owner-group --build "$stage" "$deb" >/dev/null
echo "$deb"
