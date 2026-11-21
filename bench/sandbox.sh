#!/usr/bin/env bash
# A snyvi of its own for whoever is working on snyvi: a scratch HOME, data and
# config, a spare port, a binary built from this tree and copied out of
# target/, ui/ served from disk. The one way to start, stop, restart or set up
# a snyvi from this checkout. Never 7777, which is the reader's daily window.
#
#   bench/sandbox.sh up [--port N] [--seed] [--window] [--no-build]
#   bench/sandbox.sh run <snyvi args...>   any snyvi command, inside the sandbox
#   bench/sandbox.sh status                port, pids, the binary's commit and age
#   bench/sandbox.sh shot [file.png] [path]  a picture of its page (default /)
#   bench/sandbox.sh curl [curl args] <path>  the window's API, with a capability
#   bench/sandbox.sh restart               its daemon only, same environment
#   bench/sandbox.sh down                  end what up started, remove the scratch
#
# Each of these is here because doing it by hand went wrong once:
#   - a test of the installer restarted 7777 and pointed Claude Code's hooks at
#     a deleted binary, so `run` is the only way to call stop, restart,
#     init-claude or update, and HOME is never the real one;
#   - `env $E snyvi stop` in zsh, where $E does not split, stopped the daily
#     daemon, so no string of variables is handed to env here: `envs` names
#     each one;
#   - a new worktree's target/ is a link to the main checkout's and its
#     binaries are old, and one ran on the real HOME and wrote an old skill
#     over the installed one, so `up` builds and runs a copy;
#   - `pkill -f <port>` matches the shell that typed it, so `down` kills the
#     pids `up` wrote down, each checked against its port first.
#
# SANDBOX=<name> keeps a second one apart (default: this checkout's folder
# name). Linux only; a tool for this repository, not part of the binary.
set -euo pipefail
cd "$(dirname "$0")/.."
REPO=$PWD
NAME=${SANDBOX:-$(basename "$REPO")}
ST=${XDG_RUNTIME_DIR:-/tmp}/snyvi-sandbox-$NAME
BIN=$ST/bin/snyvi
DAILY=7777

die() { echo "sandbox: $*" >&2; exit 1; }
up_or_die() { [ -f "$ST/port" ] || die "nothing up (bench/sandbox.sh up)"; }
port() { cat "$ST/port"; }
base() { echo "http://127.0.0.1:$(port)"; }
healthy() { curl -sf "$(base)/api/health" >/dev/null 2>&1; }

# The environment everything in the sandbox runs in. Every SNYVI_*, CLAUDE* and
# ANTHROPIC_* variable is dropped first: this is usually run from a panel, and
# a panel's SNYVI_SESSION would make the sandbox's snyvi speak for that panel.
envs() {
  local drop=()
  while IFS= read -r v; do drop+=(-u "$v"); done < <(env | grep -oE '^(SNYVI_|CLAUDE|ANTHROPIC_)[A-Za-z0-9_]*' || true)
  env "${drop[@]}" \
    HOME="$ST/home" \
    SNYVI_PORT="$(port)" SNYVI_DATA_DIR="$ST/data" SNYVI_CONFIG_DIR="$ST/config" \
    SNYVI_UI_DIR="$REPO/ui" SNYVI_NOTIFY=0 SNYVI_UPDATES=off \
    PATH="$ST/bin:$PATH" "$@"
}

# The daemon's pid, only if the process is this sandbox's: it runs this
# sandbox's copy of the binary, and its environment names this sandbox's port
# and data folder. Looked for by its executable, not kept from `$!`: setsid
# may fork, and then `$!` is a process that has already gone.
daemon_pid() {
  local pid
  for pid in $(pgrep -f "^$BIN serve\$" || true); do
    [ "$(readlink -f "/proc/$pid/exe" 2>/dev/null)" = "$BIN" ] || continue
    tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null | grep -qx "SNYVI_DATA_DIR=$ST/data" || continue
    tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null | grep -qx "SNYVI_PORT=$(port)" || continue
    echo "$pid"; return 0
  done
  return 1
}

free_port() {
  local p
  for p in $(seq 7800 7899); do
    ss -ltnH "sport = :$p" 2>/dev/null | grep -q . || { echo "$p"; return; }
  done
  die "no free port between 7800 and 7899"
}

build() {
  # Debug, niced, two jobs: a fat release build hangs this machine. The shared
  # target is warm, so only snyvi compiles; what runs is the copy.
  echo "sandbox: building (debug, niced)..." >&2
  nice -n 19 ionice -c3 cargo build -j 2 --bin snyvi >&2
  local built; built=$(readlink -f target/debug/snyvi)
  [ -x "$built" ] || die "no binary at target/debug/snyvi after the build"
  cp -f "$built" "$BIN.new" && mv -f "$BIN.new" "$BIN"
  git rev-parse --short HEAD > "$ST/commit" 2>/dev/null || echo "?" > "$ST/commit"
  git diff --quiet 2>/dev/null || echo "$(cat "$ST/commit")+changes" > "$ST/commit"
}

serve() {
  healthy && die "something already answers on $(port); not starting a second daemon"
  envs setsid nohup "$BIN" serve > "$ST/serve.log" 2>&1 &
  for _ in $(seq 150); do healthy && daemon_pid >/dev/null && return 0; sleep 0.1; done
  tail -5 "$ST/serve.log" >&2
  die "the daemon did not come up on $(port) (see $ST/serve.log)"
}

stop_daemon() {
  local pid
  pid=$(daemon_pid) || return 0
  envs "$BIN" stop >/dev/null 2>&1 || kill "$pid" 2>/dev/null || true
  for _ in $(seq 80); do [ -e "/proc/$pid" ] || return 0; sleep 0.1; done
  kill -9 "$pid" 2>/dev/null || true
  for _ in $(seq 20); do [ -e "/proc/$pid" ] || return 0; sleep 0.1; done
  die "the daemon (pid $pid) would not stop"
}

capability() {
  curl -sf -X POST -H "x-snyvi-window: $(cat "$ST/config/window")" "$(base)/api/capability" \
    | sed -E 's/.*"capability":"([^"]+)".*/\1/'
}

case "${1:-}" in
up)
  shift
  want="" seed=0 window=0 nobuild=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --port) want=${2:-}; shift ;;
      --seed) seed=1 ;;
      --window) window=1 ;;
      --no-build) nobuild=1 ;;
      *) die "up: unknown argument $1" ;;
    esac
    shift
  done
  [ -e "$ST" ] && die "already up: $ST (status, or down first)"
  [ "$want" = "$DAILY" ] && die "$DAILY is the daily window's port; the sandbox never takes it"
  if [ -n "$want" ]; then
    [[ "$want" =~ ^[0-9]+$ ]] || die "--port wants a number"
    ss -ltnH "sport = :$want" 2>/dev/null | grep -q . && die "port $want is in use"
  else
    want=$(free_port)
  fi
  mkdir -p "$ST/home" "$ST/bin" "$ST/data" "$ST/config"
  echo "$want" > "$ST/port"
  if [ "$nobuild" = 1 ]; then
    [ -x target/debug/snyvi ] || { rm -rf "$ST"; die "--no-build, and there is no target/debug/snyvi"; }
    cp -f "$(readlink -f target/debug/snyvi)" "$BIN"
    echo "unbuilt copy of target/debug/snyvi" > "$ST/commit"
  else
    build || { rm -rf "$ST"; exit 1; }
  fi
  serve
  if [ "$seed" = 1 ]; then
    for f in bench/seed/*.md; do envs "$BIN" send "$f" -p "$REPO/bench/seed" >/dev/null; done
  fi
  if [ "$window" = 1 ]; then
    app=$(command -v snyvi-app || true)
    [ -n "$app" ] || die "the daemon is up, but there is no snyvi-app on PATH for --window"
    ln -sf "$app" "$ST/bin/snyvi-app"
    # A private session bus, or the daily window takes the launch as its own.
    # To a file, not a pipe: the forked bus holds a pipe open and nothing ends.
    dbus-daemon --session --fork --print-address=1 --print-pid=1 --nopidfile > "$ST/bus.txt"
    sed -n 2p "$ST/bus.txt" > "$ST/bus.pid"
    envs DBUS_SESSION_BUS_ADDRESS="$(sed -n 1p "$ST/bus.txt")" setsid nohup "$BIN" app > "$ST/app.log" 2>&1 &
    for _ in $(seq 100); do
      app_pid=$(pgrep -f "snyvi-app $(base)" | head -1 || true)
      [ -n "$app_pid" ] && { echo "$app_pid" > "$ST/app.pid"; break; }
      sleep 0.2
    done
  fi
  echo "up: $(base)  binary $(cat "$ST/commit")  scratch $ST"
  ;;
run)
  up_or_die; shift
  [ $# -gt 0 ] || die "run: which snyvi command?"
  envs "$BIN" "$@"
  ;;
status)
  up_or_die
  echo "sandbox  $NAME"
  echo "address  $(base)"
  echo "scratch  $ST"
  echo "binary   $(cat "$ST/commit"), copied $(date -r "$BIN" '+%Y-%m-%d %H:%M')"
  if pid=$(daemon_pid); then echo "daemon   pid $pid, $(healthy && echo healthy || echo not answering)"; else echo "daemon   not running"; fi
  [ -f "$ST/app.pid" ] && echo "window   pid $(cat "$ST/app.pid")$([ -e "/proc/$(cat "$ST/app.pid")" ] || echo ' (gone)')"
  newer=$(find src ui build.rs Cargo.toml -newer "$BIN" -type f 2>/dev/null | grep -v '^ui/' | head -1 || true)
  [ -n "$newer" ] && echo "note     src/ changed since the binary was built ($newer): down, then up"
  exit 0
  ;;
shot)
  up_or_die; healthy || die "the daemon is not answering"
  out=${2:-snyvi-shot.png}; path=${3:-/}
  node=$(command -v node || ls -d "$HOME"/.nvm/versions/node/v22*/bin/node 2>/dev/null | tail -1 || true)
  [ -n "$node" ] || die "shot needs node 22 or newer"
  "$node" bench/shot.mjs "$(base)" "$(capability)" "$path" "$out"
  ;;
curl)
  # The window's side of the API (desks, panels), with a capability minted for
  # this call: `curl /api/desks`, `curl -X POST -d '{"name":"x"}' /api/desks`.
  up_or_die; shift
  [ $# -gt 0 ] || die "curl: [curl args] <path>"
  path=${!#}; set -- "${@:1:$#-1}"
  curl -sf -H "x-snyvi-capability: $(capability)" -H "content-type: application/json" "$@" "$(base)$path"
  ;;
restart)
  up_or_die
  stop_daemon
  serve
  echo "restarted: $(base)"
  ;;
down)
  [ -e "$ST" ] || { echo "nothing up"; exit 0; }
  if [ -f "$ST/app.pid" ]; then
    app_pid=$(cat "$ST/app.pid")
    tr '\0' ' ' < "/proc/$app_pid/cmdline" 2>/dev/null | grep -q "$(base)" && kill "$app_pid" 2>/dev/null || true
  fi
  stop_daemon
  [ -f "$ST/bus.pid" ] && kill "$(cat "$ST/bus.pid")" 2>/dev/null || true
  rm -rf "$ST" 2>/dev/null || { sleep 1; rm -rf "$ST"; }
  echo "down"
  ;;
*) sed -n '2,14p' "$0"; exit 1 ;;
esac
