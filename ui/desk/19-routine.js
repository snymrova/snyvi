/* ui/desk/19-routine.js: a part of desk.js, one module. build.rs joins ui/desk/*.js in name
 * order (src/strip.rs `source`); SNYVI_UI_DIR serves the same join. */
// ---------- routines ----------

/* A routine is a line that comes back (src/routine.rs; the field and the
 * draft, 1.53, plan f30461f2c1). Its own section under Notes, always there:
 * one line when empty, the field, so the way in is in sight on every desk.
 *
 * The field takes `/newsroom · every day 7:30` or the reader's own words
 * with a cadence. `/` lists the project's and the reader's commands and
 * skills (src/routine/places.rs); the chip says what the daemon reads in
 * the line (`GET …/routines/read`), never a grammar of its own. Enter makes
 * a draft and opens its sheet (21-routine-sheet.js): Try once now, then
 * Start it. Nothing runs on its own before Start.
 *
 * A row is drawn like a note's with a clock ring in the circle's place, the
 * ⋯ menu every row has, and arrives at the list's foot, so nothing above it
 * moves. The chip, the list under the field and an error all overlay. */

/** This desk's routines, as the daemon last said them, and which desk. */
let rts = [], rtsAt = null;
/** The commands and skills `/` lists: `{ at, list, project, yours }`. */
let rtCmds = { at: null, list: [], project: 0, yours: 0 };
/** The routine whose menu is open, or 0. */
let rtMenu = 0;
/** One just removed from view: its row holds the Undo. */
let rtGone = null;
/** Just started: the row says so until then (ms), by id. */
const rtStarted = new Map();
/** The field, open: what is typed, the caret, why Enter was refused, the
 *  daemon's read of it, the picked line of the list, and whether the
 *  focus left it (a redraw then leaves the focus where it went). */
let rtField = null;
let rtReadT = 0, rtReadN = 0;

/** Read again: on open, and on the `desknotes` event (`routine_run::changed`). */
async function routinesGet(id) {
  let j;
  try { j = await ctx.api(`/api/desks/${id}/routines`); } catch { return; }
  if (id !== deskId) return;
  // Every notes event asks; the rail is drawn again only when what it shows
  // moved, or a redraw would race a click on a card the event came for.
  const next = j.routines || [];
  const moved = rtsAt !== id || JSON.stringify(next) !== JSON.stringify(rts);
  rts = next; rtsAt = id;
  if (rtOpen) rtSheetGet(rtOpen.id, rtOpen.at);
  if (moved && current()) rail();
}

/** The `/` list, asked for when the field opens: the daemon keeps it by the
 *  folders' times, so asking again costs four stats. */
async function rtCmdsGet(id) {
  try {
    const j = await ctx.api(`/api/desks/${id}/commands`);
    rtCmds = { at: id, list: j.commands || [], project: j.project || 0, yours: j.yours || 0 };
  } catch { return; }
  if (rtField && current()) rtCompDraw();
}

/** The routine a panel runs for, on this desk. */
const rtPane = pane => rtsAt === deskId && pane ? rts.find(r => r.pane === pane) : undefined;

/** The section, under Notes: always drawn, one line when empty. */
function routineSec(d) {
  const { esc } = ctx;
  rtStyle();
  const mine = rtsAt === d.id ? rts : [];
  const gone = rtGone && rtGone.at === d.id;
  const rows = mine.map(r => rtRow(r, esc)).join("") +
    (gone ? `<li class="dk-note gone" role="status"><span class="nm">${esc(rtGone.name)} · removed from view</span><button type="button" class="dk-undo" data-a="rt-back" data-r="${rtGone.id}">Undo</button></li>` + errLine(`r${rtGone.id}`, esc) : "");
  const running = mine.filter(r => r.running_since).length;
  const acts = `<button type="button" data-a="rt-new" data-tip="New routine" aria-label="New routine">${ico("plus")}</button>`;
  return sec("routines", "rail.routines", "Routines", {
    cls: "dk-notes dk-rts", part: "rail.routines.head", empty: !mine.length, acts,
    tip: "Routines", sub: "Lines that come back: a /command or your own words, and when. Try one once, then Start it, and snyvi runs it at its hour in a panel in the back.",
    count: running ? `● ${mine.length}` : mine.length || "", tone: running ? "accent" : "", countTip: running ? `${running} running` : "",
  }, (rows ? `<ul class="dk-list">${rows}</ul>` : "") + rtFieldHtml(esc));
}

/* Short enough for the rail's width. It was `/command · every day 9`,
 * which read as a syntax to copy (audit 566d17f746, R3): the list that
 * opens on focus now shows the `/` and the when. */
const RT_HOLD = "Something to run on its own…";

/** The field at the list's foot: quiet until clicked, then live, in the
 *  same room, so nothing under it moves as it opens and shuts. */
function rtFieldHtml(esc) {
  const lead = `<span class="dk-lead"><span class="dk-tick dk-ring ghost" aria-hidden="true">${RT_HANDS}</span></span>`;
  if (!rtField) return `<div class="dk-note new idle rt-new">${lead}<input class="rt-in idle" placeholder="${RT_HOLD}" aria-label="A new routine on this desk" data-tip="A new routine" data-tip-sub="a /command or skill, or your own words, then when: every weekday 9" spellcheck="false"></div>`;
  return `<div class="dk-note new rt-new">${lead}<input class="rt-in" placeholder="${RT_HOLD}" aria-label="A new routine on this desk" spellcheck="false" autocomplete="off" role="combobox" aria-autocomplete="list" aria-controls="rt-comp" aria-expanded="false">` +
    `<span class="dk-due-guess rt-chip" aria-hidden="true" hidden></span>` +
    (rtField.err ? `<span class="field-err" role="alert">${esc(rtField.err)}</span>` : "") + `</div>`;
}

/** What the list shows for what is typed: while the field is empty or a
 *  name is being typed (`/new`, no space yet). A name that starts with what
 *  is typed comes first, then one that holds it, then one whose about does,
 *  so `/video` finds the skill that makes one (R2); within each, A to Z
 *  with a leading `_` passed over, the project's ahead of the reader's. */
function rtMatches() {
  const t = rtField ? rtField.text : "";
  if (!rtListing(t) || rtCmds.at !== deskId) return [];
  const q = t.slice(1).toLowerCase();
  const by = c => { const n = c.name.toLowerCase(); return n.startsWith(q) ? 0 : n.includes(q) ? 1 : q && (c.about || "").toLowerCase().includes(q) ? 2 : 3; };
  const key = c => c.name.replace(/^[^a-z0-9]+/i, "").toLowerCase();
  return rtCmds.list.filter(c => by(c) < 3)
    .sort((a, b) => (a.who === b.who ? 0 : a.who === "project" ? -1 : 1) || by(a) - by(b) || key(a).localeCompare(key(b)));
}

/** Whether the field is at the point the list serves: empty, or a `/name`. */
const rtListing = t => t === "" || /^\/[\w-]*$/.test(t);

/** The list under the field, drawn on its own: typing never redraws the
 *  rail. It lives on the page's body, over the desk, as the sheet does: in
 *  the rail it was clipped, and its height scrolled the rail sideways.
 *
 *  It opens upward when the room below is short. The field is the rail's
 *  last line, so below it was the window's edge: the list was drawn there
 *  and the reader saw no skills at all (R1). It opens with the field, so
 *  the way to say a command and when is in sight before anything is typed. */
function rtCompDraw() {
  const inp = ctx.tocEl.querySelector(".rt-in:not(.idle)");
  const ms = rtMatches(), e = ctx.esc;
  const open = !!(inp && rtField && !rtField.away) && rtListing(rtField.text) && rtCmds.at === deskId;
  inp?.setAttribute("aria-expanded", String(open));
  let el = document.getElementById("rt-comp");
  if (!open) { el?.remove(); return; }
  if (!el) {
    el = document.createElement("div");
    el.id = "rt-comp"; el.className = "rt-comp";
    el.setAttribute("role", "listbox"); el.setAttribute("aria-label", "Commands and skills");
    // Its buttons must not take the focus from the field.
    el.addEventListener("mousedown", ev => ev.preventDefault());
    el.addEventListener("click", ev => { const b = ev.target.closest("[data-n]"); if (b) rtPick(b.dataset.n); });
    document.body.append(el);
  }
  rtField.pick = Math.min(rtField.pick || 0, Math.max(0, ms.length - 1));
  // Its right edge on the field's, so it opens over the desk; up when
  // there is more room above than below.
  const at = inp.getBoundingClientRect(), w = Math.max(at.width, 360);
  const below = innerHeight - at.bottom - 12, above = at.top - 12, up = below < 260 && above > below;
  Object.assign(el.style, { left: `${Math.max(8, at.right - w)}px`, width: `${w}px`, maxHeight: `${Math.min(420, up ? above : below)}px`,
    top: up ? "" : `${at.bottom + 2}px`, bottom: up ? `${innerHeight - at.top + 2}px` : "" });
  el.classList.toggle("up", up);
  const head = (who, n) => `<p class="rt-o-h">${who === "project" ? "This project" : "Yours"} · ${n}</p>`;
  let rows = "", was = "";
  ms.forEach((c, i) => {
    if (c.who !== was) { was = c.who; rows += head(c.who, ms.filter(x => x.who === c.who).length); }
    rows += `<button type="button" role="option" id="rt-o${i}" aria-selected="${i === rtField.pick && !!rtField.moved}" data-n="${e(c.name)}"><span class="rt-o-n">/${e(c.name)}</span><span class="rt-o-tag">${e(c.kind)}</span>${c.about ? `<span class="rt-o-ab">${e(c.about)}</span>` : ""}</button>`;
  });
  const none = !rtCmds.list.length ? "No commands or skills in this project or yours yet: write your own words instead."
    : "No command or skill by that name: words without a / are your own.";
  el.innerHTML = (rows || `<p class="rt-o-none">${none}</p>`) +
    `<p class="rt-o-foot">then when: <b>every weekday 9</b> · <b>every mon 9:00</b> · <b>every 1st</b> · or your own words instead of a /command</p>`;
  inp.setAttribute("aria-activedescendant", ms.length && rtField.moved ? `rt-o${rtField.pick}` : "");
  // Up, the list's foot is nearest the field: start it scrolled there.
  if (up && !rtField.moved) el.scrollTop = 0;
  el.querySelector("[aria-selected=true]")?.scrollIntoView({ block: "nearest" });
}

/** The chip under the field: what the daemon read, there or not. It
 *  overlays, so it moves nothing, and the field keeps its whole width for
 *  the line, which the rail's width needs. */
function rtChipDraw() {
  const inp = ctx.tocEl.querySelector(".rt-in:not(.idle)"), el = inp?.parentElement?.querySelector(".rt-chip");
  if (!el || !rtField) return;
  const j = rtField.read || {};
  const said = j.error ? j.error
    : j.when ? `when? · ${j.where} · every day 9`
    : j.every ? `↻ ${j.every} · ${j.words ? "your words" : j.where} · first ${dueWord(j.next).w.replace(/^due /, "")}` : "";
  el.textContent = said;
  el.classList.toggle("warn", !!j.error);
  el.hidden = !said || !!rtField.err;
}

/** Ask the daemon what the line would become, 120 ms after the last key. */
function rtRead(d) {
  clearTimeout(rtReadT);
  const n = ++rtReadN, text = rtField ? rtField.text : "";
  if (!text.trim() || /^\/[\w-]*$/.test(text)) { if (rtField) rtField.read = null; rtChipDraw(); return; }
  rtReadT = setTimeout(async () => {
    let j;
    try { j = await ctx.api(`/api/desks/${d.id}/routines/read?text=${encodeURIComponent(text)}`); } catch { return; }
    if (n !== rtReadN || !rtField) return;
    rtField.read = j; rtChipDraw();
  }, 120);
}

/** Enter: the line made a draft, and its sheet open with the same reply.
 *  A no keeps the field open with every character and the reason. */
async function rtAdd(d) {
  const text = rtField ? rtField.text.trim() : "";
  if (!text) return;
  let j;
  try { j = await ctx.api(`/api/desks/${d.id}/routines`, { text }); }
  catch (e) { if (rtField) { rtField.err = ctx.sayErr(e).why; rail(); } return; }
  rtField = null;
  if (j.routine) { rts = [...rts.filter(r => r.id !== j.routine.id), j.routine]; rtsAt = d.id; }
  rail();
  if (j.routine) rtSheetShow(j);
  routinesGet(d.id);
}

/** Put the open field back after a redraw, with what was typed and the
 *  caret where it was; unless the focus had gone elsewhere. */
function rtFocus() {
  const d = current();
  if (!rtField) document.getElementById("rt-comp")?.remove();
  ctx.tocEl.querySelector(".rt-in.idle")?.addEventListener("focus", () => {
    rtField = { text: "", caret: 0, err: "", read: null, pick: 0, away: false };
    if (d && rtCmds.at !== d.id) rtCmdsGet(d.id);
    rail();
  }, { once: true });
  const inp = ctx.tocEl.querySelector(".rt-in:not(.idle)");
  if (!inp || !rtField || !d) return;
  inp.value = rtField.text;
  const typed = () => {
    rtField.text = inp.value; rtField.caret = inp.selectionStart; rtField.pick = 0; rtField.moved = false;
    if (rtField.err) { rtField.err = ""; inp.parentElement?.querySelector(".field-err")?.remove(); }
    rtCompDraw(); rtRead(d);
  };
  inp.addEventListener("input", typed);
  for (const e of ["keyup", "click"]) inp.addEventListener(e, () => { if (rtField) rtField.caret = inp.selectionStart; });
  inp.addEventListener("keydown", e => {
    // The desk gives every other key to the shell in the focused panel.
    e.stopPropagation();
    const ms = rtMatches();
    if (ms.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      // The first press lands on the first line, not past it.
      rtField.pick = !rtField.moved ? (e.key === "ArrowDown" ? 0 : ms.length - 1) : (rtField.pick + (e.key === "ArrowDown" ? 1 : ms.length - 1)) % ms.length;
      rtField.moved = true;
      return rtCompDraw();
    }
    // A name being typed takes the first match; an empty field only the
    // line the arrows chose, so Enter on nothing never picks for the reader.
    if (ms.length && (rtField.moved || rtField.text) && (e.key === "Enter" || e.key === "Tab")) { e.preventDefault(); return rtPick(ms[rtField.moved ? rtField.pick : 0].name); }
    if (e.key === "Enter") { e.preventDefault(); rtAdd(d); }
    else if (e.key === "Escape") {
      e.preventDefault();
      // The list goes first, as a space would take it: the field stays.
      if (ms.length && rtField.text) { rtField.text += " "; inp.value = rtField.text; rtCompDraw(); return rtRead(d); }
      rtField = null; rail();
    }
  });
  // Leaving an empty field shuts it; one with words keeps them for later.
  inp.addEventListener("blur", () => {
    if (drawing || !rtField) return;
    if (!rtField.text.trim()) { rtField = null; rail(); } else { rtField.away = true; rtCompDraw(); }
  });
  inp.addEventListener("focus", () => { if (rtField) { rtField.away = false; rtCompDraw(); } });
  rtCompDraw(); rtChipDraw();
  if (rtField.read == null && rtField.text) rtRead(d);
  if (rtField.away) return;
  inp.focus();
  const at = Math.min(rtField.caret, inp.value.length);
  inp.setSelectionRange(at, at);
  // The focus can scroll the rail to the field: the list is measured after
  // it, and again whenever the rail scrolls, so it stays on the field.
  rtCompDraw();
  if (!rtScrollHeard) { rtScrollHeard = true; ctx.tocEl.addEventListener("scroll", () => { if (rtField && document.getElementById("rt-comp")) rtCompDraw(); }, { passive: true }); }
}

/** Whether the rail's scroll is heard for the list yet: once a page. */
let rtScrollHeard = false;

/** A name from the list: the line takes it and waits for when. */
function rtPick(name) {
  if (!rtField) return;
  rtField.text = `/${name} `; rtField.caret = rtField.text.length; rtField.pick = 0; rtField.moved = false; rtField.away = false;
  const inp = ctx.tocEl.querySelector(".rt-in:not(.idle)");
  if (inp) { inp.value = rtField.text; inp.focus(); inp.setSelectionRange(rtField.caret, rtField.caret); }
  rtCompDraw();
  const d = current();
  if (d) rtRead(d);
}

/** How long ago, in the rail's words. */
const rtAgo = s => s < 60 ? "just now" : s < 3600 ? `${s / 60 | 0} min ago` : s < 86400 ? `${s / 3600 | 0} h ago` : `${s / 86400 | 0} d ago`;
/** How long, roughly, as the row says it: `2 h`, `3 d`, `40 min`. */
const rtLong = s => s < 3600 ? `${Math.max(1, s / 60 | 0)} min` : s < 86400 ? `${s / 3600 | 0} h` : `${s / 86400 | 0} d`;
/** When next, in the rail's words. */
const rtNext = at => dueWord(at).w.replace(/^due /, "");

/** A row's one line of state: the whole of it, as the plan counts it. */
function rtMeta(r) {
  const now = Date.now() / 1000;
  if (r.state === "offer") return `${r.suggested_by} offers · ${r.every}`;
  if (r.state === "draft") return r.running_since ? "draft · trying" : `draft · ${r.every} · Start it to run`;
  if (rtStarted.get(r.id) > Date.now()) return `started · it runs on its own from ${rtNext(r.due_at)}`;
  // A run's minutes are the ones it ran: a laptop asleep mid-run is said
  // apart, and does not use them up (#198, `server::routine_run::over`).
  if (r.running_since) return `running ${Math.max(1, (now - r.running_since - (r.slept_s || 0)) / 60 | 0)} min${r.slept_s ? ` · slept ${rtLong(r.slept_s)}` : ""}${r.running !== "session" ? ` · ${r.running}` : ""}`;
  if (r.file === "gone") return "command gone";
  if (r.file === "two") return "two files hold it: rename one";
  if (r.file === "changed") return "changed since you allowed it";
  if (r.paused_at) return `paused · ${r.every}`;
  // A clock's catch-up says how late it ran: only a clock start is late,
  // and an hour that never ran leaves the last run's word (#198).
  const last = r.last_at ? ` · ran ${rtAgo(now - r.last_at)}${r.late_s ? ` · ${rtLong(r.late_s)} late` : ""}` : "";
  const st = r.last_state && !["done", "running"].includes(r.last_state) ? ` · ${r.last_state}` : "";
  return `${r.every} · next ${rtNext(r.due_at)}${last}${st}`;
}

/** What a row is called in a tip: `/newsroom`, or the words themselves. */
const rtSaid = r => r.cmd ? `/${r.name}` : r.name;

function rtRow(r, esc) {
  const offer = r.state === "offer", meta = rtMeta(r);
  const tools = offer
    ? `<span class="dk-sug-tools"><button type="button" class="dk-keep" data-a="rt-sheet" data-r="${r.id}" aria-label="Look at ${esc(r.name)} and accept it">Accept…</button>` +
      `<button type="button" data-a="rt-x" data-r="${r.id}" data-tip="Not this one" data-tip-sub="nothing is deleted" aria-label="Do not keep ${esc(r.name)}">${ico("x")}</button></span>`
    : `<span class="dk-tail"><span class="dk-tools"><button type="button" data-a="rt-menu" data-r="${r.id}" aria-haspopup="menu" aria-expanded="${rtMenu === r.id}" data-tip="More" aria-label="More for ${esc(r.name)}">⋯</button></span></span>`;
  const allow = r.file === "changed" && r.state !== "draft" && !offer ? `<button type="button" class="dk-keep rt-allow" data-a="rt-sheet" data-r="${r.id}" data-tip="See what changed, and allow it" data-tip-sub="${esc(r.path)} changed; it does not run until you allow it">Allow…</button>` : "";
  return `<li class="dk-note dk-rt${offer ? " dk-sug" : ""}${r.state === "draft" ? " draft" : ""}${r.running_since ? " on" : ""}${r.paused_at ? " paused" : ""}">` +
    `<span class="dk-lead"><span class="dk-tick dk-ring" aria-hidden="true">${RT_HANDS}</span></span>` +
    `<button type="button" class="nm" data-a="rt-sheet" data-r="${r.id}" data-tip="${esc(rtSaid(r))}" data-tip-sub="${esc(meta)} · click for its sheet"><span class="nm-t" data-tip-cut>${esc(r.name)}</span></button>` +
    tools +
    `<span class="dk-meta"><span class="rt-meta">${esc(meta)}</span>${allow}</span>` +
    (rtMenu === r.id ? rtPop(r, esc) : "") + `</li>` + errLine(`r${r.id}`, esc);
}

/** A clock's two hands, in the circle a note's tick draws: the ring. */
const RT_HANDS = '<svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><path d="M6 3.2V6l2 1.3"/></svg>';

/** The ⋯ menu. A draft's: Open · Try once now · Start it · Remove. A live
 *  one's: Run now · Pause or Resume · Change… · History · Remove. */
function rtPop(r, esc) {
  const item = (a, l, tip = "") => `<button type="button" role="menuitem" data-a="${a}" data-r="${r.id}"${tip ? ` data-tip="${esc(tip)}"` : ""}>${l}</button>`;
  const x = item("rt-x", "Remove from view", "nothing is deleted");
  if (r.state === "draft") {
    return `<span class="dk-due-pop rt-pop" role="menu" aria-label="${esc(r.name)}">` + item("rt-sheet", "Open") +
      (r.running_since ? "" : item("rt-try", "Try once now", "one run in its panel in the back, while you watch")) +
      item("rt-start", "Start it", "allows the file as it is now; it runs on its own from its next hour") + x + `</span>`;
  }
  return `<span class="dk-due-pop rt-pop" role="menu" aria-label="${esc(r.name)}">` +
    (r.running_since ? "" : item("rt-run", "Run now", `${rtSaid(r)} in its panel in the back`)) +
    item(r.paused_at ? "rt-resume" : "rt-pause", r.paused_at ? "Resume" : "Pause") +
    item("rt-sheet", "Change…") + item("rt-history", "History") + x + `</span>`;
}

/** Started: the row says so where it is, for eight seconds. */
function rtSaidStarted(id) {
  rtStarted.set(id, Date.now() + 8000);
  setTimeout(() => { rtStarted.delete(id); if (current()) rail(); }, 8100);
}

/** The row's clicks; true when one of them was this part's. */
async function routineAct(a, b, d) {
  if (!a.startsWith("rt-")) { if (rtMenu) { rtMenu = 0; rail(); } return false; }
  const id = +b.dataset.r, r = rts.find(x => x.id === id);
  const call = (act, why, back = () => {}) => told({ ...b.dataset }, `r${id}`, why, back, () => ctx.api(`/api/desks/${d.id}/routines/${id}/${act}`, {}));
  // The head's + is the way to the field when the rail is scrolled away
  // from it, at the foot of a long list of notes (R4).
  if (a === "rt-new") {
    if (!rtField) rtField = { text: "", caret: 0, err: "", read: null, pick: 0, away: false };
    rtField.away = false; if (rtCmds.at !== d.id) rtCmdsGet(d.id); rail();
    ctx.tocEl.querySelector(".rt-new")?.scrollIntoView({ block: "nearest" }); rtCompDraw();
    return true;
  }
  if (a === "rt-menu") { rtMenu = rtMenu === id ? 0 : id; rail(); if (rtMenu) ctx.tocEl.querySelector(".rt-pop button")?.focus(); return true; }
  rtMenu = 0;
  if (a === "rt-sheet" || a === "rt-history") { rtSheetGet(id, a === "rt-history" ? "runs" : ""); rail(); return true; }
  if (a === "rt-back") { rtGone = null; rail(); if (await call("restore", "Could not bring it back")) routinesGet(d.id); return true; }
  if (!r) return true;
  if (a === "rt-x") { rtRemove(d, r, b.dataset); return true; }
  const act = { "rt-run": "run", "rt-try": "try", "rt-start": "start", "rt-pause": "pause", "rt-resume": "resume" }[a];
  if (act) {
    const why = { run: "Could not run it", try: "Could not try it", start: "Could not start it", pause: "Could not pause it", resume: "Could not resume it" }[act];
    if (act === "run" || act === "try") r.running_since = Date.now() / 1000;
    rail();
    if (await call(act, why, () => { r.running_since = 0; }) && act === "start") rtSaidStarted(id);
    routinesGet(d.id);
  }
  return true;
}

/** Remove from view (and a draft's Cancel): the row keeps its Undo. */
async function rtRemove(d, r, again = {}) {
  const id = r.id;
  rts = rts.filter(x => x !== r); rtGone = { id, name: r.name, at: d.id }; rail();
  const ok = await told(again, `r${id}`, "Could not remove it", () => { rts.push(r); rtGone = null; },
    () => ctx.api(`/api/desks/${d.id}/routines/${id}/remove`, {}));
  if (!ok) return;
  setTimeout(() => { if (rtGone && rtGone.id === id) { rtGone = null; if (current()) rail(); } }, 8000);
}

function rtStyle() {
  if (document.getElementById("rt-css")) return;
  const s = document.createElement("style");
  s.id = "rt-css";
  s.textContent = RT_CSS + RT_SHEET_CSS;
  document.head.append(s);
}

/* The ring stands where a note's circle does, at its size, so a routine's
 * row is exactly a note row's height; the meta line is the note's. The
 * field is the note field's, under its own class: the notes' code finds
 * its field by `.dk-note-in` and must never find this one. */
const RT_CSS = `
.dk-ring { color: var(--fg-3); }
.dk-ring.ghost { opacity: .55; }
.dk-rt.on .dk-ring { color: var(--accent-d); box-shadow: inset 0 0 0 1.5px var(--accent); }
.dk-rt.paused .nm-t, .dk-rt.paused .rt-meta, .dk-rt.draft .nm-t { color: var(--fg-3); }
.dk-tick.dk-ring svg { width: 12px; height: 12px; }
.rt-meta { color: var(--fg-3); font-size: var(--fs-micro); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.dk-rt .rt-allow { margin-left: 6px; }
.dk-rt > .rt-pop { left: 27px; }
.rt-in { flex: 1; min-width: 0; margin: 2px 8px 2px 0; padding: 2px 6px; font: inherit; font-size: 12px; line-height: 1.5; color: var(--fg); background: var(--bg); border: 1px solid var(--accent); border-radius: var(--r-xs); }
.rt-in::placeholder { color: var(--fg-3); }
.rt-in.idle { border-color: var(--rule-2); background: transparent; cursor: text; }
.rt-in.idle:hover { border-color: var(--fg-3); }
.rt-new .rt-chip { top: calc(100% + 1px); left: 27px; right: 8px; transform: none; width: fit-content; max-width: calc(100% - 35px); z-index: var(--z-pop, 30); line-height: 15px; padding: 1px 6px; white-space: normal; box-shadow: var(--shadow); border-radius: var(--r-xs); }
.rt-chip.warn { background: color-mix(in srgb, var(--warn) 16%, var(--bg)); }
.rt-comp { position: fixed; z-index: var(--z-pop, 30); max-height: 300px; overflow: auto; box-sizing: border-box; background: var(--bg-raise); border: 1px solid var(--rule); border-radius: var(--r-xs); box-shadow: var(--shadow); padding: 3px 0; }
.rt-comp button { display: grid; grid-template-columns: auto 1fr; gap: 0 8px; width: 100%; text-align: left; background: none; border: 0; padding: 3px 8px; font: inherit; font-size: 12px; color: var(--fg); cursor: pointer; }
.rt-comp button[aria-selected=true], .rt-comp button:hover { background: color-mix(in srgb, var(--accent) 12%, var(--bg-raise)); }
.rt-o-n { font-family: var(--pn-font, monospace); }
.rt-o-tag { color: var(--fg-3); font-size: var(--fs-micro); justify-self: end; }
.rt-o-ab { grid-column: 1 / -1; color: var(--fg-3); font-size: var(--fs-micro); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rt-o-none, .rt-o-foot, .rt-o-h { margin: 0; padding: 3px 8px; color: var(--fg-3); font-size: var(--fs-micro); }
.rt-o-h { padding-top: 6px; font-weight: 600; color: var(--fg-2); }
.rt-o-foot { position: sticky; bottom: -3px; background: var(--bg-raise); border-top: 1px solid var(--rule); margin-top: 3px; padding-bottom: 6px; }
.rt-o-foot b { font-weight: 500; color: var(--fg-2); font-family: var(--pn-font, monospace); }
`;
