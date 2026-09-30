/* A staged snyvi, full of a fortnight's work, left running for a camera.
 *
 *   node film/stage.mjs [--bin target/release/snyvi] [--port 7799]
 *
 * The other seeds in this repo are minimal on purpose: bench/media.mjs wants
 * two projects so the sidebar has a shape, and bench/ui.mjs wants as little as
 * it can prove something with. The film wants the opposite. A library with one
 * project in it photographs as a demo; a reader recognises their own week in
 * five projects, a dozen documents, folders open on disk and five desks with
 * shells in them, and that recognition is most of what the film is selling.
 *
 * So this stages the full thing and then gets out of the way: it prints the
 * port and the temporary directory, and leaves the daemon, the desks and their
 * shells running for `snyvi-app` to attach to and a camera to photograph. It
 * cleans up nothing, because it is not finished when it exits -- `--stop` is
 * how you take it down.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, copyFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const flag = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const PORT = flag("--port") || "7799";
const BIN_SRC = resolve(flag("--bin") || "./target/release/snyvi");
const HERE = dirname(fileURLToPath(import.meta.url));
const SEED = join(HERE, "..", "bench", "seed");
const MARK = join(tmpdir(), `snyvi-stage-${PORT}.json`);
const base = `http://127.0.0.1:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- taking a previous stage down ---------- */

if (args.includes("--stop")) {
  if (!existsSync(MARK)) { console.log(`nothing staged on ${PORT}`); process.exit(0); }
  const { tmp } = JSON.parse(readFileSync(MARK, "utf8"));
  try { execFileSync(join(tmp, "bin", "snyvi"), ["stop"], { env: envFor(tmp), stdio: "ignore" }); } catch {}
  await sleep(1500);
  rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  rmSync(MARK, { force: true });
  console.log(`stopped, and ${tmp} is gone`);
  process.exit(0);
}

/* ---------- the environment the staged daemon runs in ---------- */

function envFor(tmp) {
  // Nothing named for an agent or a model provider is passed on: run this from
  // inside one and its variables reach the shells in the picture, which then
  // say so across the bottom of the pane.
  const clean = Object.fromEntries(Object.entries(process.env)
    .filter(([k]) => !/^(CLAUDE|CLAUDECODE|ANTHROPIC|AWS_BEARER_TOKEN|GOOGLE_|VERTEX|BEDROCK)/.test(k)));
  return {
    ...clean,
    HOME: join(tmp, "home"),
    SNYVI_DATA_DIR: join(tmp, "data"),
    SNYVI_CONFIG_DIR: join(tmp, "config"),
    SNYVI_PORT: PORT,
    SNYVI_NOTIFY: "0",
    CLAUDE_CONFIG_DIR: join(tmp, "claude"),
    PATH: `${join(tmp, "bin")}:${process.env.PATH ?? ""}`,
  };
}

/* ---------- what the library holds ---------- */

/** Five checkouts, because a sidebar with one project in it is a demo. Each is
 *  a real git repo so the branch beside it is read rather than invented, and
 *  so a pane opened on one can run `git` and mean it. */
const REPOS = [
  ["ledger", "rate-limits"],
  ["gateway", "main"],
  ["atlas", "spike/statements"],
  ["infra", "main"],
  ["website", "main"],
];

/** Every document the staged library holds, in the order it arrived.
 *  `[repo, workflow, file, sender, keep, as, from]`.
 *
 *  `keep` marks the few left unread, so the queue above the document reads
 *  like a morning's arrivals rather than a library nobody has opened.
 *
 *  `from` is the desk and panel (0-based) it was sent from, so the desk's
 *  rail lists it under Documents, the way a send from inside a panel
 *  would; without it a document is filed in the inbox and nowhere else.
 *
 *  `as` is the name it lands under, where that differs from the fixture it is
 *  copied from. Two fixtures landing under one name is how a version is made:
 *  a document is a path, and the same path sent twice is the same document
 *  revised, which is what `c` compares. Give the two plans their own file
 *  names and they are two documents that merely look alike, and the compare
 *  says there is nothing to compare with. */
const DOCS = [
  ["website", "Pricing rewrite", "notes.md", "claude-code", false],
  ["infra", "On-call", "runbook.md", "claude-code", false],
  ["gateway", "One door", "gateway-design.md", "claude-code", false, null, ["gateway", 0]],
  ["gateway", "One door", "ingest.ts", "codex", false, null, ["gateway", 1]],
  ["gateway", "Latency", "latency.csv", "claude-code", false],
  ["atlas", "Statements spike", "spike.md", "claude-code", false, null, ["atlas", 0]],
  ["ledger", "Gateway refactor", "limit.rs", "codex", false, null, ["ledger", 1]],
  ["ledger", "Rate limiting", "plan.md", "claude-code", false, "rate-limiting.md", ["ledger", 0]],
  ["ledger", "Rate limiting", "plan-v2.md", "claude-code", true, "rate-limiting.md", ["ledger", 0]],
];

/** Held back for the camera: sent from a panel while it is photographing, so
 *  a frame can show a document arriving on the desk that wrote it. */
const LATER = {
  summary: ["ledger", "Rate limiting", "summary.md", "claude-code", ["ledger", 3]],
  review: ["ledger", "Rate limiting", "review.md", "claude-code", ["ledger", 2]],
};

/** The desks: a name, the checkout it is rooted at, and how many panes.
 *  Five desks, so Home has a shelf of them; infra is parked, with the step
 *  it is waiting on, so Home shows a project put down on purpose. */
const DESKS = [["ledger", "ledger", 4], ["gateway", "gateway", 2], ["atlas", "atlas", 1], ["website", "website", 1], ["infra", "infra", 1]];
const PARKED = { infra: "Rotate the staging certificates before Friday's deploy" };

/** What each desk still owes its reader, on its own list in the rail, and
 *  how far an agent in one of its panels has got with each: a list being
 *  worked through, by the agents as much as by the reader.
 *  `[text, stage, pane]`: stage is open (null), read, planned, working or
 *  done, said by the panel `pane` the way mark_desk_note and tick_desk_note
 *  say it. */
const DESK_NOTES = {
  ledger: [
    ["Pick a side on the org bucket: plan or code", "done", 0],
    ["Retry-After in whole seconds, or allow fractions?", null],
    ["Fail open on Redis errors: ask ops before merge", "working", 2],
    ["Write up what changes for Free, Team and Enterprise keys", "planned", 3],
  ],
  gateway: [
    ["Make dedup-and-enqueue one atomic step", "read", 0],
    ["Cap the retry queue before a replay storm fills it", null],
  ],
  atlas: [["Ask finance which 300 merchants make up the tail", null]],
  website: [["Hero for the pricing page: the calmer one, like this", null, null, "hero"]],
};

/** Where each desk's work was left, as a panel's agent says it with
 *  leave_off -- or, for the one without an agent, as the reader typed it. */
const LEFT_OFF = {
  ledger: ["If ops agree to fail open, merge the limiter; the two open questions are in the notes", 0],
  gateway: ["Dedup and enqueue still race under replay; the fix is one Lua script, next session", 0],
  atlas: ["Spike says yes; waiting on finance for the 300 accounts before the real build", 0],
  website: ["Pricing copy is done; the hero picture is the last thing", null],
};

/** What the panels are called, as their agents name them with name_panel. */
const PANEL_NAMES = {
  ledger: ["Plan vs code", "Load review", "Redis errors", "Tier summary"],
  gateway: ["Design vs ingest", "Replay storm"],
  atlas: ["Statements spike"],
  website: ["Pricing page"],
};

/** Folders open under Folders, read from disk rather than imported. */
const FOLDERS = ["ledger", "gateway", "atlas", "website", "infra"];

/** The notes at the foot of the sidebar: the sentence that is not a document.
 *  The last of them is the one lit. */
const NOTES = [
  ["Left the org bucket alone -- the plan and the code disagree about it and I did not want to pick a side without you.", "ledger"],
  ["The statements spike came out yes, with a tail of 300 merchant accounts. Numbers are in the table.", "atlas"],
];

/* ---------- staging ---------- */

const tmp = mkdtempSync(join(tmpdir(), "snyvi-stage-"));
const home = join(tmp, "home");
const bin = join(tmp, "bin");
mkdirSync(home, { recursive: true });
mkdirSync(bin, { recursive: true });
const BIN = join(bin, "snyvi");
copyFileSync(BIN_SRC, BIN);
const env = envFor(tmp);

// Claude Code, if this machine has it, for the shells in the desks: its own
// config directory holding a copy of the credentials and nothing else, so the
// sessions touch none of the real one's history and go when `tmp` does.
const claudeCfg = join(tmp, "claude");
const creds = join(process.env.HOME ?? "", ".claude", ".credentials.json");
let agentReady = false;
try {
  mkdirSync(claudeCfg, { recursive: true, mode: 0o700 });
  copyFileSync(creds, join(claudeCfg, ".credentials.json"));
  agentReady = true;
} catch { /* no Claude Code here; the panes will simply be shells */ }

const GIT = ["-c", "user.name=ledger-core", "-c", "user.email=core@ledger.test", "-c", "commit.gpgsign=false"];
const gitEnv = { ...env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const git = (dir, ...a) => execFileSync("git", [...GIT, "-C", dir, ...a], { env: gitEnv, stdio: "ignore" });

const dirs = {};
for (const [name, branch] of REPOS) {
  const dir = join(home, "code", name);
  mkdirSync(dir, { recursive: true });
  execFileSync("git", [...GIT, "init", "-q", "-b", branch, dir], { env: gitEnv, stdio: "ignore" });
  writeFileSync(join(dir, "README.md"), `# ${name}\n`);
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", `${name}: first commit`);
  dirs[name] = dir;
}

// The daemon comes up the way it always does, on the first send. This is the
// first document of DOCS rather than a throwaway: the same bytes from the same
// path are the same document, so a warm-up send under its own name would put
// the workflow it invented on the row instead of the one below.
execFileSync(BIN, ["send", join(SEED, "notes.md"), "-w", "Pricing rewrite"], { env, cwd: dirs.website, encoding: "utf8" });
const token = readFileSync(join(tmp, "config", "token"), "utf8").trim();
const api = async (path, body, extra = {}) => {
  const r = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...extra },
    body: JSON.stringify(body ?? {}),
  });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return r.status === 204 ? null : r.json();
};

/** A picture on a desk note: drawn here, so the stage needs nothing it has
 *  not got. A hero sketch for the pricing page -- the kind of thing a reader
 *  drops on a note to say "like this". */
async function attach(desk, note, what) {
  const file = join(tmp, `${what}.png`);
  execFileSync("convert", ["-size", "960x540", "gradient:#f4efe6-#d9cbb3",
    "-fill", "#2b2a28", "-font", "DejaVu-Sans-Bold", "-pointsize", "64", "-gravity", "west", "-annotate", "+90-40", "Build the thing\nyou care about.",
    "-fill", "#7a6f60", "-font", "DejaVu-Sans", "-pointsize", "30", "-annotate", "+92+110", "Free for makers. $12 a month for teams.",
    "-fill", "#c8553d", "-draw", "roundrectangle 90,420 330,480 12,12",
    "-fill", "#ffffff", "-pointsize", "26", "-gravity", "northwest", "-annotate", "+128+434", "Start free", file]);
  const r = await fetch(`${base}/api/desks/${desk}/notes/${note}/image`, {
    method: "POST", headers: { "content-type": "image/png", authorization: `Bearer ${token}`, ...asPage }, body: readFileSync(file),
  });
  if (!r.ok) throw new Error(`note image: ${r.status} ${await r.text()}`);
}

// The notes: in memory, the last five, the newest lit.
for (const [text, repo] of NOTES) { await api("/api/notes", { text, sender: "claude-code", cwd: dirs[repo] }); await sleep(400); }

// Folders, read from disk. Nothing is imported by this.
const roots = {};
for (const name of FOLDERS) roots[name] = (await api("/api/browse", { path: dirs[name] })).root.id;

// The desks. These routes answer a page of the daemon's own that holds the
// window's capability, so the camera mints one over the token the way a window
// launch does, and presents the Origin a page would have sent.
const cap = (await api("/api/capability")).capability;
const asPage = { "x-snyvi-capability": cap, origin: base };
const desks = [];
const panes = {};
for (const [name, root, count] of DESKS) {
  const { desk } = await api("/api/desks", { root: roots[root], name }, asPage);
  panes[name] = [];
  for (let i = 0; i < count; i++) {
    const id = (await api(`/api/desks/${desk.id}/panes`, {}, asPage)).pane.id;
    // Started, the way a window's first look at the panel starts it: a shell
    // in the desk's folder. The agents' routes below answer only a running
    // pane, as they do for a real one.
    await api(`/api/panes/${id}/start`, { cmd: "", cols: 100, rows: 30 }, asPage);
    panes[name].push(id);
  }
  desks.push(desk);
}

// Every document, each written into the checkout it belongs to first, so the
// rail's "open source" and the relative images resolve the way they would.
const sent = [];
for (const [repo, workflow, file, sender, keep, as, from] of DOCS) {
  const name = as || file;
  const at = join(dirs[repo], name.endsWith(".md") ? "docs" : "src", name);
  mkdirSync(dirname(at), { recursive: true });
  copyFileSync(join(SEED, file), at);
  const pane = from ? panes[from[0]][from[1]] : undefined;
  const { doc } = await api("/api/docs", { path: at, cwd: dirs[repo], workflow, sender, origin: "mcp", pane });
  sent.push({ doc, keep });
  git(dirs[repo], "add", "-A");
  git(dirs[repo], "commit", "-qm", `${workflow.toLowerCase()}: ${file}`);
  await sleep(1100);   // received_at is whole seconds; keep the order
}

// Read everything but the last few, so the queue is a morning and not a backlog.
for (const { doc, keep } of sent) if (!keep) await api(`/api/docs/${doc.id}/read`, {});

// The plan the ledger's notes point at: a note planned or ticked names the
// document it is about, the way an agent passes the id send_document gave it.
const plan = sent.filter(s => s.doc.title && /rate/i.test(s.doc.title)).pop()?.doc ?? sent[sent.length - 1].doc;
const head = repo => execFileSync("git", ["-C", dirs[repo], "rev-parse", "--short", "HEAD"], { env: gitEnv, encoding: "utf8" }).trim();

// Each desk's own list, in the order it was written, and each line as far
// along as the agent on it says. The panes' routes are the agents' own --
// the token and a running pane -- so this is what mark_desk_note and
// tick_desk_note do, not a shortcut past them.
for (const desk of desks) {
  for (const [text, stage, pane, picture] of DESK_NOTES[desk.name] ?? []) {
    const { note } = await api(`/api/desks/${desk.id}/notes`, { text }, asPage);
    if (picture) await attach(desk.id, note.id, picture);
    if (!stage) continue;
    const at = `/api/panes/${panes[desk.name][pane]}/notes/${note.id}`;
    if (stage === "done") await api(`${at}/tick`, { by: "claude-code", commit: head(desk.name), about: plan.id });
    else await api(`${at}/mark`, { stage, by: "claude-code", about: stage === "planned" ? plan.id : "" });
    await sleep(300);
  }
}

// The panels' names, and where each desk was left.
for (const desk of desks) {
  for (const [i, name] of (PANEL_NAMES[desk.name] ?? []).entries()) await api(`/api/panes/${panes[desk.name][i]}/name`, { name });
  const left = LEFT_OFF[desk.name];
  if (!left) continue;
  if (left[1] === null) await api(`/api/desks/${desk.id}/leftoff`, { text: left[0], at: 0 }, asPage);
  else await api(`/api/panes/${panes[desk.name][left[1]]}/leftoff`, { text: left[0], by: "claude-code" });
}
for (const desk of desks) if (PARKED[desk.name]) await api(`/api/desks/${desk.id}/park`, { next: PARKED[desk.name] }, asPage);
// Visited in the order a day went, so Home offers ledger to pick up.
for (const name of ["website", "atlas", "gateway", "ledger"]) {
  await api(`/api/desks/${desks.find(d => d.name === name).id}/visit`, {}, asPage);
  await sleep(1100);
}

// Three agents registered in this home, so the connect page and the count
// beside the mark have something to say.
writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { snyvi: { command: "snyvi", args: ["mcp"] } } }));
for (const a of ["cursor", "codex"]) execFileSync(BIN, ["init", a], { env, stdio: "ignore" });

// What Claude Code would otherwise stop and ask on its way into a folder it
// has never seen. Written into the copy's own config, so neither answer is
// given on behalf of the real one.
if (agentReady) {
  writeFileSync(join(claudeCfg, ".claude.json"), JSON.stringify({
    hasCompletedOnboarding: true,
    // snyvi, by name: the stage's bin is first on the panes' PATH. Written
    // here because init-claude reads the stage HOME's registration (the
    // connect page's, above), finds snyvi there, and adds nothing.
    mcpServers: { snyvi: { type: "stdio", command: "snyvi", args: ["mcp"], env: {} } },
    projects: Object.fromEntries(Object.values(dirs).map(d => [d, { hasTrustDialogAccepted: true, allowedTools: [], history: [] }])),
  }));
  // And connected to this snyvi, as a reader's would be after `snyvi
  // init-claude`: the MCP server, the hooks that say whether a panel is
  // working, the status line. Run under the stage's HOME and Claude config,
  // then the hooks copied to where that config's Claude reads them. The real
  // ~/.claude is checked before and after: this must not have touched it.
  // (~/.claude.json itself is rewritten by every running Claude, so its
  // snyvi entry is what is compared, not its time.)
  const realHome = process.env.HOME ?? "";
  const stamp = () => {
    let t = 0, entry = "";
    try { t = statSync(join(realHome, ".claude", "settings.json")).mtimeMs; } catch {}
    try { entry = JSON.stringify(JSON.parse(readFileSync(join(realHome, ".claude.json"), "utf8")).mcpServers?.snyvi); } catch {}
    return `${t} ${entry}`;
  };
  const before = stamp();
  execFileSync(BIN, ["init-claude"], { env, stdio: "ignore" });
  if (stamp() !== before) throw new Error("init-claude touched the real ~/.claude -- stop here and look");
  copyFileSync(join(home, ".claude", "settings.json"), join(claudeCfg, "settings.json"));
}

writeFileSync(MARK, JSON.stringify({ tmp, port: PORT, desks: desks.map(d => d.id), panes, dirs, later: LATER }, null, 2) + "\n");
console.log(`staged on ${base}`);
console.log(`  ${sent.length} documents, ${REPOS.length} projects, ${FOLDERS.length} folders, ${DESKS.length} desks`);
console.log(`  ${sent.filter(s => s.keep).length} waiting to be read, ${NOTES.length} notes, ${Object.keys(LATER).length} held back for the camera`);
console.log(`  ${agentReady ? "Claude Code is logged in; panes can run it" : "no Claude Code credentials; panes are shells"}`);
console.log(`  data in ${tmp}`);
console.log(`\nopen it:  HOME=${home} SNYVI_PORT=${PORT} SNYVI_CONFIG_DIR=${join(tmp, "config")} SNYVI_DATA_DIR=${join(tmp, "data")} snyvi-app`);
console.log(`take it down:  node film/stage.mjs --port ${PORT} --stop`);
