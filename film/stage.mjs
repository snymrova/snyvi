/* A staged snyvi, full of a fortnight's work, left running for a camera.
 *
 *   node film/stage.mjs [--bin target/release/snyvi] [--port 7799]
 *
 * The other seeds in this repo are minimal on purpose: bench/media.mjs wants
 * two projects so the sidebar has a shape, and bench/ui.mjs wants as little as
 * it can prove something with. The film wants the opposite. A library with one
 * project in it photographs as a demo; a reader recognises their own week in
 * five projects, a dozen documents, folders open on disk and three desks with
 * shells in them, and that recognition is most of what the film is selling.
 *
 * So this stages the full thing and then gets out of the way: it prints the
 * port and the temporary directory, and leaves the daemon, the desks and their
 * shells running for `snyvi-app` to attach to and a camera to photograph. It
 * cleans up nothing, because it is not finished when it exits -- `--stop` is
 * how you take it down.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, copyFileSync, existsSync } from "node:fs";
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
 *  Seven panes over three desks, against a global cap of eight, so the
 *  Panels count in the rail reads as a working machine and not a fresh one. */
const DESKS = [["ledger", "ledger", 4], ["gateway", "gateway", 2], ["atlas", "atlas", 1]];

/** What each desk still owes its reader, on its own list in the rail. The
 *  first is done, so the list reads as one being worked through. */
const DESK_NOTES = {
  ledger: [
    ["Pick a side on the org bucket: plan or code", true],
    ["Retry-After in whole seconds, or allow fractions?", false],
    ["Fail open on Redis errors: ask ops before merge", false],
  ],
  gateway: [["Make dedup-and-enqueue one atomic step", false]],
};

/** Folders open under Folders, read from disk rather than imported. */
const FOLDERS = ["ledger", "gateway", "atlas"];

/** The notes at the foot of the sidebar: the sentence that is not a document.
 *  The last of them is the one lit. */
const NOTES = [
  "Left the org bucket alone -- the plan and the code disagree about it and I did not want to pick a side without you.",
  "The statements spike came out yes, with a tail of 300 merchant accounts. Numbers are in the table.",
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

// The notes: in memory, the last five, the newest lit.
for (const text of NOTES) { await api("/api/notes", { text, sender: "claude-code" }); await sleep(400); }

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
  for (let i = 0; i < count; i++) panes[name].push((await api(`/api/desks/${desk.id}/panes`, {}, asPage)).pane.id);
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

// Each desk's own list, in the order it was written.
for (const desk of desks) {
  for (const [text, done] of DESK_NOTES[desk.name] ?? []) {
    const { note } = await api(`/api/desks/${desk.id}/notes`, { text }, asPage);
    if (done) await api(`/api/desks/${desk.id}/notes/${note.id}`, { done: true }, asPage);
  }
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
    projects: Object.fromEntries(Object.values(dirs).map(d => [d, { hasTrustDialogAccepted: true, allowedTools: [], history: [] }])),
  }));
}

writeFileSync(MARK, JSON.stringify({ tmp, port: PORT, desks: desks.map(d => d.id), panes, dirs, later: LATER }, null, 2) + "\n");
console.log(`staged on ${base}`);
console.log(`  ${sent.length} documents, ${REPOS.length} projects, ${FOLDERS.length} folders, ${DESKS.length} desks`);
console.log(`  ${sent.filter(s => s.keep).length} waiting to be read, ${NOTES.length} notes, ${Object.keys(LATER).length} held back for the camera`);
console.log(`  ${agentReady ? "Claude Code is logged in; panes can run it" : "no Claude Code credentials; panes are shells"}`);
console.log(`  data in ${tmp}`);
console.log(`\nopen it:  HOME=${home} SNYVI_PORT=${PORT} SNYVI_CONFIG_DIR=${join(tmp, "config")} SNYVI_DATA_DIR=${join(tmp, "data")} snyvi-app`);
console.log(`take it down:  node film/stage.mjs --port ${PORT} --stop`);
