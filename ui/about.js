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

/* ---------- updates that ask ----------
 * From the daemon's `update` block, four things, none of which moves
 * anything on the page:
 *
 * - a 6 px dot on the mascot, which says there is something (`html[data-upd]`);
 *   its words are the mark's tip and a live line for a screen reader (#upd);
 * - the update card, laid over the foot of the sidebar above the aside card:
 *   *Update when quiet*, *Now* and *Later*; who a restart waits on, by name;
 *   a confirm in the card when *Now* would end a panel's work; the lines to
 *   run for an install snyvi does not update itself. Home draws the same card
 *   (`card`);
 * - a strip over the top of the main area while snyvi restarts, not a modal:
 *   the page reloads onto the new version when it is back;
 * - "Updated to X", once per landing, as a toast whose action is what's new.
 *
 * "Later" is the daemon's (`snoozed_until`), so every window agrees. A tab
 * holds no capability: it reads the card and presses nothing but About. */
let upd = null, updWaiting = false, updFresh = null, updEl = null, uc = null, sure = false, cardEl = null, peekWas = null, peekUntil = 0, peekTimer = 0;
const later = () => {
  // Tomorrow morning, in the reader's own time: 8 o'clock, at least an hour off.
  const t = new Date(); t.setHours(8, 0, 0, 0);
  if (t.getTime() < Date.now() + 3600e3) t.setDate(t.getDate() + 1);
  return Math.floor(t.getTime() / 1000);
};
const since = t => { const m = Math.max(0, Math.round((Date.now() / 1000 - t) / 60)); return m < 1 ? "just now" : m < 60 ? `${m} m` : `${Math.round(m / 60)} h`; };
/** Who a restart waits on, the way the rail names them. */
const named = w => [w.desk && `${w.desk} · panel ${w.slot}`, w.agent === "needs_you" ? "waiting on you" : w.agent === "working" ? `Claude working${w.since ? ` ${since(w.since)}` : ""}` : "printing"].filter(Boolean).join(" · ");

/** What the update block says now: the dot's class, one line, and the card's
 *  state, or nothing. */
function said(u) {
  const { capability, plural, version } = uc;
  const r = u && u.restart, w = (r && r.waiting) || [], n = r && r.waiting_on ? r.waiting_on.length : 0;
  if (u && (u.restarting || (updWaiting && r && r.now))) return { dot: "waiting", line: `Restarting${u.ready ? ` to ${u.ready}` : ""}`, card: "restarting" };
  if (r) return n ? { dot: "waiting", line: `Waiting on ${plural(n, "panel")}`, card: "waiting", w } : { dot: "waiting", line: "Waiting for a check…", card: "waiting", w };
  if (!u || !u.show) return null;
  if (u.failed_recent) return { dot: "failed", line: `${u.failed} did not start · kept ${version || ""}`.trim(), card: "failed" };
  if (u.ready) return { dot: u.amber ? "amber" : "ready", line: capability ? `snyvi ${u.ready} is ready` : `Update ready · ${u.ready}`, card: "ready" };
  if (u.available) return { dot: "ready", line: `snyvi ${u.available} is out`, card: "told" };
  if (u.stale) return { dot: "ready", line: "A newer snyvi is on disk", card: "stale" };
  return null;
}

function renderUpd() {
  const u = upd, { version, toast, panel } = uc;
  const s = said(u);
  const root = document.documentElement;
  if (s) root.dataset.upd = s.dot; else delete root.dataset.upd;
  // The mark's tip carries the line; the card below it has the controls.
  const brand = document.querySelector(".side-head .brand");
  if (brand) { if (s) { brand.dataset.tip = "Home"; brand.dataset.tipSub = s.line; } else delete brand.dataset.tipSub; }
  updEl.hidden = !s;
  updEl.textContent = s ? s.line : "";
  drawCard(s);
  strip(s && s.card === "restarting" ? s.line : "");
  // Updated: once per landing, kept for the page it was first shown on, as a
  // toast whose action is the release notes.
  const at = u && u.last_applied;
  if (!s && at && Date.now() / 1000 - at < 3600 && uc.landed) uc.landed(version, at * 1000);
  if (!s && at && Date.now() / 1000 - at < 86400 && updFresh !== at) {
    let seen = null; try { seen = localStorage.getItem("snyvi.updated"); } catch {}
    updFresh = at;
    if (seen !== String(at)) {
      try { localStorage.setItem("snyvi.updated", String(at)); } catch {}
      toast(`Updated to ${version}`, { sub: "your panels came back as they were", action: { label: "What's new", run: () => panel("about") } });
    }
  }
}

/** The card's words and buttons for state `s`, into `el`. Home's snyvi widget
 *  draws it too, with its own element. Returns false when there is nothing. */
export function card(el, u, c) {
  if (c) uc = c;
  if (u !== undefined) upd = u;
  const s = said(upd);
  el.hidden = !s;
  if (!s) { el.replaceChildren(); return false; }
  const { capability, esc = x => String(x) } = uc;
  const b = (label, act, cls = "") => `<button type="button" class="uc-b${cls ? " " + cls : ""}" data-uc="${act}">${label}</button>`;
  let body = "", acts = "";
  if (s.card === "ready" || s.card === "stale") {
    body = `<p class="uc-sub">Claude panels come back with their conversation. <button type="button" class="uc-link" data-uc="notes">What's new</button></p>`;
    acts = capability ? b("Update when quiet", "idle", "go") + b("Now", "now") + b("Later", "later") : `<p class="uc-sub">The snyvi window updates it.</p>`;
  } else if (s.card === "waiting" && sure && s.w.length) {
    // Now, with a panel busy, ends its work: said here, in the card, before
    // it happens. The restart already waits for quiet, so "Wait" is a no.
    body = `<p class="uc-sub">Now ends what ${s.w.length === 1 ? "this panel is" : "these panels are"} doing:</p><ul class="uc-who">${s.w.map(w => `<li>${esc(named(w))}</li>`).join("")}</ul>`;
    acts = b("Restart now", "now-sure", "danger") + b("Wait for quiet", "wait");
  } else if (s.card === "waiting") {
    body = s.w.length ? `<ul class="uc-who">${s.w.map(w => `<li>${esc(named(w))}</li>`).join("")}</ul>` : `<p class="uc-sub">snyvi looks again in a moment.</p>`;
    acts = capability ? b("Now", "now") + b("Cancel", "cancel") : "";
  } else if (s.card === "restarting") {
    body = `<p class="uc-sub">Back in a moment; this page reloads when it is.</p>`;
  } else if (s.card === "told") {
    const how = (upd.how || []).join("\n");
    body = `<p class="uc-sub">This install is updated by hand:</p>` + (how ? `<div class="uc-how"><pre>${esc(how)}</pre><button type="button" class="uc-b" data-uc="copy">Copy</button></div>` : "");
    acts = (capability ? b("Later", "later") : "") + b("About", "about");
  } else if (s.card === "failed") {
    body = `<p class="uc-sub">The version before was put back.</p>`;
    acts = b("About", "about");
  }
  // snyvi behind the sidebar's card, as it is behind an aside (docs/DESIGN.md
  // §2.2's peek): at rest, for the cards that offer something -- an update
  // ready, one out, a newer binary on disk -- and not while it waits, restarts
  // or failed. Home's copy of the card carries no face (§2.3).
  const peek = el === cardEl && uc.peek && (s.card === "ready" || s.card === "stale" || s.card === "told") ? `<span class="uc-bg">${uc.peek("rest")}</span>` : "";
  el.innerHTML = `<div class="uc" data-state="${s.card}" role="status">${peek}<p class="uc-t">${s.card === "waiting" || s.card === "restarting" ? DOTS : ""}${esc(s.line)}</p>${body}${acts ? `<div class="uc-acts">${acts}</div>` : ""}</div>`;
  if (!el.dataset.ucWired) { el.dataset.ucWired = "1"; el.addEventListener("click", e => { const t = e.target.closest("[data-uc]"); if (t) act(t.dataset.uc, t, el); }); }
  return true;
}

async function act(what, btn, el) {
  const u = upd, { deskApi, toast, panel, copied } = uc;
  const redraw = () => { renderUpd(); if (el !== cardEl) card(el); };
  const restart = async now => {
    updWaiting = true; sure = false; redraw();
    try {
      const j = await deskApi("/api/restart", { when: now ? "now" : "idle", apply: !!u.ready });
      if (!upd.restart) upd = { ...upd, restart: { apply: !!u.ready, now, waiting_on: j.waiting_on || [], waiting: j.waiting || [] } };
    } catch (e) { toast("Could not restart", { sub: e, at: btn }); }
    updWaiting = false; redraw();
  };
  if (what === "idle") return restart(false);
  if (what === "now-sure") return restart(true);
  if (what === "wait") { sure = false; return redraw(); }
  if (what === "now") {
    // Asked for when quiet first: with nothing busy that is at once, and
    // with a panel busy the card says whose work Now would end.
    if (!u.restart) await restart(false);
    const w = (upd.restart && upd.restart.waiting) || [];
    if (!w.length) return upd.restart ? restart(true) : undefined;
    sure = true;
    return redraw();
  }
  if (what === "cancel") {
    try {
      const res = await fetch("/api/restart", { method: "DELETE", headers: { "x-snyvi-capability": uc.capability } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      upd = { ...upd, restart: null }; sure = false; redraw();
    } catch (e) { toast("Could not cancel", { sub: e, at: btn }); }
    return;
  }
  if (what === "later") {
    try { const j = await deskApi("/api/update/later", { until: later() }); upd = j.update; sure = false; redraw(); toast("Later", { sub: "snyvi asks again tomorrow morning", at: btn }); }
    catch (e) { toast("Could not put it off", { sub: e, at: btn }); }
    return;
  }
  if (what === "copy") return copied ? copied((u.how || []).join("\n"), btn) : navigator.clipboard?.writeText((u.how || []).join("\n"));
  if (what === "notes" || what === "about") return panel("about");
}

/** The card at the sidebar's foot: over the tree, above the aside card, so
 *  its coming and going moves nothing. The tree keeps room for both. */
function drawCard(s) {
  const side = document.getElementById("side");
  if (!side) return;
  if (!cardEl) {
    cardEl = Object.assign(document.createElement("section"), { id: "upd-card", hidden: true });
    cardEl.setAttribute("aria-label", "snyvi update");
    side.insertBefore(cardEl, side.querySelector(".side-foot"));
    const foot = side.querySelector(".side-foot");
    const room = () => {
      side.style.setProperty("--note-foot", `${foot ? foot.offsetHeight : 52}px`);
      side.style.setProperty("--upd-h", `${cardEl.hidden ? 0 : cardEl.offsetHeight + 6}px`);
    };
    if (window.ResizeObserver) { const ro = new ResizeObserver(room); ro.observe(cardEl); if (foot) ro.observe(foot); }
    cardEl.room = room;
  }
  if (!s || s.card !== "waiting") sure = false;
  card(cardEl);
  cardEl.room();
  // A card that has just come up brings snyvi up from behind it for a
  // moment, as a new aside does; a window in the background plays it to
  // nobody, and a redraw of the same card -- the daemon's next update event
  // rebuilds it -- neither plays it again nor cuts it short.
  const now = s && cardEl.querySelector(".uc-bg") ? s.card : null;
  if (now && now !== peekWas && !document.hidden) {
    peekUntil = Date.now() + 4200;
    clearTimeout(peekTimer);
    peekTimer = setTimeout(() => cardEl.querySelector(".uc")?.classList.remove("peek"), 4200);
  }
  const box = cardEl.querySelector(".uc");
  if (box && now && Date.now() < peekUntil) { void box.offsetWidth; box.classList.add("peek"); }
  peekWas = now;
}

/** Over the top of the main area while snyvi restarts: a strip, not a modal,
 *  and nothing under it moves. */
function strip(text) {
  let el = document.getElementById("restart-strip");
  if (!text) { if (el) el.hidden = true; return; }
  if (!el) {
    el = Object.assign(document.createElement("div"), { id: "restart-strip", role: "status" });
    (document.querySelector("main") || document.body).append(el);
  }
  el.hidden = false;
  el.innerHTML = `${DOTS}<span>${text.replace(/[<&]/g, c => c === "<" ? "&lt;" : "&amp;")} · back in a moment</span>`;
}

/** Ctrl K, the mark's menu, Home and About: ask for the manifest now. The
 *  answer is said where it was asked, and the card takes it from there. A
 *  tab has no capability to ask with, so About says how. */
export async function checkUpdates(at, c) {
  if (!c.capability) return c.panel("about");
  c.toast("Checking for updates…", { at, face: null });
  let j;
  try { j = await c.deskApi("/api/update/check", {}); }
  catch (e) { return c.toast("Could not check for updates", { sub: e, at }); }
  const u = j.update || {};
  c.setUpd(u);
  c.toast(u.ready ? `snyvi ${u.ready} is ready` : u.available ? `snyvi ${u.available} is out` : "snyvi is up to date", { sub: u.ready || u.available ? "the card in the sidebar has it" : c.version, at });
}

/** The daemon's word, whichever came first -- it or the reply to a press:
 *  from here the dot, the card and the strip say what it says. */
export function pill(el, u, c) {
  uc = c; upd = u; updWaiting = false;
  if (!updEl) updEl = el;
  renderUpd();
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
  <button class="icon help-close" id="about-close" data-tip="Close" data-key="esc" aria-label="Close"><svg class="g-ico" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
  <h2 class="dlg-title" id="about-title">snyvi</h2>
  <p id="about-say">A fast, beautiful viewer for the documents your agents produce.</p>
  <section id="about-upd" class="ab-upd" aria-label="Updates"></section>
  <div id="about-facts"></div>
</div>
`;
const RESET = `
<form class="help-box reset-box" role="dialog" aria-modal="true" aria-labelledby="reset-title" tabindex="-1">
  <button class="icon help-close" id="reset-close" type="button" data-tip="Close" data-key="esc" aria-label="Close"><svg class="g-ico" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
  <h2 class="dlg-title" id="reset-title">Reset snyvi</h2>
  <p id="reset-say">Reading what there is…</p>
  <label id="reset-pinned-row" hidden><input type="checkbox" id="reset-pinned"> <span id="reset-pinned-say"></span></label>
  <label class="reset-ask">Type the number of documents to continue
    <input id="reset-n" type="text" inputmode="numeric" autocomplete="off" spellcheck="false" aria-describedby="reset-say">
  </label>
  <p id="reset-err" class="reset-err" role="alert" hidden></p>
  <div class="reset-act"><button class="text" type="button" id="reset-cancel">Cancel</button><button class="btn btn-danger fill" type="submit" id="reset-go" disabled>Reset</button></div>
</form>
`;
/** The keys as this machine names them, the words app.js's keyHint uses
 *  (docs/DESIGN.md §3.4): glyphs on a Mac, Ctrl and Alt everywhere else. */
const MAC = /Mac/.test(navigator.platform);
const KEY = { mod: MAC ? "⌘" : "Ctrl", ctrl: MAC ? "⌃" : "Ctrl", alt: MAC ? "⌥" : "Alt", shift: MAC ? "⇧" : "Shift" };
/** The working dots (app.css .dots), beside a word, for a process under way. */
const DOTS = `<span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>`;
const kb = (...ks) => ks.map(k => `<kbd>${KEY[k] || k}</kbd>`).join("");

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
    <div class="hk"><span>Letter keys on / off</span><span class="keys">${kb("ctrl", "B")}</span></div>
    <div class="hk"><span>Search</span><span class="keys">${kb("mod", "K")}</span></div>
    <div class="hk"><span>These shortcuts</span><span class="keys"><kbd>?</kbd></span></div>
    <div class="hk"><span>Close</span><span class="keys"><kbd>Esc</kbd></span></div>
  </section>
  <section>
    <h3>Move</h3>
    <div class="hk"><span>Next / previous document</span><span class="keys"><kbd>j</kbd><i>/</i><kbd>k</kbd></span></div>
    <div class="hk"><span>Older / newer version</span><span class="keys"><kbd>[</kbd><i>/</i><kbd>]</kbd></span></div>
    <div class="hk"><span>The next document waiting</span><span class="keys"><kbd>n</kbd></span></div>
    <div class="hk"><span>Home</span><span class="keys"><kbd>h</kbd></span></div>
    <div class="hk"><span>Inbox</span><span class="keys"><kbd>i</kbd></span></div>
    <div class="hk"><span>A note, on Home</span><span class="keys"><kbd>a</kbd></span></div>
    <div class="hk"><span>Back / forward</span><span class="keys">${kb("alt", "←")}<i>/</i><kbd>→</kbd></span></div>
    <div class="hk"><span>Go to a line</span><span class="keys">${kb("mod", "K")}<code>:120</code></span></div>
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
    <div class="hk"><span>Zoom</span><span class="keys">${kb("mod")}<i>+</i>scroll</span></div>
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
    <div class="hk"><span>Remove</span><span class="keys"><kbd>Del</kbd></span></div>
    <div class="hk"><span>Undo</span><span class="keys">${kb("mod", "Z")}</span></div>
  </section>
</div>
`;

/** The shortcuts card's box: in index.html until 1.8, and built here now,
 *  since this is what fills it and opens it. */
const HELP_BOX = `<div class="help-box" role="dialog" aria-modal="true" aria-labelledby="help-title" tabindex="-1">
    <div class="help-head">
      <h2 class="dlg-title" id="help-title">Keyboard shortcuts</h2>
      <button class="icon help-close" id="help-close" data-tip="Close" data-key="esc" aria-label="Close"><svg class="g-ico" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
    </div>
    <div class="help-body"></div>
    <div class="help-foot">
      <button class="text" id="btn-welcome">Welcome</button>
      <button class="text" id="btn-start">How snyvi works</button>
      <button class="text" id="btn-connect">Agents…</button>
      <button class="text" id="btn-about">About snyvi</button>
      <span class="help-gap"></span>
      <button class="text" id="btn-reset">Reset snyvi…</button>
    </div>
  </div>`;

function fillHelp(d) {
  const { help, closeDialog } = d;
  if (help.querySelector(".hk")) return;
  if (!help.firstElementChild) {
    help.innerHTML = HELP_BOX;
    const on = (id, f) => help.querySelector(id).addEventListener("click", f);
    on("#help-close", () => closeDialog(help));
    on("#btn-about", () => d.panel("about"));
    on("#btn-reset", () => d.panel("reset"));
    on("#btn-connect", () => { closeDialog(help); d.showConnect(); });
    on("#btn-start", () => { closeDialog(help); d.showStart(true, ""); });
    on("#btn-welcome", () => { closeDialog(help); d.showWelcome(true); });
  }
  help.querySelector(".help-body").innerHTML = HELP;
  // The native window adds its own rows (ui/frame.js) once these are in.
  help.dispatchEvent(new Event("snyvi:help"));
}

const STYLE = `
/* The connect page: one row per agent, the state as a dot and a word, and
 * everything to paste in a block with its own Copy. It sits in the document
 * pane at the document's measure, so it reads as a page and not as chrome. */
.connect .agents { list-style: none; margin: 0; padding: 0; }
.agent { padding: 16px 0; border-top: 1px solid var(--rule); }
.agent:last-child { border-bottom: 1px solid var(--rule); }
.agent-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.agent-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--fg-3); align-self: center; flex: none; }
.agent.is-connected .agent-dot { background: var(--ok); }
/* Here now: the accent, with a ring, so an open session reads apart from one that is only set up. */
.agent.is-live .agent-dot { background: var(--accent); box-shadow: 0 0 0 3px var(--accent-bg); }
.agent.is-live .agent-state { color: var(--accent); }
.agent.is-stale .agent-dot { background: var(--danger); }
.agent-name { font-size: 16px; font-weight: 600; }
.agent-state { color: var(--fg-3); font-size: var(--fs-ui); }
.agent-say { margin: 6px 0 0; font-size: 14.5px; color: var(--fg-2); line-height: 1.5; }
.connect code { font-family: var(--mono); font-size: var(--fs-small); }
.agent-fix { margin-top: 10px; }
.agent-instr { margin: 8px 0 0; font-size: var(--fs-ui); color: var(--fg-3); }
.connect-line { margin-top: 28px; }
.connect-line p { margin: 0 0 8px; font-size: var(--fs-body-s); color: var(--fg-2); }
pre.cmd { position: relative; font-family: var(--mono); font-size: var(--fs-ui); line-height: 1.55; background: var(--code-bg); border-radius: var(--r-sm); padding: 8px 72px 8px 12px; margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
pre.cmd code { background: none; padding: 0; font-size: inherit; }
.agent-fix details { margin-top: 8px; }
.agent-fix summary { cursor: pointer; font-size: var(--fs-ui); color: var(--fg-3); }
.agent-fix details[open] summary { margin-bottom: 6px; }
.connect-foot { margin-top: 24px; color: var(--fg-3); font-size: var(--fs-ui); }
.agents-more { margin-top: 20px; }
.agents-more > summary { cursor: pointer; font-size: var(--fs-body-s); color: var(--fg-2); padding: 6px 0; }
.agents-more[open] > summary { margin-bottom: 8px; }
/* Welcome: the story in two lines, one question, one button. */
.welcome { max-width: 560px; padding-top: 6vh; }
.welcome .w-mark .mk { width: 44px; height: 44px; }
.welcome .doc-title { margin: 14px 0 12px; }
.w-lede { font-size: 16px; line-height: 1.55; color: var(--fg-2); margin: 0 0 36px; }
.w-q { font-size: var(--fs-h3); font-weight: 600; margin: 0 0 14px; }
.w-or { margin: 26px 0 8px; font-size: var(--fs-ui); color: var(--fg-3); }
.w-places { list-style: none; margin: 0; padding: 0; }
.w-places button { display: flex; align-items: baseline; gap: 10px; width: 100%; text-align: left; font: inherit; padding: 7px 10px; margin: 0 -10px; border-radius: var(--r-sm); color: var(--fg); }
.w-places button:hover { background: var(--rule); }
.w-places b { font-weight: 600; font-size: 14.5px; }
.w-places span { font-family: var(--mono); font-size: var(--fs-small); color: var(--fg-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.w-tab { font-size: var(--fs-body-s); color: var(--fg-2); }
.w-connect { margin-top: 10px; }
.w-ask-box { padding: 12px 14px; border: 1px solid var(--rule-2); border-radius: 8px; background: var(--bg-raise); }
.w-ask-box p { margin: 0 0 10px; font-size: var(--fs-ui); line-height: 1.5; color: var(--fg-2); }
.w-ask-act { display: flex; gap: 12px; align-items: center; }
.w-said { margin: 0; font-size: var(--fs-ui); color: var(--fg-2); }
.w-said.ok { color: var(--ok); display: flex; align-items: center; gap: 8px; }
.w-face { flex: none; width: 22px; height: 22px; }
.w-face .mk { animation: mk-hop .62s var(--ease-spring) 1; }
.w-said.bad { color: var(--danger); margin-bottom: 6px; }
.help-body { flex: 1; min-height: 0; overflow-y: auto; display: grid; grid-template-columns: 1fr 1fr; gap: 0 40px; padding: 4px 24px 8px; scrollbar-width: thin; scrollbar-color: var(--rule-2) transparent; }
.help-col { display: flex; flex-direction: column; gap: 18px; align-content: start; }
.help-col h3 { margin: 0 0 2px; font-size: var(--fs-micro); font-weight: 600; letter-spacing: .01em; color: var(--fg-3); }
.hk { display: flex; align-items: center; gap: 12px; min-height: 30px; padding: 1px 0; border-top: 1px solid var(--rule); font-size: var(--fs-ui); color: var(--fg); }
.hk:first-of-type { border-top: 0; }
.hk > span:first-child { flex: 1; min-width: 0; line-height: 1.3; }
.hk em { font-style: normal; font-size: var(--fs-small); color: var(--fg-3); }
.hk .keys { flex: none; display: inline-flex; align-items: center; gap: 3px; font-size: var(--fs-small); color: var(--fg-3); }
.hk .keys i { font-style: normal; font-size: var(--fs-micro); padding: 0 1px; }
.hk .keys code { font-family: var(--mono); font-size: var(--fs-micro); color: var(--fg-2); background: var(--rule); padding: 0 5px; border-radius: var(--r-xs); line-height: 18px; }
.help-col .help-note { margin: 8px 0 0; font-size: var(--fs-small); line-height: 1.4; color: var(--fg-3); }
/* Updates in About, a card over the facts: a dot for where it stands (the
   latest, something to do, something wrong), the sentence, the controls
   under it, and the lines a told-only install runs under those. */
.ab-upd { margin: 0 0 6px; padding: 12px 14px; border: 1px solid var(--rule); border-radius: var(--r-md); background: var(--bg-raise, var(--bg)); }
.ab-upd:empty { display: none; }
.upd-row { display: flex; flex-direction: column; gap: 10px; }
.upd-row .upd-say { display: flex; align-items: baseline; gap: 8px; font-size: var(--fs-body-s); font-weight: 500; color: var(--fg); }
.upd-row .upd-say::before { content: ""; flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--fg-3); }
.upd-row[data-st="ok"] .upd-say::before { background: var(--ok); }
.upd-row[data-st="ready"] .upd-say::before { background: var(--accent); }
.upd-row[data-st="bad"] .upd-say::before { background: var(--warn); }
.upd-row[data-st="busy"] .upd-say::before { display: none; }
.upd-act { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; }
.upd-act:empty { display: none; }
.upd-act .btn { padding: 4px 12px; border-radius: var(--r-sm); }
.upd-notes { margin-left: auto; font-size: var(--fs-small); }
/* A switch, beside the sentence it turns on and off, or with its own words. */
.ab-tog { display: inline-flex; align-items: center; gap: 8px; padding: 0; border: 0; background: none; font: inherit; font-size: var(--fs-ui); color: var(--fg-2); cursor: pointer; }
.ab-sw { flex: none; position: relative; width: 26px; height: 16px; border-radius: var(--r-pill); background: var(--rule-2); transition: background var(--t); }
.ab-sw::after { content: ""; position: absolute; top: 2px; left: 2px; width: 12px; height: 12px; border-radius: 50%; background: var(--bg-raise); box-shadow: var(--shadow); transition: transform var(--t); }
.ab-tog[aria-checked="true"] .ab-sw { background: var(--accent); }
.ab-tog[aria-checked="true"] .ab-sw::after { transform: translateX(10px); }
.ab-tog:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; border-radius: var(--r-xs); }
.ab-swrow { display: flex; align-items: flex-start; gap: 16px; }
.ab-swrow .upd-say { flex: 1; min-width: 0; color: var(--fg-2); }
.ab-swrow .ab-tog { margin-top: 2px; }
.upd-how { flex-basis: 100%; margin: 4px 0 0; padding: 6px 10px; font-family: var(--mono); font-size: var(--fs-small); line-height: 1.5; background: var(--code-bg); border-radius: var(--r-sm); white-space: pre-wrap; }
@media (max-width: 600px) {
  .help-body { grid-template-columns: 1fr; }
  #help-col-2 { margin-top: 18px; }
}
`;
{
  const st = document.createElement("style");
  st.id = "about-css";
  st.textContent = STYLE;
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
  aboutFacts.replaceChildren(); $("#about-upd").replaceChildren();
  openDialog(aboutDlg, aboutDlg.firstElementChild);
  let a;
  try { a = await (await fetch("/api/about")).json(); } catch { noReach($("#about-say"), () => openAbout(d)); return; }
  $("#about-say").classList.remove("no-reach");
  $("#about-say").textContent = `${a.description}.`;
  // Updates first, on a card of its own: the one row here that asks for
  // something, and it was row two of fourteen, worded like the License
  // (#103). Then the facts, in small groups.
  $("#about-upd").append(updateRow(a.update, d));
  let dl = null;
  const group = title => {
    const h = document.createElement("h3"); h.className = "ab-h"; h.textContent = title;
    dl = document.createElement("dl");
    aboutFacts.append(h, dl);
  };
  const fact = (k, v, cls) => {
    if (v == null || v === "") return;
    const dt = document.createElement("dt"); dt.textContent = k;
    const dd = document.createElement("dd"); if (cls) dd.className = cls;
    if (v instanceof Node) dd.append(v); else dd.textContent = v;
    dl.append(dt, dd);
  };
  if (d.capability) {
    group("In panels");
    fact("Desk brief", switchRow(d, "/api/brief", "Desk brief", "A Claude starting in a panel is told about its desk", "Claude starts in a panel knowing nothing of its desk"));
    fact("Asides", switchRow(d, "/api/asides", "Asides", "An agent may leave a line at the foot of the sidebar", "An agent's aside is refused; snyvi's own first lines still show"));
    fact("Claude Code mod", switchRow(d, "/api/claude-mod", "Claude Code mod in panels", "A panel's Claude shows its thread above the prompt, puts its questions on Your turn, and takes /note", "Panels start Claude Code without the snyvi mod (it needs Claude Code 2.1.287 or later); a panel started before picks this up at its next start"));
  }
  group("This snyvi");
  const ver = document.createDocumentFragment();
  ver.append(a.version);
  const build = [a.commit, a.target].filter(Boolean).join(", ");
  if (build) { const m = document.createElement("span"); m.className = "muted"; m.textContent = ` (${build})`; ver.append(m); }
  fact("Version", ver);
  fact("Theme", themeFact());
  fact("Agents", a.agents, "pre");
  fact("License", a.license);
  if (a.repository) {
    const link = document.createElement("a"); link.href = a.repository; link.target = "_blank"; link.rel = "noopener";
    link.textContent = a.repository.replace(/^https?:\/\//, "");
    fact("Source", link);
  }
  group("Where things are");
  fact("Binary", a.binary, "path");
  fact("Documents", a.data_dir, "path");
  fact("Settings", a.config_dir, "path");
}

/** The updates row: `1.7.1 is ready · applies tomorrow, when the desks
 *  are quiet`, with `Check now` beside it, and what a press finds -- the
 *  latest, a version ready with the restart control in the row, a restart
 *  waiting for quiet with Restart now and Cancel, or the lines a told-only install
 *  runs. The daemon is the updater; this only says what it says
 *  (`/api/about` and `/api/update/*`). A tab holds no capability, so it
 *  reads the row and presses nothing. */
/** What the updater's own error means, said the way a person would; the
 *  exact words go in the line's title. Not signed is said as what it is, a
 *  refusal that kept this machine safe. */
const updWhy = (e, v) => /not signed/i.test(e) ? `${v || "the update"} was not signed by snyvi, so it was not installed`
  : /HTTP 404/.test(e) ? "the release is not there yet"
  : /HTTP|dns|resolve|connect|timed? ?out|network/i.test(e) ? "snyvi could not reach GitHub"
  : /space|disk|read-only|permission/i.test(e) ? "the disk would not take it" : e;

/** "Could not reach snyvi", with a Retry that does `again`. */
function noReach(el, again) {
  const b = Object.assign(document.createElement("button"), { type: "button", textContent: "Retry" });
  b.addEventListener("click", again);
  el.replaceChildren("Could not reach snyvi", b);
  el.classList.add("no-reach");
}

/** One of the daemon's switches, the window's to change; a tab has no
 *  desks, and no row. The desk brief: whether a Claude starting in a desk's
 *  panel is handed where it is, the open notes, what was done and where the
 *  work was left, as context before its first reply. Asides: whether an
 *  agent's line at the foot of the sidebar is taken at all -- the one
 *  consent for every agent at once, beside each aside's own ✕. */
function switchRow(d, path, name, onSay, offSay) {
  const box = document.createElement("div"); box.className = "ab-swrow";
  const say = document.createElement("span"); say.className = "upd-say";
  const b = swBtn(name);
  box.append(say, b);
  const draw = on => {
    say.textContent = on ? onSay : offSay;
    b.setAttribute("aria-checked", String(!!on));
    b.onclick = async () => { try { draw((await d.deskApi(path, { on: !on })).on); } catch (e) { say.textContent = `Could not change it · ${d.sayErr(e).why}`; } };
  };
  say.textContent = "…";
  d.deskApi(path).then(j => draw(j.on), () => { say.textContent = "snyvi did not answer"; });
  return box;
}

/** A switch: the track and its knob, its state in aria-checked. `label`,
 *  when given, is drawn beside it; otherwise it is only its name. */
function swBtn(name, label) {
  const b = document.createElement("button"); b.type = "button"; b.className = "ab-tog";
  b.setAttribute("role", "switch"); b.setAttribute("aria-checked", "false");
  b.innerHTML = '<i class="ab-sw" aria-hidden="true"></i>';
  if (label) b.append(label); else b.setAttribute("aria-label", name);
  return b;
}

function updateRow(u, d) {
  const { rel, capability, deskApi } = d;
  const box = document.createElement("div"); box.className = "upd-row";
  const say = document.createElement("span"); say.className = "upd-say";
  const act = document.createElement("span"); act.className = "upd-act";
  const how = document.createElement("pre"); how.className = "upd-how"; how.hidden = true;
  box.append(say, act, how);
  const when = ts => { const s = ts - Date.now() / 1000; return s <= 0 ? "at the next quiet moment" : s < 3600 ? `in ${Math.max(1, Math.round(s / 60))} min` : s < 20 * 3600 ? `in ${Math.round(s / 3600)} h` : "tomorrow"; };
  const button = (label, fn, kind = "secondary") => { const b = document.createElement("button"); b.type = "button"; b.className = `btn btn-${kind}`; b.textContent = label; b.addEventListener("click", fn); return b; };
  const msg = e => d.sayErr(e).why;
  // `note` is what a press here just met -- a restart the daemon refused --
  // and is said before anything the block says.
  const draw = (u, busy, note) => {
    act.replaceChildren(); how.hidden = true; delete box.dataset.st;
    if (!u || u.channel === "unknown") { say.textContent = "snyvi cannot tell which file it runs from here, so it does not update itself."; return; }
    if (u.channel === "dev") { say.textContent = "A development build: it does not check."; return; }
    const r = u.restart, n = r && r.waiting_on ? r.waiting_on.length : 0;
    const told = !!(u.how && u.how.length);
    // An old failure is history once something else is out.
    const failed = u.failed && (u.failed_recent || u.failed === u.available);
    const parts = [];
    if (busy) parts.push("Checking");
    else if (note) parts.push(note);
    else if (u.restarting) parts.push("Restarting");
    else if (r) parts.push(n ? `Restarting when ${n === 1 ? "a panel is" : `${n} panels are`} quiet` : "Restarting");
    else if (failed) parts.push(`${u.failed} was applied and did not start; the previous version was kept`);
    else if (u.ready) parts.push(`${u.ready} is ready`);
    else if (u.available && u.available === u.skipped) parts.push(`You went back from ${u.skipped}; the release after it updates as usual`);
    else if (u.available && u.error) parts.push(told ? `${u.available} is out · the last check failed: ${updWhy(u.error, u.available)}` : `${u.available} is out · ${updWhy(u.error, u.available)} · Check now tries again`);
    else if (u.available) parts.push(`${u.available} is out`);
    else if (u.error) parts.push(`The last check failed: ${updWhy(u.error)}`);
    else if (u.checked) parts.push(`You're on the latest · checked ${rel(u.checked)}`);
    else parts.push("Not checked yet");
    if (!busy && !r && u.ready) parts.push(u.auto && !u.slot_open ? `applies ${when(u.slot)}, when the desks are quiet` : "applies at the next quiet moment");
    // Off is said by the switch, where there is one to say it.
    if (!busy && !u.auto && (u.env_off || !capability)) parts.push(u.env_off ? "automatic updates off in snyvi's environment" : "automatic updates off");
    say.textContent = parts.join(" · ");
    // The dot before the line: the latest, something to do, or something wrong.
    box.dataset.st = busy || u.restarting ? "busy" : failed || u.error ? "bad" : r || u.ready || u.available ? "ready" : u.checked ? "ok" : "";
    if (busy || u.restarting) say.insertAdjacentHTML("afterbegin", DOTS);
    // The updater's own words, for whoever needs them, in the line's tip.
    if (u.error) { say.dataset.tip = "What it said"; say.dataset.tipSub = u.error; } else delete say.dataset.tip;
    if (busy || u.restarting) return;
    if (u.available && !u.ready && u.how && u.how.length) { how.textContent = u.how.join("\n"); how.hidden = false; }
    const notes = () => { if (u.notes) { const a = document.createElement("a"); a.className = "upd-notes"; a.href = u.notes; a.target = "_blank"; a.rel = "noopener"; a.textContent = "Release notes ↗"; act.append(a); } };
    if (!capability) { notes(); return; }
    if (r) {
      act.append(button("Restart now", async () => {
        try { await deskApi("/api/restart", { when: "now" }); draw({ ...u, restarting: true }, false); } catch (e) { draw(u, false, `Could not restart · ${msg(e)}`); }
      }, "primary"), button("Cancel", async () => {
        try {
          const res = await fetch("/api/restart", { method: "DELETE", headers: { "x-snyvi-capability": capability } });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          draw({ ...u, restart: null }, false);
        } catch (e) { draw(u, false, `Could not call it off · ${msg(e)}`); }
      }));
      return;
    }
    if (u.ready) act.append(button("Restart to update", async () => {
      say.textContent = "Restarting when the panels are quiet…"; act.replaceChildren();
      try { const j = await deskApi("/api/restart", { when: "idle", apply: true }); draw({ ...u, restart: { apply: true, waiting_on: j.waiting_on || [] } }, false); }
      catch (e) { draw(u, false, `Could not restart · ${msg(e)}`); }
    }, "primary"));
    act.append(button("Check now", async () => {
      draw(u, true);
      try { const j = await deskApi("/api/update/check", {}); draw(j.update, false); }
      catch (e) { draw({ ...u, error: msg(e) }, false); }
    }));
    if (!u.env_off) {
      const sw = swBtn("Automatic updates", "Automatic updates");
      sw.setAttribute("aria-checked", String(!!u.auto));
      sw.addEventListener("click", async () => {
        try { const j = await deskApi("/api/update/auto", { on: !u.auto }); draw(j.update, false); } catch {}
      });
      act.append(sw);
    }
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
/* A removal has Undo; this has a number. The dialog says what goes and what
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
const resetSentence = (c, plural) => `This deletes ${plural(c.documents, "document")} in ${plural(c.projects, "project")}, ${c.desks ? plural(c.desks, "desk") + " and their panels, " : ""}the index, the token and this page's preferences. Agents stay connected: the next document they send lands in an empty library. Nothing can be undone.`;

async function openReset(d) {
  const { $, openDialog, closeDialog, help, resetDlg, plural } = d;
  const resetSay = $("#reset-say"), resetN = $("#reset-n"), resetErr = $("#reset-err");
  const resetPinRow = $("#reset-pinned-row"), resetPin = $("#reset-pinned");
  closeDialog(help);
  resetCensus = null; resetN.value = ""; resetErr.hidden = true; resetPin.checked = false; resetPinRow.hidden = true;
  resetSay.textContent = "Reading what there is…";
  resetArm(d);
  openDialog(resetDlg, resetN);
  try { resetCensus = await (await fetch("/api/reset")).json(); } catch { noReach(resetSay, () => openReset(d)); return; }
  resetSay.classList.remove("no-reach");
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
  resetGo.disabled = true; resetGo.innerHTML = `${DOTS}Resetting`;
  let r;
  try {
    r = await fetch("/api/reset", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ documents: resetCensus.documents, desks: resetCensus.desks || 0, pinned: resetPin.checked }) });
  } catch { resetGo.textContent = "Reset"; noReach(resetErr, () => { resetErr.hidden = true; resetArm(d); submitReset(e, d); }); resetErr.hidden = false; resetArm(d); return; }
  if (r.ok) { afterReset(); return; }
  resetGo.textContent = "Reset";
  let j = {}; try { j = await r.json(); } catch {}
  // Why, from what changed: the daemon sends the library as it is now.
  const c = j.census, was = resetCensus, n = c ? c.documents - was.documents : 0;
  resetErr.classList.remove("no-reach");
  resetErr.textContent = `Could not reset · ${!c ? j.error || "snyvi said no"
    : n ? `${plural(Math.abs(n), "document")} ${n > 0 ? "arrived" : "went"} since you looked · type ${c.documents}`
    : c.desks !== was.desks ? `the desks changed since you looked · type ${c.documents}`
    : `${plural(c.pinned, "pinned document")} · tick Also the pinned to include them`}`;
  if (j.error) { resetErr.dataset.tip = "What it said"; resetErr.dataset.tipSub = j.error; } else delete resetErr.dataset.tip;
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
  const cmd = (text, cls) => `<pre class="cmd ${cls || ""}"><code>${esc(text)}</code><button type="button" class="copy">Copy</button></pre>`;
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
export function connectAsk(b, { api, done, sayErr, mascotHead }) {
  const box = b.closest(".w-connect") || b.parentElement;
  const was = box.innerHTML;
  box.innerHTML = `<div class="w-ask-box" role="group" aria-label="Connect Claude Code"><p>This adds snyvi to Claude Code: its MCP server in <code>~/.claude.json</code>, and hooks and a status line in <code>~/.claude/settings.json</code>, all run by this snyvi. A status line of your own is kept. <code>snyvi uninstall-claude</code> takes it all back out.</p>` +
    `<div class="w-ask-act"><button type="button" class="w-btn" data-w="connect-yes">Connect</button><button type="button" class="text" data-w="connect-no">Not now</button></div></div>`;
  box.querySelector('[data-w="connect-yes"]').focus();
  const no = () => { box.onclick = box.onkeydown = null; box.innerHTML = was; box.querySelector("button")?.focus(); };
  // Esc is Not now, as it closes anything else that asks.
  box.onkeydown = e => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); no(); } };
  box.onclick = async e => {
    const t = e.target.closest("[data-w]");
    if (!t) return;
    e.stopPropagation();
    if (t.dataset.w === "connect-no") return no();
    if (t.dataset.w !== "connect-yes") return;
    box.onclick = box.onkeydown = null;
    box.innerHTML = `<p class="w-said">${DOTS}Connecting</p>`;
    try {
      const j = await api("/api/agents/claude/connect", {});
      const row = j.agents && j.agents.rows.find(r => r.id === "claude");
      const ok = j.ok && row && row.state === "connected";
      // The one moment on this page that earns a face (docs/DESIGN.md §2.3):
      // it went right, once per machine, at the point of action. Glad, and
      // the one hop a rare moment is allowed; the ask before it stays plain.
      box.innerHTML = ok ? `<p class="w-said ok">${mascotHead ? `<span class="w-face">${mascotHead("glad")}</span>` : ""}<span>Connected. A Claude session started from now on sends here.</span></p>`
        : `<p class="w-said bad">It did not take. What it said:</p><pre class="cmd"><code>${(j.said || "").replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c])}</code></pre>`;
      done && done(j.agents, ok);
    } catch (e) { box.innerHTML = `<p class="w-said bad">Could not connect Claude Code · ${sayErr(e).why.replace(/[&<>]/g, "")}</p>`; }
  };
}

// ---------- /welcome ----------
/* What snyvi is, in the README's words, and one question: which project
 * first. The answer is a folder, from the desktop's own dialog or from the
 * projects snyvi already knows -- it never looks through folders itself.
 * Nothing about agents is here: that is asked inside the desk, if at all. */
export function welcome({ cap, places, tilde, mascot, esc }) {
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
/** What each Show me lights, and what it says when that is not there. Asked
 *  at the moment of the click as well as at the draw: an arrival while the
 *  page is read makes the first one true. */
const folded = () => document.documentElement.dataset.side === "0";
const q = s => document.querySelector(s);
const SHOW = {
  arrives: { at: () => q("#tree a[data-id]") && (folded() ? q('#rail-nav [data-pop="tree"]') : q("#tree a[data-id]")),
    none: `Nothing has arrived yet. <a href="/connect" data-nav="connect">Agents</a>` },
  waiting: { at: () => q("#queue .t-queue") && (folded() ? q('#rail-nav [data-pop="inbox"]') : q("#queue .t-queue")), none: "Nothing is waiting right now." },
  desks: { at: () => startCap && (folded() ? q('#rail-nav [data-pop="desks"]') : q("#desk-nav .sec-head")), none: "Desks live in the window: <code>snyvi app</code>." },
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
      `${kb("ctrl", "`")} desk / reading · ${kb("ctrl", "⌥", "1")}–${kb("4")} a panel · ${kb("ctrl", "⌥", "N")} new panel · ${kb("ctrl", "⌥", "W")} close it (with Undo) · ${kb("ctrl", "⌥", "Z")} that panel alone. Every other key goes to the panel.`) +
    sec("arrives", "Nothing scrolls away",
      `<p>When an agent writes something worth reading, it sends it here and replies with a link, and by the time you read the reply the document is already open. It is filed under its project, the folder the agent was working in, and under its workflow, one per Claude Code session. There is nothing to import or save: what arrives stays until you remove it, and Undo brings it back. ${showLink("arrives")}</p>`,
      `${kb("mod", "K")} search everything · ${kb("j")} ${kb("k")} next / previous document · ${kb("/")} find in this one`) +
    sec("waiting", "What is waiting",
      `<p>A document that arrives while you read never takes the page away. It waits, as a row under Waiting in the sidebar and a count in the bar above what you are reading (or a number on the inbox icon, when the sidebar is folded). ${kb("n")} opens the oldest and takes it off, so the next ${kb("n")} is the one after: one key, in the order they came. Opening one any other way counts as read too, and Mark all read clears the list without opening anything. Opened one from the bar in the middle of another? ‹ at the top left takes you back to it, where you were, and once more to the panels; hold it for the last ten places. ${showLink("waiting")}</p>`,
      `${kb("n")} the next one waiting · ${kb("alt", "←")} ${kb("alt", "→")} back / forward · ${kb("h")} home · ${kb("i")} the inbox · ${kb("Del")} remove, ${kb("mod", "Z")} put it back`) +
    sec("notes", "Out of your head: notes, points and asides",
      `<p>Three small things, each going one way. <em>Notes</em> are yours: a list kept with each desk (+ New note), ticked off as things get done. An agent in that desk's panels can read it and tick a line, and nothing more. <em>Points</em> go from you to a panel: select a passage in a document you read over a desk and press + Point for panel 2. They gather under the panel until Put it in panel 2 types them into its input, quoted. Nothing is sent until you press Enter there.</p>` +
      `<ul class="dk-list start-sample" inert aria-hidden="true"><li class="dk-note dk-point"><span class="nm">From PLAN.md: the cache is per project, not per desk</span></li></ul><button type="button" class="dk-new dk-put start-sample" inert aria-hidden="true" tabindex="-1">Put it in panel 2</button>` +
      `<p><em>Asides</em> come from an agent to you: a line about what it noticed, never a document and never counted as waiting. They sit at the foot of the sidebar. ${showLink("notes")}</p>`,
      `Right-click anything for what it can do · ${kb("☰")} or ${kb("shift", "F10")} the same menu from the keyboard`) +
    sec("versions", "Versions",
      `<p>A document is never changed. When an agent revises its plan it sends it again, and you keep both: the newest waits for you, the older ones are one key away. ${kb("c")} shows what changed since the one before, in green and red, and ${kb("s")} turns that between side by side and inline. Every version of the same file, from any session, is listed under Versions in the contents.</p>` +
      `<pre class="code diff start-sample" inert aria-hidden="true"><code><span class="ln hunk">@@ -3,2 +3,2 @@</span>\n<span class="ln del">-## The cache</span>\n<span class="ln del">-It lives beside each desk.</span>\n<span class="ln add">+## The cache, per project</span>\n<span class="ln add">+It is per project, not per desk.</span></code></pre>`,
      `${kb("[")} ${kb("]")} older / newer · ${kb("c")} compare · ${kb("s")} side by side / inline · ${kb("t")} contents`) +
    sec("keys", "Keys",
      `<p>The letter keys start asleep, so a ${kb("j")} meant for a terminal cannot move the page. ${kb("ctrl", "B")} wakes them; a pill at the bottom says <em>Keys on</em>, and they sleep again on Esc, a click, or ten quiet seconds.</p>` +
      `<div class="keymode-sample show on" inert aria-hidden="true">Keys on · Esc</div>` +
      `<p>Keys with a modifier always work. ${kb("mod", "K")} searches everything, and a search that starts with <code>&gt;</code> lists what snyvi can do: a theme, a new desk, a folder, an agent to connect. ${showLink("keys")}</p>`,
      `${kb("ctrl", "B")} letter keys · ${kb("mod", "K")} search · ${kb("mod", "K")} <code>&gt;</code> commands · ${kb("?")} every key · ${kb("\\")} sidebar · ${kb("Esc")} back to where you were`) +
    `<p class="connect-foot">${cap ? `Nothing here yet? <a href="/welcome" data-nav="welcome">Give a project a desk</a>. ` : ""}<a href="/connect" data-nav="connect">Agents</a>.</p></div>`;
}

/** After the page is in: the pill's look is keys.js's own, fetched for the
 *  sample. */
export async function startReady(v) {
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
.start-sec h2 { font-size: var(--fs-h3); margin: 0 0 8px; }
.start-sec p { font-size: var(--fs-body-s); line-height: 1.6; color: var(--fg-2); margin: 0 0 10px; }
.start-keys { font-size: var(--fs-ui) !important; color: var(--fg-3) !important; }
.show-me { font-size: var(--fs-ui); white-space: nowrap; }
.show-none { font-size: var(--fs-ui); color: var(--fg-3); }
pre.start-sample { margin: 6px 0 12px; font-size: var(--fs-small); }
.start-sample.dk-list { list-style: none; margin: 6px 0 0; padding: 0; max-width: 280px; }
.start-sample .dk-note { display: flex; align-items: flex-start; gap: 6px; border-radius: var(--r-sm); }
.start-sample .dk-note > .nm { flex: 1; min-width: 0; text-align: left; padding: 4px 0; font-size: var(--fs-small); line-height: 1.5; color: var(--fg-2); white-space: normal; overflow-wrap: anywhere; }
.start-sample .dk-point > .nm { padding-left: 8px; border-left: 2px solid var(--rule-2); margin-left: 8px; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow: hidden; }
button.start-sample.dk-new { display: block; padding: 3px 8px; font-size: var(--fs-small); border-radius: var(--r-sm); margin: 0 0 12px; }
button.start-sample.dk-put { color: var(--accent); }
.keymode-sample { margin: 6px 0 12px; }
.show-lit { animation-iteration-count: 2 !important; }
`;
{ const s = document.createElement("style"); s.textContent = START_CSS; document.head.append(s); }

/* The about and reset boxes, which this file builds -- in app.css until 1.7.1, and nothing on screen used them before
 * this file was loaded, so they came here to leave first paint. */
const CSS_MOVED = `
/* The dialogs, which this file fills and opens (1.8: out of first paint). */
/* The overlay places the box 12vh down, so the cap leaves that and a little
   below it: a box that outgrew the window would put its foot -- About,
   Connect, Reset -- past the bottom edge, where no click can reach it. */
.help-box { padding: 18px 22px 20px; position: relative; outline: none; max-height: 84vh; overflow-y: auto; }
.help-close { position: absolute; top: 12px; right: 12px; }
/* One dialog title, every dialog's (docs/DESIGN.md §8): About, Reset and the
   shortcuts card, whose head holds it beside its ✕. */
.dlg-title { margin: 0 0 4px; font-size: var(--fs-h3); font-weight: 600; letter-spacing: -.01em; color: var(--fg); }
.help-box dl { display: grid; grid-template-columns: auto 1fr; gap: 6px 18px; margin: 0; font-size: var(--fs-body-s); }
.help-box dt { font-family: var(--mono); font-size: var(--fs-small); color: var(--fg-2); }
.help-box dd { margin: 0; }
.help-foot { display: flex; align-items: center; gap: 4px; }
.help-gap { flex: 1; }

/* The shortcuts card. A title row and the foot stay put; only the middle
   scrolls, and on a normal screen it never has to. Each row is the meta
   panel's own shape -- what it does, then the key, small and flat -- so
   there is no key column to line up; the keys sit on the right edge. */
#help .help-box { width: min(700px, 92vw); padding: 0; display: flex; flex-direction: column; overflow: hidden; border-radius: var(--r-md); }
.help-head { flex: none; display: flex; align-items: center; padding: 14px 14px 12px 24px; }
.help-head .dlg-title { margin: 0; flex: 1; }
#help .help-close { position: static; }
#help .help-foot { flex: none; margin: 0; padding: 10px 14px 10px 16px; border-top: 1px solid var(--rule); background: var(--bg-side); }
/* Updates (renderUpd): the dot on the mascot, the card over the sidebar's
   foot, the strip over the main area. None of them is in the flow. */
#upd { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); border: 0; white-space: nowrap; }
html[data-upd] .brand-mark { position: relative; }
html[data-upd] .brand-mark::after { content: ""; position: absolute; right: -3px; top: -2px; width: 6px; height: 6px; border-radius: 50%;
  background: var(--accent); box-shadow: 0 0 0 2px var(--bg-side); pointer-events: none; }
html[data-upd="amber"] .brand-mark::after { background: var(--warn); }
html[data-upd="failed"] .brand-mark::after { background: var(--danger); }
html[data-upd="waiting"] .brand-mark::after { animation: upd-breathe 1.6s ease-in-out infinite; }
@keyframes upd-breathe { 50% { opacity: .35; } }
@media (prefers-reduced-motion: reduce) { html[data-upd="waiting"] .brand-mark::after { animation: none; } }
#side > #upd-card { position: absolute; left: 8px; right: 8px; bottom: calc(var(--note-foot, 52px) + var(--note-h, 0px)); z-index: 4; margin: 0 0 6px; }
:root[data-side="0"] #side > #upd-card { display: none; }
:root:not([data-side="0"]) #app #side:has(> #upd-card:not([hidden])) #trees { padding-bottom: calc(8px + var(--note-h, 0px) + var(--upd-h, 0px)); }
.uc { position: relative; overflow: hidden; isolation: isolate; padding: 10px 12px; border-radius: var(--r-md); background: color-mix(in srgb, var(--accent) 6%, var(--bg-side)); border: 1px solid color-mix(in srgb, var(--accent) 22%, var(--rule)); box-shadow: var(--shadow); font-size: var(--fs-small); }
.uc[data-state="failed"] { border-color: color-mix(in srgb, var(--danger) 35%, var(--rule)); }
/* The peek: 72 px, tilted, faint, rising from the card's corner -- the aside
   card's own (note.js), and the words stay above it. */
.uc > :not(.uc-bg) { position: relative; z-index: 1; }
.uc-bg { position: absolute; right: -12px; bottom: -22px; width: 72px; height: 72px; z-index: 0; pointer-events: none;
  opacity: 0; transform: translate(12px, 26px) rotate(0deg); transition: opacity var(--dur-move) ease, transform .45s var(--ease-spring); }
#upd-card:hover .uc-bg, #upd-card:focus-within .uc-bg, .uc.peek .uc-bg { opacity: var(--mascot-peek); transform: rotate(-14deg); transition-delay: .12s; }
.uc-t { margin: 0; font-size: var(--fs-ui); font-weight: 600; color: var(--fg); display: flex; align-items: center; gap: 6px; }
.uc-sub { margin: 4px 0 0; color: var(--fg-2); line-height: 1.4; }
.uc-who { margin: 4px 0 0; padding: 0 0 0 14px; color: var(--fg-2); }
.uc-who li { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.uc-acts { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.uc-b { padding: 3px 9px; border: 1px solid var(--rule-2); border-radius: var(--r-sm); background: var(--bg); font: inherit; color: var(--fg); cursor: pointer; }
.uc-b:hover { border-color: var(--accent); }
.uc-b.go { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
.uc-b.danger { border-color: var(--danger); color: var(--danger); }
.uc-link { padding: 0; border: 0; background: none; font: inherit; color: var(--accent); cursor: pointer; }
.uc-link:hover { text-decoration: underline; }
.uc-how { display: flex; gap: 6px; align-items: flex-start; margin-top: 6px; }
.uc-how pre { flex: 1; min-width: 0; margin: 0; padding: 6px 8px; font-family: var(--mono); font-size: var(--fs-micro); line-height: 1.5; background: var(--code-bg); border-radius: var(--r-sm); white-space: pre-wrap; overflow-wrap: anywhere; }
#restart-strip { position: fixed; top: 0; left: 0; right: 0; z-index: 50; display: flex; align-items: center; justify-content: center; gap: 8px; padding: 6px 12px;
  background: color-mix(in srgb, var(--accent) 12%, var(--bg)); border-bottom: 1px solid var(--rule); color: var(--fg); font-size: var(--fs-small); pointer-events: none; }
#restart-strip[hidden] { display: none; }
.about-box { width: min(560px, 92vw); }
.about-box p { margin: 0 0 14px; font-size: var(--fs-body-s); color: var(--fg-2); }
.about-box dl { grid-template-columns: 9.5em 1fr; gap: 7px 20px; }
.about-box .ab-h { margin: 18px 0 8px; padding-bottom: 4px; border-bottom: 1px solid var(--rule); font-size: var(--fs-micro); font-weight: 600; color: var(--fg-3); }
.about-box dt { font-family: inherit; font-size: var(--fs-ui); color: var(--fg-3); }
.about-box dd { min-width: 0; overflow-wrap: anywhere; }
.about-box dd.path { font-family: var(--mono); font-size: var(--fs-small); }
.about-box dd.pre { white-space: pre-line; }
.about-box .muted { color: var(--fg-3); }
.about-box a { color: var(--accent); text-decoration: none; }
.about-box a:hover { text-decoration: underline; }
.reset-box { width: min(520px, 92vw); margin: 0; }
.reset-box p { margin: 0 0 12px; font-size: var(--fs-body-s); line-height: 1.5; }
.reset-box label { display: block; font-size: var(--fs-body-s); margin: 0 0 12px; }
.reset-box label[hidden] { display: none; }
.reset-ask input { display: block; width: 100%; margin-top: 6px; font: inherit; font-family: var(--mono); font-size: var(--fs-body-s); padding: 8px 10px; border: 1px solid var(--rule-2); border-radius: var(--r-sm); background: var(--bg); color: inherit; outline: none; }
.reset-ask input:focus { border-color: var(--accent); }
.reset-err { color: var(--danger); }
/* "Also the pinned ones", drawn as a document's checkbox is, in the danger colour once ticked. */
#reset-pinned { appearance: none; position: relative; width: 14px; height: 14px; margin: 0 6px -2px 0; border: 1.5px solid var(--rule-2); border-radius: var(--r-xs); background: var(--bg-raise); cursor: pointer; }
#reset-pinned:checked { background: var(--danger); border-color: var(--danger); }
#reset-pinned:checked::after { content: ""; position: absolute; left: 3.5px; top: 0; width: 4px; height: 8px; border: solid var(--on-accent); border-width: 0 2px 2px 0; transform: rotate(45deg); }
#reset-pinned:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.reset-act { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
`;
{ const s = document.createElement("style"); s.textContent = CSS_MOVED; document.head.append(s); }

/* ---------- the agents page, the first ten minutes, Welcome: their wiring ----------
 * The three pages this chunk draws are also routed, polled and answered
 * from here, so app.js keeps only a name for each (04-doc.js). `c` is the
 * page's context, read when a page is shown and not before. */
export function pages(c) {
  const { state, docEl, main, boot, esc, rel, toast } = c;
  let agentsSeen = "", agentsTimer = 0, connectHtml = null, welcomePlaces = [];
  const open = (view, title) => {
    state.view = view; state.doc = null; state.previous = null; state.comparing = null; state.browseRoot = null;
    document.title = title;
  };
  /** A page the reader went to puts the focus on its heading (or the
   *  section it was sent to), so the keyboard starts where the eye does. */
  const toHead = sec => {
    const h = (sec || docEl).querySelector("h1, h2");
    if (h) { h.tabIndex = -1; h.focus({ preventScroll: true }); }
  };
  /** Every fact on the agents page comes from /api/agents, read by the
   *  daemon from the agent's file; the page asks again every few seconds
   *  while it is on screen, so `snyvi init codex` in the terminal beside it
   *  turns the row without a reload. */
  async function showConnect(push = true) {
    if (push) c.leave();
    c.offDesk();
    open("connect", "Agents · snyvi");
    if (push) history.pushState({ connect: true }, "", "/connect");
    let a = boot.agents; boot.agents = null;
    if (!a) { try { a = await (await fetch("/api/agents")).json(); } catch { a = null; } }
    connectHtml ||= a => (agentsSeen = JSON.stringify(a ? a.rows : []), connect(a, { esc, rel, cap: !!c.capability }));
    if (state.view !== "connect") return;
    docEl.innerHTML = connectHtml(a);
    if (push) c.swapIn();
    main.scrollTo({ top: 0, behavior: "instant" });
    c.afterRender();
    clearInterval(agentsTimer);
    agentsTimer = setInterval(refreshAgents, 2500);
  }
  /** Ask again while the page is on screen; redraw only when something
   *  changed. The page left behind takes its timer with it. */
  async function refreshAgents() {
    if (state.view !== "connect") { clearInterval(agentsTimer); agentsTimer = 0; return; }
    if (!docEl.querySelector(".connect") || document.hidden) return;
    let a; try { a = await (await fetch("/api/agents")).json(); } catch { return; }
    if (JSON.stringify(a.rows) === agentsSeen || !connectHtml) return;
    const opened = [...docEl.querySelectorAll(".agent details[open]")].map(d => d.closest(".agent").dataset.agent);
    // And the fold of the other agents: a row turning is no reason to shut it.
    const more = !!docEl.querySelector(".agents-more[open]");
    docEl.innerHTML = connectHtml(a);
    for (const id of opened) docEl.querySelector(`.agent[data-agent="${CSS.escape(id)}"] details`)?.setAttribute("open", "");
    if (more) docEl.querySelector(".agents-more")?.setAttribute("open", "");
  }
  /** Connect Claude Code, from the Agents page or a desk's panel: it asks,
   *  in place, then runs `init-claude` in the daemon. "Connected." wears a
   *  face once, on the Agents page; a desk's panel is the work and gets the
   *  words alone (docs/DESIGN.md §2.3). */
  function connectClaude(b, done) {
    connectAsk(b, { sayErr: c.sayErr, api: (path, body) => c.deskApi(path, body), mascotHead: state.view === "desk" ? null : c.mascotHead, done: (a, ok) => {
      if (a && state.view === "connect" && connectHtml) setTimeout(() => { if (state.view === "connect") docEl.innerHTML = connectHtml(a); }, 1600);
      done && done(a, ok);
    } });
  }
  /** The first ten minutes. `at` is a section to land on (`#desks`), as an
   *  aside's link names one. */
  async function showStart(push = true, at = location.hash) {
    if (push) c.leave();
    c.offDesk();
    open("start", "How snyvi works · snyvi");
    if (push) history.pushState({ start: true }, "", "/start" + (at || ""));
    // A click in the page went elsewhere while the chunk was on its way.
    if (state.view !== "start") return;
    docEl.innerHTML = start({ cap: !!c.capability });
    startReady(boot.v);
    if (push) c.swapIn();
    const sec = at && document.getElementById(at.slice(1));
    if (sec) sec.scrollIntoView({ block: "start" }); else main.scrollTo({ top: 0, behavior: "instant" });
    c.afterRender();
    if (push) toHead(sec);
  }
  /** Welcome: what snyvi is, and which project first. Its own address to
   *  come back to from Help; the empty library draws the same page at `/`. */
  function welcomePage() {
    welcomePlaces = c.places();
    return welcome({ cap: !!c.capability, places: welcomePlaces, tilde: c.tilde, mascot: c.mascotHead("glad"), esc });
  }
  async function showWelcome(push = true) {
    if (push) c.leave();
    c.offDesk();
    open("welcome", "Welcome · snyvi");
    if (push) history.pushState({ welcome: true }, "", "/welcome");
    if (c.capability && !state.desks) await c.loadDesks();
    if (state.view !== "welcome") return;
    docEl.innerHTML = welcomePage();
    if (push) c.swapIn();
    main.scrollTo({ top: 0, behavior: "instant" });
    c.afterRender();
    if (push) toHead();
  }
  return { showConnect, showStart, showWelcome, welcomePage, connectClaude, refreshAgents, place: i => welcomePlaces[i] };
}
