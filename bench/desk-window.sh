#!/usr/bin/env bash
# The desk's paint cost in a real window: bench/webkit.py's desk row, but in
# snyvi-app on the real display and its GPU, where the target in
# docs/DESK-PAINT.md is measured. A daemon of its own on a spare port, ui/
# served from disk, one desk of four panels drawing bench/tui-load.mjs, and a
# window on a private session bus so the daily one does not take it over.
# Never 7777.
#
#   bench/desk-window.sh up [port]       start it all, print the web process pid
#   bench/desk-window.sh measure [secs]  CPU of that process: whole and per thread
#   bench/desk-window.sh profile [secs]  a perf recording, read by perf-webkit.py
#   bench/desk-window.sh down            close the window, stop the daemon, clean up
#
# DESK_UI=<dir> serves another copy of ui/, for a control. The window is
# maximized, since its size is most of the cost.
#
# `profile` needs kernel.perf_event_paranoid <= 1 and the debug file at
# $WK_DEBUG (default /dev/shm/wk-sym/webkit.debug); see DESK-PAINT.md.
set -euo pipefail
cd "$(dirname "$0")/.."
REPO=$PWD
ST=/dev/shm/snyvi-desk-window
BIN=$REPO/target/release/snyvi
PERF=/usr/lib/linux-tools-6.8.0-47/perf

envs() {
  env $(env | grep -oE '^SNYVI_[A-Z_]+' | sed 's/^/-u /') \
    SNYVI_PORT="$(cat $ST/port)" SNYVI_DATA_DIR=$ST/data SNYVI_CONFIG_DIR=$ST/config \
    SNYVI_UI_DIR="${DESK_UI:-$REPO/ui}" SNYVI_NOTIFY=0 HOME=$ST/home "$@"
}

web_pid() {
  local app; app=$(cat $ST/app.pid)
  for c in $(pgrep -P "$app"); do [ "$(cat /proc/$c/comm)" = WebKitWebProces ] && { echo "$c"; return; }; done
  return 1
}

case "${1:-}" in
up)
  [ -e $ST ] && { echo "already up: $ST (run down first)"; exit 1; }
  mkdir -p $ST/home; echo "${2:-7841}" > $ST/port
  envs setsid nohup "$BIN" serve > $ST/serve.log 2>&1 &
  base="http://127.0.0.1:$(cat $ST/port)"
  for _ in $(seq 100); do curl -sf "$base/api/health" >/dev/null 2>&1 && break; sleep 0.1; done
  tok=$(cat $ST/config/token)
  cap=$(curl -sf -X POST -H "authorization: Bearer $tok" "$base/api/capability" | sed -E 's/.*"capability":"([^"]+)".*/\1/')
  H=(-H "x-snyvi-capability: $cap" -H "content-type: application/json")
  desk=$(curl -sf -X POST "${H[@]}" -d '{"name":"paint"}' "$base/api/desks" | grep -oE '"id":[0-9]+' | head -1 | cut -d: -f2)
  for _ in 1 2 3 4; do
    pane=$(curl -sf -X POST "${H[@]}" -d '{}' "$base/api/desks/$desk/panes" | sed -E 's/.*"pane":\{"id":"([^"]+)".*/\1/')
    curl -sf -X POST "${H[@]}" -d "{\"cmd\":\"$(command -v node) $REPO/bench/tui-load.mjs\"}" "$base/api/panes/$pane/start" >/dev/null
  done
  # To a file, not a pipe: the forked bus holds a pipe open and nothing ends.
  dbus-daemon --session --fork --print-address=1 --print-pid=1 --nopidfile > $ST/bus.txt
  addr=$(sed -n 1p $ST/bus.txt); sed -n 2p $ST/bus.txt > $ST/bus.pid
  envs DBUS_SESSION_BUS_ADDRESS="$addr" setsid nohup "$BIN" app "$base/desk/$desk" > $ST/app.log 2>&1 &
  for _ in $(seq 100); do
    app=$(pgrep -f "snyvi-app $base" | head -1 || true)
    [ -n "$app" ] && { echo "$app" > $ST/app.pid; web_pid >/dev/null 2>&1 && break; }
    sleep 0.2
  done
  /usr/bin/python3 - "$(cat $ST/app.pid)" <<'PY' 2>/dev/null
import sys, time, gi
gi.require_version("Wnck", "3.0"); gi.require_version("Gtk", "3.0")
from gi.repository import Wnck, Gtk
pid, s = int(sys.argv[1]), Wnck.Screen.get_default()
for _ in range(50):
    s.force_update()
    wins = [w for w in s.get_windows() if w.get_pid() == pid and w.get_window_type() == Wnck.WindowType.NORMAL]
    if wins:
        wins[0].maximize()
        while Gtk.events_pending(): Gtk.main_iteration()
        break
    time.sleep(0.2)
PY
  sleep 3
  echo "desk $desk on $base, window $(cat $ST/app.pid), web process $(web_pid), ui ${DESK_UI:-$REPO/ui}"
  ;;
measure)
  pid=$(web_pid); secs=${2:-10}; hz=$(getconf CLK_TCK)
  ticks() { awk '{print $14 + $15}' "$1" 2>/dev/null || echo 0; }
  declare -A t0; for t in /proc/$pid/task/*; do t0[$t]=$(ticks $t/stat); done
  a0=$(ticks /proc/$pid/stat); s0=$(date +%s.%N)
  sleep "$secs"
  a1=$(ticks /proc/$pid/stat); s1=$(date +%s.%N)
  span=$(echo "$s1 - $s0" | bc -l)
  printf "whole process %.0f%% of a core over %ss\n" "$(echo "100 * ($a1 - $a0) / $hz / $span" | bc -l)" "$secs"
  for t in /proc/$pid/task/*; do
    [ -n "${t0[$t]:-}" ] && [ -e $t/stat ] || continue
    printf "%s %.0f\n" "$(tr ' ' _ < $t/comm)$([ "${t##*/}" = "$pid" ] && echo '(main)')" "$(echo "100 * ($(ticks $t/stat) - ${t0[$t]}) / $hz / $span" | bc -l)"
  done | awk '{a[$1] += $2} END {for (k in a) if (a[k] >= 1) print "  " a[k] "%  " k}' | sort -t% -k1 -rn
  ;;
profile)
  pid=$(web_pid); out=$ST/wk.data
  "$PERF" record -F 499 -g -p "$pid" -o "$out" -- sleep "${2:-8}" 2>&1 | tail -1
  python3 bench/perf-webkit.py "$out" "${WK_DEBUG:-/dev/shm/wk-sym/webkit.debug}" --top 30
  ;;
down)
  [ -e $ST ] || { echo "nothing up"; exit 0; }
  [ -f $ST/app.pid ] && kill "$(cat $ST/app.pid)" 2>/dev/null || true
  envs "$BIN" stop >/dev/null 2>&1 || true
  [ -f $ST/bus.pid ] && kill "$(cat $ST/bus.pid)" 2>/dev/null || true
  # The daemon is still writing its data as it goes: wait for the port to close.
  for _ in $(seq 50); do curl -sf "http://127.0.0.1:$(cat $ST/port 2>/dev/null)/api/health" >/dev/null 2>&1 || break; sleep 0.1; done
  rm -rf $ST 2>/dev/null || { sleep 1; rm -rf $ST; }; echo "down"
  ;;
*) sed -n '2,16p' "$0"; exit 1 ;;
esac
