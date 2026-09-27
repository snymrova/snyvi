#!/bin/sh
# snyvi, in one line, on Linux and macOS:
#
#   curl -fsSL https://raw.githubusercontent.com/snymrova/snyvi/main/install.sh | sh
#
# It is short enough to read first. It does what the README's Install section says
# to do by hand, choosing the path for the machine it is on:
#
#   macOS with Homebrew      brew install --cask snymrova/snyvi/snyvi
#   macOS without            snyvi.app into /Applications, `snyvi` linked on PATH
#   Linux                    snyvi into ~/.local/bin, the window beside it when this
#                            machine can show one, a menu entry and a user unit; no
#                            root, and it updates itself from then on
#   Linux, snyvi as a .deb   stays a package: both .debs upgraded in one apt run
#
# Every download is checked against the .sha256 published beside it. Running
# it again installs the newer version over the old one and restarts the
# daemon if one was running; nothing you sent is touched.
#
#   sh install.sh --deb             the two .debs instead (Debian, Ubuntu; needs root)
#   sh install.sh --tar             the per-user install, even over a .deb; later
#                                   runs keep it, the .deb left where it is
#   sh install.sh --no-app          no window
#   sh install.sh --no-init         do not register with Claude Code
#   sh install.sh --version 1.3.0   a particular release, not the latest
#   sh install.sh --bin-dir DIR     where the per-user install goes (~/.local/bin)
#
# SNYVI_ASSET_DIR=DIR takes the downloads from a folder instead of GitHub, and
# checks them the same way; CI runs this script that way in three distributions.
#
# Windows: `scoop install snyvi` from the snymrova/scoop-snyvi bucket, or the
# installer on the releases page. The README has both.
set -eu

repo=${SNYVI_REPO:-snymrova/snyvi}
version=${SNYVI_VERSION:-}
bin_dir=${SNYVI_BIN_DIR:-$HOME/.local/bin}
asset_dir=${SNYVI_ASSET_DIR:-}
mode=auto
bin_dir_given=${SNYVI_BIN_DIR:+1}
want_app=1
want_init=1
snyvi=

while [ $# -gt 0 ]; do
  case $1 in
    --tar) mode=tar ;;
    --deb) mode=deb ;;
    --no-app) want_app=0 ;;
    --no-init) want_init=0 ;;
    --version) version=${2:?--version needs a value}; shift ;;
    --version=*) version=${1#--version=} ;;
    --bin-dir) bin_dir=${2:?--bin-dir needs a value}; bin_dir_given=1; shift ;;
    --bin-dir=*) bin_dir=${1#--bin-dir=}; bin_dir_given=1 ;;
    -h|--help) awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; exit 0 ;;
    *) echo "install.sh: unknown option $1 (try --help)" >&2; exit 2 ;;
  esac
  shift
done

say()  { printf '%s\n' "$*"; }
die()  { printf 'install.sh: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
# A path with its links resolved, where the system can say.
real() { readlink -f "$1" 2>/dev/null || printf '%s\n' "$1"; }

# The release to install: `latest` resolves on GitHub's side, and a pinned
# version is the same file names under that tag. Both are the names that do
# not move -- snyvi-linux-x64.tar.gz, snyvi-macos-arm64.tar.gz -- which every
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
elif [ -z "$asset_dir" ]; then
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
  if [ -n "$asset_dir" ]; then
    say "  taking $1 from $asset_dir"
    cp "$asset_dir/$1" "$tmp/$1" 2>/dev/null || die "no $1 in $asset_dir"
    cp "$asset_dir/$1.sha256" "$tmp/$1.sha256" 2>/dev/null || die "no $1.sha256 in $asset_dir"
  else
    say "  fetching $1"
    fetch "$base/$1" "$tmp/$1" || die "could not download $base/$1"
    fetch "$base/$1.sha256" "$tmp/$1.sha256" || die "could not download $base/$1.sha256"
  fi
  check "$tmp/$1" || die "$1 does not match its published sha256; not installing it"
}

sudo_if_needed() {
  if [ "$(id -u)" = 0 ]; then "$@"
  elif have sudo; then say "  (sudo, for apt)"; sudo "$@"
  else die "root is needed to install a .deb; run as root, or leave out --deb for the per-user install in $bin_dir"
  fi
}

# ---------- what is here already ----------

# The daemon, found by asking it rather than by PATH: a daemon started from
# another copy of snyvi, or from a folder PATH does not name, is still the
# one to restart. `ask health` prints its answer, or nothing.
port=${SNYVI_PORT:-7777}
ask() {
  url=http://127.0.0.1:$port/api/$1
  if have curl; then curl -fsS --max-time 2 "$url" 2>/dev/null || true
  elif have wget; then wget -q -T 2 -O - "$url" 2>/dev/null || true
  else
    # Neither: any snyvi here can ask for us, pretty-printed.
    for s in "$(command -v snyvi 2>/dev/null || true)" "$bin_dir/snyvi" /usr/bin/snyvi; do
      if [ -n "$s" ] && [ -x "$s" ]; then
        if [ "$1" = health ]; then "$s" status 2>/dev/null | sed -n '/^{/,/^}/p' || true; fi
        return 0
      fi
    done
  fi
}
# One top-level field out of JSON, compact or pretty, without a JSON tool.
field() { tr ',' '\n' | sed -n "s/.*\"$1\": *\"\{0,1\}\([^\",}]*\).*/\1/p" | head -n 1; }

health=$(ask health)
running_pid=$(printf '%s' "$health" | field pid)
running_version=$(printf '%s' "$health" | field version)
running_bin=
[ -n "$running_pid" ] && running_bin=$(ask about | field binary)

# Any snyvi at all, before this run: an update, not a first install. What
# decides between refreshing Claude Code's registration and making one.
previous=
for s in "$(command -v snyvi 2>/dev/null || true)" "$bin_dir/snyvi" /usr/bin/snyvi; do
  if [ -n "$s" ] && [ -x "$s" ]; then previous=$s; break; fi
done
[ -z "$previous" ] && [ -n "$running_pid" ] && previous=running

deb_installed() {
  have dpkg-query && [ "$(dpkg-query -W -f='${Status}' "$1" 2>/dev/null)" = "install ok installed" ]
}
display() { [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; }

# The receipt a per-user install left, which the daemon reads too (see
# src/update.rs): its channel, and the folder it went in.
conf=${SNYVI_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/snyvi}
receipt_channel=
receipt_bin=
if [ -f "$conf/install.json" ]; then
  receipt_channel=$(field channel < "$conf/install.json")
  receipt_bin=$(field bin_dir < "$conf/install.json")
fi

say "snyvi: ${version:-latest} for $os $arch"
if [ -n "$running_pid" ]; then
  say "  snyvi ${running_version:-?} is running (pid $running_pid)${running_bin:+ from $running_bin}"
fi

switched=0
deb_left=0
app=0
told=
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
      bundle=$(find "$tmp" -maxdepth 2 -name snyvi.app -type d | head -n 1)
      [ -n "$bundle" ] || die "the tarball did not contain snyvi.app"
      if [ -w /Applications ]; then dest=/Applications; else dest=$HOME/Applications; mkdir -p "$dest"; fi
      rm -rf "$dest/snyvi.app"
      mv "$bundle" "$dest/snyvi.app"
      say "  snyvi.app is in $dest"
      snyvi=$dest/snyvi.app/Contents/MacOS/snyvi
      "$snyvi" install-cli
    fi
    ;;
  Linux)
    # A machine that has snyvi as a package keeps it as one: nobody's
    # install is moved behind their back. --tar is how to move -- and once
    # moved, it stays moved: a receipt from --tar, with its snyvi still in
    # the folder it names, wins over a package left installed beside it.
    # Without that, the next plain run put the package back in charge, a
    # step back to a version that does not update itself.
    if [ "$mode" = auto ]; then
      if [ "$receipt_channel" = tar ] && [ -n "$receipt_bin" ] && [ -x "$receipt_bin/snyvi" ]; then
        mode=tar
        [ -n "$bin_dir_given" ] || bin_dir=$receipt_bin
        if deb_installed snyvi; then
          told="kept the per-user install in $receipt_bin, as $conf/install.json says it was made; the .deb beside it was left alone"
        fi
      elif deb_installed snyvi; then
        mode=deb
        told="installed as a package; snyvi tells you when a new one is out. \`sh install.sh --tar\` moves to the per-user install, which updates itself"
      else
        mode=tar
      fi
    fi
    if [ "$mode" = deb ]; then
      { have dpkg && have apt-get; } || die "--deb needs dpkg and apt-get, which this Linux does not have; the per-user install needs neither: sh install.sh"
      get "snyvi-linux-$arch.deb"
      debs="$tmp/snyvi-linux-$arch.deb"
      # The window: when asked for and there is a display to show it on,
      # or when it is installed already and would otherwise fall behind.
      if [ "$want_app" = 1 ] && { display || deb_installed snyvi-app; }; then
        get "snyvi-app-linux-$arch.deb"
        debs="$debs $tmp/snyvi-app-linux-$arch.deb"
        app=1
      elif [ "$want_app" = 1 ]; then
        say "  no display here, so no window; run this again from the desktop for one"
      fi
      # One apt transaction for both, so WebKitGTK resolves and the two
      # never disagree; a path rather than a name, so apt reads the file.
      # shellcheck disable=SC2086
      chmod 644 $debs
      # shellcheck disable=SC2086
      sudo_if_needed apt-get install -y $debs
      snyvi=/usr/bin/snyvi
      [ -x "$bin_dir/snyvi" ] && switched=1
    else
      get "snyvi-linux-$arch.tar.gz"
      tar -C "$tmp" -xzf "$tmp/snyvi-linux-$arch.tar.gz"
      bin=
      for f in "$tmp"/snyvi-*/snyvi "$tmp"/snyvi; do
        if [ -f "$f" ]; then bin=$f; break; fi
      done
      [ -n "$bin" ] || die "the tarball did not contain a snyvi binary"
      mkdir -p "$bin_dir"
      # Beside the old file and renamed over it: a running daemon keeps the
      # file it started from, and a write into a running executable fails.
      place() { install -m 755 "$1" "$bin_dir/.$2.new" && mv -f "$bin_dir/.$2.new" "$bin_dir/$2"; }
      place "$bin" snyvi
      snyvi=$bin_dir/snyvi
      say "  snyvi is in $bin_dir"
      # A package still here: a move, unless the daemon running is already
      # this copy -- a re-run after the move, which restarts it as any
      # update does rather than stopping it.
      if deb_installed snyvi; then
        deb_left=1
        if [ -z "$running_bin" ] || [ "$(real "$running_bin")" != "$(real "$bin_dir/snyvi")" ]; then switched=1; fi
      fi

      # The window, beside it, when this machine can run one: a display,
      # WebKitGTK 4.1, and a glibc as new as the one it was built against.
      # One already here is always kept in step with the daemon.
      if [ "$want_app" = 1 ] || [ -x "$bin_dir/snyvi-app" ]; then
        glibc=$(getconf GNU_LIBC_VERSION 2>/dev/null | sed -n 's/^glibc //p')
        webkit=0
        if { ldconfig -p 2>/dev/null || /sbin/ldconfig -p 2>/dev/null; } | grep -q 'libwebkit2gtk-4\.1\.so\.0'; then webkit=1; fi
        gmaj=${glibc%%.*}; gmin=${glibc#*.}; gmin=${gmin%%.*}
        if [ -z "$glibc" ]; then
          say "  the window needs glibc, which this Linux does not use; snyvi opens in a browser here"
        elif [ "$gmaj" -lt 2 ] || { [ "$gmaj" = 2 ] && [ "$gmin" -lt 34 ]; }; then
          say "  the window needs glibc 2.34 or newer and this has $glibc; snyvi opens in a browser here"
        elif [ ! -x "$bin_dir/snyvi-app" ] && ! display; then
          say "  no display here, so no window; run this again from the desktop for one"
        elif [ "$webkit" = 0 ]; then
          distro=$(sed -n 's/^ID_LIKE=//p; s/^ID=//p' /etc/os-release 2>/dev/null | tr -d '"' | tr '\n' ' ')
          case " $distro " in
            *" fedora "*|*" rhel "*) line="sudo dnf install webkit2gtk4.1" ;;
            *" arch "*) line="sudo pacman -S webkit2gtk-4.1" ;;
            *" suse "*|*" opensuse "*) line="sudo zypper install libwebkit2gtk-4_1-0" ;;
            *" debian "*|*" ubuntu "*) line="sudo apt install libwebkit2gtk-4.1-0" ;;
            *) line="your distribution's WebKitGTK 4.1 package" ;;
          esac
          say "  the window needs WebKitGTK 4.1, which is not installed: $line, then run this again"
        else
          get "snyvi-app-linux-$arch.tar.gz"
          mkdir "$tmp/app"
          tar -C "$tmp/app" -xzf "$tmp/snyvi-app-linux-$arch.tar.gz"
          win=
          for f in "$tmp"/app/snyvi-*/snyvi-app "$tmp"/app/snyvi-app; do
            if [ -f "$f" ]; then win=$f; break; fi
          done
          [ -n "$win" ] || die "the window's tarball did not contain snyvi-app"
          place "$win" snyvi-app
          app=1
          say "  the window is beside it"
        fi
      fi

      # What a package puts under /usr/share, in this home: the menu entry,
      # the icon, snyvi:// links, a user unit (written, not enabled).
      "$snyvi" install-desktop | sed 's/^/  /'

      # The receipt the daemon reads to know how it was installed, and so
      # what an update may do to it. See src/update.rs.
      mkdir -p "$conf"
      esc=$(real "$bin_dir" | sed 's/\\/\\\\/g; s/"/\\"/g')
      if [ "$app" = 1 ]; then app_json=true; else app_json=false; fi
      printf '{ "channel": "tar", "bin_dir": "%s", "app": %s }\n' "$esc" "$app_json" > "$conf/install.json"
    fi
    ;;
  *)
    die "no installer for $os here; Windows has \`scoop install snyvi\`, and the releases page has everything: https://github.com/$repo/releases"
    ;;
esac

[ -x "$snyvi" ] || die "installed, but $snyvi is not there to finish with; open a new terminal and run \`snyvi status\`"
new_version=$("$snyvi" --version 2>/dev/null || true)
new_version=${new_version##* }

# The daemon that was up is the old code still serving; the new file takes
# over. When it runs from the same path, `restart` waits for the desks to be
# quiet and brings the Claude panels back. When it runs from another copy --
# a move between the package and the per-user install -- that copy is
# stopped and this one started, since a restart would start the old path.
restarted=
if [ -n "$running_pid" ]; then
  if [ "$switched" = 1 ] || { [ -n "$running_bin" ] && [ "$(real "$running_bin")" != "$(real "$snyvi")" ]; }; then
    "$snyvi" stop >/dev/null 2>&1 || true
    if "$snyvi" restart >/dev/null; then restarted=moved; fi
  elif "$snyvi" restart; then
    restarted=same
  fi
fi

if [ "$want_init" = 1 ]; then
  if [ -n "$previous" ]; then
    # An update: whatever Claude Code has of snyvi is pointed here, and
    # nothing is added that the reader took out.
    "$snyvi" init-claude --refresh | sed 's/^/  /'
  elif have claude || [ -d "$HOME/.claude" ]; then
    "$snyvi" init-claude --auto
  else
    say "  Claude Code is not here; \`snyvi init-claude --auto\` when it is, or \`snyvi init <agent>\` for another agent"
  fi
fi

# The last lines say what is true, not what was hoped: which file runs when
# `snyvi` is typed in a new terminal, and whether it updates itself.
say ""
case $os/$mode in
  Linux/tar)
    with=
    [ "$app" = 1 ] && with=", with the window beside it"
    say "snyvi $new_version is in $bin_dir$with, and updates itself from now on." ;;
  Linux/deb) say "snyvi $new_version is installed as a package; snyvi tells you when a new one is out." ;;
  *) say "snyvi $new_version is installed, and updates itself from now on." ;;
esac
[ -n "$told" ] && say "  $told"
case $restarted in
  same) say "  The daemon that was running is now $new_version." ;;
  moved) say "  The daemon that ran from ${running_bin:-the other copy} was stopped; this one is running now." ;;
esac
# Not run for the reader: piped from curl there is no tty to ask for a
# password on, and taking out someone's package is theirs to do.
if [ "$os/$mode" = Linux/tar ] && [ "$deb_left" = 1 ]; then
  say "  The .deb is still installed. Two installs pull different ways -- apt"
  say "  upgrades /usr/bin/snyvi, this one updates itself -- and whichever comes"
  say "  first on PATH is the one a terminal runs. To take the package out:"
  # Only what is installed: neither package is in a repository, so apt
  # cannot even find the name of one that never was.
  pkgs=snyvi
  if deb_installed snyvi-app; then pkgs="$pkgs snyvi-app"; fi
  say "    sudo apt remove $pkgs"
fi
found=$(command -v snyvi 2>/dev/null || true)
if [ -z "$found" ]; then
  say "  $(dirname "$snyvi") is not on your PATH yet; add it, or call $snyvi by that name."
elif [ "$(real "$found")" != "$(real "$snyvi")" ]; then
  say "  But \`snyvi\` runs $found, which comes first on your PATH; call $snyvi by that name, or put $(dirname "$snyvi") first."
fi
say "  snyvi send README.md    a document, and a link to read it"
say "  snyvi app               the window, where desks run"
say "  snyvi status            what is running, what is registered"

# One question, asked only where it can be answered: a desktop to open the
# window on, the window installed, and a terminal. `curl | sh` has no stdin
# of its own, so the answer is read from /dev/tty, and no tty is no question.
if { [ -n "${DISPLAY:-}" ] || [ -n "${WAYLAND_DISPLAY:-}" ]; } &&
   { [ "${app:-0}" = 1 ] || have snyvi-app; } &&
   ( : </dev/tty ) 2>/dev/null; then
  printf "\nOpen the window now? [Y/n] " >/dev/tty
  answer=
  read -r answer </dev/tty || answer=n
  case $answer in
    [nN]*) ;;
    *) "$snyvi" app >/dev/null 2>&1 & ;;
  esac
fi
