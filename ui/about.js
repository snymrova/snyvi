/* What this is, and the one thing that cannot be undone.
 *
 * A chunk, like the desk view, the diagram driver and the game -- fetched the
 * first time the reader opens either panel and never before. Neither is on the
 * way to reading a document: one says which build is answering, the other
 * empties the library, and a first paint that has never been asked for either
 * pays for neither.
 *
 * Both already went to the daemon when they opened -- `/api/about` for the
 * facts, `/api/reset` for the census -- so the fetch that brings this module
 * is the one the panel was going to make anyway, on the same localhost.
 *
 * The connect page came here too, for the same reason: it is what an empty
 * library shows, and what `?` reaches, and a reader with documents to read
 * never draws it.
 *
 * The page owns the markup and the dialog helpers; this owns what goes in
 * them. Everything it needs arrives in `d`, so nothing here reaches into the
 * page's scope and the seam is one object.
 */

let wired = false;

/** Open a panel, building and wiring the boxes the first time. `which` is
 *  "about", "reset", or "help" for the shortcuts card's rows. The listeners
 *  go on once: a panel opened twice is the same dialog. */
export function open(which, d) {
  if (!wired) { fill(d); wire(d); wired = true; }
  return which === "help" ? fillHelp(d) : which === "about" ? openAbout(d) : openReset(d);
}

/* The about and reset boxes are empty shells in index.html -- an id for the
 * scripts that close every dialog on Esc -- and are built here the first
 * time either is asked for, since nothing else ever shows them. */
const ABOUT = `
<div class="help-box about-box" role="dialog" aria-modal="true" aria-labelledby="about-title" tabindex="-1">
  <button class="icon help-close" id="about-close" title="Close (Esc)" aria-label="Close">✕</button>
  <h2 id="about-title">snyvi</h2>
  <p id="about-say">A fast, beautiful viewer for the documents your agents produce.</p>
  <dl id="about-facts"></dl>
</div>
`;
const RESET = `
<form class="help-box reset-box" role="dialog" aria-modal="true" aria-labelledby="reset-title" tabindex="-1">
  <button class="icon help-close" id="reset-close" type="button" title="Close (Esc)" aria-label="Close">✕</button>
  <h2 id="reset-title">Reset snyvi</h2>
  <p id="reset-say">Reading what there is…</p>
  <label id="reset-pinned-row" hidden><input type="checkbox" id="reset-pinned"> <span id="reset-pinned-say"></span></label>
  <label class="reset-ask">Type the number of documents to continue
    <input id="reset-n" type="text" inputmode="numeric" autocomplete="off" spellcheck="false" aria-describedby="reset-say">
  </label>
  <p id="reset-err" class="reset-err" role="alert" hidden></p>
  <div class="reset-act"><button class="text" type="button" id="reset-cancel">Cancel</button><button class="danger" type="submit" id="reset-go" disabled>Reset</button></div>
</form>
`;
// ---------- the shortcuts card: its rows ride here, not in index.html ----------
/* The card's shell -- title, close, the foot's three buttons -- is in
 * index.html so `?` opens it at once; the two columns of keys are 3 KB of
 * markup nobody reads at first paint, so they arrive with this chunk and
 * are put in the first time the card opens. The rules that lay them out
 * came with them, and the connect page's with its markup below, by the same
 * argument: a style the page cannot need before the chunk is loaded is not
 * first paint's to carry. */
const HELP = `
<div class="help-col">
  <section>
    <h3>Everywhere</h3>
    <div class="hk"><span>Letter keys on / off</span><span class="keys"><kbd>⌃</kbd><kbd>B</kbd></span></div>
    <div class="hk"><span>Search</span><span class="keys"><kbd data-mod>⌘</kbd><kbd>K</kbd></span></div>
    <div class="hk"><span>These shortcuts</span><span class="keys"><kbd>?</kbd></span></div>
    <div class="hk"><span>Close</span><span class="keys"><kbd>esc</kbd></span></div>
  </section>
  <section>
    <h3>Move</h3>
    <div class="hk"><span>Next / previous document</span><span class="keys"><kbd>j</kbd><i>/</i><kbd>k</kbd></span></div>
    <div class="hk"><span>Older / newer version</span><span class="keys"><kbd>[</kbd><i>/</i><kbd>]</kbd></span></div>
    <div class="hk"><span>The next document waiting</span><span class="keys"><kbd>n</kbd></span></div>
    <div class="hk"><span>Inbox</span><span class="keys"><kbd>i</kbd></span></div>
    <div class="hk"><span>Back / forward</span><span class="keys"><kbd>alt</kbd><kbd>←</kbd><i>/</i><kbd>→</kbd></span></div>
    <div class="hk"><span>Go to a line</span><span class="keys"><kbd data-mod>⌘</kbd><kbd>K</kbd><code>:120</code></span></div>
  </section>
  <section>
    <h3>Read</h3>
    <div class="hk"><span>Find in document</span><span class="keys"><kbd>/</kbd></span></div>
    <div class="hk"><span>Compare with previous version</span><span class="keys"><kbd>c</kbd></span></div>
    <div class="hk"><span>Split / inline diff</span><span class="keys"><kbd>s</kbd></span></div>
    <div class="hk"><span>Preview / source</span><span class="keys"><kbd>v</kbd></span></div>
    <div class="hk"><span>Maximise width</span><span class="keys"><kbd>w</kbd></span></div>
    <div class="hk"><span>Wrap long lines</span><span class="keys"><kbd>z</kbd></span></div>
    <div class="hk"><span>Open source</span><span class="keys"><kbd>o</kbd></span></div>
  </section>
</div>
<div class="help-col" id="help-col-2">
  <section>
    <h3>Diagram</h3>
    <div class="hk"><span>Fullscreen</span><span class="keys"><kbd>f</kbd></span></div>
    <div class="hk"><span>Fit to window</span><span class="keys"><kbd>0</kbd></span></div>
    <div class="hk"><span>Zoom</span><span class="keys"><kbd data-mod>⌘</kbd><i>+</i>scroll</span></div>
    <div class="hk"><span>Pan</span><span class="keys">drag</span></div>
  </section>
  <section>
    <h3>Layout</h3>
    <div class="hk"><span>Contents</span><span class="keys"><kbd>t</kbd></span></div>
    <div class="hk"><span>Sidebar</span><span class="keys"><kbd>\</kbd></span></div>
  </section>
  <section>
    <h3>Keep</h3>
    <div class="hk"><span>Pin <em>kept by prune</em></span><span class="keys"><kbd>p</kbd></span></div>
    <div class="hk"><span>Delete</span><span class="keys"><kbd>del</kbd></span></div>
    <div class="hk"><span>Undo a delete</span><span class="keys"><kbd data-mod>⌘</kbd><kbd>Z</kbd></span></div>
  </section>
</div>
`;

function fillHelp(d) {
  const { help } = d;
  if (help.querySelector(".hk")) return;
  help.querySelector(".help-body").innerHTML = HELP;
  // The native window adds its own rows (ui/frame.js) once these are in.
  help.dispatchEvent(new Event("snyvi:help"));
  // The chip that says ⌘ says it on a Mac; everywhere else the key is ctrl.
  if (!/Mac/.test(navigator.platform)) help.querySelectorAll("kbd[data-mod]").forEach(k => { k.textContent = "ctrl"; });
}

const CSS = `
/* The connect page: one row per agent, the state as a dot and a word, and
 * everything to paste in a block with its own Copy. It sits in the document
 * pane at the document's measure, so it reads as a page and not as chrome. */
.connect .agents { list-style: none; margin: 0; padding: 0; }
.agent { padding: 16px 0; border-top: 1px solid var(--rule); }
.agent:last-child { border-bottom: 1px solid var(--rule); }
.agent-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.agent-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--fg-3); align-self: center; flex: none; }
.agent.is-connected .agent-dot { background: var(--add-fg); }
/* Here now: the accent, with a ring, so an open session reads apart from one that is only set up. */
.agent.is-live .agent-dot { background: var(--accent); box-shadow: 0 0 0 3px var(--accent-bg); }
.agent.is-live .agent-state { color: var(--accent); }
.agent.is-stale .agent-dot { background: var(--del-fg); }
.agent-name { font-size: 16px; font-weight: 600; }
.agent-state { color: var(--fg-3); font-size: 13px; }
.agent-say { margin: 6px 0 0; font-size: 14.5px; color: var(--fg-2); line-height: 1.5; }
.connect code { font-family: var(--mono); font-size: 12.5px; }
.agent-fix { margin-top: 10px; }
.agent-instr { margin: 8px 0 0; font-size: 13.5px; color: var(--fg-3); }
.connect-line { margin-top: 28px; }
.connect-line p { margin: 0 0 8px; font-size: 14px; color: var(--fg-2); }
pre.cmd { position: relative; font-family: var(--mono); font-size: 13px; line-height: 1.55; background: var(--code-bg); border-radius: var(--radius); padding: 8px 72px 8px 12px; margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
pre.cmd code { background: none; padding: 0; font-size: inherit; }
pre.cmd .copy { position: absolute; top: 6px; right: 8px; font: inherit; font-family: var(--sans); font-size: 11px; padding: 3px 8px; border-radius: 4px; background: var(--bg-raise); color: var(--fg-2); box-shadow: 0 1px 2px rgba(0,0,0,.12); border: 0; cursor: pointer; }
pre.cmd .copy:hover { color: var(--fg); }
pre.cmd .copy:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.agent-fix details { margin-top: 8px; }
.agent-fix summary { cursor: pointer; font-size: 13px; color: var(--fg-3); }
.agent-fix details[open] summary { margin-bottom: 6px; }
.connect-foot { margin-top: 24px; color: var(--fg-3); font-size: 13.5px; }
.help-body { flex: 1; min-height: 0; overflow-y: auto; display: grid; grid-template-columns: 1fr 1fr; gap: 0 40px; padding: 4px 24px 8px; scrollbar-width: thin; scrollbar-color: var(--rule-2) transparent; }
.help-col { display: flex; flex-direction: column; gap: 18px; align-content: start; }
.help-col h3 { margin: 0 0 2px; font-size: 11px; font-weight: 600; letter-spacing: .01em; color: var(--fg-3); }
.hk { display: flex; align-items: center; gap: 12px; min-height: 30px; padding: 1px 0; border-top: 1px solid var(--rule); font-size: 13.5px; color: var(--fg); }
.hk:first-of-type { border-top: 0; }
.hk > span:first-child { flex: 1; min-width: 0; line-height: 1.3; }
.hk em { font-style: normal; font-size: 12px; color: var(--fg-3); }
.hk .keys { flex: none; display: inline-flex; align-items: center; gap: 3px; font-size: 12px; color: var(--fg-3); }
.hk .keys i { font-style: normal; font-size: 11px; padding: 0 1px; }
.hk .keys code { font-family: var(--mono); font-size: 11px; color: var(--fg-2); background: var(--rule); padding: 0 5px; border-radius: 4px; line-height: 18px; }
#help kbd { display: inline-block; box-sizing: border-box; min-width: 20px; padding: 0 5px; font-family: var(--mono); font-size: 11px; line-height: 18px; text-align: center; color: var(--fg-2); background: var(--bg-side); border: 1px solid var(--rule-2); border-radius: 4px; white-space: nowrap; }
.help-col .help-note { margin: 8px 0 0; font-size: 12px; line-height: 1.4; color: var(--fg-3); }
@media (max-width: 600px) {
  .help-body { grid-template-columns: 1fr; }
  #help-col-2 { margin-top: 18px; }
}
`;
{
  const st = document.createElement("style");
  st.id = "about-css";
  st.textContent = CSS;
  document.head.append(st);
}

function fill(d) {
  d.aboutDlg.innerHTML = ABOUT;
  d.resetDlg.innerHTML = RESET;
}

function wire(d) {
  const { $, closeDialog, aboutDlg, resetDlg } = d;
  $("#about-close").addEventListener("click", () => closeDialog(aboutDlg));
  aboutDlg.addEventListener("click", e => { if (e.target === aboutDlg) closeDialog(aboutDlg); });
  $("#reset-close").addEventListener("click", () => closeDialog(resetDlg));
  $("#reset-cancel").addEventListener("click", () => closeDialog(resetDlg));
  resetDlg.addEventListener("click", e => { if (e.target === resetDlg) closeDialog(resetDlg); });
  $("#reset-n").addEventListener("input", () => resetArm(d));
  $("#reset-pinned").addEventListener("change", () => resetArm(d));
  resetDlg.firstElementChild.addEventListener("submit", e => submitReset(e, d));
}

// ---------- about: what this is, from the daemon ----------
/* Every number here is read from the daemon when the panel opens, not
 * baked into this bundle, so the version it names is the one answering
 * and the one `snyvi --version` prints. */
async function openAbout(d) {
  const { $, openDialog, closeDialog, help, aboutDlg } = d;
  const aboutFacts = $("#about-facts");
  closeDialog(help);
  aboutFacts.replaceChildren();
  openDialog(aboutDlg, aboutDlg.firstElementChild);
  let a;
  try { a = await (await fetch("/api/about")).json(); } catch { $("#about-say").textContent = "The daemon did not answer."; return; }
  $("#about-say").textContent = `${a.description}.`;
  const fact = (k, v, cls) => {
    if (v == null || v === "") return;
    const dt = document.createElement("dt"); dt.textContent = k;
    const dd = document.createElement("dd"); if (cls) dd.className = cls;
    if (v instanceof Node) dd.append(v); else dd.textContent = v;
    aboutFacts.append(dt, dd);
  };
  const ver = document.createDocumentFragment();
  ver.append(a.version);
  const build = [a.commit, a.target].filter(Boolean).join(", ");
  if (build) { const m = document.createElement("span"); m.className = "muted"; m.textContent = ` (${build})`; ver.append(m); }
  fact("Version", ver);
  fact("Binary", a.binary, "path");
  fact("Documents", a.data_dir, "path");
  fact("Settings", a.config_dir, "path");
  fact("Theme", themeFact());
  fact("Agents", a.agents, "pre");
  fact("License", a.license);
  if (a.repository) {
    const link = document.createElement("a"); link.href = a.repository; link.target = "_blank"; link.rel = "noopener";
    link.textContent = a.repository.replace(/^https?:\/\//, "");
    fact("Source", link);
  }
}

/** The three `snyvi.theme.*` keys, said as a sentence: your light theme,
 *  your dark one, and which of them the window is following. */
function themeFact() {
  const get = k => { try { return localStorage.getItem(k) || ""; } catch { return ""; } };
  const name = k => k ? k[0].toUpperCase() + k.slice(1) : k;
  const light = name(get("snyvi.theme.light") || "paper"), dark = name(get("snyvi.theme.dark") || "ink"), follow = get("snyvi.theme.follow");
  return `${light} by day, ${dark} by night, ${follow ? `${follow === "dark" ? dark : light} chosen` : "following the system"}`;
}

// ---------- reset: the one thing that cannot be undone ----------
/* A delete has Undo; this has a number. The dialog says what goes and what
 * stays, and the button stays dead until the number of documents is typed
 * back -- the number, not "yes", because the number means the sentence was
 * read. The daemon is sent that number and refuses if it is no longer
 * true, so a document that arrived while the dialog was open is not reset
 * unseen. Every open tab hears the event and comes back to the empty
 * library with its preferences dropped; the agents stay registered. */
let resetCensus = null;

function resetArm(d) {
  const { $ } = d;
  const pin = $("#reset-pinned");
  $("#reset-go").disabled = !resetCensus || $("#reset-n").value.trim() !== String(resetCensus.documents) || (resetCensus.pinned > 0 && !pin.checked);
}

/** The documents and the desks both, because the daemon checks both. */
const resetSentence = (c, plural) => `This removes ${plural(c.documents, "document")} in ${plural(c.projects, "project")}, ${c.desks ? plural(c.desks, "desk") + " and their panels, " : ""}the index, the token and this page's preferences. Agents stay connected: the next document they send lands in an empty library. Nothing can be undone.`;

async function openReset(d) {
  const { $, openDialog, closeDialog, help, resetDlg, plural } = d;
  const resetSay = $("#reset-say"), resetN = $("#reset-n"), resetErr = $("#reset-err");
  const resetPinRow = $("#reset-pinned-row"), resetPin = $("#reset-pinned");
  closeDialog(help);
  resetCensus = null; resetN.value = ""; resetErr.hidden = true; resetPin.checked = false; resetPinRow.hidden = true;
  resetSay.textContent = "Reading what there is…";
  resetArm(d);
  openDialog(resetDlg, resetN);
  try { resetCensus = await (await fetch("/api/reset")).json(); } catch { resetSay.textContent = "The daemon did not answer."; return; }
  resetSay.textContent = resetSentence(resetCensus, plural);
  if (resetCensus.pinned > 0) {
    $("#reset-pinned-say").textContent = `Also the ${plural(resetCensus.pinned, "pinned document")} — a pin means keep`;
    resetPinRow.hidden = false;
  }
  resetArm(d);
}

/** Drop the preferences and start over. The drop is done again by boot.js
 *  on the page that lands, because this page is still running until the
 *  navigation commits, and a task it already queued -- the toggle event a
 *  rendered `<details open>` fires, which writes `snyvi.open` -- can run
 *  after the drop here. Seen once in CI: one key back in storage. */
function afterReset() {
  try { sessionStorage.setItem("snyvi.reset", "1"); } catch {}
  try { Object.keys(localStorage).filter(k => k.startsWith("snyvi.")).forEach(k => localStorage.removeItem(k)); } catch {}
  location.replace("/");
}

async function submitReset(e, d) {
  const { $, plural } = d;
  const resetGo = $("#reset-go"), resetErr = $("#reset-err"), resetPin = $("#reset-pinned");
  e.preventDefault();
  if (resetGo.disabled) return;
  resetGo.disabled = true; resetGo.textContent = "Resetting…";
  let r;
  try {
    r = await fetch("/api/reset", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ documents: resetCensus.documents, desks: resetCensus.desks || 0, pinned: resetPin.checked }) });
  } catch { resetGo.textContent = "Reset"; resetErr.textContent = "The daemon did not answer."; resetErr.hidden = false; return; }
  if (r.ok) { afterReset(); return; }
  resetGo.textContent = "Reset";
  let j = {}; try { j = await r.json(); } catch {}
  resetErr.textContent = j.error || `The daemon refused (${r.status}).`;
  resetErr.hidden = false;
  // The number has moved: say the new sentence and ask for the new number.
  if (j.census) { resetCensus = j.census; $("#reset-n").value = ""; $("#reset-say").textContent = resetSentence(j.census, plural); }
  resetArm(d);
}

/** The connect page: one row per agent, from /api/agents. The page keeps
 *  the timer that asks again; the copy buttons are wired here, once, on
 *  the document pane the page is drawn into. */
document.getElementById("doc").addEventListener("click", e => {
  const b = e.target.closest(".connect pre.cmd .copy");
  if (!b) return;
  navigator.clipboard?.writeText(b.parentElement.querySelector("code").textContent);
  b.textContent = "Copied"; setTimeout(() => (b.textContent = "Copy"), 1200);
});
export function connect(a, { esc, rel }) {
  const rows = a ? a.rows : [];
  const cmd = (text, cls) => `<pre class="cmd ${cls || ""}"><code>${esc(text)}</code><button type="button" class="copy" title="Copy">Copy</button></pre>`;
  const row = r => {
    const other = r.id.startsWith("sender:");
    const live = r.live || 0;
    const when = r.last_sent != null ? ` · sent ${rel(r.last_sent)}` : "";
    let say, state;
    if (other) { state = "connected"; say = `Calls itself <code>${esc(r.name)}</code>, and ${live ? "is here now" : "has sent"}: connected.`; }
    else if (r.state === "connected") { state = "connected"; say = `Registered in <code>${esc(r.file)}</code> as <code>${esc(r.command)} ${esc(r.args.join(" "))}</code>.${r.last_sent == null ? " Nothing has arrived from it yet." : ""}`; }
    else if (r.state === "stale") { state = "stale"; say = `Registered in <code>${esc(r.file)}</code> as <code>${esc(r.command)}</code>, which no longer exists — every send fails.`; }
    else if (r.state === "unreadable") { state = "stale"; say = `<code>${esc(r.file)}</code> could not be read (${esc(r.error)}), so it is not edited. Put the entry in by hand.`; }
    // Here, and nothing in its user file: registered somewhere the daemon
    // does not read -- a project's own settings, most often.
    else if (live) { state = "off"; say = r.file ? `Nothing in <code>${esc(r.file)}</code>, yet it is here: registered somewhere else, a project's own settings perhaps.` : `Here, though not set up in any file snyvi reads.`; }
    else { state = "off"; say = r.file ? `Nothing in <code>${esc(r.file)}</code>.` : `Not set up.`; }
    // An agent that is here now says so in place of "connected": a session
    // of it is open on the daemon this moment, not only set up to be.
    const word = live ? `online${live > 1 ? ` ×${live}` : ""}` : { connected: "connected", stale: "needs fixing", off: "not set up" }[state];
    if (live) state += " is-live";
    const fix = other || r.state === "connected" ? "" :
      `<div class="agent-fix">${r.state === "unreadable" ? "" : cmd(r.fix.command)}<details><summary>${r.state === "unreadable" ? "In" : "Or by hand, in"} <code>${esc(r.fix.place)}</code></summary>${cmd(r.fix.snippet, "snippet")}</details></div>`;
    const i = r.instructions;
    const line = other || !i ? "" : `<p class="agent-instr">${
      i.present ? `Asked to send what it writes, in <code>${esc(i.place)}</code>.`
      : state === "connected" ? `Not yet asked to send what it writes: the line below goes in <code>${esc(i.place)}</code>.`
      : `Then the line below, in <code>${esc(i.place)}</code>.`}</p>`;
    return `<li class="agent is-${state}" data-agent="${esc(r.id)}"><div class="agent-head"><span class="agent-dot"></span><b class="agent-name">${esc(r.name)}</b><span class="agent-state">${word}${when}</span></div><p class="agent-say">${say}</p>${fix}${line}</li>`;
  };
  const line = rows.find(r => r.instructions)?.instructions.line || "";
  return `<div class="connect"><header class="doc-head"><h1 class="doc-title">Connect an agent</h1><p class="doc-sub">Any agent that speaks MCP can send documents here. Each row is what that agent's own settings say about snyvi, right now.</p></header>` +
    `<ul class="agents">${rows.map(row).join("")}</ul>` +
    (line ? `<div class="connect-line"><p>The line that makes an agent send what it writes, for its instructions file or its rules setting:</p>${cmd(line)}</div>` : "") +
    `<p class="connect-foot">From a terminal, <code>${esc(a ? a.program : "snyvi")} send PLAN.md</code> sends a file by hand.</p></div>`;
}
