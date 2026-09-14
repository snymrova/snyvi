#!/usr/bin/env bash
# The first ten minutes, as a newcomer types them, in a home that has never
# seen snyvi.
#
#   HOMEDIR=/tmp/snyvi-first B=target/release/snyvi bash bench/onboarding.sh
#
# Every line here was a place the install stalled before 0.17: init-claude
# run a second time called itself unable to run claude, a moved binary left
# hooks failing quietly on every tool call, a taken port was "did not come
# up", and a machine with no browser printed a bare URL and exit 0. The
# `claude` used is a fake that keeps user-scope servers where the real one
# does, in ~/.claude.json, and refuses a second `add` the way the real one
# does; the settings file starts with someone else's hook in it, which has
# to be there, untouched, at the end.
set -eu
: "${HOMEDIR:?where to make the home}" "${B:?the snyvi binary}"
B=$(cd "$(dirname "$B")" && pwd)/$(basename "$B")
export HOME=$HOMEDIR SNYVI_PORT=7793 SNYVI_DATA_DIR=$HOMEDIR/data SNYVI_CONFIG_DIR=$HOMEDIR/cfg
rm -rf $HOME; mkdir -p $HOME/bin $HOME/.claude
# A claude that keeps user-scope servers the way the real one does, in ~/.claude.json.
cat > $HOME/bin/claude <<'PY'
#!/usr/bin/env python3
import json, os, sys
f = os.path.expanduser("~/.claude.json"); log = os.path.expanduser("~/claude.log")
open(log, "a").write(" ".join(sys.argv[1:]) + "\n")
d = json.load(open(f)) if os.path.exists(f) else {}
srv = d.setdefault("mcpServers", {})
a = sys.argv[1:]
if a[:2] == ["mcp", "add"]:
    name = a[a.index("--")-1]; cmd = a[a.index("--")+1:]
    if name in srv: print(f"MCP server {name} already exists in user config", file=sys.stderr); sys.exit(1)
    srv[name] = {"type": "stdio", "command": cmd[0], "args": cmd[1:]}; json.dump(d, open(f, "w")); print(f"Added stdio MCP server {name}")
elif a[:2] == ["mcp", "remove"]:
    name = a[-1]
    if name not in srv: print(f"No MCP server found with name: {name}", file=sys.stderr); sys.exit(1)
    del srv[name]; json.dump(d, open(f, "w")); print(f"Removed MCP server {name}")
else: sys.exit(2)
PY
chmod +x $HOME/bin/claude
# An unrelated hook and setting that must survive everything below.
echo '{"theme":"dark","hooks":{"PostToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"other --x"}]}]}}' > $HOME/.claude/settings.json
cp $HOME/.claude/settings.json $HOME/settings-before.json
# Only what the probe needs on PATH: python3 and coreutils, and never a real claude.
export PATH=$HOME/bin:/usr/bin:/bin
command -v claude | grep -q "$HOME/bin/claude" || { echo "a claude other than the fake is on PATH"; exit 1; }
check() { python3 -c "import json,os,sys
s=json.load(open(os.path.expanduser('~/.claude/settings.json')))
d=json.load(open(os.path.expanduser('~/.claude.json'))) if os.path.exists(os.path.expanduser('~/.claude.json')) else {}
$1" || { echo "FAILED: $1"; exit 1; }; }
echo "--- 1. not on PATH: written with the full path"
$B init-claude | tee $HOME/init1.log
grep -q "Registered snyvi with Claude Code" $HOME/init1.log
grep -q "Try it" $HOME/init1.log
grep -q "full path" $HOME/init1.log
check "assert s['hooks']['SessionStart'][0]['hooks'][0]['command']=='$B hook', s"
echo "--- 2. again: nothing re-added, claude asked once"
$B init-claude | tee $HOME/init2.log
grep -q "already has snyvi registered" $HOME/init2.log
test "$(grep -c 'mcp add' $HOME/claude.log)" = 1
echo "--- 3. the binary moves onto PATH: registration and hooks follow, as snyvi"
cp $B $HOME/bin/snyvi
snyvi init-claude --auto | tee $HOME/init3.log
grep -q "Re-registering" $HOME/init3.log
grep -q "now run this binary" $HOME/init3.log
check "h=s['hooks']; assert h['SessionStart'][0]['hooks'][0]['command']=='snyvi hook', h; assert [x['hooks'][0]['command'] for x in h['PostToolUse']]==['other --x','snyvi hook'], h; assert s['theme']=='dark'; assert d['mcpServers']['snyvi']['command']=='snyvi', d"
echo "--- 4. status says so"
snyvi status | tee $HOME/status.log
grep -q "Claude Code: MCP server registered (snyvi mcp); hooks: SessionStart, PostToolUse" $HOME/status.log
echo "--- 5. --claude-md, twice"
snyvi init-claude --claude-md | grep -q "Added a line"
snyvi init-claude --claude-md | grep -q "already asks"
test "$(grep -c send_document $HOME/.claude/CLAUDE.md)" = 1
echo "--- 6. uninstall-claude leaves the file as it was found"
snyvi uninstall-claude | tee $HOME/un.log
grep -q "Removed 2 snyvi hook" $HOME/un.log
check "b=json.load(open(os.path.expanduser('~/settings-before.json'))); assert s==b, (s,b); assert 'snyvi' not in d['mcpServers']"
! grep -q send_document $HOME/.claude/CLAUDE.md
snyvi status | grep -q "MCP server not registered"
echo "--- 7. no claude at all: says so, exits 0, gives the line"
rm $HOME/bin/claude
! command -v claude
snyvi init-claude | tee $HOME/init4.log
grep -q "is not on PATH" $HOME/init4.log
grep -q "claude mcp add --scope user snyvi -- snyvi mcp" $HOME/init4.log
echo "--- 8. a taken port names itself"
python3 -m http.server 7793 --bind 127.0.0.1 >/dev/null 2>&1 & hp=$!
sleep 1
! snyvi send README.md 2>$HOME/port.log
cat $HOME/port.log
grep -q "not a snyvi daemon" $HOME/port.log
grep -q "SNYVI_PORT" $HOME/port.log
kill $hp; sleep 0.3
echo "--- 9. no browser: the link is printed, said to be for the reader"
env -i HOME=$HOME PATH=$HOME/bin SNYVI_PORT=7793 SNYVI_DATA_DIR=$SNYVI_DATA_DIR SNYVI_CONFIG_DIR=$SNYVI_CONFIG_DIR snyvi open 2>$HOME/open.log
cat $HOME/open.log
grep -q "open this yourself" $HOME/open.log
env -i HOME=$HOME PATH=$HOME/bin SNYVI_PORT=7793 SNYVI_DATA_DIR=$SNYVI_DATA_DIR SNYVI_CONFIG_DIR=$SNYVI_CONFIG_DIR snyvi app 2>$HOME/app.log
cat $HOME/app.log
grep -q "no display" $HOME/app.log
echo "--- 10. install-cli into a directory"
snyvi install-cli $HOME/cli | tee $HOME/cli.log
test "$(readlink $HOME/cli/snyvi)" = "$HOME/bin/snyvi"
grep -q "not on PATH" $HOME/cli.log
snyvi install-cli $HOME/cli | tee $HOME/cli2.log
snyvi stop
echo "first ten minutes: ok"
