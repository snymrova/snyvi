/* What a Claude Code hook costs the turn it runs in, counted.
 *
 * `snyvi hook` runs on every prompt, every tool call the matcher names, and
 * the start and end of every session. Nothing of it is on the screen, so
 * nothing said when it grew: by 1.16 a prompt inside a panel was two requests
 * on two connections with a resolver thread for each, a PostToolUse on any
 * MCP tool of any server was one more process, and a Markdown write with no
 * daemon up started one and waited for it -- inside Claude's turn, for up to
 * ten seconds, and against a `snyvi stop` the reader had just asked for.
 *
 *   node bench/hook.mjs            report the numbers
 *   node bench/hook.mjs --check    and exit non-zero if one is over budget
 *   node bench/hook.mjs --bin P    another build (default ./target/release/snyvi)
 *   node bench/hook.mjs --keep     leave the temp directory behind
 *
 * Everything here is a count, so it holds on any machine under any load: the
 * one clock, the no-daemon row, has a budget of 1.6 s against a path that
 * took up to 10 s, which no runner is slow enough to confuse.
 *
 *   execs per tool call   The PostToolUse matchers snyvi installs, run
 *                         against a tool name: how many `snyvi hook`
 *                         processes Claude Code starts for it. Read off the
 *                         settings file `init-claude` writes, so it is what
 *                         a reader's install does and not a guess.
 *   per event             connections to the daemon, and threads started,
 *                         for one hook run of each event. From strace,
 *                         where there is one (Linux); printed as "—" and
 *                         not enforced where there is not.
 *   no daemon             a `.md` Write hook with nothing on the port:
 *                         how long Claude's turn waits, and whether a daemon
 *                         was started. The hook must never start one.
 *
 * The daemon is this bench's own -- a throwaway HOME, data and config
 * directories, a port nothing else uses -- and is ended by the pid it was
 * started with, never by a name match across the machine.
 */

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, copyFileSync, existsSync, openSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, basename } from "node:path";

const args = process.argv.slice(2);
const CHECK = args.includes("--check");
const KEEP = args.includes("--keep");
const BIN_SRC = resolve(flag("--bin") || "./target/release/snyvi");
const PORT = flag("--port") || "7792";   // 7791 and 7794-7796 are CI's; see the list in ui.mjs

function flag(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
/* A pane id of the right shape: 32 hex digits. The daemon answers 404 for a
 * pane that is not running, which is what every hook path does before the
 * answer matters -- the counts here are of what the hook sends, not of what
 * it hears back. */
const PANE = "0123456789abcdef0123456789abcdef";
const SESSION = "11111111-2222-4333-8444-555555555555";

/* ---------- the rows ---------- */

const rows = [];
/** value, budget: `budget === null` is measured and printed, never enforced. */
function row(name, value, budget, why) {
  rows.push({ name, value, budget, why });
}

function report() {
  console.log(`\nhook budget\n`);
  console.log(`${"".padEnd(34)}${"got".padStart(8)}${"budget".padStart(10)}`);
  let bad = 0;
  for (const { name, value, budget, why } of rows) {
    const got = value === null ? "—" : String(value);
    const b = budget === null ? "" : `≤ ${budget}`;
    const ok = value === null || budget === null || value <= budget;
    if (!ok) bad++;
    console.log(`  ${name.padEnd(32)}${got.padStart(8)}${b.padStart(10)}${ok ? "  ok  " : "  OVER"} ${why || ""}`);
  }
  return bad;
}

/* ---------- strace, where it is ---------- */

const STRACE = (() => {
  if (process.platform !== "linux") return null;
  const r = spawnSync("strace", ["-V"], { encoding: "utf8" });
  return r.status === 0 ? "strace" : null;
})();

/** One hook run: the event on stdin, the pane in the environment. With
 *  strace: every execve, thread start and connect it made, counted. */
function runHook(BIN, env, event, { pane = PANE, trace = true, limit = 30_000 } = {}) {
  const out = join(env.SNYVI_DATA_DIR, `strace-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  const e = { ...env };
  if (pane) e.SNYVI_SESSION = pane; else delete e.SNYVI_SESSION;
  const traced = trace && STRACE;
  const cmd = traced ? STRACE : BIN;
  const argv = traced ? ["-f", "-qq", "-e", "trace=execve,clone,clone3,connect", "-o", out, BIN, "hook"] : ["hook"];
  // Output goes to files, not pipes: a hook that starts a daemon hands it
  // its stdout, and a pipe held open by a daemon is a bench that never
  // returns (what a 1.16 hook with no daemon did here). The clock is cut
  // at `limit` for the same reason -- strace -f follows that daemon too.
  const o = `${out}.out`, er = `${out}.err`;
  const fo = openSync(o, "w"), fe = openSync(er, "w");
  const t0 = performance.now();
  const r = spawnSync(cmd, argv, { env: e, input: JSON.stringify(event), stdio: ["pipe", fo, fe], timeout: limit, killSignal: "SIGKILL" });
  closeSync(fo); closeSync(fe);
  const ms = Math.round(performance.now() - t0);
  const read = f => { try { return readFileSync(f, "utf8"); } catch { return ""; } finally { rmSync(f, { force: true }); } };
  const stdout = read(o), stderr = read(er);
  const counts = { execs: null, threads: null, connects: null, serve: null, ms, cut: !!r.error || r.signal != null };
  if (traced && existsSync(out)) {
    const text = readFileSync(out, "utf8");
    const lines = text.split("\n");
    // The hook's own execve is the first; anything past it is a process the
    // hook started.
    const execs = lines.filter(l => /\bexecve\(/.test(l) && !/= -1 /.test(l));
    counts.execs = Math.max(0, execs.length - 1);
    counts.serve = execs.filter(l => /"serve"/.test(l)).length;
    // A thread is a clone or clone3 with CLONE_THREAD in its flags; a child
    // process is one without, and posix_spawn uses clone3 too, so the flag
    // is what tells them apart. Resumed lines (`<... clone3 resumed>`) are
    // the same call seen twice.
    counts.threads = lines.filter(l => /\bclone3?\(/.test(l) && !/resumed/.test(l) && /CLONE_THREAD/.test(l)).length;
    counts.connects = lines.filter(l => /\bconnect\(/.test(l) && new RegExp(`htons\\(${PORT}\\)`).test(l) && !/resumed/.test(l)).length;
    rmSync(out, { force: true });
  }
  return { ...counts, status: r.status, stdout, stderr };
}

/* ---------- the daemon, by its pid ---------- */

async function health(base) {
  try { return await (await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(400) })).json(); } catch { return null; }
}

async function until(f, tries = 80, every = 50) {
  for (let i = 0; i < tries; i++) { const v = await f(); if (v) return v; await sleep(every); }
  return null;
}

/** Whatever answers on the port, ended by the pid it reports, and waited
 *  out. A daemon the hook started on its own (the fault the no-daemon row
 *  is there to catch) is reached the same way, since it reports the same. */
async function endWhatever(base) {
  const h = await health(base);
  if (!h || !h.pid) return false;
  try { process.kill(h.pid, "SIGTERM"); } catch {}
  await until(async () => !(await health(base)), 100, 50);
  if (await health(base)) { try { process.kill(h.pid, "SIGKILL"); } catch {} await sleep(200); }
  return true;
}

async function main() {
  const tmp = mkdtempSync(join(tmpdir(), "snyvi-hook-"));
  const home = join(tmp, "home");
  mkdirSync(join(home, ".claude"), { recursive: true });
  const bin = join(tmp, "bin");
  mkdirSync(bin);
  const BIN = join(bin, basename(BIN_SRC));
  copyFileSync(BIN_SRC, BIN);
  const data = join(tmp, "data");
  mkdirSync(data);
  const env = {
    ...process.env, HOME: home, SNYVI_DATA_DIR: data, SNYVI_CONFIG_DIR: join(tmp, "config"), SNYVI_PORT: PORT,
    SNYVI_NOTIFY: "0", SNYVI_UPDATES: "off",
  };
  for (const k of ["SNYVI_SESSION", "SNYVI_DESK", "SNYVI_SLOT", "SNYVI_UI_DIR", "SNYVI_HOOK_EXT"]) delete env[k];
  const base = `http://127.0.0.1:${PORT}`;
  let serve = null;
  try {
    if (await health(base)) throw new Error(`something already answers on ${base}; pass --port`);

    // ---- what the install runs per tool call ----
    // With no `claude` on PATH: `init-claude` then writes the hooks and says
    // how to register the MCP server by hand, which is the half this needs.
    execFileSync(BIN, ["init-claude", "--auto"], { env: { ...env, PATH: bin }, cwd: tmp, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
    const ours = h => typeof h.command === "string" && h.command.endsWith(" hook") && h.command.includes("snyvi");
    const post = (settings.hooks?.PostToolUse || []).filter(e => (e.hooks || []).some(ours));
    const execsFor = tool => post.filter(e => {
      const m = e.matcher;
      if (m == null || m === "" || m === "*") return true;
      try { return new RegExp(`^(?:${m})$`).test(tool); } catch { return m === tool; }
    }).length;
    row("execs per mcp__other__tool", execsFor("mcp__other__tool"), 0, "another server's tool: the status line says working already");
    row("execs per mcp__snyvi__send_document", execsFor("mcp__snyvi__send_document"), 1, "snyvi's own: the status entry");
    row("execs per Write", execsFor("Write"), 2, "status + auto-send (two entries, by design)");
    row("execs per Read", execsFor("Read"), 0, "");

    // ---- the daemon, started by this bench and nothing else ----
    serve = spawn(BIN, ["serve"], { env, cwd: tmp, stdio: ["ignore", "ignore", "pipe"] });
    let serveErr = "";
    serve.stderr.on("data", d => { serveErr += d; });
    if (!(await until(() => health(base)))) throw new Error(`the daemon did not come up on ${base}\n${serveErr}`);
    // A token to send with: the daemon writes it on its first start.
    if (!existsSync(join(tmp, "config", "token"))) throw new Error("no token written");

    // ---- per event, under strace ----
    const events = [
      ["SessionStart", { hook_event_name: "SessionStart", cwd: tmp, session_id: SESSION, source: "startup" }, 1],
      ["UserPromptSubmit", { hook_event_name: "UserPromptSubmit", cwd: tmp, session_id: SESSION, prompt: "hi" }, 1],
      ["PostToolUse mcp__snyvi__x", { hook_event_name: "PostToolUse", cwd: tmp, session_id: SESSION, tool_name: "mcp__snyvi__send_document", tool_input: {}, tool_response: {} }, 1],
      ["Stop", { hook_event_name: "Stop", cwd: tmp, session_id: SESSION }, 1],
    ];
    for (const [name, event, conns] of events) {
      const r = runHook(BIN, env, event);
      row(`${name}: connections`, r.connects, conns, STRACE ? "" : "no strace here");
      row(`${name}: threads`, r.threads, 0, STRACE ? "a resolver thread is a clone3 per call" : "no strace here");
      row(`${name}: child processes`, r.execs, 0, "");
      row(`${name}: ms`, r.ms, null, "wall, the daemon up");
    }

    // ---- no daemon: the turn must not wait, and nothing may be started ----
    await endWhatever(base);
    if (await health(base)) throw new Error("the bench daemon did not stop");
    const md = join(tmp, "notes.md");
    writeFileSync(md, "# Notes\n\nOne paragraph.\n");
    const write = { hook_event_name: "PostToolUse", cwd: tmp, session_id: SESSION, tool_name: "Write", tool_input: { file_path: md, content: "x" }, tool_response: {} };
    // Outside a panel: the auto-send path alone, which is what every
    // `init-claude --auto` install runs on every Markdown write.
    const r = runHook(BIN, env, write, { pane: null, limit: 12_000 });
    row("no daemon, .md Write: ms", r.ms, 1600, r.cut ? "cut at 12 s: the hook had not returned" : "Claude's turn waits this long");
    // A daemon started by the hook answers the port within a second or two
    // of the hook returning; one that was not started never does.
    await sleep(1500);
    const started = !!(await health(base));
    row("no daemon, .md Write: daemons started", started ? 1 : 0, 0, r.serve === null ? "by the port" : `by the port; strace saw ${r.serve} serve exec(s)`);
    if (started) await endWhatever(base);
    // And inside a panel, a session starting with no daemon: the brief is
    // asked for with a short wait and nothing printed.
    const r2 = runHook(BIN, env, events[0][1], { limit: 12_000 });
    row("no daemon, SessionStart: ms", r2.ms, 1600, "");
    row("no daemon, SessionStart: child processes", r2.execs, 0, "");
    if (await health(base)) { row("no daemon, SessionStart: daemons started", 1, 0, ""); await endWhatever(base); }
  } finally {
    if (serve && serve.exitCode === null) { try { serve.kill("SIGTERM"); } catch {} }
    await endWhatever(base);
    if (serve && serve.exitCode === null) { try { serve.kill("SIGKILL"); } catch {} }
    if (KEEP) console.log(`kept ${tmp}`); else rmSync(tmp, { recursive: true, force: true });
  }
  const bad = report();
  if (!STRACE) console.log("\nno strace: connections and threads are not measured here, and not enforced.");
  if (bad && CHECK) {
    console.error(`\nhook budget: ${bad} row(s) over budget`);
    process.exitCode = 1;
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
