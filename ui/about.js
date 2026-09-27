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

/* ---------- the update pill ----------
 * The pill in the sidebar's foot (#upd), from the daemon's `update` block.
 * Shown when the daemon says so -- the day's slot is open or the reader
 * asked, a version failed to start, the file on disk is newer than the
 * daemon -- while a restart waits for the panels to be quiet, and for one
 * session after an update landed, so a desk that came back is explained. A
 * click restarts onto the staged version once the panels are quiet; in a
 * tab, which holds no capability, on an install that is only told, or while
 * a restart waits, it opens About, which says what to run and holds Now and
 * Cancel. It was app.js's until 1.7.2; app.js fetches this file for it only
 * when there is something to say. */
let upd = null, updWaiting = false, updFresh = null, updEl = null, uc = null;
function renderUpd() {
  const u = upd, { capability, plural, version } = uc;
  let text = "", cls = "", title = "";
  const r = u && u.restart, n = r && r.waiting_on ? r.waiting_on.length : 0;
  if (u && (u.restarting || updWaiting)) { text = "Restarting…"; cls = "waiting"; title = "Claude panels come back with their conversation"; }
  else if (r) { text = n ? `Waiting on ${plural(n, "panel")}` : "Restarting…"; cls = "waiting"; title = n ? `Restarts once ${n === 1 ? "it is" : "they are"} quiet; About has Now and Cancel` : ""; }
  else if (u && u.show) {
    if (u.ready) { text = capability ? `Restart to update · ${u.ready}` : `Update ready · ${u.ready}`; cls = u.amber ? "amber" : ""; title = capability ? "Restarts once no panel is busy; Claude panels come back with their conversation" : "The window restarts it; About says more"; }
    else if (u.failed_recent) { text = `${u.failed} did not start · kept ${version || ""}`.trim(); cls = "failed"; title = "The previous version was put back; About says more"; }
    else if (u.available) { text = `${u.available} is out · how`; title = "This install is updated by hand; About says how"; }
    else if (u.stale) { text = capability ? "Restart to update" : "Update ready"; title = "The snyvi on disk is newer than the one running"; }
  }
  // Updated: once per landing, kept for the page it was first shown on.
  const at = u && u.last_applied;
  if (!text && at && Date.now() / 1000 - at < 86400 && updFresh !== -1) {
    let seen = null; try { seen = localStorage.getItem("snyvi.updated"); } catch {}
    if (updFresh === at || seen !== String(at)) {
      updFresh = at; try { localStorage.setItem("snyvi.updated", String(at)); } catch {}
      text = `Updated to ${version} · what's new`; cls = "quiet updated"; title = "About has the release notes";
    }
  }
  updEl.hidden = !text;
  if (!text) return;
  updEl.textContent = text; updEl.className = `upd ${cls}`.trim(); updEl.title = title;
  updEl.setAttribute("aria-label", title ? `${text}. ${title}` : text);
  updEl.tabIndex = updWaiting || (u && u.restarting) ? -1 : 0;
}
/** The daemon's word, whichever came first -- it or the reply to the click:
 *  from here the pill says what it says. */
export function pill(el, u, c) {
  uc = c; upd = u; updWaiting = false;
  if (!updEl) { updEl = el; el.addEventListener("click", clickUpd); }
  renderUpd();
}
async function clickUpd() {
  const u = upd, { capability, deskApi, toast, panel } = uc;
  if (!u || u.restarting || updWaiting) return;
  if (!u.restart && (u.ready || (u.stale && !u.failed_recent)) && capability) {
    updWaiting = true; renderUpd();
    // The daemon's `update` event says what the restart waits on; until
    // it comes, this pill says Restarting.
    try { await deskApi("/api/restart", { when: "idle", apply: !!u.ready }); if (upd && (upd.restart || upd.restarting)) { updWaiting = false; renderUpd(); } }
    catch (e) { updWaiting = false; renderUpd(); toast("Could not restart", e); }
    return;
  }
  if (updEl.classList.contains("updated")) { updFresh = -1; renderUpd(); }
  panel("about");
}

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
.agents-more { margin-top: 20px; }
.agents-more > summary { cursor: pointer; font-size: 14px; color: var(--fg-2); padding: 6px 0; }
.agents-more[open] > summary { margin-bottom: 8px; }
/* Welcome: the story in two lines, one question, one button. */
.welcome { max-width: 560px; padding-top: 6vh; }
.welcome .w-mark .mk { width: 44px; height: 44px; }
.welcome .doc-title { margin: 14px 0 12px; }
.w-lede { font-size: 16px; line-height: 1.55; color: var(--fg-2); margin: 0 0 36px; }
.w-q { font-size: 20px; font-weight: 600; margin: 0 0 14px; }
.w-btn { font: inherit; font-size: 14.5px; font-weight: 600; color: var(--on-accent); background: var(--accent); border: 0; border-radius: 8px; padding: 9px 16px; cursor: pointer; }
.w-btn:hover { filter: brightness(1.08); }
.w-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.w-or { margin: 26px 0 8px; font-size: 13.5px; color: var(--fg-3); }
.w-places { list-style: none; margin: 0; padding: 0; }
.w-places button { display: flex; align-items: baseline; gap: 10px; width: 100%; text-align: left; font: inherit; padding: 7px 10px; margin: 0 -10px; border-radius: 6px; color: var(--fg); }
.w-places button:hover { background: var(--rule); }
.w-places b { font-weight: 600; font-size: 14.5px; }
.w-places span { font-family: var(--mono); font-size: 12px; color: var(--fg-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.w-tab { font-size: 15px; color: var(--fg-2); }
.w-connect { margin-top: 10px; }
.w-ask-box { padding: 12px 14px; border: 1px solid var(--rule-2); border-radius: 8px; background: var(--bg-raise); }
.w-ask-box p { margin: 0 0 10px; font-size: 13.5px; line-height: 1.5; color: var(--fg-2); }
.w-ask-act { display: flex; gap: 12px; align-items: center; }
.w-said { margin: 0; font-size: 13.5px; color: var(--fg-2); }
.w-said.ok { color: var(--add-fg); }
.w-said.bad { color: var(--del-fg); margin-bottom: 6px; }
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
/* The updates row in About: the sentence, the controls after it, and the
   lines a told-only install runs under both. */
.upd-row { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; }
.upd-act { display: inline-flex; flex-wrap: wrap; gap: 4px 12px; }
.upd-act button.text { padding: 0; font-size: 13px; }
.upd-how { flex-basis: 100%; margin: 4px 0 0; padding: 6px 10px; font-family: var(--mono); font-size: 12px; line-height: 1.5; background: var(--code-bg); border-radius: var(--radius); white-space: pre-wrap; }
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
  fact("Updates", updateRow(a.update, d));
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

/** The updates row: `1.7.1 is ready · applies tomorrow, when the desks
 *  are quiet`, with `Check now` beside it, and what a press finds -- the
 *  latest, a version ready with the restart control in the row, a restart
 *  waiting for quiet with Now and Cancel, or the lines a told-only install
 *  runs. The daemon is the updater; this only says what it says
 *  (`/api/about` and `/api/update/*`). A tab holds no capability, so it
 *  reads the row and presses nothing. */
function updateRow(u, d) {
  const { rel, capability, deskApi } = d;
  const box = document.createElement("div"); box.className = "upd-row";
  const say = document.createElement("span"); say.className = "upd-say";
  const act = document.createElement("span"); act.className = "upd-act";
  const how = document.createElement("pre"); how.className = "upd-how"; how.hidden = true;
  box.append(say, act, how);
  const when = ts => { const s = ts - Date.now() / 1000; return s <= 0 ? "at the next quiet moment" : s < 3600 ? `in ${Math.max(1, Math.round(s / 60))} min` : s < 20 * 3600 ? `in ${Math.round(s / 3600)} h` : "tomorrow"; };
  const button = (label, fn) => { const b = document.createElement("button"); b.type = "button"; b.className = "text"; b.textContent = label; b.addEventListener("click", fn); return b; };
  const msg = e => String(e && e.message || e);
  // `note` is what a press here just met -- a restart the daemon refused --
  // and is said before anything the block says.
  const draw = (u, busy, note) => {
    act.replaceChildren(); how.hidden = true;
    if (!u || u.channel === "unknown") { say.textContent = "This daemon cannot say what file it runs from, so it does not update itself."; return; }
    if (u.channel === "dev") { say.textContent = "A development build: it does not check."; return; }
    const r = u.restart, n = r && r.waiting_on ? r.waiting_on.length : 0;
    const told = !!(u.how && u.how.length);
    // An old failure is history once something else is out.
    const failed = u.failed && (u.failed_recent || u.failed === u.available);
    const parts = [];
    if (busy) parts.push("Checking…");
    else if (note) parts.push(note);
    else if (u.restarting) parts.push("Restarting…");
    else if (r) parts.push(n ? `Restarting when ${n === 1 ? "a panel is" : `${n} panels are`} quiet` : "Restarting…");
    else if (failed) parts.push(`${u.failed} was applied and did not start; the previous version was kept`);
    else if (u.ready) parts.push(`${u.ready} is ready`);
    else if (u.available && u.available === u.skipped) parts.push(`You went back from ${u.skipped}; the release after it updates as usual`);
    else if (u.available && u.error) parts.push(told ? `${u.available} is out · the last check failed: ${u.error}` : `${u.available} is out · couldn't download it: ${u.error} · Check now tries again`);
    else if (u.available) parts.push(`${u.available} is out`);
    else if (u.error) parts.push(`The last check failed: ${u.error}`);
    else if (u.checked) parts.push(`You're on the latest · checked ${rel(u.checked)}`);
    else parts.push("Not checked yet");
    if (!busy && !r && u.ready) parts.push(u.auto && !u.slot_open ? `applies ${when(u.slot)}, when the desks are quiet` : "applies at the next quiet moment");
    if (!busy && !u.auto) parts.push(u.env_off ? "automatic updates off in the daemon's environment" : "automatic updates off");
    say.textContent = parts.join(" · ");
    if (busy || u.restarting) return;
    if (u.available && !u.ready && u.how && u.how.length) { how.textContent = u.how.join("\n"); how.hidden = false; }
    const notes = () => { if (u.notes) { const a = document.createElement("a"); a.href = u.notes; a.target = "_blank"; a.rel = "noopener"; a.textContent = "release notes"; act.append(a); } };
    if (!capability) { notes(); return; }
    if (r) {
      act.append(button("Now", async () => {
        try { await deskApi("/api/restart", { when: "now" }); draw({ ...u, restarting: true }, false); } catch (e) { draw(u, false, `Could not restart: ${msg(e)}`); }
      }), button("Cancel", async () => {
        try {
          const res = await fetch("/api/restart", { method: "DELETE", headers: { "x-snyvi-capability": capability } });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          draw({ ...u, restart: null }, false);
        } catch (e) { draw(u, false, `Could not call it off: ${msg(e)}`); }
      }));
      return;
    }
    if (u.ready) act.append(button("Restart to update", async () => {
      say.textContent = "Restarting when the panels are quiet…"; act.replaceChildren();
      try { const j = await deskApi("/api/restart", { when: "idle", apply: true }); draw({ ...u, restart: { apply: true, waiting_on: j.waiting_on || [] } }, false); }
      catch (e) { draw(u, false, `Could not restart: ${msg(e)}`); }
    }));
    act.append(button("Check now", async () => {
      draw(u, true);
      try { const j = await deskApi("/api/update/check", {}); draw(j.update, false); }
      catch (e) { draw({ ...u, error: msg(e) }, false); }
    }));
    if (!u.env_off) act.append(button(u.auto ? "Turn off" : "Turn on", async () => {
      try { const j = await deskApi("/api/update/auto", { on: !u.auto }); draw(j.update, false); } catch {}
    }));
    notes();
  };
  draw(u, false);
  return box;
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
export function afterReset() {
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
export function connect(a, { esc, rel, cap }) {
  const rows = a ? a.rows : [];
  const cmd = (text, cls) => `<pre class="cmd ${cls || ""}"><code>${esc(text)}</code><button type="button" class="copy" title="Copy">Copy</button></pre>`;
  const row = r => {
    const other = r.id.startsWith("sender:");
    const live = r.live || 0;
    const when = r.last_sent != null ? ` · sent ${rel(r.last_sent)}` : "";
    let say, state;
    if (other) { state = "connected"; say = `Calls itself <code>${esc(r.name)}</code>, and ${live ? "is here now" : "has sent"}: connected.`; }
    else if (r.state === "connected") { state = "connected"; say = `Registered in <code>${esc(r.file)}</code> as <code>${esc(r.command)} ${esc(r.args.join(" "))}</code>.${r.last_sent == null ? " Nothing has arrived from it yet. Restart any session that was already open: one that was running before this does not see snyvi." : ""}`; }
    else if (r.state === "stale") { state = "stale"; say = `Registered in <code>${esc(r.file)}</code> as <code>${esc(r.command)}</code>, which no longer exists — every send fails.`; }
    else if (r.state === "unreadable") { state = "stale"; say = `<code>${esc(r.file)}</code> could not be read (${esc(r.error)}), so it is not edited. Put the entry in by hand.`; }
    // Here, and nothing in its user file: registered somewhere the daemon
    // does not read -- a project's own settings, most often.
    else if (live) { state = "off"; say = r.file ? `Nothing in <code>${esc(r.file)}</code>, yet it is here: registered somewhere else, a project's own settings perhaps.` : `Here, though not set up in any file snyvi reads.`; }
    else { state = "off"; say = r.file ? `Nothing in <code>${esc(r.file)}</code>.` : `Not set up.`; }
    // An agent that is here now says so in place of "connected": a session
    // of it is open on the daemon this moment, not only set up to be.
    const word = live ? `running now${live > 1 ? ` ×${live}` : ""}` : { connected: "set up", stale: "needs fixing", off: "not set up" }[state];
    if (live) state += " is-live";
    // Claude Code, not set up, in the window: one button, which asks first.
    const button = cap && r.id === "claude" && r.state !== "connected" && r.state !== "unreadable" ? `<div class="w-connect"><button type="button" class="w-btn" data-w="connect">Connect Claude Code</button></div>` : "";
    const fix = other || r.state === "connected" ? "" :
      `<div class="agent-fix">${button}${r.state === "unreadable" ? "" : button ? "" : cmd(r.fix.command)}<details><summary>${r.state === "unreadable" ? "In" : button ? "Or from a terminal, or by hand" : "Or by hand, in"} ${button ? "" : `<code>${esc(r.fix.place)}</code>`}</summary>${button ? cmd(r.fix.command) : ""}${cmd(r.fix.snippet, "snippet")}</details></div>`;
    const i = r.instructions;
    // Claude Code set up by snyvi sends what it writes through its hooks, so
    // the instructions line is not a step it is missing.
    const line = other || !i || (r.id === "claude" && !i.present) ? "" : `<p class="agent-instr">${
      i.present ? `Asked to send what it writes, in <code>${esc(i.place)}</code>.`
      : state === "connected" ? `Not yet asked to send what it writes: the line below goes in <code>${esc(i.place)}</code>.`
      : `Then the line below, in <code>${esc(i.place)}</code>.`}</p>`;
    return `<li class="agent is-${state}" data-agent="${esc(r.id)}"><div class="agent-head"><span class="agent-dot"></span><b class="agent-name">${esc(r.name)}</b><span class="agent-state">${word}${when}</span></div><p class="agent-say">${say}</p>${fix}${line}</li>`;
  };
  const line = rows.find(r => r.instructions)?.instructions.line || "";
  // Claude Code first and always shown; any other agent only once it is set
  // up or has sent something. The rest wait under one question.
  const shown = rows.filter(r => r.id === "claude" || r.id.startsWith("sender:") || (r.state && r.state !== "not_set_up") || r.live);
  const rest = rows.filter(r => !shown.includes(r));
  return `<div class="connect"><header class="doc-head"><h1 class="doc-title">Agents</h1><p class="doc-sub">An agent sends what it writes here, and snyvi shows what it is doing in its desk. Each row is what that agent's own settings say, right now.</p></header>` +
    `<ul class="agents">${shown.map(row).join("")}</ul>` +
    (rest.length ? `<details class="agents-more"><summary>Using a different agent?</summary><ul class="agents">${rest.map(row).join("")}</ul>` +
      (line ? `<div class="connect-line"><p>The line that makes an agent send what it writes, for its instructions file or its rules setting:</p>${cmd(line)}</div>` : "") + `</details>` : "") +
    `<p class="connect-foot">From a terminal, <code>${esc(a ? a.program : "snyvi")} send PLAN.md</code> sends a file by hand. <a href="/start" data-nav="start">How snyvi works</a>.</p></div>`;
}

/** Connect Claude Code from the window, after saying what that writes. The
 *  ask replaces the button, in its place; so does the answer. `done` hears
 *  the agents as they are after it. */
export function connectAsk(b, { api, done }) {
  const box = b.closest(".w-connect") || b.parentElement;
  const was = box.innerHTML;
  box.innerHTML = `<div class="w-ask-box" role="group" aria-label="Connect Claude Code"><p>This adds snyvi to Claude Code: its MCP server in <code>~/.claude.json</code>, and hooks and a status line in <code>~/.claude/settings.json</code>, all run by this snyvi. A status line of your own is kept. <code>snyvi uninstall-claude</code> takes it all back out.</p>` +
    `<div class="w-ask-act"><button type="button" class="w-btn" data-w="connect-yes">Connect</button><button type="button" class="text" data-w="connect-no">Not now</button></div></div>`;
  box.querySelector('[data-w="connect-yes"]').focus();
  box.onclick = async e => {
    const t = e.target.closest("[data-w]");
    if (!t) return;
    e.stopPropagation();
    if (t.dataset.w === "connect-no") { box.onclick = null; box.innerHTML = was; box.querySelector("button")?.focus(); return; }
    if (t.dataset.w !== "connect-yes") return;
    box.onclick = null;
    box.innerHTML = `<p class="w-said">Connecting…</p>`;
    try {
      const j = await api("/api/agents/claude/connect", {});
      const row = j.agents && j.agents.rows.find(r => r.id === "claude");
      const ok = j.ok && row && row.state === "connected";
      box.innerHTML = ok ? `<p class="w-said ok">Connected. A Claude session started from now on sends here.</p>`
        : `<p class="w-said bad">It did not take. What it said:</p><pre class="cmd"><code>${(j.said || "").replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c])}</code></pre>`;
      done && done(j.agents, ok);
    } catch (e) { box.innerHTML = `<p class="w-said bad">Could not connect: ${String(e.message || e).replace(/[&<>]/g, "")}</p>`; }
  };
}

// ---------- /welcome ----------
/* What snyvi is, in the README's words, and one question: which project
 * first. The answer is a folder, from the desktop's own dialog or from the
 * projects snyvi already knows -- it never looks through folders itself.
 * Nothing about agents is here: that is asked inside the desk, if at all. */
export function welcome({ cap, places, home, mascot, esc }) {
  const tilde = p => (home && p.startsWith(home + "/") ? "~" + p.slice(home.length) : p);
  const ask = cap ? `<h2 class="w-q">What are you working on?</h2>` +
    `<button type="button" class="w-btn w-pick" data-w="pick">Choose its folder…</button>` +
    (places.length ? `<p class="w-or">Or one snyvi already knows:</p><ul class="w-places">${places.map((f, i) =>
      `<li><button type="button" data-w="place" data-i="${i}"><b>${esc(f.name)}</b><span>${esc(tilde(f.abs))}</span></button></li>`).join("")}</ul>` : "")
    : `<p class="w-tab">Desks live in the snyvi window: <code>snyvi app</code>.</p>`;
  return `<div class="connect welcome"><div class="w-mark">${mascot}</div>` +
    `<h1 class="doc-title">All your passion projects, in one calm place.</h1>` +
    `<p class="w-lede">More projects than hours? Give each one a desk: its folder, its agents side by side, and everything they write kept.</p>` +
    ask + `<p class="connect-foot"><a href="/start" data-nav="start">How snyvi works</a></p></div>`;
}

// ---------- /start: how snyvi works ----------
/* A page, not a tour: six sections, a paragraph and a line of keys each,
 * for someone with one document in front of them. No screenshots -- they
 * would ride in the binary, show one theme to a reader on another, and be
 * stale the day the window moves. The page shows the real window instead:
 * a "Show me" lights the element it means, where it is, with the wash an
 * arrival's row gets, and never opens, moves or changes anything; and three
 * samples are drawn with the page's own classes, inert, so they wear the
 * reader's theme, accent and font. */
const kb = (...ks) => ks.map(k => `<kbd${k === "⌘" ? " data-mod" : ""}>${k}</kbd>`).join("");
/** What each Show me lights, and what it says when that is not there. Asked
 *  at the moment of the click as well as at the draw: an arrival while the
 *  page is read makes the first one true. */
const folded = () => document.documentElement.dataset.side === "0";
const q = s => document.querySelector(s);
const SHOW = {
  arrives: { at: () => q("#tree a[data-id]") && (folded() ? q('#rail-nav [data-pop="tree"]') : q("#tree a[data-id]")),
    none: `Nothing has arrived yet. <a href="/connect" data-nav="connect">Agents</a>` },
  waiting: { at: () => q("#queue .t-queue") && (folded() ? q('#rail-nav [data-pop="inbox"]') : q("#queue .t-queue")), none: "Nothing is waiting right now." },
  desks: { at: () => startCap && (folded() ? q('#rail-nav [data-pop="desks"]') : q("#desk-nav .s-head")), none: "Desks live in the window: <code>snyvi app</code>." },
  notes: { at: () => !q("#note")?.hidden && (folded() ? q("#rail-note") : q("#note")), none: "No aside right now." },
  keys: { at: () => q("#btn-help"), none: "" },
};
let startCap = false;
const showLink = k => (SHOW[k].at() ? `<a href="#${k}" class="show-me" data-show="${k}">Show me</a>` : `<span class="show-none">${SHOW[k].none}</span>`);

/** Light the thing a section is about, and nothing else: no navigation, no
 *  focus moved, nothing opened. The foot's ? is only on screen while its
 *  column is open, so the column is held open for as long as the light is. */
function showMe(a) {
  const k = a.dataset.show, el = SHOW[k] && SHOW[k].at();
  if (!el) { a.outerHTML = `<span class="show-none">${SHOW[k].none}</span>`; return; }
  el.scrollIntoView({ block: "nearest" });
  const held = k === "keys" ? el : null;
  held?.classList.add("said");
  el.classList.remove("wash", "show-lit"); void el.offsetWidth;
  el.classList.add("wash", "show-lit");
  setTimeout(() => { el.classList.remove("wash", "show-lit"); held?.classList.remove("said"); }, 1500);
}

/** The page, drawn into the document pane. `cap` says whether this window
 *  can run desks. */
export function start({ cap }) {
  startCap = !!cap;
  const sec = (id, title, body, keys) => `<section id="${id}" class="start-sec"><h2>${title}</h2>${body}${keys ? `<p class="start-keys">${keys}</p>` : ""}</section>`;
  return `<div class="connect start"><header class="doc-head"><h1 class="doc-title">How snyvi works</h1><p class="doc-sub">Six things, a paragraph each. Every key is in ${kb("?")}.</p></header>` +
    sec("desks", "A desk for each project",
      `<p>A desk is one project's workbench: its folder, and up to four real terminal panels beside what you read, each running a shell or an agent. Make one with + beside Desks, which asks which project or folder it is for, or with the desk button on a project's or a folder's row. Everything the desk's agents send is listed on its rail, next to the panel that sent it. When an agent in a panel is waiting on you, for an answer or a permission, its row turns amber and Desks counts it. Restarting snyvi stops what runs in the panels; each comes back in its folder, and offers the conversation back with one click. ${showLink("desks")}</p>`,
      `${kb("⌃", "`")} desk / reading · ${kb("⌃", "⌥", "1")}–${kb("4")} a panel · ${kb("⌃", "⌥", "N")} new panel · ${kb("⌃", "⌥", "W")} close it (with Undo) · ${kb("⌃", "⌥", "Z")} that panel alone. Every other key goes to the panel.`) +
    sec("notes", "Out of your head: notes, points and asides",
      `<p>Three small things, each going one way. <em>Notes</em> are yours: a list kept with each desk (+ New note), ticked off as things get done. An agent in that desk's panels can read it and tick a line, and nothing more. <em>Points</em> go from you to a panel: select a passage in a document you read over a desk and press + Point for panel 2. They gather under the panel until Put it in panel 2 types them into its input, quoted. Nothing is sent until you press Enter there.</p>` +
      `<ul class="dk-list start-sample" inert aria-hidden="true"><li class="dk-note dk-point"><span class="nm">From PLAN.md: the cache is per project, not per desk</span></li></ul><button type="button" class="dk-new dk-put start-sample" inert aria-hidden="true" tabindex="-1">Put it in panel 2</button>` +
      `<p><em>Asides</em> come from an agent to you: a line about what it noticed, never a document and never counted as waiting. They sit at the foot of the sidebar. ${showLink("notes")}</p>`,
      `Right-click anything for what it can do · ${kb("☰")} or ${kb("⇧", "F10")} the same menu from the keyboard`) +
    sec("arrives", "Nothing scrolls away",
      `<p>When an agent writes something worth reading, it sends it here and replies with a link, and by the time you read the reply the document is already open. It is filed under its project, the folder the agent was working in, and under its workflow, one per Claude Code session. There is nothing to import or save: what arrives stays until you delete it, and a delete can be undone. ${showLink("arrives")}</p>`,
      `${kb("⌘", "K")} search everything · ${kb("j")} ${kb("k")} next / previous document · ${kb("/")} find in this one`) +
    sec("waiting", "What is waiting",
      `<p>A document that arrives while you read never takes the page away. It waits, as a row under Waiting in the sidebar and a count in the bar above what you are reading (or a number on the inbox icon, when the sidebar is folded). ${kb("n")} opens the oldest and takes it off, so the next ${kb("n")} is the one after: one key, in the order they came. Opening one any other way counts as read too, and Mark all read clears the list without opening anything. ${showLink("waiting")}</p>`,
      `${kb("n")} the next one waiting · ${kb("i")} the inbox · ${kb("Del")} remove, ${kb("⌘", "Z")} put it back`) +
    sec("versions", "Versions",
      `<p>A document is never changed. When an agent revises its plan it sends it again, and you keep both: the newest waits for you, the older ones are one key away. ${kb("c")} shows what changed since the one before, in green and red, and ${kb("s")} turns that between side by side and inline. Every version of the same file, from any session, is listed under Versions in the contents.</p>` +
      `<pre class="code diff start-sample" inert aria-hidden="true"><code><span class="ln hunk">@@ -3,2 +3,2 @@</span>\n<span class="ln del">-## The cache</span>\n<span class="ln del">-It lives beside each desk.</span>\n<span class="ln add">+## The cache, per project</span>\n<span class="ln add">+It is per project, not per desk.</span></code></pre>`,
      `${kb("[")} ${kb("]")} older / newer · ${kb("c")} compare · ${kb("s")} side by side / inline · ${kb("t")} contents`) +
    sec("keys", "Keys",
      `<p>The letter keys start asleep, so a ${kb("j")} meant for a terminal cannot move the page. ${kb("⌃", "B")} wakes them; a pill at the bottom says <em>Keys on</em>, and they sleep again on Esc, a click, or ten quiet seconds.</p>` +
      `<div class="keymode-sample show on" inert aria-hidden="true">Keys on · esc</div>` +
      `<p>Keys with a modifier always work. ${kb("⌘", "K")} searches everything, and a search that starts with <code>&gt;</code> lists what snyvi can do: a theme, a new desk, a folder, an agent to connect. ${showLink("keys")}</p>`,
      `${kb("⌃", "B")} letter keys · ${kb("⌘", "K")} search · ${kb("⌘", "K")} <code>&gt;</code> commands · ${kb("?")} every key · ${kb("\\")} sidebar · ${kb("Esc")} back to where you were`) +
    `<p class="connect-foot">${cap ? `Nothing here yet? <a href="/welcome" data-nav="welcome">Give a project a desk</a>. ` : ""}<a href="/connect" data-nav="connect">Agents</a>.</p></div>`;
}

/** After the page is in: the keys say ctrl off a Mac, and the pill's look is
 *  keys.js's own, fetched for the sample. */
export async function startReady(v) {
  if (!/Mac/.test(navigator.platform)) document.querySelectorAll(".start kbd[data-mod]").forEach(k => { k.textContent = "ctrl"; });
  try { (await import(`/assets/keys.js${v ? `?v=${v}` : ""}`)).sheet(); } catch {}
}
document.getElementById("doc").addEventListener("click", e => {
  const a = e.target.closest(".start .show-me");
  if (!a) return;
  e.preventDefault();
  showMe(a);
});

/* The page's own look, and the point sample's: the four rules of desk.js a
 * point row is drawn with, copied here because desk.js is a chunk a browser
 * never loads, scoped to the sample. The bench holds the copy to the real
 * one (startRows). */
const START_CSS = `
.start-sec { margin: 0 0 30px; }
.start-sec h2 { font-size: 18px; margin: 0 0 8px; }
.start-sec p { font-size: 15px; line-height: 1.6; color: var(--fg-2); margin: 0 0 10px; }
.start-keys { font-size: 13px !important; color: var(--fg-3) !important; }
.start kbd { display: inline-block; min-width: 18px; padding: 0 5px; font-family: var(--mono); font-size: 11px; line-height: 18px; text-align: center; color: var(--fg-2); background: var(--bg-side); border: 1px solid var(--rule-2); border-radius: 4px; white-space: nowrap; }
.show-me { font-size: 13px; white-space: nowrap; }
.show-none { font-size: 13px; color: var(--fg-3); }
pre.start-sample { margin: 6px 0 12px; font-size: 12.5px; }
.start-sample.dk-list { list-style: none; margin: 6px 0 0; padding: 0; max-width: 280px; }
.start-sample .dk-note { display: flex; align-items: flex-start; gap: 6px; border-radius: 6px; }
.start-sample .dk-note > .nm { flex: 1; min-width: 0; text-align: left; padding: 4px 0; font-size: 12px; line-height: 1.5; color: var(--fg-2); white-space: normal; overflow-wrap: anywhere; }
.start-sample .dk-point > .nm { padding-left: 8px; border-left: 2px solid var(--rule-2); margin-left: 8px; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow: hidden; }
button.start-sample.dk-new { display: block; padding: 3px 8px; font-size: 12px; border-radius: 6px; margin: 0 0 12px; }
button.start-sample.dk-put { color: var(--accent); }
.keymode-sample { margin: 6px 0 12px; }
.show-lit { animation-iteration-count: 2 !important; }
`;
{ const s = document.createElement("style"); s.textContent = START_CSS; document.head.append(s); }

/* The about and reset boxes, which this file builds -- in app.css until 1.7.1, and nothing on screen used them before
 * this file was loaded, so they came here to leave first paint. */
const CSS_MOVED = `
/* The update pill, which this file draws (pill). */
:root[data-side="0"] #upd:not([hidden]) { width: 10px; height: 10px; padding: 0; margin: 0; font-size: 0; }
:root[data-side="0"] #upd.quiet { display: none; }
.upd { display: inline-flex; align-items: center; gap: 5px; margin-right: 4px; padding: 1px 8px; border: 0; border-radius: 999px; background: var(--accent-bg); color: var(--accent); font: inherit; font-size: 11px; font-weight: 600; line-height: 16px; cursor: pointer; white-space: nowrap; transition: background var(--t), color var(--t); }
.upd[hidden] { display: none; }
.upd:hover { color: var(--fg); }
.upd.amber { background: color-mix(in srgb, var(--warn) 16%, transparent); color: var(--warn); }
.upd.failed { background: var(--del); color: var(--del-fg); }
.upd.waiting { opacity: .7; }
.upd.waiting[tabindex="-1"] { cursor: default; }
.upd.quiet { background: none; color: var(--fg-3); font-weight: 500; }
.about-box { width: min(560px, 92vw); }
.about-box p { margin: 0 0 14px; font-size: 14px; color: var(--fg-2); }
.about-box dl { grid-template-columns: max-content 1fr; gap: 7px 20px; }
.about-box dt { font-family: inherit; font-size: 13px; color: var(--fg-3); }
.about-box dd { min-width: 0; overflow-wrap: anywhere; }
.about-box dd.path { font-family: var(--mono); font-size: 12.5px; }
.about-box dd.pre { white-space: pre-line; }
.about-box .muted { color: var(--fg-3); }
.about-box a { color: var(--accent); text-decoration: none; }
.about-box a:hover { text-decoration: underline; }
.reset-box { width: min(520px, 92vw); margin: 0; }
.reset-box p { margin: 0 0 12px; font-size: 14px; line-height: 1.5; }
.reset-box label { display: block; font-size: 14px; margin: 0 0 12px; }
.reset-box label[hidden] { display: none; }
.reset-ask input { display: block; width: 100%; margin-top: 6px; font: inherit; font-family: var(--mono); font-size: 15px; padding: 8px 10px; border: 1px solid var(--rule-2); border-radius: 6px; background: var(--bg); color: inherit; outline: none; }
.reset-ask input:focus { border-color: var(--accent); }
.reset-err { color: var(--del-fg); }
/* "Also the pinned ones", drawn as a document's checkbox is, in the danger colour once ticked. */
#reset-pinned { appearance: none; position: relative; width: 14px; height: 14px; margin: 0 6px -2px 0; border: 1.5px solid var(--rule-2); border-radius: 4px; background: var(--bg-raise); cursor: pointer; }
#reset-pinned:checked { background: var(--danger); border-color: var(--danger); }
#reset-pinned:checked::after { content: ""; position: absolute; left: 3.5px; top: 0; width: 4px; height: 8px; border: solid var(--on-accent); border-width: 0 2px 2px 0; transform: rotate(45deg); }
#reset-pinned:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.reset-act { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
/* The Reset button's own: this sheet stays in the page once fetched, and a
   bare \`button.danger\` would paint the context menu's danger rows too. */
.reset-act button.danger { font: inherit; font-size: 13px; font-weight: 550; color: var(--on-accent); background: var(--danger); border: 0; padding: 6px 14px; border-radius: 6px; cursor: pointer; }
.reset-act button.danger:hover { background: color-mix(in srgb, var(--danger), var(--fg) 12%); }
.reset-act button.danger:disabled { opacity: .4; cursor: default; }
.reset-act button.danger:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
`;
{ const s = document.createElement("style"); s.textContent = CSS_MOVED; document.head.append(s); }
