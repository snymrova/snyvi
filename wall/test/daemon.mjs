/* The wall, end to end: a built snyvi daemon against this Worker under
 * `wrangler dev --env test`, both local, on spare ports (7801, 8796, 8797).
 * wall.test.mjs drives the Worker with the daemon's vectors; this drives it
 * with the daemon itself: Publish, the check in the repo, Home's read, a
 * heart, Take it down. GitHub's raw files and the relay are this script's
 * own server on 8796. Nothing leaves the machine.
 *
 *   npm run daemon -- ../target/debug/snyvi     (from wall/; `npm install` first)
 */
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
const BIN = resolve(process.argv[2] || "../target/debug/snyvi");
const WALLDIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 7801, WP = 8797, SIDE = 8796;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const tmp = mkdtempSync(join(tmpdir(), "snyvi-wall-e2e-"));
const home = join(tmp, "home"); mkdirSync(home);
const dir = join(tmp, "breeds"); mkdirSync(dir);
writeFileSync(join(dir, "README.md"), "# Breeds of dogs\n\nA field guide, one breed a chapter.\n");
execFileSync("git", ["init", "-q"], { cwd: dir });
execFileSync("git", ["remote", "add", "origin", "https://github.com/bench/breeds.git"], { cwd: dir });
const results = [];
const row = (name, ok, said) => { results.push(ok); console.log(`${ok ? "ok  " : "FAIL"} ${name}  ·  ${said}`); };

const deposits = [];
const side = createServer((req, res) => {
  const chunks = []; req.on("data", c => chunks.push(c));
  req.on("end", () => {
    if (req.url.startsWith("/to/")) { deposits.push(req.url); return res.writeHead(201).end(); }
    const m = /^\/raw\/bench\/breeds\/HEAD\/\.snyvi\/owner$/.exec(req.url);
    const f = join(dir, ".snyvi", "owner");
    if (m && existsSync(f)) return res.writeHead(200).end(readFileSync(f));
    res.writeHead(404).end();
  });
}).listen(SIDE, "127.0.0.1");

const vectors = JSON.parse(readFileSync(join(WALLDIR, "test", "vectors.json"), "utf8"));
const wr = spawn("npx", ["wrangler", "dev", "--env", "test", "--ip", "127.0.0.1", "--port", String(WP), "--inspector-port", "0", "--log-level", "warn", "--var", `WALL_SEED:${vectors.wall_seed}`], { cwd: WALLDIR, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" }, detached: true });
let wout = ""; wr.stdout.on("data", d => wout += d); wr.stderr.on("data", d => wout += d);
const env = { ...process.env, HOME: home, SNYVI_DATA_DIR: join(tmp, "data"), SNYVI_CONFIG_DIR: join(tmp, "config"), SNYVI_PORT: String(PORT), SNYVI_WALL: `http://127.0.0.1:${WP}`, SNYVI_RELAY: `http://127.0.0.1:${SIDE}`, SNYVI_NOTIFY: "0" };
const base = `http://127.0.0.1:${PORT}`, W = `http://127.0.0.1:${WP}`;
try {
  for (let t = Date.now(); ; ) { try { if ((await fetch(`${W}/health`)).ok) break; } catch {} if (Date.now() - t > 60000) throw new Error("wrangler did not come up:\n" + wout); await sleep(250); }
  const rid = execFileSync(BIN, ["browse", dir, "--no-open"], { env, cwd: tmp, encoding: "utf8" }).trim().split("\n").pop().match(/\/b\/([^/?#]+)/)[1];
  const secret = readFileSync(join(tmp, "config", "window"), "utf8").trim();
  const cap = (await (await fetch(`${base}/api/capability`, { method: "POST", headers: { "x-snyvi-window": secret } })).json()).capability;
  const H = { "x-snyvi-capability": cap, "content-type": "application/json" };
  const call = async (path, body) => { const r = await fetch(base + path, body === undefined ? { headers: H } : { method: "POST", headers: H, body: JSON.stringify(body) }); return { status: r.status, j: await r.json().catch(() => ({})) }; };
  const made = (await call("/api/desks", { root: rid, path: "" })).j, desk = made.desk ? made.desk.id : made.id;

  const started = await call(`/api/desks/${desk}/page`, { start: true });
  const slug = started.j.page && started.j.page.slug;
  row("the page is made from the desk", !!slug && started.j.page.github.includes("github.com/bench/breeds"), `${started.status} slug ${slug}, github ${started.j.page && started.j.page.github}`);
  await call(`/api/desks/${desk}/page/moments`, { moment: { title: "Chapter 4 accepted", body_md: "Working dogs, done.", about: "" }, pick: [] });
  await call(`/api/desks/${desk}/page`, { edit: { visibility: "everyone" } });

  const pub = await call(`/api/desks/${desk}/page/publish`, {});
  const html = await fetch(`${W}/p/${slug}`);
  const body = html.ok ? await html.text() : "";
  row("Publish: the daemon's signed writes are taken by the Worker, and the page is up", html.ok && body.includes("Breeds of dogs") && body.includes("Chapter 4 accepted"), `publish ${pub.status} "${pub.j.said || pub.j.error}"; /p/${slug} ${html.status}`);
  const wall0 = await (await fetch(`${W}/wall.json`)).json().catch(() => ({}));
  row("not on the wall before the check is in the repo", !(wall0.pages || []).some(p => p.slug === slug), `${(wall0.pages || []).length} on the wall`);

  const own = await call(`/api/desks/${desk}/page/owner`, {});
  const pub2 = await call(`/api/desks/${desk}/page/publish`, {});
  let wall1 = {};
  for (let i = 0; i < 20; i++) { wall1 = await (await fetch(`${W}/wall.json`)).json().catch(() => ({})); if ((wall1.pages || []).some(p => p.slug === slug)) break; await sleep(250); }
  const card = (wall1.pages || []).find(p => p.slug === slug);
  row("with .snyvi/owner in the repo, the Worker's check passes and the page is on the wall", !!card && card.moment && card.moment.title === "Chapter 4 accepted", `owner ${own.status} ${own.j.path || own.j.error}; again "${pub2.j.said || pub2.j.error}"; card ${JSON.stringify(card && { title: card.title, moment: card.moment && card.moment.title })}`);

  const through = await call(`/api/wall?again=1`);
  const mine = (through.j.mine || []).find(m => m.title === "Breeds of dogs");
  row("Home's /api/wall brings it through the daemon, and names it as mine", (through.j.wall.pages || []).some(p => p.slug === slug) && !!mine && !!mine.checked, `wall ${(through.j.wall.pages || []).length}, mine ${JSON.stringify(mine)}`);

  const h = await call(`/api/wall/heart`, { slug });
  const h2 = await call(`/api/wall/heart`, { slug });
  row("a heart, signed by the daemon, is one per key and a toggle", h.status === 200 && h.j.on === true && h.j.hearts === 1 && h2.j.on === false && h2.j.hearts === 0, `${h.status} ${JSON.stringify(h.j)} then ${JSON.stringify(h2.j)}`);

  const read = await call(`/api/desks/${desk}/page`);
  row("the row under Publish says it is up", /up/.test(read.j.page ? (read.j.waiting ? "waiting" : "up") : "") && !read.j.waiting, `waiting ${read.j.waiting} ${read.j.waiting_why || ""}, up_at ${read.j.page && read.j.page.up_at}`);

  const down = await call(`/api/desks/${desk}/page/down`, {});
  let gone = 0;
  for (let i = 0; i < 20; i++) { gone = (await fetch(`${W}/p/${slug}`)).status; if (gone === 404) break; await sleep(250); }
  const wall2 = await (await fetch(`${W}/wall.json`)).json().catch(() => ({}));
  row("Take it down: gone from snyvi.page and from the wall", gone === 404 && !(wall2.pages || []).some(p => p.slug === slug), `down ${down.status} "${down.j.said || down.j.error}"; /p ${gone}`);
} catch (e) { console.log("FAIL", e.stack || e); results.push(false); }
finally {
  // Only the process on this run's port: never `snyvi stop`, never 7777.
  try { const out = execFileSync("ss", ["-ltnpH", `sport = :${PORT}`], { encoding: "utf8" }); for (const m of out.matchAll(/pid=(\d+)/g)) process.kill(+m[1], "SIGTERM"); } catch {}
  try { process.kill(-wr.pid, "SIGTERM"); } catch {}
  side.close();
  console.log(`${results.filter(Boolean).length}/${results.length} ok · ${tmp}`);
  process.exit(results.every(Boolean) ? 0 : 1);
}
