#!/bin/sh
# snyvi, in one line, on Linux and macOS:
#
#   curl -fsSL https://mrova.rocks/snyvi/install.sh | sh
#
# The same file lives at
# https://raw.githubusercontent.com/snymrova/snyvi/main/install.sh, and it is
# short enough to read first. It does what the README's Install section says
# to do by hand, choosing the path for the machine it is on:
#
#   macOS with Homebrew      brew install --cask snymrova/snyvi/snyvi
#   macOS without            snyvi.app into /Applications, `snyvi` linked on PATH
#   Debian and Ubuntu        the two .debs: snyvi, and the window desks run in
#   any other Linux          the static binary into ~/.local/bin
#
# Every download is checked against the .sha256 published beside it. Running
# it again installs the newer version over the old one and restarts the
# daemon if one was running; nothing you sent is touched.
#
#   sh install.sh --tar             the static binary even where dpkg exists
#   sh install.sh --no-app          on Debian, skip the window package
#   sh install.sh --no-init         do not register with Claude Code
#   sh install.sh --version 1.3.0   a particular release, not the latest
#   sh install.sh --bin-dir DIR     where the static binary goes (~/.local/bin)
#
# Windows: `scoop install snyvi` from the snymrova/scoop-snyvi bucket, or the
# installer on the releases page. The README has both.
set -eu

repo=${SNYVI_REPO:-snymrova/snyvi}
version=${SNYVI_VERSION:-}
bin_dir=${SNYVI_BIN_DIR:-$HOME/.local/bin}
mode=auto
want_app=1
want_init=1
snyvi=

while [ $# -gt 0 ]; do
  case $1 in
    --tar) mode=tar ;;
    --no-app) want_app=0 ;;
    --no-init) want_init=0 ;;
    --version) version=${2:?--version needs a value}; shift ;;
    --version=*) version=${1#--version=} ;;
    --bin-dir) bin_dir=${2:?--bin-dir needs a value}; shift ;;
    --bin-dir=*) bin_dir=${1#--bin-dir=} ;;
    -h|--help) sed -n '2,27p' "$0"; exit 0 ;;
    *) echo "install.sh: unknown option $1 (try --help)" >&2; exit 2 ;;
  esac
  shift
done

say()  { printf '%s\n' "$*"; }
die()  { printf 'install.sh: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# The release to install: `latest` resolves on GitHub's side, and a pinned
# version is the same file names under that tag. Both are the names that do
# not move -- snyvi-linux-x64.deb, snyvi-macos-arm64.tar.gz -- which every
# release since 1.0 has carried beside its versioned copies.
version=${version#v}
if [ -n "$version" ]; then
  base=https://github.com/$repo/releases/download/v$version
else
  base=https://github.com/$repo/releases/latest/download
fi

os=$(uname -s)
case $(uname -m) in
  x86_64|amd64) arch=x64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) die "no build for $(uname -m); the releases page lists what there is: https://github.com/$repo/releases" ;;
esac

if have curl; then
  fetch() { curl -fsSL --proto '=https' --tlsv1.2 -o "$2" "$1"; }
elif have wget; then
  fetch() { wget -q -O "$2" "$1"; }
else
  die "curl or wget is needed to download the release"
fi

# `-c` and nothing else: busybox's sha256sum has no --quiet, and the OK line
# is the only thing a successful check prints, so it goes to /dev/null.
if have sha256sum; then
  check() { (cd "$(dirname "$1")" && sha256sum -c "$(basename "$1").sha256" >/dev/null); }
elif have shasum; then
  check() { (cd "$(dirname "$1")" && shasum -a 256 -c "$(basename "$1").sha256" >/dev/null); }
else
  die "sha256sum or shasum is needed to check the download"
fi

tmp=$(mktemp -d "${TMPDIR:-/tmp}/snyvi-install.XXXXXX")
trap 'rm -rf "$tmp"' EXIT INT TERM
# apt reads the .deb as its own unprivileged user, so the folder must be
# readable by everyone; a warning otherwise, not a failure, but a loud one.
chmod 755 "$tmp"

# Download one asset and its checksum, and refuse a file that does not match.
get() {
  say "  fetching $1"
  fetch "$base/$1" "$tmp/$1" || die "could not download $base/$1"
  fetch "$base/$1.sha256" "$tmp/$1.sha256" || die "could not download $base/$1.sha256"
  check "$tmp/$1" || die "$1 does not match its published sha256; not installing it"
}

sudo_if_needed() {
  if [ "$(id -u)" = 0 ]; then "$@"
  elif have sudo; then say "  (sudo, for dpkg)"; sudo "$@"
  else die "root is needed to install a .deb; run as root, or use --tar for a copy in $bin_dir"
  fi
}

# Was a daemon running before the swap? The new binary on disk does not take
# effect until the old process exits, so a daemon that was up is restarted at
# the end; one that was not is left alone.
old=$(command -v snyvi 2>/dev/null || true)
was_running=0
if [ -n "$old" ]; then
  status=$("$old" status 2>/dev/null || true)
  case $status in
    '{'*) was_running=1 ;;
  esac
fi

say "snyvi: ${version:-latest} for $os $arch"

case $os in
  Darwin)
    if [ "$mode" = auto ] && have brew; then
      if brew list --cask snyvi >/dev/null 2>&1; then
        brew upgrade --cask snymrova/snyvi/snyvi || true
      else
        brew install --cask snymrova/snyvi/snyvi
      fi
      snyvi=$(brew --prefix)/bin/snyvi
    else
      # The tarball is the bundle: both executables inside snyvi.app, and
      # `install-cli` links the command onto PATH from wherever the app went.
      # Unpacked by tar it carries no quarantine, so Gatekeeper has nothing
      # to refuse.
      get "snyvi-macos-$arch.tar.gz"
      tar -C "$tmp" -xzf "$tmp/snyvi-macos-$arch.tar.gz"
      app=$(find "$tmp" -maxdepth 2 -name snyvi.app -type d | head -n 1)
      [ -n "$app" ] || die "the tarball did not contain snyvi.app"
      if [ -w /Applications ]; then dest=/Applications; else dest=$HOME/Applications; mkdir -p "$dest"; fi
      [ "$was_running" = 1 ] && "$old" stop >/dev/null 2>&1 || true
      rm -rf "$dest/snyvi.app"
      mv "$app" "$dest/snyvi.app"
      say "  snyvi.app is in $dest"
      snyvi=$dest/snyvi.app/Contents/MacOS/snyvi
      "$snyvi" install-cli
    fi
    ;;
  Linux)
    if [ "$mode" = auto ] && have dpkg && have apt-get; then
      get "snyvi-linux-$arch.deb"
      sudo_if_needed dpkg -i "$tmp/snyvi-linux-$arch.deb"
      snyvi=/usr/bin/snyvi
      if [ "$want_app" = 1 ]; then
        # apt rather than dpkg for the window, so WebKitGTK resolves; and
        # `./` so apt reads a file instead of looking a name up.
        get "snyvi-app-linux-$arch.deb"
        chmod 644 "$tmp/snyvi-app-linux-$arch.deb"
        sudo_if_needed apt-get install -y "$tmp/snyvi-app-linux-$arch.deb"
      fi
    else
      get "snyvi-linux-$arch.tar.gz"
      tar -C "$tmp" -xzf "$tmp/snyvi-linux-$arch.tar.gz"
      bin=$(find "$tmp" -maxdepth 2 -name snyvi -type f | head -n 1)
      [ -n "$bin" ] || die "the tarball did not contain a snyvi binary"
      mkdir -p "$bin_dir"
      install -m 755 "$bin" "$bin_dir/snyvi"
      snyvi=$bin_dir/snyvi
      say "  snyvi is in $bin_dir"
      case ":$PATH:" in
        *":$bin_dir:"*) ;;
        *) say "  $bin_dir is not on your PATH yet; add it, or call $bin_dir/snyvi by that name" ;;
      esac
      [ "$want_app" = 1 ] && [ "$mode" = auto ] && say "  the window is a .deb or a source build; docs/GUIDE.md#desktop says how" || true
    fi
    ;;
  *)
    die "no installer for $os here; Windows has \`scoop install snyvi\`, and the releases page has everything: https://github.com/$repo/releases"
    ;;
esac

[ -x "$snyvi" ] || die "installed, but $snyvi is not there to finish with; open a new terminal and run \`snyvi status\`"

# The daemon that was up is now the old code still serving; the new binary
# takes over. One that was not running is not started.
if [ "$was_running" = 1 ]; then
  "$snyvi" restart
fi

if [ "$want_init" = 1 ]; then
  if have claude || [ -d "$HOME/.claude" ]; then
    "$snyvi" init-claude --auto
  else
    say "  Claude Code is not here; \`snyvi init-claude --auto\` when it is, or \`snyvi init <agent>\` for another agent"
  fi
fi

say ""
say "snyvi $("$snyvi" --version 2>/dev/null | awk '{print $NF}') is installed."
say "  snyvi send README.md    a document, and a link to read it"
say "  snyvi app               the window, where desks run"
say "  snyvi status            what is running, what is registered"
