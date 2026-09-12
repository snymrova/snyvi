#!/usr/bin/env bash
# Build a .deb around an already-built snyvi binary.
#
#   packaging/deb.sh [--desktop] <binary> <version> <debian-arch> [outdir]
#   packaging/deb.sh target/x86_64-unknown-linux-musl/release/snyvi 0.4.0 amd64 dist
#   packaging/deb.sh --desktop target/release/snyvi 0.4.0 amd64 dist
#
# Two packages, and the second adds to the first rather than replacing it.
#
# The default is `snyvi`: the static (musl) build of the whole program -- daemon,
# CLI, MCP server, hook. It declares no dependencies at all and installs on any
# Debian or Ubuntu of that architecture. This is what everyone installs.
#
# --desktop is `snyvi-app`: the native window executable alone, which links the
# distribution's webkit and gtk and so cannot be static. It depends on snyvi and
# ships one file; `snyvi app` finds it and hands it a URL. Installing it is an
# addition, never a choice made instead of the first one.
#
# Its dependencies are read out of the binary by dpkg-shlibdeps rather than
# written by hand, so the package states exactly what the build needs and cannot
# claim a glibc baseline the build did not have.
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
if [ "$desktop" = 1 ]; then pkg=snyvi-app; fi

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

if [ "$desktop" = 1 ]; then
  # One file. The menu entry, the service and the icon belong to snyvi, which
  # this depends on, so shipping them again would be two packages owning a path.
  install -Dm755 "$bin"                  "$stage/usr/bin/snyvi-app"
else
  install -Dm755 "$bin"                  "$stage/usr/bin/snyvi"
  install -Dm644 "$here/snyvi.service"   "$stage/usr/lib/systemd/user/snyvi.service"
  install -Dm644 "$here/snyvi.desktop"   "$stage/usr/share/applications/snyvi.desktop"
  # Every size the theme spec looks for, plus the scalable master. Icon themes
  # pick the nearest size rather than scaling the largest one, so shipping only
  # 256 left the panel and the task switcher downsampling it themselves.
  for px in 16 24 32 48 64 128 256 512; do
    install -Dm644 "$root/icons/$px.png" \
      "$stage/usr/share/icons/hicolor/${px}x${px}/apps/snyvi.png"
  done
  install -Dm644 "$root/icons/icon.svg" \
    "$stage/usr/share/icons/hicolor/scalable/apps/snyvi.svg"
fi
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
  if [ "$desktop" = 1 ]; then
    # snyvi itself, at exactly this version: the window is handed a URL by
    # `snyvi app`, so a mismatched pair is not a combination worth shipping.
    echo "Depends: snyvi (= $version), $depends"
  else
    # 0.5.0 shipped snyvi-desktop as a whole second snyvi that replaced this
    # one. It is now an add-on under a different name, so this package
    # supersedes that one rather than refusing to sit beside it.
    # Conflicts rather than Breaks: Breaks asks dpkg to deconfigure the old
    # package, which it refuses, while Conflicts with Replaces makes it remove
    # the thing being superseded -- which is right, because 0.5.0's
    # snyvi-desktop was a whole second snyvi, not an add-on to keep.
    echo "Conflicts: snyvi-desktop (<< 0.6.0)"
    echo "Replaces: snyvi-desktop (<< 0.6.0)"
  fi
  echo "Installed-Size: $(du -ks --exclude=DEBIAN "$stage" | cut -f1)"
  echo "Section: utils"
  echo "Priority: optional"
  echo "Homepage: https://github.com/snymrova/snyvi"
  if [ "$desktop" = 1 ]; then
    echo "Description: native window for snyvi"
  else
    echo "Description: fast, beautiful viewer for the documents your agents produce"
  fi
  echo " snyvi receives Markdown and source files from coding agents such as Claude"
  echo " Code and shows them rendered, filed under the project and workflow they came"
  echo " from. It also browses a folder straight from disk."
  echo " ."
  echo " The channel is one way: agents send, snyvi shows. Nothing is ever read back"
  echo " out, and the daemon listens on the loopback interface only."
  echo " ."
  if [ "$desktop" = 1 ]; then
    echo " This package adds a native window. Without it snyvi opens in a browser,"
    echo " in app mode when a Chromium-family one is installed; with it, \"snyvi app\""
    echo " opens a WebKitGTK window of its own that remembers its size and place."
    echo " ."
    echo " It is one executable and nothing else, because linking a browser engine"
    echo " into snyvi itself would link it into the daemon too. Install it whenever"
    echo " you like; nothing about snyvi changes until you do."
  else
    echo " A single static binary with its own UI, fonts and syntax grammars embedded."
    echo " No runtime, no dependencies, no network access."
    echo " ."
    echo " It opens documents in a browser window. For a native one, add the"
    echo " snyvi-app package; it needs this package and does not replace it."
  fi
} > "$stage/DEBIAN/control"

# Only the main package: upgrading the window executable does not leave a stale
# daemon behind, because the daemon was never in it.
if [ "$desktop" != 1 ]; then
  cat > "$stage/DEBIAN/postinst" <<'EOF'
#!/bin/sh
set -e
if [ "$1" = configure ] && [ -n "$2" ]; then
  echo "snyvi: the daemon keeps running the old binary until it is restarted."
  echo "snyvi:   systemctl --user restart snyvi   (or: snyvi restart)"
fi
EOF
  chmod 755 "$stage/DEBIAN/postinst"
fi

# md5sums covers every shipped file, so `dpkg -V` can verify the install.
(cd "$stage" && find . -path ./DEBIAN -prune -o -type f -print0 \
  | sed -z 's|^\./||' | sort -z | xargs -0 md5sum > DEBIAN/md5sums)
chmod 644 "$stage/DEBIAN/md5sums"

mkdir -p "$out"
deb="$out/${pkg}_${version}_${arch}.deb"
dpkg-deb --root-owner-group --build "$stage" "$deb" >/dev/null
echo "$deb"
