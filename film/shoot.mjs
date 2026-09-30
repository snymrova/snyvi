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
// theme until a reader picks one, and `open` below has the system say dark.
// `--light` for the paper version.
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
/** The window's scale: 1 for the film's frames, 2 for the README's stills,
 *  which are the same window drawn at twice the pixels. Every coordinate in
 *  this file is in the window's own (1280x860) points. */
let K = 1;
async function click(x, y) {
  execFileSync(PY, [join(HERE, "xdo.py"), "--no-focus", "click", `${x * K},${y * K}`], { env, stdio: "inherit" });
  await sleep(500);
}

async function shot(name, dir = OUT) {
  const id = execFileSync(PY, [join(HERE, "xdo.py"), "find"], { env, encoding: "utf8" }).split(" ")[0];
  execFileSync("import", ["-window", id, join(dir, `${name}.png`)], { env, stdio: "ignore" });
  console.log(`  ${name}.png`);
}

const token = () => readFileSync(join(tmp, "config", "token"), "utf8").trim();
const post = async (path, body, extra = {}) => {
  const r = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token()}`, ...extra }, body: JSON.stringify(body ?? {}) });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return r.status === 204 ? null : r.json();
};

/** The display, the bus and the window, none of them the desktop's. */
async function world() {
  const children = [];
  // Room for the window at twice its size, for the README's stills.
  const x = spawn("Xvfb", [DISPLAY, "-screen", "0", "2800x1900x24", "-nolisten", "tcp"], { stdio: "ignore" });
  children.push(x);
  await sleep(1500);
  const bus = execFileSync("dbus-daemon", ["--session", "--fork", "--print-address=1", "--print-pid=1", "--nopidfile"], { encoding: "utf8" }).trim().split("\n");
  env.DBUS_SESSION_BUS_ADDRESS = bus[0];
  const busPid = +bus[1];
  // Beside the stage's binary, so `snyvi app` finds this build's window and
  // not whichever one is installed.
  const app = join(tmp, "bin", "snyvi-app");
  if (!existsSync(app)) copyFileSync(resolve(HERE, "..", "target", "release", "snyvi-app"), app);
  let win = null;
  /** The window, opened afresh: in a theme (the system's side, which snyvi
   *  follows until a reader picks one) and at a scale. The panels and their
   *  sessions are the daemon's, so they are there again as they were. */
  async function open({ theme = args.includes("--light") ? "light" : "dark", scale = 1 } = {}) {
    if (win) { win.kill(); await sleep(1500); }
    if (theme === "dark") env.GTK_THEME = "Adwaita:dark"; else delete env.GTK_THEME;
    if (scale === 1) delete env.GDK_SCALE; else env.GDK_SCALE = String(scale);
    K = scale;
    const { capability } = await post("/api/capability");
    win = spawn(app, [`${base}/?window=1#cap=${capability}`], { env, stdio: "ignore", cwd: tmpdir() });
    for (let i = 0; i < 60; i++) {
      try { execFileSync(PY, [join(HERE, "xdo.py"), "find"], { env, stdio: "ignore" }); break; } catch { await sleep(500); }
    }
    await sleep(3000);
  }
  await open();
  return { open, down: () => { win?.kill(); for (const c of children.reverse()) c.kill(); try { process.kill(busPid); } catch {} } };
}

async function move(x, y) { execFileSync(PY, [join(HERE, "xdo.py"), "--no-focus", "move", `${x * K},${y * K}`], { env }); }
/** The pointer out of the way, and any tooltip it left behind taken down. */
async function still(x = 640, y = 845) { await move(x, y); execFileSync(PY, [join(HERE, "xdo.py"), "--no-focus", "untip"], { env }); await sleep(300); }

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
    "Read src/limit.rs and docs/rate-limiting.md and say what changes for Free, Team and Enterprise keys",
  ],
  gateway: [
    "Review docs/gateway-design.md against src/ingest.ts and list where they conflict",
    "What happens to src/ingest.ts in a replay storm? Walk through it",
  ],
};
// The desk rail, in window pixels: rows of Documents, and the notes under them.
// An open document's row wraps to two lines and lays its tools over its end:
// copy, ← back to the desk, ✕ off the desk. ← is the middle one.
const RAIL = { row: n => [1140, 286 + 26 * n], back: n => [1223, 295 + 26 * n], note: y => [1072, y] };

/** `--no-agents`: the panels stay shells, for checking where every click
 *  lands without spending a turn of anyone's Claude. */
const AGENTS = !args.includes("--no-agents");

/** Each panel of a desk restarted on its question, the way a panel's Start
 *  runs a program: stopped, then started with `claude "…"` as its command.
 *  Typing it at the window was the first way, and it raced: a click on the
 *  next panel landed while the last was still taking keys, and half a
 *  question went to the wrong one. */
async function ask(deskIdx, name) {
  await go(`/desk/${desks[deskIdx]}`);
  const cap = (await post("/api/capability")).capability;
  const page = { "x-snyvi-capability": cap, origin: base };
  for (const [n, q] of ASK[name].entries()) {
    const id = panes[name][n];
    await post(`/api/panes/${id}/stop`, {}, page);
    await sleep(600);
    await post(`/api/panes/${id}/start`, { cmd: AGENTS ? `claude "${q}"` : "", cols: 100, rows: 30 }, page);
  }
  await sleep(1500);
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const { open, down } = await world();
  try {
    console.log(`frames: ${OUT}`);
    await key("Escape", { focus: true });

    // Real sessions, asked once, and left to finish: a panel that has answered
    // shows the work, and past a screenful Claude Code's banner -- version,
    // model, plan -- has scrolled off.
    await ask(0, "ledger");
    await ask(1, "gateway");
    await sleep(Number(process.env.SNYVI_FILM_WORK_MS || (AGENTS ? 90000 : 3000)));
    await post("/api/queue/clear");

    // Home: every desk, where each was left, what is still open on it -- with
    // the ledger, looked at last, offered to pick up.
    await go(`/desk/${desks[0]}`);
    await go("/");
    await still(1150, 845);   // Home's right column, empty: over the list a pointer raises a tip
    await shot("home");

    // Which agents are connected: the six sessions above, and the others
    // registered in this home.
    await go("/connect");
    await still();
    await shot("connect-dark");

    // The poster: the desk, four agents, what they sent, what it still owes.
    await go(`/desk/${desks[0]}`);
    await still();
    await shot("desk");

    // Room to focus: the sidebar folded to its strip, the rail put away, and
    // panel 1 given the whole window -- then all of it put back, so every
    // frame after this one is the desk as it was.
    await click(238, 28);          // the sidebar's Hide
    await sleep(900);
    await still();
    await shot("focus-side");
    await click(1070, 28);         // the rail's Hide
    await sleep(900);
    await still();
    await shot("focus-rail");
    await click(612, 64);          // panel 1's full view, in its head
    await sleep(1400);
    await still();
    await shot("focus-full");
    await click(1218, 64);         // back to the grid
    await sleep(900);
    await click(1154, 28);         // the rail, from its button in the window's head
    await sleep(700);
    await click(22, 66);           // the sidebar, from the top of its strip
    await sleep(900);

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

    // Against the version before it. The letters sleep until ⌃B wakes them,
    // as they do for a reader, and go back to sleep after.
    await click(640, 420);
    await key("ctrl+b");
    await key("c");
    await sleep(1500);
    await still();
    await shot("desk-diff");
    await key("c");
    await key("ctrl+b");

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

    // The README's stills: the same library, the window reopened at twice the
    // pixels, once on each side of the system theme. Photographed, not
    // clicked through -- the notes were ticked above, and a second click would
    // untick one -- except the plan, opened over the desk and closed again.
    if (!args.includes("--no-stills")) {
      const dir = join(OUT, "stills");
      mkdirSync(dir, { recursive: true });
      // Panel 3's review, sent during the game, is read: no banner over the
      // stills, and it sits at the top of the rail, so the plan is row 2.
      await post("/api/queue/clear");
      for (const theme of ["dark", "light"]) {
        await open({ theme, scale: 2 });
        await key("Escape", { focus: true });
        await go("/");
        await still(1150, 845);
        await shot(`home-${theme}`, dir);
        await go(`/desk/${desks[0]}`);
        await still();
        await shot(`desk-${theme}`, dir);
        await click(...RAIL.row(2));
        await sleep(2000);
        await still();
        await shot(`over-${theme}`, dir);
        await click(...RAIL.back(2));
        await sleep(1500);
        // Room to focus: sidebar and rail folded, panel 1 in full view, and
        // all of it put back after.
        await go(`/desk/${desks[0]}`);
        await click(238, 28);
        await sleep(900);
        await click(1070, 28);
        await sleep(900);
        await click(612, 64);
        await sleep(1400);
        await still();
        await shot(`focus-${theme}`, dir);
        await click(1218, 64);
        await sleep(900);
        await click(1154, 28);
        await sleep(700);
        await click(22, 66);
        await sleep(900);
        await go(`/desk/${desks[1]}`);
        await still();
        await shot(`switch-${theme}`, dir);
      }
    }
  } finally {
    down();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
