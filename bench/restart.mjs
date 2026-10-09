/* A restart that costs nothing, read rather than trusted.
 *
 * `snyvi restart` used to kill every panel with no warning, and a panel that
 * had been running Claude came back as a shell. Now the daemon waits until
 * no panel has an agent mid-turn or a program still printing, marks the
 * panels an agent was in, hands off to a new process, and the window brings
 * those panels back with `claude --resume`. This runs the whole of that on a
 * daemon of its own -- a throwaway HOME, data and config directories, a port
 * nothing else uses -- and never the daemon on 7777.
 *
 *   node bench/restart.mjs                report, and exit non-zero on a fault
 *   node bench/restart.mjs --keep         leave the temp directory behind
 *   node bench/restart.mjs --no-browser   the daemon's half only
 *
 * The rows: a restart asked for while one panel's agent is `working` and
 * another has just printed waits on both; the quiet window passing leaves
 * only the agent; the agent's turn ending lets the restart through, and a
 * new process answers with the same version; the desks' list says the Claude
 * panel resumes and the shell does not; a page that opens on the desk asks
 * for exactly that, and `snyvi restart --now` skips the wait. Since 1.7.1: a
 * panel waiting on its reader's approval holds a restart as a turn does; the
 * marks wait for someone to look, however long that takes; and a restart
 * waiting for quiet can be called off. Nothing here is a clock:
 * `SNYVI_QUIET_S` shortens the quiet window to two seconds for the daemon
 * under test, and `SNYVI_RESUME_S` the marks' window once looked at, so the
 * rows read state, not timing.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, basename } from "node:path";
import { launch, killTree, pageLoad, sleep, tab, chromePath } from "./chrome.mjs";

const args = process.argv.slice(2);
const KEEP = args.includes("--keep");
const NO_BROWSER = args.includes("--no-browser");
const BIN_SRC = resolve(flag("--bin") || "./target/release/snyvi");
const PORT = flag("--port") || "7816";   // 7797 is ui.mjs, 7796 browser.mjs; see the list in ui.mjs
const QUIET_S = 2;
const RESUME_S = 5;

function flag(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}

const rows = [];
const row = (name, ok, detail) => { rows.push([name, ok, detail]); console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`); };
const until = async (f, tries = 60, every = 250) => { for (let i = 0; i < tries; i++) { const v = await f(); if (v) return v; await sleep(every); } return null; };

async function main() {
  const tmp = mkdtempSync(join(tmpdir(), "snyvi-restart-"));
  const home = join(tmp, "home");
  mkdirSync(home);
  const bin = join(tmp, "bin");
  mkdirSync(bin);
  const BIN = join(bin, basename(BIN_SRC));
  copyFileSync(BIN_SRC, BIN);
  const env = {
    ...process.env, HOME: home, SNYVI_DATA_DIR: join(tmp, "data"), SNYVI_CONFIG_DIR: join(tmp, "config"), SNYVI_PORT: PORT,
    SNYVI_QUIET_S: String(QUIET_S), SNYVI_RESUME_S: String(RESUME_S), SNYVI_NOTIFY: "0",
    // A copy outside target/ is a tarball install, which checks GitHub for
    // updates; not this one. bench/update.mjs is where that is read.
    SNYVI_UPDATES: "off",
  };
  for (const k of ["SNYVI_SESSION", "SNYVI_DESK", "SNYVI_SLOT", "SNYVI_UI_DIR"]) delete env[k];
  const base = `http://127.0.0.1:${PORT}`;
  const cli = (...a) => execFileSync(BIN, a, { env, cwd: tmp, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  let chromeProc = null;
  try {
    // The daemon comes up the way it always does: on the first send.
    const md = join(tmp, "plan.md");
    writeFileSync(md, "# A plan\n\nOne paragraph.\n");
    cli("send", md);
    const token = readFileSync(join(tmp, "config", "token"), "utf8").trim();
    // What restarts the daemon answers to the window secret, not the token.
    const windowSecret = readFileSync(join(tmp, "config", "window"), "utf8").trim();
    const T = { authorization: `Bearer ${token}`, "x-snyvi-window": windowSecret, "content-type": "application/json" };
    const health = async () => { try { return await (await fetch(`${base}/api/health`)).json(); } catch { return null; } };
    const postT = async (path, body = {}) => { const r = await fetch(base + path, { method: "POST", headers: T, body: JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
    const h0 = await health();
    if (!h0) throw new Error("no daemon came up");

    // A desk with two panels, through the window's capability: one about to
    // be Claude, one a shell. Both are started, so both have just printed.
    const cap = (await postT("/api/capability")).json.capability;
    const C = { "x-snyvi-capability": cap, "content-type": "application/json" };
    const postC = async (path, body = {}) => (await fetch(base + path, { method: "POST", headers: C, body: JSON.stringify(body) })).json().catch(() => ({}));
    const desks = async () => (await (await fetch(`${base}/api/desks`, { headers: C })).json()).desks;
    const made = await postC("/api/desks", { name: "restart" });
    const desk = made.desk ? made.desk.id : made.id;
    const claude = (await postC(`/api/desks/${desk}/panes`)).pane.id;
    const shell = (await postC(`/api/desks/${desk}/panes`)).pane.id;
    await postC(`/api/panes/${claude}/start`, { cmd: "sleep 300" });
    await postC(`/api/panes/${shell}/start`, { cmd: "sleep 300" });
    const session = "0f6c1c2e-8a41-4b7e-9d3a-5e2f1b7c9a10";
    await postT(`/api/panes/${claude}/agent`, { state: "working", session });

    // Asked for now: both panels have just printed, so both hold it back.
    const asked = await postT("/api/restart", { when: "idle" });
    const both = [claude, shell].sort();
    row("a restart asked for waits on every busy panel", asked.status === 200 && JSON.stringify(asked.json.waiting_on) === JSON.stringify(both),
      asked.status !== 200 ? `POST /api/restart answered ${asked.status}` : `waiting on ${asked.json.waiting_on.length} of 2`);
    // 1.8: and names them, the way the update card says who it waits on.
    const who = (asked.json && asked.json.waiting) || [];
    const wc = who.find(x => x.pane === claude);
    row("and says who, by desk and panel", who.length === 2 && !!wc && wc.slot >= 1 && typeof wc.desk === "string" && wc.agent === "working",
      JSON.stringify(who.map(x => `${x.desk} · panel ${x.slot} · ${x.agent || "printing"}`)));
    // The quiet window passes: the shell is quiet, the agent is still
    // mid-turn, and the daemon is the same process.
    await sleep((QUIET_S + 1) * 1000);
    const h1 = await health();
    const only = h1 && h1.restart && h1.restart.pending && JSON.stringify(h1.restart.waiting_on) === JSON.stringify([claude]);
    row("a panel at its prompt is quiet; an agent mid-turn is not", !!only && h1.pid === h0.pid,
      !h1 ? "no health" : !h1.restart ? "health says no restart is pending" : `waiting on ${JSON.stringify(h1.restart.waiting_on)}, pid ${h1.pid === h0.pid ? "unchanged" : "changed"}`);

    // The turn stops on an approval: a restart now would take the question
    // away unanswered, so it still waits, however long the reader takes.
    await postT(`/api/panes/${claude}/agent`, { state: "needs_you", session });
    await sleep((QUIET_S + 1) * 1000);
    const hq = await health();
    const held = hq && hq.restart && hq.restart.pending && JSON.stringify(hq.restart.waiting_on) === JSON.stringify([claude]) && hq.pid === h0.pid;
    row("a panel waiting on an approval holds the restart", !!held,
      !hq ? "no health" : !hq.restart ? "the restart went, or was dropped" : `waiting on ${JSON.stringify(hq.restart.waiting_on)}`);

    // The turn ends. The daemon goes, on purpose, and another answers.
    await postT(`/api/panes/${claude}/agent`, { state: "done", session });
    const h2 = await until(async () => { const h = await health(); return h && h.pid !== h0.pid ? h : null; }, 80);
    row("the turn ending lets the restart through", !!h2 && h2.version === h0.version && h2.restart == null && h2.panes === 0,
      !h2 ? "no new process answered in 20 s" : `pid ${h0.pid} → ${h2.pid}, ${h2.version}, ${h2.panes} panes running, restart ${JSON.stringify(h2.restart)}`);
    if (!h2) return;

    // What the new daemon says of the two panels, before any page has asked.
    const list = (await desks()).find(d => d.id === desk);
    const st = id => (list.panes.find(p => p.id === id) || {}).status || {};
    row("the desks' list says which panel comes back as a conversation", st(claude).resume === true && st(shell).resume === false && !st(claude).running && !st(shell).running,
      `claude: resume ${st(claude).resume}, running ${st(claude).running}; shell: resume ${st(shell).resume}, running ${st(shell).running}`);

    // Nobody looks for longer than the marks last once looked at: an update
    // applied while the window was away. The clock has not started, so the
    // conversation is still coming back.
    await sleep((RESUME_S + 2) * 1000);
    const late = (await desks()).find(d => d.id === desk);
    const lst = (late.panes.find(p => p.id === claude) || {}).status || {};
    row("the marks wait for someone to look", lst.resume === true && !lst.offer,
      `after ${RESUME_S + 2} s with no desk shown: resume ${lst.resume}, offer ${!!lst.offer}`);

    // A page opens on the desk and brings the panels back: the shell as the
    // shell, the other as `claude --resume <id>`. Whether claude is on this
    // machine does not matter -- the command the pane was started with is
    // what is read, and a missing claude only ends it at once.
    let chrome = null;
    try { chrome = NO_BROWSER ? null : chromePath(); } catch { chrome = null; }
    if (chrome) {
      const browser = await launch(join(tmp, "chrome"));
      chromeProc = browser.proc;
      const { sessionId } = await tab(browser.cdp);
      const url = `${base}/desk/${desk}#cap=${cap}`;
      const loaded = pageLoad(browser.cdp, sessionId, url);
      await browser.cdp.send("Page.navigate", { url }, sessionId);
      await loaded;
      const back = await until(async () => {
        const d = (await desks()).find(x => x.id === desk);
        const s = id => (d.panes.find(p => p.id === id) || {}).status || {};
        const ok = s(claude).cmd === `claude --resume ${session}` && s(shell).cmd === "sleep 300" && s(shell).running;
        return ok ? { claude: s(claude), shell: s(shell) } : null;
      }, 60);
      row("a page on the desk resumes the conversation and restarts the shell", !!back,
        back ? `claude: ${JSON.stringify(back.claude.cmd)}; shell: ${JSON.stringify(back.shell.cmd)}, running` : "the panels did not come back as expected within 15 s");
      const after = (await desks()).find(x => x.id === desk);
      const gone = after.panes.every(p => !(p.status || {}).resume);
      row("and the marks are spent", gone, gone ? "no panel says resume any more" : "a panel still says resume after its start");
    } else {
      row("a page on the desk resumes the conversation", true, "skipped: no Chromium here (--no-browser, or none installed)");
    }

    // `snyvi restart --now` does not wait: the shell is running again and
    // has just printed, and the restart goes anyway.
    const h3 = await health();
    let out = "";
    const t0 = Date.now();
    try { out = cli("restart", "--now"); } catch (e) { out = `exit ${e.status}: ${e.stderr}`; }
    // Asked more than once: the first request after a restart can go out on
    // a kept-alive connection to the process that has just left.
    const h4 = await until(async () => { const h = await health(); return h && h.pid !== h3.pid ? h : null; }, 20);
    const took = Date.now() - t0;
    row("snyvi restart --now skips the wait", !!h4 && h4.pid !== h3.pid && /running on/.test(out), `${out.trim().split("\n").pop()}; pid ${h3 && h3.pid} → ${h4 && h4.pid}`);
    // The strip over the page says "back in a moment": a restart is that, a
    // few seconds from the ask to the new process answering, not a minute.
    row("a restart is back in a moment", !!h4 && took < 5000, `${(took / 1000).toFixed(1)} s from the ask to the new daemon answering`);

    // 1.7.1: a shell that moved comes back where it moved to, and a stop
    // nobody planned -- `snyvi stop`, a signal, a reboot -- offers the Claude
    // panels' conversations back rather than starting them.
    const root = (await desks()).find(x => x.id === desk).root;
    const moved = join(root, "moved-here");
    mkdirSync(moved, { recursive: true });
    const wander = (await postC(`/api/desks/${desk}/panes`)).pane.id;
    await postC(`/api/panes/${wander}/start`, { cmd: `cd '${moved}' && exec sleep 300` });
    await postT(`/api/panes/${wander}/agent`, { state: "working", session });
    const followed = await until(async () => { const d = (await desks()).find(x => x.id === desk); const s = (d.panes.find(p => p.id === wander) || {}).status || {}; return s.cwd === moved ? s : null; }, 40);
    row("a shell's folder is followed as it moves", !!followed, followed ? `status says ${followed.cwd}` : "the status never named the folder it moved to");

    // A restart waiting on the working panel is called off, by the route
    // the pill's Cancel and Ctrl-C use; the turn ending then restarts
    // nothing, and `--cancel` finds nothing left to call off.
    const hc = await health();
    const pend = await postT("/api/restart", { when: "idle" });
    const del = await fetch(`${base}/api/restart`, { method: "DELETE", headers: T }).then(r => r.json()).catch(() => ({}));
    await postT(`/api/panes/${wander}/agent`, { state: "done", session });
    await sleep((QUIET_S + 2) * 1000);
    const hd = await health();
    let said = "";
    try { said = cli("restart", "--cancel"); } catch (e) { said = `exit ${e.status}: ${e.stderr}`; }
    row("a restart waiting for quiet can be called off", pend.status === 200 && del.cancelled === true && !!hd && hd.pid === hc.pid && hd.restart == null && /no restart was waiting/.test(said),
      `asked ${pend.status}, cancelled ${del.cancelled}, pid ${hc && hc.pid} → ${hd && hd.pid}, then: ${said.trim()}`);
    const h5 = await health();
    try { cli("stop"); } catch {}
    await until(async () => !(await health()), 40);
    cli("send", md);
    const h6 = await until(health, 40);
    const offered = (await desks()).find(x => x.id === desk);
    const w = offered && offered.panes.find(p => p.id === wander);
    const ws = (w && w.status) || {};
    row("an unplanned stop offers the conversation, in the folder the shell was in", !!h6 && h6.pid !== (h5 && h5.pid) && !!w && w.cwd === moved && ws.offer === true && !ws.resume,
      !h6 ? "no daemon came back" : !w ? "the panel is gone" : `cwd ${w.cwd}, offer ${ws.offer}, resume ${ws.resume}`);
    if (chrome && w) {
      const browser2 = await launch(join(tmp, "chrome2"));
      const { sessionId: s2 } = await tab(browser2.cdp);
      const url2 = `${base}/desk/${desk}#cap=${cap}`;
      const loaded2 = pageLoad(browser2.cdp, s2, url2);
      await browser2.cdp.send("Page.navigate", { url: url2 }, s2);
      await loaded2;
      const ev = async expr => (await browser2.cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true }, s2)).result.value;
      const strip = await until(() => ev(`!!document.querySelector('.pn[data-id="${wander}"] .pn-offer:not([hidden])')`), 60);
      const paneNow = ((((await desks()).find(x => x.id === desk) || {}).panes || []).find(p => p.id === wander) || {});
      const cmdNow = paneNow.status?.cmd ?? "?";
      // #108: it comes back as the shell -- not its command run again, whose
      // `claude` would be a new conversation over the one on offer -- and
      // keeps that command for Start.
      row("an offered panel comes back as its shell and keeps its command", cmdNow === "" && /exec sleep 300/.test(paneNow.cmd || ""),
        `started ${JSON.stringify(cmdNow)}, Start keeps ${JSON.stringify(paneNow.cmd)}`);
      // Its button does something to see: the resume goes in and the strip
      // with it, or the strip stays and says why where the click was.
      await sleep(1500);
      await ev(`document.querySelector('.pn[data-id="${wander}"] [data-offer="go"]')?.click(); 1`);
      const went = await until(() => ev(`(() => { const o = document.querySelector('.pn[data-id="${wander}"] .pn-offer'); return o && (o.hidden ? "went" : o.querySelector("span.why") ? o.querySelector("span").textContent : ""); })()`), 20);
      let away = went === "went";
      if (went && !away) {
        await ev(`document.querySelector('.pn[data-id="${wander}"] [data-offer="x"]')?.click(); 1`);
        away = await until(() => ev(`!!document.querySelector('.pn[data-id="${wander}"] .pn-offer[hidden]')`), 20);
      }
      row("the strip offers it, and its Resume is answered where it was clicked", !!strip && !!went && !!away,
        !strip ? "no strip on the panel" : !went ? "Resume did nothing to see" : went === "went" ? "the resume went in, the strip with it" : !away ? `said "${went}", then ✕ did not put it away` : `said "${went}" in the strip, ✕ put it away`);
      killTree(browser2.proc);
    }
  } finally {
    if (chromeProc) killTree(chromeProc);
    try { cli("stop"); } catch {}
    if (KEEP) console.log(`kept ${tmp}`);
    else rmSync(tmp, { recursive: true, force: true });
  }
}

main().then(() => {
  const failed = rows.filter(r => !r[1]).length;
  console.log(failed ? `\n${failed} of ${rows.length} rows failed` : `\nall ${rows.length} rows hold`);
  process.exit(failed ? 1 : 0);
}, e => { console.error(e); process.exit(1); });
