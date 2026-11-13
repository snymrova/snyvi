/* ui/desk/29-decisions.js: a part of desk.js, one module. build.rs joins ui/desk/*.js in name
 * order (src/strip.rs `source`); SNYVI_UI_DIR serves the same join. */
// ---------- decisions ----------
// The desk's shelf of decisions (1.65, plan 2d186a80c1; `src/ledger.rs`):
// every question an agent put to the reader here, open however old,
// answered, or dropped. On you shows a question while it is fresh and for a
// day; after that it was on no list, and the next agent asked it again.
//
// It is the pile, on request: one line at the foot of On you's tray, and the
// tray's own space when that line is pressed. It never rings, rises or
// counts, so nothing here moves the page: it is drawn inside the tray, which
// lies over the rail. The rail is this desk's, so the shelf is too.
//
// A press answers in place. The row stays where it was and says what was
// done, with Undo there (the turn's own restore), until the shelf is closed.

const dec = {
  open: false,      // the tray shows the shelf, not On you
  at: null,         // the desk `list` is of
  sig: "",          // what `list` was read against (`decSig`)
  get: null,        // the desk being read
  list: [], counts: null,
  field: null,      // { id, k }: the row with a field open, "other" | "drop"
  draft: "",
  done: new Map(),  // id -> what a press did here, said in the row
  folds: new Set(), // "answered", "dropped": folded parts opened
};

/** What the list depends on: the desk, and its questions as the rail has
 *  them. An answer, a new asking or a put-away changes it, and each of those
 *  is said to the rail first (`threads_moved`). */
function decSig(d) {
  return d.id + "|" + filed.turns.filter(w => w.kind === "decide").map(w => `${w.id}:${w.answered_at || 0}:${w.until || 0}`).join(",");
}

/** Read the shelf when what it depends on moved. Once the desk's own list
 *  is in, or the first read would be made twice. */
function decWant(d) {
  if (filedAt !== d.id) return;
  const sig = decSig(d);
  if (dec.at === d.id && dec.sig === sig) return;
  decGet(d, sig);
}

async function decGet(d, sig = decSig(d)) {
  if (dec.get === d.id + sig) return;
  dec.get = d.id + sig;
  let j;
  try { j = await ctx.api(`/api/desks/${d.id}/decisions`); }
  catch { dec.get = null; return; }
  dec.get = null;
  if (d.id !== deskId) return;
  if (dec.at !== d.id) { dec.done.clear(); dec.field = null; dec.draft = ""; dec.folds.clear(); }
  Object.assign(dec, { at: d.id, sig, list: j.list || [], counts: j.counts || null });
  if (current()) rail();
}

/** How long ago, in the rail's short words; and the day something is back. */
function decAgo(ts) { const r = ctx.relShort(ts); return r === "now" ? "just now" : /^\d+[mhd]$/.test(r) ? `${r} ago` : r; }
function decDay(ts) { return new Date(ts * 1000).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }); }

/** The shelf's line at the foot of On you's tray: how many are open and how
 *  long the oldest has waited. Not there while the desk has none at all. */
function decLine(d, esc) {
  const c = dec.at === d.id && dec.counts;
  if (!c || !(c.open + c.later + c.answered + c.dropped)) return "";
  const { plural } = ctx;
  const open = c.open ? `${plural(c.open, "decision")} open${c.oldest_open_at ? `, the oldest ${esc(decAgo(c.oldest_open_at))}` : ""}` : "No decisions open";
  const rest = [c.later && `${c.later} later`, c.answered && `${c.answered} answered`].filter(Boolean).join(" · ");
  return `<button type="button" class="dc-line" data-a="dec-open" data-part="desk.decisions" data-tip="Decisions" data-tip-sub="Every question an agent asked you on this desk: open, answered, dropped. Agents read it before they ask again">` +
    `<span class="t">${open}${rest ? ` · ${rest}` : ""}</span><span class="g" aria-hidden="true">›</span></button>`;
}

/** What a question was asked under: its document, else its thread. */
function decGroup(x) {
  return x.doc ? `d${x.doc}` : x.thread_id ? `t${x.thread_id}` : "";
}

function decRow(x, esc) {
  const done = dec.done.get(x.id), f = dec.field?.id === x.id ? dec.field : null;
  const err = rowErr?.k === `c${x.id}` ? `<p class="dc-err" role="alert">${esc(rowErr.why)}</p>` : "";
  const q = `<p class="dc-q">${esc(x.text)}</p>`;
  const undo = `<button type="button" class="cn-undo" data-a="dec-undo" data-w="${x.id}">Undo</button>`;
  if (done) return `<li class="dc-row done" data-w="${x.id}">${q}<p class="dc-m">${esc(done)} ${undo}</p>${err}</li>`;
  if (f) {
    const drop = f.k === "drop";
    return `<li class="dc-row" data-w="${x.id}">${q}<div class="dc-f"><input class="dc-in" type="text" maxlength="${drop ? 120 : 300}" aria-label="${drop ? "Why not, in a word" : "Your answer"}" placeholder="${drop ? "Why not, in a word (or leave empty)" : "Your answer"}">` +
      `<button type="button" class="tn-opt rec" data-a="dec-save" data-w="${x.id}">${drop ? "Drop" : "Answer"}</button><button type="button" class="tn-opt quiet" data-a="dec-cancel">Cancel</button></div>${err}</li>`;
  }
  if (x.state === "answered") {
    const heard = x.answered_in === "panel" ? " · as the agent heard it" : "";
    return `<li class="dc-row" data-w="${x.id}">${q}<p class="dc-a">${esc(x.answer)}</p><p class="dc-m">${esc(decAgo(x.answered_at))}${heard} <button type="button" class="cn-undo" data-a="dec-other" data-w="${x.id}">Change</button></p>${err}</li>`;
  }
  if (x.state === "dropped") {
    return `<li class="dc-row" data-w="${x.id}">${q}<p class="dc-m">Dropped${x.answer ? `: ${esc(x.answer)}` : ""} <button type="button" class="cn-undo" data-a="dec-undo" data-w="${x.id}">Bring back</button></p>${err}</li>`;
  }
  if (x.state === "later") {
    return `<li class="dc-row" data-w="${x.id}">${q}<p class="dc-m">Back ${esc(decDay(x.until))} <button type="button" class="cn-undo" data-a="dec-undo" data-w="${x.id}">Bring back</button></p>${err}</li>`;
  }
  const opts = (x.options || []).map((o, i) => `<button type="button" class="tn-opt${i === x.recommended ? " rec" : ""}" data-a="dec-pick" data-w="${x.id}" data-v="${esc(o)}">${esc(o)}</button>`).join("");
  const meta = `asked ${esc(decAgo(x.asked_at))}${x.aged ? " · off On you" : ""}`;
  return `<li class="dc-row" data-w="${x.id}">${q}<p class="dc-m">${meta}</p><div class="tn-acts">${opts}` +
    `<button type="button" class="tn-opt quiet" data-a="dec-other" data-w="${x.id}">Other…</button>` +
    `<button type="button" class="tn-opt quiet" data-a="dec-later" data-w="${x.id}" data-tip="Not now" data-tip-sub="Back on On you next week">Not now</button>` +
    `<button type="button" class="tn-opt quiet" data-a="dec-drop" data-w="${x.id}" data-tip="Drop" data-tip-sub="Not this. The desk's agents are told, with your word">Drop</button></div>${err}</li>`;
}

/** Open ones under what they were asked for, the group asked of last first;
 *  inside a group the one that has waited longest leads, as the list has it. */
function decOpen(open, esc) {
  const groups = new Map();
  for (const x of open) {
    const k = decGroup(x);
    if (!groups.has(k)) groups.set(k, { x, rows: [], at: 0 });
    const g = groups.get(k);
    g.rows.push(x); g.at = Math.max(g.at, x.asked_at);
  }
  return [...groups.values()].sort((a, b) => b.at - a.at).map(g => {
    const x = g.x;
    const head = x.doc ? `<button type="button" class="dc-gh" data-a="dec-doc" data-doc="${esc(x.doc)}">${esc(x.doc_title || "A document")}</button>`
      : x.thread ? `<p class="dc-gh">${esc(x.thread)}</p>` : groups.size > 1 ? `<p class="dc-gh">On their own</p>` : "";
    return `${head}<ul class="dc-list">${g.rows.map(r => decRow(r, esc)).join("")}</ul>`;
  }).join("");
}

function decFold(k, label, rows, esc) {
  if (!rows.length) return "";
  const on = dec.folds.has(k);
  return `<p class="oy-qh"><button type="button" data-a="dec-fold" data-k="${k}" aria-expanded="${on}">${label} · ${rows.length}</button></p>` +
    (on ? `<ul class="dc-list">${rows.map(r => decRow(r, esc)).join("")}</ul>` : "");
}

/** The shelf, in the tray's place. A row a press settled here keeps its
 *  place among the open ones until the shelf is closed (`dec.done`), so
 *  nothing jumps from under the pointer and Undo is where the click was. */
function decHtml(d, esc) {
  const here = x => x.state === "open" || dec.done.has(x.id);
  const open = dec.list.filter(here), rest = dec.list.filter(x => !here(x));
  const of = s => rest.filter(x => x.state === s);
  const body = (open.length ? decOpen(open, esc) : `<p class="oy-none">Nothing is waiting on a decision.</p>`) +
    decFold("later", "Later", of("later"), esc) + decFold("answered", "Answered", of("answered"), esc) + decFold("dropped", "Dropped", of("dropped"), esc);
  const head = `<div class="oy-head"><button type="button" class="dc-back" data-a="dec-open" aria-label="Back to On you" data-tip="On you">‹</button>` +
    `<h3 class="oy-h">Decisions</h3><span class="oy-gap"></span><button type="button" class="oy-x" data-a="oy-open" aria-label="Close" data-tip="Close" data-tip-sub="Esc">${ico("x")}</button></div>`;
  return `<div class="oy-tray" role="dialog" aria-label="Decisions" tabindex="-1">${head}<div class="oy-scroll dc-shelf">${body}</div></div>`;
}

/** The open field takes the draft and the hand after a redraw, as a
 *  thread's does (`threadFocus`). Enter saves, Esc closes the field only. */
function decFocus(root) {
  const inp = root.querySelector(".dc-in");
  if (!inp || !dec.field) return;
  inp.value = dec.draft;
  inp.addEventListener("input", () => { dec.draft = inp.value; });
  inp.addEventListener("keydown", e => {
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); const d = current(); if (d) decSave(d, dec.field.id); }
    else if (e.key === "Escape") { e.preventDefault(); dec.field = null; dec.draft = ""; rail(); }
  });
  inp.focus({ preventScroll: true });
}

/** One press sent: the row says what was done, or why it could not be. */
async function decSend(d, id, act, body, said, again) {
  dec.field = null; dec.draft = "";
  dec.done.set(id, said);
  rail();
  if (await told(again, `c${id}`, "Could not save it", () => { dec.done.delete(id); },
    () => ctx.api(`/api/desks/${d.id}/decisions/${id}/${act}`, body))) {
    await decGet(d, decSig(d) + "!" + id + act);
    await getFiled(d.id, true);
  }
}

function decSave(d, id) {
  const f = dec.field, word = dec.draft.trim();
  if (!f || f.id !== id) return;
  if (f.k === "drop") return decSend(d, id, "drop", { not: word }, word ? `Dropped: ${word}` : "Dropped", { a: "dec-drop", w: id });
  if (!word) return;
  return decSend(d, id, "answer", { answer: word }, `Answered: ${word}`, { a: "dec-other", w: id });
}

async function decAct(a, b, d) {
  if (!a.startsWith("dec-")) return false;
  const id = +b.dataset.w;
  if (a === "dec-open") {
    dec.open = !dec.open;
    dec.field = null; dec.draft = "";
    if (!dec.open) dec.done.clear();
    else { oy.open = true; decGet(d, decSig(d) + "!open"); }
    rail();
  } else if (a === "dec-fold") { const k = b.dataset.k; if (!dec.folds.delete(k)) dec.folds.add(k); rail(); }
  else if (a === "dec-doc") ctx.read(b.dataset.doc);
  else if (a === "dec-pick") await decSend(d, id, "answer", { answer: b.dataset.v }, `Answered: ${b.dataset.v}`, { ...b.dataset });
  else if (a === "dec-other" || a === "dec-drop") { dec.field = { id, k: a === "dec-drop" ? "drop" : "other" }; dec.draft = ""; rail(); }
  else if (a === "dec-save") await decSave(d, id);
  else if (a === "dec-cancel") { dec.field = null; dec.draft = ""; rail(); }
  else if (a === "dec-later") await decSend(d, id, "later", { later: "next week" }, "Back next week", { ...b.dataset });
  else if (a === "dec-undo") {
    // The turn's own restore: a drop gives its word back, a Not now its
    // day, an answer its panel has not heard yet is taken back.
    const was = dec.done.get(id);
    dec.done.delete(id);
    if (await told({ ...b.dataset }, `c${id}`, "Could not bring it back", () => { if (was) dec.done.set(id, was); },
      () => ctx.api(`/api/desks/${d.id}/turns/${id}/restore`, {}))) {
      await decGet(d, decSig(d) + "!u" + id);
      await getFiled(d.id, true);
    }
  }
  return true;
}

const DECISIONS_CSS = `
.dc-line { display: flex; align-items: center; gap: 6px; width: 100%; margin: 8px 0 0; padding: 6px 0 2px; border: 0; border-top: 1px solid var(--rule); background: none; font: inherit; font-size: var(--fs-micro); color: var(--fg-3); text-align: left; cursor: pointer; }
.dc-line:hover { color: var(--fg); }
.dc-line .t { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dc-back { padding: 0 6px 0 0; border: 0; background: none; font: inherit; color: var(--fg-3); cursor: pointer; }
.dc-back:hover { color: var(--fg); }
.dc-shelf .dc-gh { display: block; margin: 10px 0 2px; padding: 0; border: 0; background: none; font: inherit; font-size: var(--fs-micro); color: var(--fg-3); text-align: left; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dc-shelf button.dc-gh { cursor: pointer; text-decoration: underline dotted; }
.dc-shelf button.dc-gh:hover { color: var(--fg); }
.dc-shelf > .dc-gh:first-child { margin-top: 2px; }
.dc-list { list-style: none; margin: 0; padding: 0; }
.dc-row { padding: 6px 0; border-top: 1px solid var(--rule); }
.dc-list > .dc-row:first-child { border-top: 0; }
.dc-row.done .dc-q { color: var(--fg-3); }
.dc-q { margin: 0; font-size: var(--fs-small); color: var(--fg); overflow-wrap: anywhere; }
.dc-a { margin: 2px 0 0; font-size: var(--fs-small); color: var(--fg-2); overflow-wrap: anywhere; }
.dc-m { margin: 2px 0 0; font-size: var(--fs-micro); color: var(--fg-3); }
.dc-err { margin: 2px 0 0; font-size: var(--fs-micro); color: var(--warn); }
.dc-f { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; margin-top: 6px; }
.dc-in { flex: 1 1 10em; min-width: 0; box-sizing: border-box; padding: 2px 6px; border: 1px solid var(--rule-2); border-radius: var(--r-xs); background: var(--bg); font: inherit; font-size: var(--fs-small); color: var(--fg); }
.dc-in:focus { outline: 0; border-color: var(--accent); }
`;
