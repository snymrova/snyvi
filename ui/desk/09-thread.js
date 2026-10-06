/* ui/desk/09-thread.js: a part of desk.js, one module. build.rs joins ui/desk/*.js in name
 * order (src/strip.rs `source`); SNYVI_UI_DIR serves the same join. */
// ---------- threads, your turn, suggested (#90) ----------
/*
 * What an agent files so the bookkeeping around the work is not the reader's
 * (src/thread.rs): the desk's threads, what is waiting on the reader, and the
 * panels and desks an agent suggests. Three sections at the top of the rail,
 * each drawn only when it has something, so a desk no agent files on looks
 * as it always did. Every ✕ leaves its Undo in the row; nothing opens,
 * starts or sends without a click here.
 */

const STAGES = ["idea", "planned", "building", "review", "waiting", "shipped"];
/** How long a shipped thread stays on the rail, and an answer with it. */
const SHIPPED_SHOWN = 2 * 86400;

let filed = { threads: [], turns: [], suggestions: [] }, filedAt = null, filedGet = null, filedOff = null;
/** A row just put away, holding its Undo: { k: "t" | "w" | "s", id, text }. */
let filedGone = null, filedTimer = 0;
/** The field open in a card: { kind: "park" | "rename" | "other" | "change", id }. */
let thField = null, thDraft = "";
/** Answers given here, kept for Send now until sent or the panel moves on. */
const sendable = new Map();

/** The three sections, above the panels. */
function filedSecs(d) {
  if (filedAt !== d.id && filedOff !== d.id) getFiled(d.id);
  const f = filedAt === d.id ? filed : { threads: [], turns: [], suggestions: [] };
  return threadSec(d, f) + turnSec(d, f) + sugSec(f);
}

/** Which panel a pane is, as the reader counts them. */
const slotOf = (d, pane) => d.panes.find(p => p.id === pane)?.slot;

/** A row put away: the same Undo room a note's ✕ leaves. */
const goneRow = (k, id, text, esc) => `<li class="dk-note gone" role="status"><span class="nm">${esc(text)}</span><button type="button" class="dk-undo" data-a="fd-back" data-k="${k}" data-i="${id}">Undo</button></li>` + errLine(`${k}${id}`, esc);

function threadSec(d, f) {
  const { esc } = ctx, now = Date.now() / 1000;
  const shown = f.threads.filter(t => t.stage !== "shipped" || now - (t.shipped_at || t.moved_at) < SHIPPED_SHOWN);
  const gone = filedGone && filedGone.k === "t" ? filedGone : null;
  if (!shown.length && !gone) return "";
  const moving = shown.filter(t => t.stage !== "shipped" && t.stage !== "parked").length;
  const rows = shown.map(t => threadCard(d, t, f, esc)).join("") + (gone ? goneRow("t", gone.id, gone.text, esc) : "");
  return `<details class="dk-sec dk-filed" data-sec="threads" data-part="rail.threads"${secFolded("threads") ? "" : " open"}>` +
    `<summary class="t-label dk-lab" data-tip="Threads" data-tip-sub="Pieces of work an agent filed on this desk: their notes, where they live, and what was decided">Threads<span class="s-chev" aria-hidden="true"></span>${moving ? `<span class="n">${moving} moving</span>` : ""}</summary>` +
    `<ul class="dk-threads">${rows}</ul></details>`;
}

/** The stage bar: six steps filled up to where the thread is; parked is its
 *  own word, with the step it was parked at left unsaid. */
function stageBar(t, esc) {
  if (t.stage === "parked") return `<div class="th-stage parked"><span class="th-word">Parked</span>${t.next ? `<span class="th-next" data-tip="Next step" data-tip-sub="${esc(t.next)}" data-tip-overflow>${esc(t.next)}</span>` : ""}</div>`;
  const at = STAGES.indexOf(t.stage);
  return `<div class="th-stage"><span class="th-bar" role="img" aria-label="Stage ${at + 1} of ${STAGES.length}: ${esc(t.stage)}">` +
    STAGES.map((s, i) => `<i class="${i < at ? "past" : i === at ? "now" : ""}" data-tip="${s}"></i>`).join("") +
    `</span><span class="th-word">${esc(t.stage)}</span></div>`;
}

function threadCard(d, t, f, esc) {
  const decided = f.turns.filter(w => w.thread_id === t.id && w.kind === "decide" && w.answered_at).slice(-3);
  const editing = thField && thField.id === t.id && (thField.kind === "park" || thField.kind === "rename");
  const notes = t.notes.length ? `<span class="th-notes">${t.notes.map(n => `#${n}`).join(" ")}</span>` : "";
  const branch = t.branch ? `<p class="th-line" data-tip="${t.seen ? "Seen" : "Said"}" data-tip-sub="${t.seen ? "the snyvi mod in the panel saw git do it" : "the agent said so"}"><span class="mono">${esc(t.branch)}</span>${t.commits ? ` · ${ctx.plural(t.commits, "commit")}` : ""}${t.seen ? ` · <i>seen</i>` : ""}</p>` : "";
  const pr = t.pr ? `<p class="th-line">PR ${esc(t.pr)}${t.ci ? ` · CI ${esc(t.ci)}` : ""}${t.merged ? ` · merged <span class="mono">${esc(t.merged.slice(0, 7))}</span>` : ""}</p>` : "";
  const by = slotOf(d, t.pane);
  return `<li class="dk-thread${t.stage === "shipped" ? " shipped" : ""}" data-t="${t.id}">` +
    `<div class="th-top"><span class="th-name" data-tip="${esc(t.name)}" data-tip-sub="${by ? `panel ${by}'s thread` : `filed by ${esc(t.by || "an agent")}`}" data-tip-overflow>${esc(t.name)}</span>` +
    `<button type="button" class="th-more" data-a="th-menu" data-t="${t.id}" data-tip="Move, park, rename or remove" aria-label="What to do with ${esc(t.name)}">⋯</button></div>` +
    stageBar(t, esc) +
    (notes || t.folder ? `<p class="th-line">${notes}${t.folder ? `<span class="th-folder" data-tip="${esc(t.folder)}" data-tip-overflow>${esc(tilde(t.folder))}</span>` : ""}</p>` : "") +
    branch + pr +
    (decided.length ? `<ul class="th-decided" aria-label="Decided">${decided.map(w => `<li data-tip="${esc(w.text)}" data-tip-sub="you answered ${esc(w.answer)}"><span class="q">${esc(w.text)}</span> → <b>${esc(w.answer)}</b></li>`).join("")}</ul>` : "") +
    (editing ? `<input class="th-in" data-for="${thField.kind}" placeholder="${thField.kind === "park" ? "The next step, to pick it up by" : "The thread's name"}" aria-label="${thField.kind === "park" ? "The next step" : "A new name"}" spellcheck="false">` : "") +
    `</li>` + errLine(`t${t.id}`, esc);
}

/** What the turn's buttons say, by its kind. */
const ANSWERS = { try: ["Looks good", "Needs changes…"], merge: ["Merged"], key: ["Added"] };

function turnSec(d, f) {
  const { esc } = ctx;
  const waiting = f.turns.filter(w => !w.answered_at);
  const said = f.turns.filter(w => w.answered_at && sendable.has(w.id));
  const gone = filedGone && filedGone.k === "w" ? filedGone : null;
  if (!waiting.length && !said.length && !gone) return "";
  const rows = waiting.map(w => turnRow(d, w, esc)).join("") + said.map(w => saidRow(d, w, esc)).join("") +
    (gone ? goneRow("w", gone.id, gone.text, esc) : "");
  return `<div class="dk-sec dk-filed dk-turns" data-part="rail.turns">` +
    `<div class="t-label dk-lab" data-tip="Your turn" data-tip-sub="What only you can do. Your answer goes with your next message to the panel that asked">Your turn${waiting.length ? `<span class="n"><b>${waiting.length}</b></span>` : ""}</div>` +
    `<ul class="dk-turn-list">${rows}</ul></div>`;
}

function turnRow(d, w, esc) {
  const n = slotOf(d, w.pane);
  const from = w.via === "dialog" ? `Claude is asking in panel ${n || "?"}` : n ? `from panel ${n}` : "from a panel since closed";
  const other = thField && thField.id === w.id && (thField.kind === "other" || thField.kind === "change");
  const buttons = w.kind === "decide"
    ? w.options.map((o, i) => `<button type="button" class="tn-opt${i === w.recommended ? " rec" : ""}" data-a="tn-pick" data-w="${w.id}" data-v="${esc(o)}"${i === w.recommended ? ` data-tip="Recommended" data-tip-sub="by ${esc(w.by || "the agent")}"` : ""}>${esc(o)}</button>`).join("") +
      `<button type="button" class="tn-opt quiet" data-a="tn-other" data-w="${w.id}">Other…</button>`
    : (ANSWERS[w.kind] || ["Done"]).map(o => o.endsWith("…")
      ? `<button type="button" class="tn-opt quiet" data-a="tn-change" data-w="${w.id}">${esc(o)}</button>`
      : `<button type="button" class="tn-opt" data-a="tn-pick" data-w="${w.id}" data-v="${esc(o)}">${esc(o)}</button>`).join("");
  const link = /^https?:\/\//.test(w.link || "") ? `<button type="button" class="tn-opt quiet" data-a="tn-link" data-u="${esc(w.link)}" data-tip="${esc(w.link)}">Open ↗</button>` : "";
  return `<li class="dk-turn" data-w="${w.id}"><p class="tn-q">${esc(w.text)}</p>` +
    `<p class="tn-by">${esc(w.kind === "decide" ? "decide" : w.kind)} · ${esc(from)}${w.link && !link ? ` · ${esc(w.link)}` : ""}</p>` +
    `<div class="tn-acts">${buttons}${link}<button type="button" class="tn-x" data-a="tn-x" data-w="${w.id}" data-tip="Not now" data-tip-sub="nothing is deleted" aria-label="Not now: ${esc(w.text)}">${ico("x")}</button></div>` +
    (other ? `<input class="th-in" data-for="${thField.kind}" placeholder="${thField.kind === "change" ? "What needs to change" : "Your answer"}" aria-label="Your answer" spellcheck="false">` : "") +
    `</li>` + errLine(`w${w.id}`, esc);
}

/** Whether a panel is at its prompt with nothing under way: the only time
 *  Send now types into it. */
const idle = v => v && v.status.running && v.mode && v.mode[1] && v.status.agent !== "working" && Date.now() - (v.typed || 0) > TYPED_MS;

/** An answer given here: what was said, and Send now while the panel that
 *  asked is idle; otherwise it says where the answer will go. */
function saidRow(d, w, esc) {
  const n = slotOf(d, w.pane), v = views.get(w.pane);
  const now = idle(v)
    ? `<button type="button" class="tn-opt" data-a="tn-send" data-w="${w.id}" data-tip="Send now" data-tip-sub="Types it into panel ${n} and presses Enter">Send now</button>`
    : `<span class="tn-wait">${n ? `goes with your next message to panel ${n}` : "goes to the next panel that asks"}</span>`;
  return `<li class="dk-turn said"><p class="tn-q">${esc(w.text)}</p><p class="tn-by">You said <b>${esc(w.answer)}</b></p>` +
    `<div class="tn-acts">${now}<button type="button" class="tn-x" data-a="tn-unsend" data-w="${w.id}" data-tip="Leave it for the next message" aria-label="Leave it for the next message">${ico("x")}</button></div></li>`;
}

function sugSec(f) {
  const { esc } = ctx;
  const gone = filedGone && filedGone.k === "s" ? filedGone : null;
  if (!f.suggestions.length && !gone) return "";
  const rows = f.suggestions.map(s => `<li class="dk-sugcard"><p class="sg-what">${s.kind === "desk" ? `A desk for <span class="mono">${esc(tilde(s.folder))}</span>` : `${esc(s.name || "A panel")}`}</p>` +
    (s.kind === "panel" ? `<code class="sg-cmd" data-tip="Runs exactly this" data-tip-sub="${esc(s.cmd)}" data-tip-overflow>${esc(s.cmd)}</code>` : "") +
    `<p class="tn-by">${esc(s.why)}${s.by ? ` · ${esc(s.by)}` : ""}</p>` +
    `<div class="tn-acts"><button type="button" class="tn-opt" data-a="sg-open" data-s="${s.id}">${s.kind === "desk" ? "Open desk" : "Open panel"}</button>` +
    `<button type="button" class="tn-x" data-a="sg-x" data-s="${s.id}" data-tip="Not this one" data-tip-sub="nothing is deleted" aria-label="Not this one">${ico("x")}</button></div></li>` + errLine(`s${s.id}`, esc)).join("") +
    (gone ? goneRow("s", gone.id, gone.text, esc) : "");
  return `<div class="dk-sec dk-filed" data-part="rail.suggested"><div class="t-label dk-lab" data-tip="Suggested" data-tip-sub="Panels and desks an agent thinks the work wants. Nothing opens until you click">Suggested</div><ul class="dk-turn-list">${rows}</ul></div>`;
}

/** The chip on a note that is in a thread: the thread's name, small. */
function threadChip(x, esc) {
  if (!x.thread || filedAt !== deskId) return "";
  const t = filed.threads.find(y => y.id === x.thread);
  return t ? `<span class="dk-chip" data-tip="In the thread" data-tip-sub="${esc(t.name)} · ${esc(t.stage)}">${esc(t.name)}</span>` : "";
}

/** This desk's threads, turns and suggestions, asked for once unless a
 *  write says to look again (the list's `desknotes`, which they share). */
async function getFiled(id, again) {
  if (id == null || !ctx) return;
  if (!again && (filedAt === id || filedGet === id)) return;
  filedGet = id;
  let j;
  try { j = await ctx.api(`/api/desks/${id}/threads`); }
  catch { filedGet = null; if (id === deskId) { filedOff = id; } return; }
  filedGet = null; filedOff = null;
  if (id !== deskId) return;
  filed = { threads: j.threads || [], turns: j.turns || [], suggestions: j.suggestions || [] };
  filedAt = id;
  // An answer that is not here any more, or was taken up by the panel, has
  // nothing left to send.
  for (const k of sendable.keys()) if (!filed.turns.some(w => w.id === k)) sendable.delete(k);
  if (current()) rail();
}

function forgetFiled() {
  filed = { threads: [], turns: [], suggestions: [] }; filedAt = null; filedGet = null;
  filedGone = null; clearTimeout(filedTimer); thField = null; thDraft = ""; sendable.clear();
}

/** A ✕ here: the row goes at once and holds its Undo for as long as a
 *  note's does. */
function putAway(k, id, text) {
  clearTimeout(filedTimer);
  filedGone = { k, id, text };
  filedTimer = setTimeout(() => { filedGone = null; if (current()) rail(); }, BACK_MS);
}

const PATH = { t: "threads", w: "turns", s: "suggestions" };

/** The menu on a thread card: right-click, or its ⋯. */
function threadMenu(card) {
  const t = filed.threads.find(x => x.id === +card.dataset.t), d = current();
  if (!t || !d) return null;
  const move = stage => () => act({ dataset: { a: "th-move", t: String(t.id), stage } });
  return { head: t.name, items: [
    ...STAGES.filter(s => s !== t.stage).map(s => ({ label: `Move to ${s}`, run: move(s) })),
    "rule",
    t.stage !== "parked" && { label: "Park…", moves: 1, run: () => { thField = { kind: "park", id: t.id }; thDraft = t.next || ""; rail(); } },
    { label: "Rename…", moves: 1, run: () => { thField = { kind: "rename", id: t.id }; thDraft = t.name; rail(); } },
    "rule",
    { label: "Remove", danger: true, run: () => act({ dataset: { a: "th-x", t: String(t.id) } }) },
  ] };
}

async function moveThread(d, t, body, again = { a: "th-move", t: String(t.id), stage: body.stage || "" }) {
  const was = { ...t };
  Object.assign(t, body.stage ? { stage: body.stage } : {}, body.name ? { name: body.name } : {}, body.next != null ? { next: body.next } : {});
  rail();
  if (await told(again, `t${t.id}`, "Could not move it", () => Object.assign(t, was),
    () => ctx.api(`/api/desks/${d.id}/threads/${t.id}/move`, body))) await getFiled(d.id, true);
}

async function answer(d, w, text, again = { a: "tn-pick", w: String(w.id), v: text }) {
  if (!text.trim()) return;
  const was = { ...w };
  w.answered_at = Date.now() / 1000; w.answer = text.trim();
  // A dialog the mod holds is answered by this; nothing is left to send.
  if (w.via !== "dialog") sendable.set(w.id, true);
  rail();
  if (await told(again, `w${w.id}`, "Could not answer", () => { Object.assign(w, was); sendable.delete(w.id); },
    () => ctx.api(`/api/desks/${d.id}/turns/${w.id}/answer`, { answer: w.answer }))) await getFiled(d.id, true);
}

/** Send now: the answer typed into the panel that asked, and Enter pressed
 *  apart from the text -- a bracketed paste with its Enter inside it is not
 *  submitted by every program. Only while that panel is idle, and only on
 *  the reader's click: snyvi never starts a turn by itself. */
function sendNow(d, w) {
  const v = views.get(w.pane), n = slotOf(d, w.pane);
  if (!idle(v)) {
    clearTimeout(rowTimer);
    rowSaid = { p: w.pane, text: `Panel ${n || "?"} is busy, so nothing is typed into it. Your answer goes with your next message.` };
    rowTimer = setTimeout(() => { rowSaid = null; if (current()) rail(); }, 5000);
    rail();
    return;
  }
  input(v, bracket(v, `Answered in snyvi: "${w.text}" → ${w.answer}`));
  setTimeout(() => input(v, "\r"), 120);
  sendable.delete(w.id);
  rail();
}

/** The section's clicks; true when one of them was this file's. */
async function filedAct(a, b, d) {
  if (!a.startsWith("th-") && !a.startsWith("tn-") && !a.startsWith("sg-") && a !== "fd-back") return false;
  const t = filed.threads.find(x => x.id === +b.dataset.t);
  const w = filed.turns.find(x => x.id === +b.dataset.w);
  const s = filed.suggestions.find(x => x.id === +b.dataset.s);
  if (a === "th-menu") {
    const card = b.closest(".dk-thread"), r = b.getBoundingClientRect();
    if (card) ctx.menu?.(card, r.left, r.bottom + 4, false);
  } else if (a === "th-move" && t) { if (b.dataset.stage) await moveThread(d, t, { stage: b.dataset.stage }); }
  else if (a === "th-x" && t) {
    filed.threads = filed.threads.filter(x => x !== t);
    putAway("t", t.id, t.name); rail();
    await told({ ...b.dataset }, `t${t.id}`, "Could not remove it", () => { filed.threads.push(t); filedGone = null; },
      () => ctx.api(`/api/desks/${d.id}/threads/${t.id}/remove`, {}));
  } else if (a === "tn-pick" && w) await answer(d, w, b.dataset.v);
  else if ((a === "tn-other" || a === "tn-change") && w) { thField = { kind: a === "tn-other" ? "other" : "change", id: w.id }; thDraft = ""; rail(); }
  else if (a === "tn-link") { if (/^https?:\/\//.test(b.dataset.u)) openLink(b.dataset.u); }
  else if (a === "tn-send" && w) sendNow(d, w);
  else if (a === "tn-unsend" && w) { sendable.delete(w.id); rail(); }
  else if (a === "tn-x" && w) {
    filed.turns = filed.turns.filter(x => x !== w);
    putAway("w", w.id, w.text); rail();
    await told({ ...b.dataset }, `w${w.id}`, "Could not put it away", () => { filed.turns.push(w); filedGone = null; },
      () => ctx.api(`/api/desks/${d.id}/turns/${w.id}/remove`, {}));
  } else if (a === "sg-x" && s) {
    filed.suggestions = filed.suggestions.filter(x => x !== s);
    putAway("s", s.id, s.kind === "desk" ? s.folder : s.name || s.cmd); rail();
    await told({ ...b.dataset }, `s${s.id}`, "Could not put it away", () => { filed.suggestions.push(s); filedGone = null; },
      () => ctx.api(`/api/desks/${d.id}/suggestions/${s.id}/dismiss`, {}));
  } else if (a === "sg-open" && s) await openSuggested(d, s);
  else if (a === "fd-back") {
    const k = b.dataset.k, id = +b.dataset.i;
    clearTimeout(filedTimer); filedGone = null; rail();
    if (await told({ ...b.dataset }, `${k}${id}`, "Could not put it back", () => {},
      () => ctx.api(`/api/desks/${d.id}/${PATH[k]}/${id}/restore`, {}))) await getFiled(d.id, true);
  }
  return true;
}

/** Open a suggested panel on the route + New panel takes, running the
 *  command the card showed and named as the card named it; or the desk the
 *  daemon makes for a suggested folder. */
async function openSuggested(d, s) {
  if (s.kind === "panel") {
    const why = noNew(d);
    if (why) return ctx.toast("Open panel", why);
  }
  let j;
  try { j = await ctx.api(`/api/desks/${d.id}/suggestions/${s.id}/open`, {}); }
  catch (e) { rowErr = { k: `s${s.id}`, why: "Could not open it", raw: e.message, again: { a: "sg-open", s: String(s.id) } }; rail(); return; }
  filed.suggestions = filed.suggestions.filter(x => x !== s);
  if (s.kind === "desk") {
    if (j.desk && j.desk.id) { await ctx.refresh(); ctx.go(j.desk.id); }
    return;
  }
  const p = await ctx.api(`/api/desks/${d.id}/panes`, { cmd: s.cmd });
  focused = p.pane.id;
  if (s.name) { try { await ctx.api(`/api/panes/${p.pane.id}/rename`, { name: s.name }); } catch {} }
  await ctx.refresh();
  const nv = views.get(p.pane.id);
  if (nv) { await run(nv, s.cmd); nv.body.focus(); }
}

/** After a redraw: the open field back, with what was typed and the keys
 *  kept from the panel, as the note field does. */
function threadFocus() {
  const inp = ctx.tocEl.querySelector(".th-in");
  if (!inp || !thField) return;
  inp.value = thDraft;
  inp.addEventListener("input", () => { thDraft = inp.value; });
  inp.addEventListener("keydown", e => {
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); saveField(); }
    else if (e.key === "Escape") { e.preventDefault(); thField = null; thDraft = ""; rail(); }
  });
  inp.addEventListener("blur", () => { if (!drawing && thField) { thField = null; rail(); } });
  inp.focus();
  inp.setSelectionRange(inp.value.length, inp.value.length);
}

async function saveField() {
  const d = current(), f = thField, text = thDraft.trim();
  thField = null; thDraft = "";
  if (!d || !f) return;
  if (f.kind === "park") {
    const t = filed.threads.find(x => x.id === f.id);
    if (t) await moveThread(d, t, { stage: "parked", next: text });
  } else if (f.kind === "rename") {
    const t = filed.threads.find(x => x.id === f.id);
    if (t && text) await moveThread(d, t, { name: text }); else rail();
  } else {
    const w = filed.turns.find(x => x.id === f.id);
    if (w && text) await answer(d, w, f.kind === "change" ? `Needs changes: ${text}` : text); else rail();
  }
}

const THREAD_CSS = `
.dk-filed { margin-bottom: 10px; }
.dk-threads, .dk-turn-list { list-style: none; margin: 4px 0 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.dk-thread, .dk-turn, .dk-sugcard { padding: 7px 8px 8px; border: 1px solid var(--rule); border-radius: var(--r-sm); background: var(--bg-raise); font-size: var(--fs-ui); }
.dk-thread.shipped { opacity: .7; }
.th-top { display: flex; align-items: center; gap: 6px; }
.th-name { flex: 1; min-width: 0; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.th-more { flex: none; width: 20px; height: 20px; border: 0; border-radius: 4px; background: none; color: var(--fg-3); cursor: pointer; font: inherit; line-height: 1; }
.th-more:hover { background: var(--rule-2); color: var(--fg); }
.th-stage { display: flex; align-items: center; gap: 8px; margin: 6px 0 2px; font-size: var(--fs-micro); color: var(--fg-2); }
.th-bar { display: flex; gap: 2px; flex: 1; max-width: 120px; }
.th-bar i { flex: 1; height: 4px; border-radius: 2px; background: var(--rule-2); }
.th-bar i.past { background: color-mix(in srgb, var(--accent) 45%, transparent); }
.th-bar i.now { background: var(--accent); }
.th-stage.parked .th-word { color: var(--fg-3); font-style: italic; }
.th-next { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.th-line { display: flex; gap: 8px; margin: 2px 0 0; font-size: var(--fs-micro); color: var(--fg-3); min-width: 0; white-space: nowrap; overflow: hidden; }
.th-line i { font-style: normal; color: var(--accent); }
.th-folder { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.th-notes { flex: none; color: var(--fg-2); }
.th-decided { list-style: none; margin: 4px 0 0; padding: 4px 0 0; border-top: 1px dashed var(--rule); font-size: var(--fs-micro); color: var(--fg-3); }
.th-decided li { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.th-decided b { font-weight: inherit; color: var(--fg-2); }
.th-in { display: block; width: 100%; box-sizing: border-box; margin-top: 6px; padding: 3px 6px; border: 1px solid var(--accent); border-radius: var(--r-sm); background: var(--bg); color: var(--fg); font: inherit; font-size: var(--fs-micro); }
.tn-q, .sg-what { margin: 0; color: var(--fg); }
.tn-by { margin: 2px 0 0; font-size: var(--fs-micro); color: var(--fg-3); }
.tn-by b { font-weight: inherit; color: var(--fg-2); }
.tn-acts { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; margin-top: 6px; }
.tn-opt { padding: 1px 7px; border: 1px solid var(--rule-2); border-radius: var(--r-sm); background: none; font: inherit; font-size: var(--fs-micro); color: var(--fg-2); cursor: pointer; }
.tn-opt:hover { color: var(--fg); border-color: var(--accent); }
.tn-opt.rec { border-color: var(--accent); color: var(--fg); }
.tn-opt.quiet { border-style: dashed; }
.tn-x { margin-left: auto; display: grid; place-items: center; width: 20px; height: 20px; border: 0; border-radius: 4px; background: none; color: var(--fg-3); cursor: pointer; }
.tn-x:hover { background: var(--rule-2); color: var(--fg); }
.tn-wait { font-size: var(--fs-micro); color: var(--fg-3); }
.dk-turn.said { border-style: dashed; }
.sg-cmd { display: block; margin-top: 4px; padding: 2px 5px; border-radius: 3px; background: var(--bg); font-family: var(--mono); font-size: 11px; color: var(--fg-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dk-chip { flex: none; max-width: 9em; margin-left: 4px; padding: 0 5px; border: 1px solid var(--rule-2); border-radius: 8px; font-size: 10px; line-height: 15px; color: var(--fg-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; align-self: center; }
`;
