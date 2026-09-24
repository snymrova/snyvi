/* The film's frames, photographed off the real desktop window.
 *
 *   node film/stage.mjs                  # a library worth filming
 *   node film/shoot.mjs [--out film/frames]
 *
 * The previous camera drove headless Chromium and screenshotted the page. That
 * was right while the argument was about documents: a page is a page wherever
 * it is drawn. It stopped being right when the argument became that the agent
 * runs *inside* snyvi, because what a reader has to believe then is that this
 * is an application on their desktop -- and a screenshot of a page in a
 * headless browser is exactly the thing that cannot show that. So the camera
 * photographs the window: its own frame, its own controls, its own title, the
 * panels with real Claude Code sessions in them.
 *
 * The window runs on a display of its own. The first version of this used
 * the desktop the person was sitting at, which meant the camera's keys went
 * to whatever had focus, and `snyvi app` -- finding no window of the stage's
 * own -- handed the stage's URL to the single-instance window already open
 * there, or to their browser. So this starts an Xvfb, a session bus nobody
 * else is on, and the stage's own `snyvi-app` with a capability minted for
 * it; nothing it does can reach the real desktop, and it takes all three
 * down when it is finished.
 *
 * The film is told from the desk, so every frame but the last few is the
 * ledger desk, or something reached from it: the folder it was opened on,
 * a document a panel sent arriving in its rail, that document opened over
 * it, the inbox it was filed in, the notes it keeps, the game over it. Two
 * documents are held back by film/stage.mjs so a frame can show one arrive.
 *
 * Keys, pointer and tooltips go through `film/xdo.py`; `import -window`
 * takes the pixels. The window is 1280x860 and cannot be resized from here,
 * so the film shows it at about its own size rather than punching into it.
 * See film/DESIGN.md.
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, copyFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const args = process.argv.slice(2);
const flag = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const PORT = flag("--port") || "7799";
const OUT = resolve(flag("--out") || "film/frames");
const HERE = dirname(fileURLToPath(import.meta.url));
const DISPLAY = flag("--display") || ":77";
const base = `http://127.0.0.1:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const MARK = join(tmpdir(), `snyvi-stage-${PORT}.json`);
if (!existsSync(MARK)) {
  console.error(`nothing staged on ${PORT} -- run: node film/stage.mjs`);
  process.exit(1);
}
const { tmp, desks, panes, dirs, later } = JSON.parse(readFileSync(MARK, "utf8"));

/** The python that has python-xlib in it. The camera does not install it: on a
 *  machine with no xdotool this is how keys are sent, and `film/README.md`
 *  says how to make the environment. */
const PY = process.env.SNYVI_XPY || join(HERE, ".venv", "bin", "python");

const env = {
  ...process.env,
  DISPLAY,
  HOME: join(tmp, "home"),
  SNYVI_PORT: PORT,
  SNYVI_CONFIG_DIR: join(tmp, "config"),
  SNYVI_DATA_DIR: join(tmp, "data"),
  BROWSER: "/bin/true",   // a window that cannot open must not become a tab on the real desktop
};
// The film is set on the dark, so the window is too: snyvi follows the system
// theme until a reader picks one, and this is the system saying dark.
// `--light` for the paper version.
if (!args.includes("--light")) env.GTK_THEME = "Adwaita:dark";
const snyvi = join(tmp, "bin", "snyvi");

/** Turn the window to a URL, the way a click on an agent's link does. */
async function go(path) {
  execFileSync(snyvi, ["app", `${base}${path}`], { env, stdio: "ignore" });
  await sleep(2600);
}

/** A key at the window. `focus` raises it first; everything after a view has
 *  opened must not, or the focus leaves whatever inside it was listening. */
async function key(combo, { focus = false } = {}) {
  const a = [join(HERE, "xdo.py"), ...(focus ? [] : ["--no-focus"]), "key", combo];
  execFileSync(PY, a, { env, stdio: "inherit" });
  await sleep(700);
}
async function type(text) {
  execFileSync(PY, [join(HERE, "xdo.py"), "--no-focus", "type", text], { env, stdio: "inherit" });
  await sleep(900);
}
async function click(x, y) {
  execFileSync(PY, [join(HERE, "xdo.py"), "--no-focus", "click", `${x},${y}`], { env, stdio: "inherit" });
  await sleep(500);
}

async function shot(name) {
  const id = execFileSync(PY, [join(HERE, "xdo.py"), "find"], { env, encoding: "utf8" }).split(" ")[0];
  execFileSync("import", ["-window", id, join(OUT, `${name}.png`)], { env, stdio: "ignore" });
  console.log(`  ${name}.png`);
}

const token = () => readFileSync(join(tmp, "config", "token"), "utf8").trim();
const post = async (path, body) => {
  const r = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token()}` }, body: JSON.stringify(body ?? {}) });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return r.status === 204 ? null : r.json();
};

/** The display, the bus and the window, none of them the desktop's. */
async function world() {
  const children = [];
  const x = spawn("Xvfb", [DISPLAY, "-screen", "0", "1600x1000x24", "-nolisten", "tcp"], { stdio: "ignore" });
  children.push(x);
  await sleep(1500);
  const bus = execFileSync("dbus-daemon", ["--session", "--fork", "--print-address=1", "--print-pid=1", "--nopidfile"], { encoding: "utf8" }).trim().split("\n");
  env.DBUS_SESSION_BUS_ADDRESS = bus[0];
  const busPid = +bus[1];
  // Beside the stage's binary, so `snyvi app` finds this build's window and
  // not whichever one is installed.
  const app = join(tmp, "bin", "snyvi-app");
  if (!existsSync(app)) copyFileSync(resolve(HERE, "..", "target", "release", "snyvi-app"), app);
  const { capability } = await post("/api/capability");
  children.push(spawn(app, [`${base}/?window=1#cap=${capability}`], { env, stdio: "ignore", cwd: tmpdir() }));
  for (let i = 0; i < 60; i++) {
    try { execFileSync(PY, [join(HERE, "xdo.py"), "find"], { env, stdio: "ignore" }); break; } catch { await sleep(500); }
  }
  await sleep(3000);
  return () => { for (const c of children.reverse()) c.kill(); try { process.kill(busPid); } catch {} };
}

async function move(x, y) { execFileSync(PY, [join(HERE, "xdo.py"), "--no-focus", "move", `${x},${y}`], { env }); }
/** The pointer out of the way, and any tooltip it left behind taken down. */
async function still() { await move(640, 845); execFileSync(PY, [join(HERE, "xdo.py"), "--no-focus", "untip"], { env }); await sleep(300); }

/** A document a panel sends, now: what film/stage.mjs held back. */
async function sendFromPanel(which) {
  const [repo, workflow, file, sender, [desk, i]] = later[which];
  const at = join(dirs[repo], "docs", file);
  copyFileSync(join(HERE, "..", "bench", "seed", file), at);
  return (await post("/api/docs", { path: at, cwd: dirs[repo], workflow, sender, origin: "mcp", pane: panes[desk][i] })).doc;
}

/** What each panel is asked, in the same words the film's frames show in
 *  their titles. `clear` first: the stage's shells start in a home that has
 *  none of the real one's dotfiles, and say so. */
const ASK = {
  ledger: [
    "Review docs/rate-limiting.md against src/limit.rs and list where the plan and the code disagree",
    "Review src/limit.rs: what it does today, and what could break under load",
    "Find every path in src/limit.rs where a Redis error turns into a 429 or lets a request through",
    "Read src/limit.rs and docs/rate-limiting.md and write docs/summary.md: what changes for Free, Team and Enterprise keys",
  ],
  gateway: [
    "Review docs/gateway-design.md against src/ingest.ts and list where they conflict",
    "What happens to src/ingest.ts in a replay storm? Walk through it",
  ],
};
// The panel bodies, by count, in window pixels: two columns, one or two rows.
const SPOTS = { 4: [[466, 300], [845, 300], [466, 700], [845, 700]], 2: [[466, 450], [845, 450]] };
// The desk rail, in window pixels: rows of Documents, and the notes under them.
const RAIL = { row: n => [1140, 286 + 26 * n], back: n => [1246, 286 + 26 * n], note: y => [1072, y] };

async function ask(deskIdx, name) {
  await go(`/desk/${desks[deskIdx]}`);
  for (const [n, q] of ASK[name].entries()) {
    await click(...SPOTS[ASK[name].length][n]);
    await type(`clear; claude "${q}"`);
    await key("Return");
  }
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const down = await world();
  try {
    console.log(`frames: ${OUT}`);
    await key("Escape", { focus: true });

    // Real sessions, asked once, and left to finish: a panel that has answered
    // shows the work, and past a screenful Claude Code's banner -- version,
    // model, plan -- has scrolled off.
    await ask(0, "ledger");
    await ask(1, "gateway");
    await sleep(Number(process.env.SNYVI_FILM_WORK_MS || 90000));
    await post("/api/queue/clear");

    // The poster: the desk, four agents, what they sent, what it still owes.
    await go(`/desk/${desks[0]}`);
    await still();
    await shot("desk");

    // Where it started: the folder the desk is rooted at, its new-desk tool up.
    await move(120, 436);
    execFileSync(PY, [join(HERE, "xdo.py"), "--no-focus", "untip"], { env });
    await shot("folder-desk");

    // Panel 4 sends; the rail takes it, marked [4].
    await still();
    await sendFromPanel("summary");
    await sleep(2500);
    await shot("desk-sent");
    // Read, as far as the camera is concerned: a waiting arrival puts a banner
    // over the top of the window and a Waiting row in the sidebar, which moves
    // every row under it -- and every click below aimed at one.
    await post("/api/queue/clear");
    await sleep(1200);

    // The plan, opened over the desk: the rail stays, its row marked.
    await click(...RAIL.row(1));
    await sleep(2000);
    await still();
    await shot("desk-over");

    // Against the version before it.
    await click(640, 420);
    await key("c");
    await sleep(1500);
    await still();
    await shot("desk-diff");
    await key("c");

    // Back to the desk, and one of its notes ticked off.
    await click(...RAIL.back(1));
    await sleep(2000);
    await click(...RAIL.note(408));
    await sleep(1000);
    await still();
    await shot("desk-notes");

    // The same plan, filed in the inbox under its project, desk still open.
    await click(16, 124);
    await sleep(1200);
    await still();
    await shot("inbox-filed");
    await click(16, 124);

    // Another desk: its own panels, documents and notes.
    await click(90, 336);
    await sleep(2500);
    await still();
    await shot("desk-two");

    // Search, over the desk.
    await go(`/desk/${desks[0]}`);
    await click(1150, 650);
    await key("ctrl+k");
    await type("retry");
    await sleep(1200);
    await shot("desk-search");
    await key("Escape");

    // The rocket, top of the column the theme button opens, over the desk: a
    // burst of stills while it plays, and panel 3 sending halfway through.
    await move(26, 836); await move(26, 760); await move(26, 700);
    await click(26, 656);
    await sleep(2000);
    mkdirSync(join(OUT, "rocket"), { recursive: true });
    const id = execFileSync(PY, [join(HERE, "xdo.py"), "find"], { env, encoding: "utf8" }).split(" ")[0];
    for (let i = 1; i <= 24; i++) {
      if (i === 15) await sendFromPanel("review");
      execFileSync(PY, [join(HERE, "xdo.py"), "--no-focus", "key", "space"], { env });
      execFileSync("import", ["-window", id, join(OUT, "rocket", `r${String(i).padStart(2, "0")}.png`)], { env, stdio: "ignore" });
    }
    console.log("  rocket/r01..r24.png");
  } finally {
    down();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
