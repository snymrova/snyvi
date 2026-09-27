#!/bin/sh
# The one-liner, run for real, inside a container: never on a machine anyone
# uses, since it installs, restarts a daemon and writes into a home.
#
#   docker run --rm -v "$PWD:/src:ro" -v /tmp/assets:/assets:ro debian:bookworm sh /src/bench/install.sh
#
# /assets holds what a release would carry for this machine, under the
# stable names, each with its .sha256: snyvi-linux-x64.tar.gz, and on a
# Debian-family image snyvi-linux-x64.deb. CI builds them from the commit
# (see the installer job in .github/workflows/ci.yml). Every row is a fact
# about files, processes and exit codes, so it holds on any runner.
#
# The rows: a fresh home gets the per-user install -- the binary in
# ~/.local/bin, the menu entry naming it, the icons, the receipt, no window
# without a display, a unit only where systemd is; a second run over a
# running daemon restarts it onto the new file and refreshes Claude Code's
# registration without creating one; uninstall-desktop takes back exactly
# its own files. On Debian and Ubuntu: --deb installs the package; a plain
# run then leaves it a package and says how to move; --tar moves, and says
# the package is still there and the line that takes it out; a plain run
# after that keeps the per-user install its receipt names.
set -u

[ -f /src/install.sh ] || { echo "bench/install.sh: mount the checkout at /src" >&2; exit 2; }
[ -d /assets ] || { echo "bench/install.sh: mount the downloads at /assets" >&2; exit 2; }
if [ "$(id -u)" != 0 ] && [ ! -f /.dockerenv ] && [ ! -f /run/.containerenv ]; then
  echo "bench/install.sh: this installs things; run it in a container" >&2
  exit 2
fi

fail=0
ok()  { echo "  ✓ $*"; }
bad() { echo "  ✗ $*"; fail=1; }
t()   { what=$1; shift; if "$@"; then ok "$what"; else bad "$what"; fi; }
has() { grep -q -- "$2" "$1"; }

. /etc/os-release 2>/dev/null || true
echo "${PRETTY_NAME:-this image}:"

fresh_home() {
  HOME=$(mktemp -d /tmp/home.XXXXXX)
  export HOME
  export SNYVI_ASSET_DIR=/assets SNYVI_UPDATES=off SNYVI_PORT=7899 SNYVI_NOTIFY=0
  unset SNYVI_DATA_DIR SNYVI_CONFIG_DIR XDG_DATA_HOME XDG_CONFIG_HOME DISPLAY WAYLAND_DISPLAY 2>/dev/null || true
}

# ---------- the per-user install ----------
fresh_home
out=/tmp/first.out
sh /src/install.sh --no-init > "$out" 2>&1
code=$?
B=$HOME/.local/bin/snyvi
t "a fresh home installs with no root and no questions" [ "$code" = 0 ]
[ "$code" = 0 ] || sed 's/^/      /' "$out"
t "the binary is in ~/.local/bin and runs" sh -c "'$B' --version >/dev/null"
t "no window without a display, and it says so" sh -c "[ ! -e '$HOME/.local/bin/snyvi-app' ] && grep -q 'no display here' '$out'"
entry=$HOME/.local/share/applications/snyvi.desktop
t "the menu entry names this binary by its path" has "$entry" "^Exec=$B app %u"
t "the icon is where the theme looks" [ -s "$HOME/.local/share/icons/hicolor/256x256/apps/snyvi.png" ]
receipt=$HOME/.config/snyvi/install.json
t "the receipt says a per-user install, in that folder" sh -c "grep -q '\"channel\": \"tar\"' '$receipt' && grep -q '\"bin_dir\": \"$HOME/.local/bin\"' '$receipt'"
unit=$HOME/.config/systemd/user/snyvi.service
if command -v systemctl >/dev/null 2>&1; then
  t "a user unit is written for this binary, not enabled" has "$unit" "^ExecStart=$B serve"
else
  t "no user unit where there is no systemd" [ ! -e "$unit" ]
fi
t "the last line says it updates itself" has "$out" "updates itself from now on"

# ---------- an update over a running daemon ----------
echo "# a plan" > /tmp/plan.md
"$B" send /tmp/plan.md > /dev/null 2>&1
pid() { "$B" status 2>/dev/null | sed -n 's/.*"pid": *\([0-9]*\).*/\1/p' | head -n 1; }
before=$(pid)
t "a daemon is running to be updated" [ -n "$before" ]
out=/tmp/second.out
sh /src/install.sh > "$out" 2>&1
code=$?
after=$(pid)
t "a second run succeeds" [ "$code" = 0 ]
[ "$code" = 0 ] || sed 's/^/      /' "$out"
t "the running daemon is restarted onto the new file" sh -c "[ -n '$after' ] && [ '$after' != '$before' ] && grep -q 'daemon that was running is now' '$out'"
t "an update refreshes Claude Code's registration and creates none" sh -c "grep -q 'nothing to refresh' '$out' && [ ! -e '$HOME/.claude/settings.json' ]"
t "a second run writes no desktop file it already wrote" has "$out" "already current"
"$B" stop > /dev/null 2>&1

t "uninstall-desktop takes back exactly its own files" sh -c "'$B' uninstall-desktop >/dev/null && [ ! -e '$entry' ] && [ ! -e '$HOME/.local/share/icons/hicolor/256x256/apps/snyvi.png' ] && [ -x '$B' ] && [ -e '$receipt' ]"

# ---------- a .deb machine stays a .deb machine ----------
if command -v apt-get >/dev/null 2>&1 && [ -f /assets/snyvi-linux-x64.deb ]; then
  fresh_home
  out=/tmp/deb.out
  sh /src/install.sh --deb --no-init > "$out" 2>&1
  code=$?
  t "--deb installs the package" sh -c "[ '$code' = 0 ] && dpkg-query -W -f='\${Status}' snyvi | grep -q 'install ok installed' && [ -x /usr/bin/snyvi ]"
  [ "$code" = 0 ] || sed 's/^/      /' "$out"
  out=/tmp/deb-again.out
  sh /src/install.sh --no-init > "$out" 2>&1
  t "a plain run over the package keeps it a package, and says how to move" sh -c "grep -q 'installed as a package' '$out' && grep -q 'install.sh --tar' '$out' && [ ! -e '$HOME/.local/bin/snyvi' ]"
  out=/tmp/deb-tar.out
  sh /src/install.sh --tar --no-init > "$out" 2>&1
  t "--tar moves to the per-user install and says the package is still there" sh -c "[ -x '$HOME/.local/bin/snyvi' ] && grep -q 'The .deb is still installed' '$out'"
  t "and says which snyvi a new terminal runs" sh -c "grep -q 'updates itself from now on' '$out' && { grep -q 'comes first on your PATH' '$out' || grep -q 'not on your PATH' '$out'; }"
  t "and names the one line that takes the package out" has "$out" "sudo apt remove snyvi$"
  # Moved stays moved: the receipt --tar wrote wins over the package still
  # installed beside it, where a plain run used to put the package back.
  before_deb=$(stat -c %Y /usr/bin/snyvi)
  out=/tmp/deb-tar-again.out
  sh /src/install.sh --no-init > "$out" 2>&1
  code=$?
  t "a plain run after --tar stays per-user, and says why" sh -c "[ '$code' = 0 ] && grep -q 'kept the per-user install' '$out' && grep -q 'updates itself from now on' '$out' && ! grep -q 'installed as a package' '$out'"
  [ "$code" = 0 ] || sed 's/^/      /' "$out"
  t "and leaves the package as it was" sh -c "[ \"\$(stat -c %Y /usr/bin/snyvi)\" = '$before_deb' ] && dpkg-query -W -f='\${Status}' snyvi | grep -q 'install ok installed'"
  dpkg -r snyvi > /dev/null 2>&1
fi

if [ "$fail" = 0 ]; then echo "  all rows hold"; else echo "  some rows failed"; fi
exit "$fail"
