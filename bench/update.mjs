/* The daemon updates itself, read rather than trusted.
 *
 * A release of its own: a key pair made for this run (bench/minisign.mjs),
 * a manifest signed with it, and a tarball of the binary just built, served
 * from a port beside a daemon on another. The daemon is pointed at that
 * port (`SNYVI_UPDATE_URL`, `SNYVI_UPDATE_KEY`) and told to check every two
 * seconds (`SNYVI_UPDATE_EVERY_S`); nothing here reaches GitHub, and never
 * the daemon on 7777. Each "new version" is the same binary with a few
 * bytes appended, which an ELF loader ignores and a sha256 does not: the
 * rows read which file is at the path, not which number it prints.
 *
 *   node bench/update.mjs               report, and exit non-zero on a fault
 *   node bench/update.mjs --keep        leave the temp directory behind
 *   node bench/update.mjs --no-browser  the daemon's half only
 *
 * The rows: a newer release is staged and verified; with nobody here it is
 * applied at once, the old file kept beside it; the next release waits
 * behind the daily floor; a hotfix skips it; a working agent holds it back
 * and its turn ending lets it through; `--back` puts the previous version
 * back; a build that will not start is rolled back and said to have failed;
 * `snyvi update check` exits 10; `snyvi update` ignores the floor; `off`
 * means no check at all; an unchanged manifest costs a 304; a build under
 * `target/` never checks; and, with a page in front, the pill appears and
 * a click on it restarts onto the staged version. Since 1.7.1: a download
 * that failed is tried again rather than stalled behind a 304, an agent
 * waiting on an approval holds an update back as a turn does, and a window
 * too old to say its number is asked to quit and started again, once.
 * Linux only: appending to a Mach-O breaks its signature, and the release
 * legs prove the others.
 */

import { execFile, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, basename } from "node:path";
import { launch, killTree, pageLoad, sleep, tab, chromePath, evaluate } from "./chrome.mjs";
import { keypair, sha256, signFile } from "./minisign.mjs";

const args = process.argv.slice(2);
const KEEP = args.includes("--keep");
const NO_BROWSER = args.includes("--no-browser");
const BIN_SRC = resolve(flag("--bin") || "./target/release/snyvi");
const PORT = flag("--port") || "7817";   // 7816 is restart.mjs; see the list in ui/ui.mjs
const DEV_PORT = String(Number(PORT) + 2);
const GH_PORT = String(Number(PORT) + 1);
const MANIFEST_PY = resolve(new URL("../packaging/manifest.py", import.meta.url).pathname);
const EVERY_S = 2;

function flag(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}

const rows = [];
const row = (name, ok, detail) => { rows.push([name, ok, detail]); console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`); };
const until = async (f, tries = 60, every = 250) => { for (let i = 0; i < tries; i++) { const v = await f(); if (v) return v; await sleep(every); } return null; };

if (process.platform !== "linux") {
  console.log("update.mjs: Linux only (the release legs prove the other platforms' swaps); nothing to do here");
  process.exit(0);
}

/* The release server: a map of files, ETags, a count of what was asked
 * for and how it was answered. */
const files = new Map();
const served = { manifest: 0, notModified: 0, downloads: 0 };
const gh = createServer((req, res) => {
  const name = decodeURIComponent(req.url.slice(1));
  const body = files.get(name);
  if (!body) { res.writeHead(404); res.end("no such file"); return; }
  const etag = `"${sha256(body).slice(0, 16)}"`;
  if (name === "latest.json") served.manifest++;
  if (req.headers["if-none-match"] === etag) { served.notModified++; res.writeHead(304, { etag }); res.end(); return; }
  if (name.endsWith(".tar.gz")) served.downloads++;
  res.writeHead(200, { "content-type": "application/octet-stream", "content-length": body.length, etag });
  res.end(body);
});

async function main() {
  const tmp = mkdtempSync(join(tmpdir(), "snyvi-update-"));
  const home = join(tmp, "home");
  mkdirSync(home);
  const bin = join(tmp, "bin");
  mkdirSync(bin);
  const BIN = join(bin, basename(BIN_SRC));
  copyFileSync(BIN_SRC, BIN);
  const original = readFileSync(BIN);
  const key = keypair();
  await new Promise(r => gh.listen(Number(GH_PORT), "127.0.0.1", r));
  const env = {
    ...process.env, HOME: home, SNYVI_DATA_DIR: join(tmp, "data"), SNYVI_CONFIG_DIR: join(tmp, "config"), SNYVI_PORT: PORT,
    SNYVI_QUIET_S: "2", SNYVI_NOTIFY: "0",
    // What `snyvi app` looks for before it starts a window; the window here
    // is a script that writes down how it was started, and nothing is drawn.
    DISPLAY: process.env.DISPLAY || ":0",
    SNYVI_UPDATE_URL: `http://127.0.0.1:${GH_PORT}/`, SNYVI_UPDATE_KEY: key.b64, SNYVI_UPDATE_EVERY_S: String(EVERY_S),
  };
  for (const k of ["SNYVI_SESSION", "SNYVI_DESK", "SNYVI_SLOT", "SNYVI_UI_DIR", "SNYVI_UPDATES"]) delete env[k];
  const base = `http://127.0.0.1:${PORT}`;
  // Asynchronous, not execFileSync: the release server lives in this
  // process, and a CLI command that makes the daemon read the manifest would
  // otherwise wait on a server whose event loop it is itself blocking.
  const cli = (...a) => new Promise((ok, no) => execFile(BIN, a, { env, cwd: tmp, encoding: "utf8" }, (err, stdout, stderr) =>
    err ? no(Object.assign(err, { status: typeof err.code === "number" ? err.code : 1, stdout, stderr })) : ok(stdout)));
  const asset = `snyvi-linux-${process.arch}.tar.gz`;
  /* One release: the tarball the release job would write, the manifest
   * packaging/manifest.py writes for it -- the real script, so the daemon
   * parses what a release publishes and not a hand-made copy of it -- and
   * the signature. manifest.py wants a checksum for every download a
   * release carries; the ones this bench does not serve get a made-up
   * one, as ci.yml's check of the script does. `bytes` is what `snyvi` in
   * the tarball is, and `app` what `snyvi-app` is, when the release is to
   * carry a window. */
  const appAsset = `snyvi-app-linux-${process.arch}.tar.gz`;
  const release = (version, bytes, { hotfix = null, appMin = "1.0.0", app = null } = {}) => {
    const dir = join(tmp, "rel", version);
    const tar = (name, what, into) => {
      const top = `${name}-${version}-x86_64-unknown-linux-musl`;
      mkdirSync(join(dir, top), { recursive: true });
      writeFileSync(join(dir, top, name), what, { mode: 0o755 });
      execFileSync("tar", ["-C", dir, "-czf", join(dir, into), top]);
      return readFileSync(join(dir, into));
    };
    const tarball = tar("snyvi", bytes, asset);
    const appTarball = app ? tar("snyvi-app", app, appAsset) : null;
    const sums = join(dir, "sums");
    mkdirSync(sums, { recursive: true });
    for (const name of execFileSync(MANIFEST_PY, ["--names"], { encoding: "utf8" }).split("\n").filter(Boolean)) {
      const hash = name === asset ? sha256(tarball) : name === appAsset && appTarball ? sha256(appTarball) : sha256(Buffer.from(name));
      writeFileSync(join(sums, `${name}.sha256`), `${hash}  ${name}\n`);
    }
    const out = join(dir, "latest.json");
    execFileSync(MANIFEST_PY, [version, sums, "--out", out, "--app-min", appMin, "--hotfix-below", hotfix || ""],
      { stdio: ["ignore", "ignore", "inherit"] });
    const manifest = readFileSync(out, "utf8");
    files.set(asset, tarball);
    if (appTarball) files.set(appAsset, appTarball);
    files.set("latest.json", Buffer.from(manifest));
    files.set("latest.json.minisig", Buffer.from(signFile(key, manifest, `snyvi ${version}`)));
    files.set(`v${version}/latest.json`, Buffer.from(manifest));
    files.set(`v${version}/latest.json.minisig`, Buffer.from(signFile(key, manifest, `snyvi ${version}`)));
    return { version, sha: sha256(bytes) };
  };
  const stamped = v => Buffer.concat([original, Buffer.from(`\n#snyvi-bench ${v}\n`)]);
  const onDisk = () => sha256(readFileSync(BIN));
  let chromeProc = null;
  let devPid = null;
  try {
    const md = join(tmp, "plan.md");
    writeFileSync(md, "# A plan\n\nOne paragraph.\n");
    await cli("send", md);
    const token = readFileSync(join(tmp, "config", "token"), "utf8").trim();
    // What restarts or updates the daemon answers to the window secret, not the token.
    const windowSecret = readFileSync(join(tmp, "config", "window"), "utf8").trim();
    const T = { authorization: `Bearer ${token}`, "x-snyvi-window": windowSecret, "content-type": "application/json" };
    // Asked twice before giving up: the first request after a restart can
    // go out on a kept-alive connection to the process that has just left.
    const health = async () => { for (let i = 0; i < 2; i++) { try { return await (await fetch(`${base}/api/health`)).json(); } catch {} } return null; };
    const postT = async (path, body = {}) => { const r = await fetch(base + path, { method: "POST", headers: T, body: JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
    const h0 = await health();
    if (!h0) throw new Error("no daemon came up");
    const [maj, min, pat] = h0.version.split(".").map(Number);
    const v = n => `${maj}.${min}.${pat + n}`;
    row("a tarball install is on the tar channel with updates on", h0.update && h0.update.channel === "tar" && h0.update.auto === true,
      h0.update ? `channel ${h0.update.channel}, auto ${h0.update.auto}` : "health has no update block");

    // Release one: staged within a check or two, then -- nobody here, no
    // floor yet on a fresh install -- applied at once.
    const r1 = release(v(1), stamped(v(1)));
    const staged1 = await until(async () => { const h = await health(); return h && h.update.ready === r1.version ? h : (h && h.pid !== h0.pid ? h : null); }, 80);
    const applied1 = await until(async () => { const h = await health(); return h && h.pid !== h0.pid ? h : null; }, 80);
    const prev = join(bin, "snyvi.prev");
    row("a newer release is staged, verified and applied with nobody here", !!applied1 && onDisk() === r1.sha && existsSync(prev) && sha256(readFileSync(prev)) === sha256(original)
      && applied1.update.last_applied != null && applied1.update.ready == null && applied1.update.slot > Date.now() / 1000 + 20 * 3600 && served.downloads >= 1,
      !applied1 ? `no new process in 20 s (${staged1 ? "staged " + staged1.update.ready : "never staged"}; error ${staged1 && staged1.update.error})`
        : `pid ${h0.pid} → ${applied1.pid}; on disk ${onDisk() === r1.sha ? "is" : "is not"} the release; .prev ${existsSync(prev) ? "kept" : "missing"}; slot in ${Math.round((applied1.update.slot - Date.now() / 1000) / 3600)} h`);
    if (!applied1) return;

    // Release two: staged, and held behind the day's floor. Not shown.
    const r2 = release(v(2), stamped(v(2)));
    const staged2 = await until(async () => { const h = await health(); return h && h.update.ready === r2.version ? h : null; }, 40);
    await sleep(EVERY_S * 2000 + 500);
    const h2 = await health();
    row("the next release waits behind the daily floor, unshown", !!staged2 && h2.pid === applied1.pid && h2.update.slot_open === false && h2.update.show === false && onDisk() === r1.sha,
      !staged2 ? "never staged" : `staged ${h2.update.ready}, pid unchanged ${h2.pid === applied1.pid}, slot_open ${h2.update.slot_open}, show ${h2.update.show}`);
    const before304 = served.notModified;
    await sleep(EVERY_S * 2000 + 500);
    row("an unchanged manifest costs a 304", served.notModified > before304, `${served.manifest} manifest reads, ${served.notModified} answered 304`);

    // Release three says every version under it should not wait -- but its
    // download is missing at first. The check fails, and the ones after it
    // read the manifest whole rather than trusting a 304 over a stage that
    // never happened; once the download is there, it goes.
    const r3 = release(v(3), stamped(v(3)), { hotfix: v(3) });
    const tar3 = files.get(asset);
    files.delete(asset);
    const failing = await until(async () => { const h = await health(); return h && h.update.available === r3.version && h.update.error ? h : null; }, 40);
    const reads = served.manifest, bare = served.notModified;
    await sleep(EVERY_S * 2000 + 500);
    row("a download that failed is tried again, not stalled behind a 304", !!failing && failing.update.ready == null && served.manifest > reads && served.notModified === bare,
      !failing ? "the failure was never reported" : `ready ${failing.update.ready}; ${served.manifest - reads} manifest reads since, ${served.notModified - bare} of them 304`);
    files.set(asset, tar3);
    const applied3 = await until(async () => { const h = await health(); return h && h.pid !== applied1.pid ? h : null; }, 80);
    row("a hotfix skips the floor", !!applied3 && onDisk() === r3.sha && sha256(readFileSync(prev)) === r1.sha,
      !applied3 ? "no new process in 20 s" : `pid ${applied1.pid} → ${applied3.pid}; on disk is ${onDisk() === r3.sha ? "the hotfix" : "not the hotfix"}; .prev is ${sha256(readFileSync(prev)) === r1.sha ? "the one before" : "something else"}`);
    if (!applied3) return;

    // A panel whose agent is mid-turn holds the next hotfix back; the turn
    // ending lets it through, and the panel is marked to resume.
    const cap = (await postT("/api/capability")).json.capability;
    const C = { "x-snyvi-capability": cap, "content-type": "application/json" };
    const postC = async (path, body = {}) => (await fetch(base + path, { method: "POST", headers: C, body: JSON.stringify(body) })).json().catch(() => ({}));
    const desks = async () => (await (await fetch(`${base}/api/desks`, { headers: C })).json()).desks;
    const made = await postC("/api/desks", { name: "update" });
    const desk = made.desk ? made.desk.id : made.id;
    const pane = (await postC(`/api/desks/${desk}/panes`)).pane.id;
    await postC(`/api/panes/${pane}/start`, { cmd: "sleep 300" });
    const session = "3b1f7c2e-0d4a-4c9e-8a2b-6e5f1d7c9a44";
    await postT(`/api/panes/${pane}/agent`, { state: "working", session });
    const r4 = release(v(4), stamped(v(4)), { hotfix: v(4) });
    const staged4 = await until(async () => { const h = await health(); return h && h.update.ready === r4.version ? h : null; }, 40);
    await sleep(EVERY_S * 2000 + 2500);
    const held = await health();
    row("a working agent holds an update back", !!staged4 && held.pid === applied3.pid && held.update.show === true,
      !staged4 ? "never staged" : `pid unchanged ${held.pid === applied3.pid}; the pill would show: ${held.update.show}`);
    // The turn stops on an approval: applying now would take the question
    // away unanswered.
    await postT(`/api/panes/${pane}/agent`, { state: "needs_you", session });
    await sleep(EVERY_S * 2000 + 2500);
    const asking = await health();
    row("an agent waiting on an approval holds it back too", !!asking && asking.pid === applied3.pid,
      `pid unchanged ${!!asking && asking.pid === applied3.pid}`);
    await postT(`/api/panes/${pane}/agent`, { state: "done", session });
    const applied4 = await until(async () => { const h = await health(); return h && h.pid !== applied3.pid ? h : null; }, 80);
    const list = applied4 && (await desks()).find(d => d.id === desk);
    const st = list && ((list.panes.find(p => p.id === pane) || {}).status || {});
    row("the turn ending lets it through, and the panel comes back as a conversation", !!applied4 && onDisk() === r4.sha && st && st.resume === true,
      !applied4 ? "no new process in 20 s" : `on disk is ${onDisk() === r4.sha ? "the release" : "not the release"}; panel resume ${st && st.resume}`);
    if (!applied4) return;

    // Back: the version before, and the one left is remembered as skipped --
    // not staged again on its own, and not called a failure.
    let out = "";
    try { out = await cli("update", "--back", "--now"); } catch (e) { out = `exit ${e.status}: ${e.stderr}`; }
    const back = await health();
    await sleep(EVERY_S * 2000 + 500);
    const backStill = await health();
    row("snyvi update --back puts the previous version back, and keeps it", !!back && back.pid !== applied4.pid && onDisk() === r3.sha && back.update.skipped === r4.version
      && !back.update.failed && !existsSync(prev) && backStill.pid === back.pid && backStill.update.ready == null,
      `${out.trim().split("\n").pop()}; on disk is ${onDisk() === r3.sha ? "the one before" : "not the one before"}; skipped ${back && back.update.skipped}; pid held ${backStill.pid === back.pid}`);

    // A build that will not start: the file is placed, the successor never
    // answers, the old file is put back, and health says so.
    const r5 = release(v(5), Buffer.from("#!/bin/sh\nexit 1\n"), { hotfix: v(5) });
    // The old daemon gives its successor 30 s before it decides nothing
    // came up.
    const rolled = await until(async () => { const h = await health(); return h && h.update.failed === r5.version ? h : null; }, 200);
    row("a build that will not start is rolled back and marked failed", !!rolled && onDisk() === r3.sha && rolled.pid !== back.pid,
      !rolled ? "health never said failed in 50 s" : `failed ${rolled.update.failed}; on disk is ${onDisk() === r3.sha ? "the kept version" : "something else"}; pid ${back.pid} → ${rolled.pid}`);
    if (!rolled) return;
    await sleep(EVERY_S * 2000 + 500);
    const still = await health();
    row("and it is not tried again on its own", still.pid === rolled.pid && still.update.ready == null, `pid unchanged ${still.pid === rolled.pid}, ready ${still.update.ready}`);

    // `snyvi update check` says so and exits 10; `snyvi update` goes anyway.
    let code = 0; out = "";
    try { out = await cli("update", "check"); } catch (e) { code = e.status; out = e.stdout + e.stderr; }
    row("snyvi update check exits 10 when a newer version is out", code === 10 && /is out/.test(out), `exit ${code}: ${out.trim().split("\n").pop()}`);
    const r6 = release(v(6), stamped(v(6)));
    try { out = await cli("update", "--now"); } catch (e) { out = `exit ${e.status}: ${e.stderr}`; }
    const asked = await health();
    row("snyvi update applies at once, floor or no floor", !!asked && asked.pid !== rolled.pid && onDisk() === r6.sha && /running on/.test(out),
      `${out.trim().split("\n").pop()}; on disk is ${onDisk() === r6.sha ? "the release" : "not the release"}`);
    if (!asked) return;

    // Off means no check at all.
    try { out = await cli("update", "off"); } catch (e) { out = `exit ${e.status}: ${e.stderr}`; }
    const before = served.manifest;
    release(v(7), stamped(v(7)), { hotfix: v(7) });
    await sleep(EVERY_S * 2000 + 500);
    const off = await health();
    row("snyvi update off means no check, not only no apply", off.update.auto === false && served.manifest === before && off.update.ready == null && off.pid === asked.pid,
      `auto ${off.update.auto}; manifest reads ${served.manifest - before} while off; ${out.trim()}`);

    // With a page in front, the update is not applied on its own: the card
    // in the sidebar says it (and #upd, its line for a screen reader), and
    // its Now restarts onto it. The page opens before the
    // checks resume, so the hotfix above finds someone here.
    let chrome = null;
    try { chrome = NO_BROWSER ? null : chromePath(); } catch { chrome = null; }
    if (chrome) {
      const browser = await launch(join(tmp, "chrome"));
      chromeProc = browser.proc;
      const { sessionId } = await tab(browser.cdp);
      const url = `${base}/#cap=${cap}`;
      const loaded = pageLoad(browser.cdp, sessionId, url);
      await browser.cdp.send("Page.navigate", { url }, sessionId);
      await loaded;
      await cli("update", "on").catch(() => {});
      const pill = await until(async () => {
        const t = await evaluate(browser.cdp, sessionId, `(() => { const e = document.getElementById("upd"); return e && !e.hidden && document.querySelector('#upd-card [data-uc="now"]') ? e.textContent : ""; })()`);
        return t && /is ready/.test(t) ? t : null;
      }, 60);
      const h7 = await health();
      row("with a page in front the card appears and nothing is applied", !!pill && h7.pid === asked.pid && pill.includes(v(7)),
        pill ? `card says ${JSON.stringify(pill)}; pid unchanged ${h7.pid === asked.pid}` : `no card with Now within 15 s (ready ${h7.update.ready}, show ${h7.update.show})`);
      // Behind the card, snyvi at rest, the way it is behind an aside: the
      // peek docs/DESIGN.md §2.2 promised the update card.
      const peek = await evaluate(browser.cdp, sessionId, `(() => { const s = document.querySelector("#upd-card .uc-bg .mk"); return s ? (s.querySelector(".mk-cheek") ? "peek" : "no cheeks") : "none"; })()`);
      row("snyvi peeks from behind the card", peek === "peek", peek === "peek" ? "the 72 px head with its cheeks, at rest" : `found ${peek}`);
      await evaluate(browser.cdp, sessionId, `document.querySelector('#upd-card [data-uc="now"]')?.click()`);
      const clicked = await until(async () => { const h = await health(); return h && h.pid !== asked.pid ? h : null; }, 80);
      row("its Now restarts onto the staged version", !!clicked && onDisk() === sha256(stamped(v(7))),
        clicked ? `pid ${asked.pid} → ${clicked.pid}; on disk is ${onDisk() === sha256(stamped(v(7))) ? "the release" : "not the release"}` : "no new process in 20 s");
      // The page reloads onto the new build, which says what happened once,
      // in a toast.
      // Every release here is this one binary with bytes on the end, so the
      // number it names is the one the new daemon reports, not v(7).
      const landed = await until(async () => {
        const t = await evaluate(browser.cdp, sessionId, `[...document.querySelectorAll("#toasts .toast")].map(t => t.textContent).find(t => /Updated to/.test(t)) || ""`).catch(() => "");
        return t || null;
      }, 80);
      row("the page back on the new build says it was updated", !!landed && !!clicked && landed.includes(clicked.version),
        landed ? `toast says ${JSON.stringify(landed)}` : "no \"Updated to\" toast in 20 s");
    } else {
      await cli("update", "on").catch(() => {});
      row("with a page in front the card appears", true, "skipped: no Chromium here (--no-browser, or none installed)");
    }

    // A window from before 1.7 says `window=1` and no number. After an
    // update, it is asked to quit, and once its stream has ended and stayed
    // ended a moment, started again -- once. The "window" is a script beside
    // the daemon that writes down how it was started, carried by the
    // release as a window would be.
    await until(async () => onDisk() === sha256(stamped(v(7))), 80);
    const appLog = join(tmp, "app.log");
    const fakeApp = tag => Buffer.from(`#!/bin/sh\n# ${tag}\necho "$*" >> '${appLog}'\n`);
    writeFileSync(join(bin, "snyvi-app"), fakeApp("old"), { mode: 0o755 });
    // The daemon looks for a window beside it when it starts.
    const hb = await health();
    await cli("restart", "--now").catch(() => {});
    const hw = await until(async () => { const h = await health(); return h && hb && h.pid !== hb.pid ? h : null; }, 80);
    release(v(8), stamped(v(8)), { app: fakeApp(v(8)), appMin: v(8) });
    try { out = await cli("update", "--now"); } catch (e) { out = `exit ${e.status}: ${e.stderr}`; }
    const hu = await until(async () => { const h = await health(); return h && hw && h.pid !== hw.pid ? h : null; }, 80);
    const logged = () => existsSync(appLog) ? readFileSync(appLog, "utf8") : "";
    const ac = new AbortController();
    fetch(`${base}/api/events?window=1`, { signal: ac.signal }).then(r => r.body.getReader().read()).catch(() => {});
    const quit = await until(async () => /--quit/.test(logged()), 40);
    ac.abort();
    const again = await until(async () => /window=1/.test(logged()) ? logged() : null, 40);
    const quits = (logged().match(/--quit/g) || []).length;
    row("a window too old to say its number is asked to quit and started again, once", !!hu && !!quit && !!again && quits === 1,
      !hu ? `the update did not land: ${out.trim().split("\n").pop()}` : `the window was started with: ${JSON.stringify(logged().trim().split("\n"))}`);

    // A build under target/ never checks, and says so when asked.
    const devDir = join(tmp, "target", "release");
    mkdirSync(devDir, { recursive: true });
    copyFileSync(BIN_SRC, join(devDir, "snyvi"));
    const denv = { ...env, SNYVI_PORT: DEV_PORT, SNYVI_DATA_DIR: join(tmp, "dev-data"), SNYVI_CONFIG_DIR: join(tmp, "dev-config") };
    execFileSync(join(devDir, "snyvi"), ["send", md], { env: denv, cwd: tmp, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const dh = await until(async () => { try { return await (await fetch(`http://127.0.0.1:${DEV_PORT}/api/health`)).json(); } catch { return null; } }, 40);
    devPid = dh && dh.pid;
    const dwindow = readFileSync(join(tmp, "dev-config", "window"), "utf8").trim();
    const dr = dh && await fetch(`http://127.0.0.1:${DEV_PORT}/api/update/check`, { method: "POST", headers: { "x-snyvi-window": dwindow, "content-type": "application/json" }, body: "{}" });
    row("a build under target/ is on the dev channel and refuses to check", !!dh && dh.update.channel === "dev" && dr && dr.status === 409,
      dh ? `channel ${dh.update.channel}; check answered ${dr && dr.status}` : "the dev daemon did not come up");
    try { execFileSync(join(devDir, "snyvi"), ["stop"], { env: denv, stdio: "ignore" }); } catch {}
  } finally {
    if (chromeProc) killTree(chromeProc);
    await cli("stop").catch(() => {});
    if (devPid) { try { process.kill(devPid); } catch {} }
    gh.close();
    if (KEEP) console.log(`kept ${tmp}`);
    else rmSync(tmp, { recursive: true, force: true });
  }
}

main().then(() => {
  const failed = rows.filter(r => !r[1]).length;
  console.log(failed ? `\n${failed} of ${rows.length} rows failed` : `\nall ${rows.length} rows hold`);
  process.exit(failed ? 1 : 0);
}, e => { console.error(e); process.exit(1); });
