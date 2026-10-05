/* The store under a save: what one overwrite of a document costs the database.
 *
 * An agent editing a plan sends it every few seconds, and within the coalesce
 * window each send is a `replace` of the same row: the source and the HTML are
 * rewritten and the search index's row for the document is taken out and put
 * back. Through 1.16 that delete was `DELETE FROM docs_fts WHERE id = ?`, and
 * `id` is an UNINDEXED column of an FTS5 table -- so SQLite read the whole
 * index to find one row: 18.7 MB and 423 page misses for a library of 541
 * documents, on every save of anything. The fix keeps the index's rowid equal
 * to the document's rowid in `docs`, and deletes by that.
 *
 *   node bench/store.mjs            report the numbers
 *   node bench/store.mjs --check    and exit non-zero if one is over budget
 *
 * ---------- how it measures, and why this way ----------
 *
 * Count-enforced, on a daemon of its own: a throwaway HOME, data and config
 * directories, a port nothing else uses, never the daemon on 7777. It is seeded
 * through POST /api/docs the way documents always go in (`SNYVI_BENCH_DOCS` of
 * them, 500 unless told otherwise), each one then saved again as a hook save
 * would be, so every row in the index has been through `replace` at least once.
 * Then the daemon is stopped and the database read with the sqlite3 shell,
 * whose `.stats on` prints the page cache misses a statement cost -- the same
 * counter the audit's 423 came from. A cold connection, so a miss is a page
 * read.
 *
 * Two rows are enforced, and neither depends on the machine:
 *
 *   fts aligned      Every index row's rowid is its document's rowid, after
 *                    the daemon's own inserts and replaces. Any drift and the
 *                    delete by rowid below is not the delete the daemon runs.
 *   fts-replace      Page misses for the delete the daemon runs on a save,
 *                    `DELETE FROM docs_fts WHERE rowid = (SELECT rowid FROM
 *                    docs WHERE id = ?)`, under 64 KB of pages. The bench
 *                    runs that statement itself, so this row holds the
 *                    statement's cost, not the daemon's choice of it: a
 *                    daemon gone back to deleting by id would still pass
 *                    here. That is held in src/store/tests.rs, by counting
 *                    the virtual machine's steps for the delete it runs.
 *
 * The 1.16 form, by id, is run on the same database and printed for the
 * record. It is not enforced: it is the number this bench exists to leave
 * behind.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, copyFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const CHECK = args.includes("--check");
const KEEP = args.includes("--keep");
const BIN = resolve(flag("--bin") || "./target/release/snyvi");
const PORT = flag("--port") || "7820";   // 7816 restart.mjs, 7817-7818 update.mjs (7818 its fake GitHub); see the list in ui.mjs
const DOCS = Number(process.env.SNYVI_BENCH_DOCS || flag("--docs") || 500);
/* 64 KB of pages, whatever the page size: one FTS5 structure read, the
 * row and its segment, and nothing like a scan. */
const BUDGET_BYTES = 64 * 1024;

function flag(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (f, tries = 80, every = 250) => { for (let i = 0; i < tries; i++) { const v = await f(); if (v) return v; await sleep(every); } return null; };

/* A document the size an agent's plan tends to be: a few headings, a list, a
 * code block, about 4 KB, distinct per row so the index holds real terms. */
function plan(i, rev) {
  const lines = [`# Plan ${i}, revision ${rev}`, ""];
  for (let s = 0; s < 6; s++) {
    lines.push(`## Section ${s} of plan ${i}`, "");
    lines.push(`Paragraph ${s} revision ${rev}: the store keeps document ${i} as source, html and an index row, and a save rewrites all three.`, "");
    lines.push(`- item ${s}a for ${i}`, `- item ${s}b for ${i}`, `- item ${s}c revision ${rev}`, "");
  }
  lines.push("```rust", `fn plan_${i}() -> u32 { ${i} + ${rev} }`, "```", "");
  return lines.join("\n");
}

/** Run one statement through the sqlite3 shell with stats on and read the
 *  page cache misses it cost. The shell prints the stats block after each
 *  statement; the statement is the last one, so the last block is its. */
function misses(db, sql) {
  const script = `.stats on\n${sql}\n`;
  const r = spawnSync("sqlite3", [db], { input: script, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`sqlite3: ${r.stderr || r.stdout}`);
  const out = r.stdout + r.stderr;
  const all = [...out.matchAll(/Page cache misses:\s+(\d+)/g)].map(m => Number(m[1]));
  const scans = [...out.matchAll(/Fullscan Steps:\s+(\d+)/g)].map(m => Number(m[1]));
  if (!all.length) throw new Error(`sqlite3 printed no stats block for: ${sql}\n${out.slice(0, 400)}`);
  return { misses: all[all.length - 1], fullscan: scans.length ? scans[scans.length - 1] : null };
}

function query(db, sql) {
  const r = spawnSync("sqlite3", ["-noheader", db, sql], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`sqlite3: ${r.stderr}`);
  return r.stdout.trim();
}

async function main() {
  if (!existsSync(BIN)) { console.error(`no binary at ${BIN}; build with cargo build --release`); process.exit(1); }
  if (spawnSync("sqlite3", ["--version"]).status !== 0) { console.error("sqlite3 is not on PATH; this bench reads the database with it"); process.exit(1); }
  const tmp = mkdtempSync(join(tmpdir(), "snyvi-store-"));
  const home = join(tmp, "home");
  mkdirSync(home);
  const env = {
    ...process.env, HOME: home, SNYVI_DATA_DIR: join(tmp, "data"), SNYVI_CONFIG_DIR: join(tmp, "config"), SNYVI_PORT: PORT,
    SNYVI_NOTIFY: "0", SNYVI_UPDATES: "off",
  };
  for (const k of ["SNYVI_SESSION", "SNYVI_DESK", "SNYVI_SLOT", "SNYVI_UI_DIR"]) delete env[k];
  const base = `http://127.0.0.1:${PORT}`;
  const cli = (...a) => execFileSync(BIN, a, { env, cwd: tmp, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const rows = [];
  const row = (name, value, budget, ok, why) => { rows.push([name, value, budget, ok, why]); };
  try {
    // The daemon comes up the way it always does: on the first send. Its
    // pid is read from health, and it is stopped by `snyvi stop` against
    // this port -- never by a pattern over every process on the machine.
    const proj = join(tmp, "proj");
    mkdirSync(proj);
    const first = join(proj, "first.md");
    writeFileSync(first, "# First\n\nThe send that starts the daemon.\n");
    cli("send", first);
    const health = async () => { try { return await (await fetch(`${base}/api/health`)).json(); } catch { return null; } };
    const h = await until(health);
    if (!h) throw new Error("the daemon did not come up");
    const token = readFileSync(join(tmp, "config", "token"), "utf8").trim();
    const T = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const send = async (i, rev) => {
      const r = await fetch(`${base}/api/docs`, { method: "POST", headers: T, body: JSON.stringify({
        content: plan(i, rev), path: join(proj, `plan-${i}.md`), cwd: proj, origin: "hook", title: `Plan ${i}`,
      }) });
      if (!r.ok) throw new Error(`POST /api/docs ${r.status}: ${await r.text()}`);
      return r.json();
    };
    const t0 = Date.now();
    // Seeded a few at a time: the daemon renders each one, and a thousand in
    // flight at once measures the executor, not the store.
    const ids = [];
    for (let i = 0; i < DOCS; i += 8) {
      const batch = [];
      for (let j = i; j < Math.min(i + 8, DOCS); j++) batch.push(send(j, 0));
      for (const j of await Promise.all(batch)) ids.push(j.id);
    }
    // Every one saved again, inside the coalesce window, so each row has
    // been through `replace`: the index row deleted and put back.
    let replaced = 0;
    for (let i = 0; i < DOCS; i += 8) {
      const batch = [];
      for (let j = i; j < Math.min(i + 8, DOCS); j++) batch.push(send(j, 1));
      for (const j of await Promise.all(batch)) if (j.existing) replaced++;
    }
    const seeded = Date.now() - t0;
    try { cli("stop"); } catch {}
    await until(async () => !(await health()), 40);

    // Read with the daemon gone, on a copy: the shell's own writes (the
    // deletes it measures) touch nothing the daemon will open again.
    const live = join(tmp, "data", "snyvi.db");
    const db = join(tmp, "bench.db");
    copyFileSync(live, db);
    for (const sfx of ["-wal", "-shm"]) if (existsSync(live + sfx)) copyFileSync(live + sfx, db + sfx);
    const pageSize = Number(query(db, "PRAGMA page_size"));
    const total = Number(query(db, "SELECT COUNT(*) FROM docs"));
    const indexed = Number(query(db, "SELECT COUNT(*) FROM docs_fts"));
    const drifted = Number(query(db, "SELECT COUNT(*) FROM docs_fts f JOIN docs d ON d.id = f.id WHERE f.rowid != d.rowid"));
    const orphans = indexed - Number(query(db, "SELECT COUNT(*) FROM docs_fts f JOIN docs d ON d.id = f.id"));
    const pages = Number(query(db, "SELECT COUNT(*) FROM docs_fts_data")) ;
    const victim = ids[Math.floor(ids.length / 2)];

    // What the daemon runs on a save, measured cold.
    const byRowid = misses(db, `DELETE FROM docs_fts WHERE rowid = (SELECT rowid FROM docs WHERE id = '${victim}');`);
    // What it ran through 1.16, for the record, on a fresh copy so the first
    // delete's page reads are not in its cache.
    const db2 = join(tmp, "bench2.db");
    copyFileSync(db, db2);
    const victim2 = ids[Math.floor(ids.length / 3)];
    const byId = misses(db2, `DELETE FROM docs_fts WHERE id = '${victim2}';`);

    row("fts aligned", drifted + orphans, 0, drifted === 0 && orphans === 0,
      `${indexed} index rows for ${total} documents after ${replaced} saves: ${drifted} with a rowid of their own, ${orphans} orphaned`);
    row("fts-replace, delete by rowid", byRowid.misses * pageSize, BUDGET_BYTES, byRowid.misses * pageSize <= BUDGET_BYTES,
      `${byRowid.misses} page misses of ${pageSize} B${byRowid.fullscan != null ? `, ${byRowid.fullscan} fullscan steps` : ""}`);
    rows.push(["  (delete by id, as 1.16 did)", byId.misses * pageSize, null, true,
      `${byId.misses} page misses, ${pages} pages in the index${byId.fullscan != null ? `, ${byId.fullscan} fullscan steps` : ""}`]);

    console.log(`store budget   (${DOCS} documents, seeded and saved again in ${(seeded / 1000).toFixed(1)} s)\n`);
    console.log(`${"".padEnd(34)}${"bytes".padStart(9)}${"budget".padStart(10)}`);
    let over = false;
    for (const [name, value, budget, ok, why] of rows) {
      const b = budget == null ? "" : String(budget);
      console.log(`${name.padEnd(34)}${String(value).padStart(9)}${b.padStart(10)}${ok ? "  ok   " : "  OVER "}${why}`);
      if (!ok) over = true;
    }
    if (over && CHECK) {
      console.error("\nstore budget: something is over budget");
      process.exitCode = 1;
    }
  } finally {
    try { cli("stop"); } catch {}
    if (KEEP) console.log(`\nkept ${tmp}`);
    else rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
