<!-- snyvi init-claude wrote this; snyvi uninstall-claude takes it out, and an update rewrites it. -->

# Writing a snyvi widget

Read `SKILL.md` first: a widget is for a figure the user asked to keep in
view, as a count and one short line.

## Box or file

| | `set_widget` | `propose_widget` |
|---|---|---|
| Who updates it | you, by calling it again | snyvi, by running your script on a timer |
| Lives | until cleared, or as long as the user picked on the card; says "panel N closed" when yours does | while it is switched on, for as long as the user picked |
| Use for | something you are watching as you work: a test run, a build | something worth seeing after you are gone: CI, a deploy, a queue |

Both go through a card on the user's On you list. Nothing shows until they say
yes. Not now, or Remove, means leave that name alone on this desk.

## What a widget shows

Markdown, or one JSON object:

```json
{ "body": "**deploy** 3/5 green", "tone": "ok", "count": "3/5", "lines": 1, "stale_after": 600 }
```

| Field | |
|---|---|
| `body` | Markdown, 1,500 characters at most: text, bold, code, links, lists. HTML is dropped, a picture shows as its alt text, a table as its pipes; a heading or a code block renders, but takes room. Empty clears |
| `tone` | `ok`, `warn`, `bad`, `none`: colours the count (`good`, `warning`, `error`, `fail` and the colours `green`, `yellow`, `red` read as those) |
| `count` | at most 8 characters, kept while folded: `3`, `!2`, `3/5` |
| `lines` | 1–6, the body's room; keep it 1 |
| `stale_after` | seconds before it dims as old (1800); 0 is never |

Names are lowercase letters, digits and dashes, 32 at most.

## A gallery

`add_to_gallery` is for what an image or video model made **for the user**:
OpenRouter, fal, Replicate, a local model, a render. Each output is a tile in
the desk's gallery box; the user opens it big, steps through, and picks one.
Their pick and a line reach you on your next prompt.

- `file` is on this machine: download the model's output first, never a URL
  (a provider's link expires). snyvi copies it in.
- A slow model: call it first with `job` and no file (the tile says it is
  being made), then the same `job` with the `file`, or with `failed`.
- Give `caption` (what differs from the others), `model`, `prompt`, `cost`
  in dollars. A clip can have a `poster` (`ffmpeg -ss 0 -i clip.mp4 -frames:v 1 poster.jpg`).
- The first add on a desk is a card, as a box's is; outputs added meanwhile
  wait and show on Allow.
- Not for screenshots of your work or documents: those are `send_document`.

```text
add_to_gallery { file: "/abs/out/r2-b.png", caption: "warm, closer", model: "flux-1.1-pro",
                 prompt: "…", cost: 0.04, job: "r2-b" }
```

A script does the same: `snyvi gallery add out.png --caption "warm" --model flux --cost 0.04 --desk 3`.

## A widget file

`propose_widget` takes what goes in its folder:

| Argument | |
|---|---|
| `name`, `title`, `why` | the name, the head it shows, one sentence for the card |
| `command` | one line, run with `sh -c` (`cmd /C` on Windows) **in the desk's folder**. Name the script bare: `run.sh`, never `./run.sh` or `sh run.sh` |
| `script_name`, `script` | the script, whole, at most 16 KB, and the file name it is written as (what `command` names); it is made executable. A `script` with no `script_name` is refused |
| `files` | up to 4 other files it reads, `{name: text}`, 16 KB each |
| `settings` | rows the user changes on /sidebars: `{"base": {"type": "string", "label": "Compare against", "default": "main"}}`; `type` is `string`, `number`, `boolean`, or `choice` with `choices`; at most 8 |
| `keys` | the names of this desk's keys the run needs, at most 4 (`["OPENROUTER_API_KEY"]`): shown on the card, and each is `$NAME` in the run's environment once the user adds it. `snyvi key` does not work in a run |
| `every`, `timeout` | seconds between runs (60, at least 5); seconds it may take (10, at most 30) |
| `for` | how long you suggest: `today`, `week`, `panel` (while yours is open); left out is until the user turns it off; the user picks |

How each run sees the world:

- **cwd**: the desk's folder. The widget's own folder is first on `PATH` and
  in `$SNYVI_WIDGET_DIR`: reach a file beside the script as
  `"$SNYVI_WIDGET_DIR/query.graphql"`.
- **stdin**: `{"desk":{"id":3,"name":"snyvi","folder":"/home/you/snyvi"},"settings":{"base":"main"},"snyvi":"1.46.0"}`.
- **env**: the user's login-shell `PATH` (nvm, pyenv and the like are on it),
  `HOME`, `USER`, `LANG`, `TMPDIR` when the daemon has one, and the `keys`
  you named. Nothing else: not snyvi's token, not the rest of the desk's
  keys, not your panel's variables. `snyvi widget check` gives it the same.
- **Limits**: 4 KB of output read; a timeout kills the whole process group;
  two run at a time; it runs only while its desk is in view.
- **State** between runs goes in `${TMPDIR:-/tmp}`, never the widget's
  folder: a change there asks the user to Allow it again.
- **Failure**: a non-zero exit, a timeout or a body snyvi refuses shows as a
  line over the last good body. Three in a row of the same kind (the exit
  code, a timeout) stop it, and you are told on your next prompt -- or the
  next panel on the desk is, if yours has closed. A widget that **waits
  for Allow** or **waits for a key** is not failing: nothing of yours to fix.
- **Not now** on the card is told to you on your next prompt, and a
  proposal of that name is refused after it: leave it unless they ask.

## Check it before proposing

In a folder of your own -- never snyvi's widgets folder, where a folder is
a live widget asking the user to allow it:

```sh
d=$(mktemp -d)/ci && mkdir -p "$d"
cat > "$d/widget.json" <<'JSON'
{ "name": "ci", "title": "CI", "scope": "desk", "run": { "command": "run.sh", "every": 60, "timeout": 10 }, "keys": [] }
JSON
cat > "$d/run.sh" <<'SH'
...the script...
SH
chmod +x "$d/run.sh"
snyvi widget check ci --dir "$d"     # run from the desk's folder: prints what snyvi would draw, or why not
```

`snyvi widget new ci` inside a panel writes that starter in the current
folder. `check` runs it as snyvi will: the environment cleared but for
PATH, home, language and the keys named, so what passes here runs there.

Then `propose_widget` with the same command and script. On the card the
user can **Try once**, pick how long, and **Add**.

## Three that work

**Git: branch, ahead, dirty** (a setting for the base branch):

```sh
#!/bin/sh
base=$(sed -n 's/.*"base":"\([^"]*\)".*/\1/p'); base=${base:-main}
ahead=$(git rev-list --count "$base"..HEAD 2>/dev/null || echo 0)
dirty=$(git status --porcelain | wc -l | tr -d ' ')
tone=ok; [ "$dirty" -gt 0 ] && tone=warn
printf '{"body":"**%s** · %s ahead of %s","tone":"%s","count":"%s"}\n' \
  "$(git branch --show-current)" "$ahead" "$base" "$tone" "$dirty"
```

**CI: the latest run on this branch** (needs `gh`, signed in):

```sh
#!/bin/sh
b=$(git branch --show-current)
gh run list --branch "$b" --limit 1 --json status,conclusion,name,url \
  --jq '.[0] | if . == null then {body:"no runs yet",tone:"none",count:"-"}
        elif .status != "completed" then {body:"**\(.name)** running · [open](\(.url))",tone:"warn",count:"…"}
        elif .conclusion == "success" then {body:"**\(.name)** green · [open](\(.url))",tone:"ok",count:"ok"}
        else {body:"**\(.name)** \(.conclusion) · [open](\(.url))",tone:"bad",count:"!"} end'
```

**A dev server: up or down** (a setting for the port):

```sh
#!/bin/sh
port=$(sed -n 's/.*"port":\([0-9]*\).*/\1/p'); port=${port:-3000}
if curl -s -o /dev/null -m 2 "http://127.0.0.1:$port/"; then
  printf '{"body":"localhost:%s answers","tone":"ok","count":"up"}\n' "$port"
else
  printf '{"body":"nothing on localhost:%s","tone":"bad","count":"down"}\n' "$port"
fi
```

with `"settings": {"port": {"type": "number", "label": "Port", "default": 3000}}`.
