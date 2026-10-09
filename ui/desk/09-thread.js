/* ui/desk/09-thread.js: a part of desk.js, one module. build.rs joins ui/desk/*.js in name
 * order (src/strip.rs `source`); SNYVI_UI_DIR serves the same join. */
// ---------- threads, your turn, suggested (#90) ----------
/*
 * What an agent files so the bookkeeping around the work is not the reader's
 * (src/thread.rs): the desk's threads, what is waiting on the reader, and the
 * panels and desks an agent suggests. Your turn and Suggested at the top of
 * the rail; a thread on its panel's row, as one line, and the ones no panel
 * is moving folded under the panels. Each is drawn only when it has
 * something, so a desk no agent files on looks as it always did. Every ✕
 * leaves its Undo in the row; nothing opens, starts or sends without a click
 * here.
 */

/** How long a shipped thread stays on its panel's row, while that panel has
 *  not taken up another; and how long an answer stays with it. */
const SHIPPED_SHOWN = 12 * 3600;

let filed = { threads: [], turns: [], suggestions: [] }, filedAt = null, filedGet = null, filedOff = null;
/** A row just put away, holding its Undo: { k: "t" | "w" | "s", id, text,
 *  pane }, a thread's pane when it was that panel's, so its Undo stays there. */
let filedGone = null, filedTimer = 0;
/** The field open on a thread or a turn: { kind: "rename" | "other" | "change", id }. */
let thField = null, thDraft = "";
/** Answers given here, kept for Send now until sent or the panel moves on. */
const sendable = new Map();

/** What is filed on this desk, asked for once (`getFiled`). */
function filedNow(d) {
  if (filedAt !== d.id && filedOff !== d.id) getFiled(d.id);
  return filedAt === d.id ? filed : { threads: [], turns: [], suggestions: [] };
}

/** Your turn and Suggested, above the panels. A thread is on its panel's row
 *  (`threadChip`); one no panel is moving is on no list (#109). */
function filedSecs(d) {
  const f = filedNow(d);
  return turnSec(d, f) + sugSec(f);
}

/** Which panel a pane is, as the reader counts them. */
const slotOf = (d, pane) => d.panes.find(p => p.id === pane)?.slot;

/** A row put away: the same Undo room a note's ✕ leaves. */
const goneRow = (k, id, text, esc) => `<li class="dk-note gone" role="status"><span class="nm">${esc(text)}</span><button type="button" class="dk-undo" data-a="fd-back" data-k="${k}" data-i="${id}">Undo</button></li>` + errLine(`${k}${id}`, esc);

/** Why no panel is moving a thread, or "" while one is. The daemon marks it
 *  (src/thread.rs `mark_rest`: a panel holds one thread, its latest); a
 *  panel closed since the list was read is said here too. */
const restOf = (d, t) => t.rest || (slotOf(d, t.pane) ? "" : "panel closed");
const shippedFresh = (t, now) => now - (t.shipped_at || t.moved_at) < SHIPPED_SHOWN;

/** The thread a panel holds, for its row: the one it last took up, unless
 *  that one shipped long enough ago to be done with. */
function paneThread(d, pane) {
  if (filedAt !== d.id) return null;
  const now = Date.now() / 1000;
  return filed.threads.find(t => t.pane === pane && !restOf(d, t) && (t.stage !== "shipped" || shippedFresh(t, now))) || null;
}

/** A thread in its tip: where it lives, what git and gh were seen to do, its
 *  next step, and what was decided in it. */
function threadSub(t) {
  const decided = filed.turns.filter(w => w.thread_id === t.id && w.kind === "decide" && w.answered_at).slice(-2);
  return [
    t.folder ? tilde(t.folder) : "",
    t.branch ? `${t.branch}${t.commits ? `, ${ctx.plural(t.commits, "commit")}` : ""}${t.seen ? " (seen)" : ""}` : "",
    t.next ? `next: ${t.next}` : "",
    ...decided.map(w => `${w.text} → ${w.answer}`),
  ].filter(Boolean).join(" · ") || `filed by ${t.by || "an agent"}`;
}


/** The field a thread's Rename… opens, in its line. */
const thInput = t => thField && thField.id === t.id && thField.kind === "rename"
  ? `<input class="th-in" data-for="rename" placeholder="The thread's name" aria-label="A new name" spellcheck="false">` : "";

/** A panel's thread, on the panel's own row: its stage, as a small chip
 *  beside the name, and the rest -- the thread's name, the PR, the checks
 *  or the merge, its notes, where it lives -- in the chip's tip. A line of
 *  its own under the row (1.26) said one bare word, "building", and made
 *  every panel with a thread two rows (#105). Its menu is the chip's
 *  right-click and the panel's own. A thread shipped shows ✓ until its
 *  panel takes up another, or for `SHIPPED_SHOWN`; then it is gone from the
 *  desk, kept, and on Home. */
function threadChip(d, pane, esc) {
  const t = paneThread(d, pane);
  if (!t) return "";
  const shipped = t.stage === "shipped";
  const facts = [
    t.pr ? `PR ${t.pr}` : "",
    t.merged ? `merged ${t.merged.slice(0, 7)}` : t.ci ? `CI ${t.ci}` : "",
    t.notes.length ? t.notes.map(n => `#${n}`).join(" ") : "",
  ].filter(Boolean);
  return `<span class="dk-pth${shipped ? " shipped" : ""}" data-t="${t.id}" data-tip="${esc(t.name)}" data-tip-sub="${esc([...facts, threadSub(t)].join(" · "))}">` +
    `<span class="th-word">${shipped ? "✓ shipped" : esc(t.stage)}</span></span>`;
}

/** Under a panel's row, only for a moment: a thread just removed, with its
 *  Undo, or the field its Rename… opened. */
function threadLine(d, pane, esc) {
  const gone = filedGone && filedGone.k === "t" && filedGone.pane === pane ? filedGone : null;
  if (gone) return goneRow("t", gone.id, gone.text, esc);
  const t = paneThread(d, pane);
  if (!t) return "";
  const field = thInput(t);
  return (field ? `<li class="th-edit" data-t="${t.id}">${field}</li>` : "") + errLine(`t${t.id}`, esc);
}

/** What the turn's buttons say, by its kind. */
const ANSWERS = { try: ["Looks good", "Needs changes…"], merge: ["Merged"], key: ["Added"] };

function turnSec(d, f) {
  const { esc } = ctx;
  const waiting = f.turns.filter(w => !w.answered_at);
  const said = f.turns.filter(w => w.answered_at && sendable.has(w.id));
  const gone = filedGone && filedGone.k === "w" ? filedGone : null;
  if (!waiting.length && !said.length && !gone) return "";
  // Questions asked together are one card (#110), where its first one would
  // be: each still a turn of its own, answered and put away on its own.
  const drawn = new Set();
  const card = w => {
    if (!w.ask_group) return w.answered_at ? saidRow(d, w, esc) : turnRow(d, w, esc);
    if (drawn.has(w.ask_group)) return "";
    drawn.add(w.ask_group);
    return groupCard(d, w.ask_group, f.turns.filter(x => x.ask_group === w.ask_group && (!x.answered_at || sendable.has(x.id))), esc);
  };
  const rows = waiting.map(card).join("") + said.map(card).join("") +
    (gone ? goneRow("w", gone.id, gone.text, esc) : "");
  // Fixed: it never folds, so what only the reader can do is never out of sight.
  return sec("turn", "rail.turns", "Your turn", {
    cls: "dk-filed dk-turns", fixed: true, count: waiting.length || "", tone: "accent",
    tip: "Your turn", sub: "What only you can do. Your answer goes with your next message to the panel that asked",
  }, `<ul class="dk-turn-list">${rows}</ul>`);
}

/** A decide's options, the recommended one marked, and Other…. */
const picks = (w, esc) => w.options.map((o, i) => `<button type="button" class="tn-opt${i === w.recommended ? " rec" : ""}" data-a="tn-pick" data-w="${w.id}" data-v="${esc(o)}"${i === w.recommended ? ` data-tip="Recommended" data-tip-sub="by ${esc(w.by || "the agent")}"` : ""}>${esc(o)}</button>`).join("") +
  `<button type="button" class="tn-opt quiet" data-a="tn-other" data-w="${w.id}">Other…</button>`;
/** The field Other… or Needs changes… opens under a turn. */
const otherIn = w => thField && thField.id === w.id && (thField.kind === "other" || thField.kind === "change")
  ? `<input class="th-in" data-for="${thField.kind}" placeholder="${thField.kind === "change" ? "What needs to change" : "Your answer"}" aria-label="Your answer" spellcheck="false">` : "";
const fromOf = (d, w) => {
  const n = slotOf(d, w.pane);
  return w.via === "dialog" ? `Claude is asking in panel ${n || "?"}` : n ? `from panel ${n}` : "from a panel since closed";
};

/** Several questions an agent asked at once (#110), as one card: a row for
 *  each, its options until it is answered and what you said after; and once
 *  every one is answered, Send answers, which types them all into the panel
 *  that asked as one message -- or they go with your next one. */
function groupCard(d, g, ms, esc) {
  if (!ms.length) return "";
  const n = slotOf(d, ms[0].pane), v = views.get(ms[0].pane);
  const open = ms.filter(w => !w.answered_at).length;
  const rows = ms.map(w => w.answered_at
    ? `<div class="tn-gq said"><p class="tn-q">${esc(w.text)}</p><p class="tn-by">You said <b>${esc(w.answer)}</b></p></div>`
    : `<div class="tn-gq" data-w="${w.id}"><p class="tn-q">${esc(w.text)}</p>` +
      `<div class="tn-acts">${picks(w, esc)}<button type="button" class="tn-x" data-a="tn-x" data-w="${w.id}" data-tip="Not now" data-tip-sub="this question; nothing is deleted" aria-label="Not now: ${esc(w.text)}">${ico("x")}</button></div>${otherIn(w)}</div>` + errLine(`w${w.id}`, esc)).join("");
  const foot = open
    ? `<span class="tn-wait">${open} of ${ms.length} to answer</span>`
    : (idle(v)
      ? `<button type="button" class="tn-opt rec" data-a="tn-gsend" data-g="${g}" data-tip="Send answers" data-tip-sub="Types all ${ms.length} into panel ${n} as one message and presses Enter">Send answers</button>`
      : `<span class="tn-wait">${n ? `they go with your next message to panel ${n}` : "they go to the next panel that asks"}</span>`) +
      `<button type="button" class="tn-x" data-a="tn-gunsend" data-g="${g}" data-tip="Leave them for the next message" aria-label="Leave them for the next message">${ico("x")}</button>`;
  return `<li class="dk-turn grp${open ? "" : " said"}" data-g="${g}"><p class="tn-by">${ms.length} decisions · ${esc(fromOf(d, ms[0]))}</p>${rows}` +
    `<div class="tn-acts tn-gfoot">${foot}</div></li>`;
}

function turnRow(d, w, esc) {
  const n = slotOf(d, w.pane);
  const from = fromOf(d, w);
  if (w.kind === "run") return runRow(d, w, n, from, esc);
  const buttons = w.kind === "decide"
    ? picks(w, esc)
    : (ANSWERS[w.kind] || ["Done"]).map(o => o.endsWith("…")
      ? `<button type="button" class="tn-opt quiet" data-a="tn-change" data-w="${w.id}">${esc(o)}</button>`
      : `<button type="button" class="tn-opt" data-a="tn-pick" data-w="${w.id}" data-v="${esc(o)}">${esc(o)}</button>`).join("");
  const link = /^https?:\/\//.test(w.link || "") ? `<button type="button" class="tn-opt quiet" data-a="tn-link" data-u="${esc(w.link)}" data-tip="${esc(w.link)}">Open ↗</button>` : "";
  return `<li class="dk-turn" data-w="${w.id}"><p class="tn-q">${esc(w.text)}</p>` +
    `<p class="tn-by">${esc(w.kind === "decide" ? "decide" : w.kind)} · ${esc(from)}${w.link && !link ? ` · ${esc(w.link)}` : ""}</p>` +
    `<div class="tn-acts">${buttons}${link}<button type="button" class="tn-x" data-a="tn-x" data-w="${w.id}" data-tip="Not now" data-tip-sub="nothing is deleted" aria-label="Not now: ${esc(w.text)}">${ico("x")}</button></div>` +
    otherIn(w) + `</li>` + errLine(`w${w.id}`, esc);
}

/** Whether Run can type into a panel: running, with a Claude Code session
 *  in it -- the agent whose `!` shell mode Run uses. Busy is fine: a `!`
 *  command sent mid-turn waits in Claude Code's queue and runs when the turn
 *  ends. */
const runsHere = v => !!(v && v.status.running && v.status.agent_in && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(v.pane.agent_session || ""));

/** A command handed over (#95): the whole of it, wrapped and never cut, and
 *  Run, which types it into the panel that asked as Claude Code's `!` shell
 *  mode, so its output lands in that conversation and the agent carries on.
 *  New panel runs it in a shell of its own; Copy is for anywhere else. */
function runRow(d, w, n, from, esc) {
  const here = runsHere(views.get(w.pane));
  const run = here
    ? `<button type="button" class="tn-opt" data-a="tn-run" data-w="${w.id}" data-tip="Run it in panel ${n}" data-tip-sub="Typed into its prompt as a ! command, after anything typed there. Its output goes to the agent">Run in panel ${n}</button>`
    : "";
  return `<li class="dk-turn" data-w="${w.id}"><p class="tn-q">${esc(w.text)}</p>` +
    `<code class="sg-cmd tn-cmd">${esc(w.cmd)}</code>` +
    `<p class="tn-by">run · ${esc(from)}${here ? "" : " · Run needs that panel's Claude"}</p>` +
    `<div class="tn-acts">${run}` +
    `<button type="button" class="tn-opt${here ? " quiet" : ""}" data-a="tn-newpanel" data-w="${w.id}" data-tip="Run it in a new panel" data-tip-sub="A shell of its own: the agent does not see the output">New panel</button>` +
    `<button type="button" class="tn-opt quiet" data-a="tn-copy" data-w="${w.id}" data-c="${esc(w.cmd)}">Copy</button>` +
    `<button type="button" class="tn-x" data-a="tn-x" data-w="${w.id}" data-tip="Not now" data-tip-sub="nothing is deleted" aria-label="Not now: ${esc(w.text)}">${ico("x")}</button></div>` +
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
  // A widget is a widget file an agent wrote (propose_widget): Add puts it
  // with the rest and allows it as it is; it runs its command on a timer
  // while it is in view, so the command is on the card.
  const what = s => s.kind === "desk" ? `A desk for <span class="mono">${esc(tilde(s.folder))}</span>` : s.kind === "widget" ? `A widget: ${esc(s.name)}` : esc(s.name || "A panel");
  const rows = f.suggestions.map(s => `<li class="dk-sugcard"><p class="sg-what">${what(s)}</p>` +
    (s.kind !== "desk" ? `<code class="sg-cmd" data-tip="${s.kind === "widget" ? "Runs this on a timer while the widget is in view" : "Runs exactly this"}" data-tip-sub="${esc(s.cmd)}" data-tip-overflow>${esc(s.cmd)}</code>` : "") +
    `<p class="tn-by">${esc(s.why)}${s.by ? ` · ${esc(s.by)}` : ""}</p>` +
    `<div class="tn-acts"><button type="button" class="tn-opt" data-a="sg-open" data-s="${s.id}">${s.kind === "desk" ? "Open desk" : s.kind === "widget" ? "Add" : "Open panel"}</button>` +
    `<button type="button" class="tn-x" data-a="sg-x" data-s="${s.id}" data-tip="Not this one" data-tip-sub="nothing is deleted" aria-label="Not this one">${ico("x")}</button></div></li>` + errLine(`s${s.id}`, esc)).join("") +
    (gone ? goneRow("s", gone.id, gone.text, esc) : "");
  return sec("suggested", "rail.suggested", "Suggested", {
    cls: "dk-filed", fixed: true, count: f.suggestions.length || "",
    tip: "Suggested", sub: "Panels and desks an agent thinks the work wants. Nothing opens until you click",
  }, `<ul class="dk-turn-list">${rows}</ul>`);
}

/** The thread a note is in, while the page holds this desk's threads. */
const threadOf = x => (x.thread && filedAt === deskId && filed.threads.find(y => y.id === x.thread)) || null;

/** The thread a note is in, in words for the note's tip; nothing beside
 *  the note, whose text has the row (#95). */
function threadWords(x) {
  const t = threadOf(x);
  return t ? `in the thread ${t.name} (${t.stage})` : "";
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
function putAway(k, id, text, pane = "") {
  clearTimeout(filedTimer);
  filedGone = { k, id, text, pane };
  filedTimer = setTimeout(() => { filedGone = null; if (current()) rail(); }, BACK_MS);
}

const PATH = { t: "threads", w: "turns", s: "suggestions" };

/** The menu on a thread, on its panel's row: right-click, or its ⋯. What a
 *  reader does to a thread, not the agent's stages: Done, for work that
 *  shipped where the panel did not see it, which the panel hears at its next
 *  prompt. No Park: a thread no panel is moving is on no list (#109). */
function threadMenu(card) {
  const t = filed.threads.find(x => x.id === +card.dataset.t), d = current();
  if (!t || !d) return null;
  return { head: t.name, items: [
    t.stage !== "shipped" && { label: "Done", run: () => act({ dataset: { a: "th-move", t: String(t.id), stage: "shipped" } }) },
    { label: "Rename…", moves: 1, run: () => { thField = { kind: "rename", id: t.id }; thDraft = t.name; rail(); } },
    "rule",
    { label: "Remove", danger: true, run: () => act({ dataset: { a: "th-x", t: String(t.id) } }) },
  ] };
}

/** The panel's own menu carries its thread's entries, named as the
 *  thread's, since a panel's "Done" or "Rename…" would say the panel: the
 *  chip has no ⋯ of its own, and the keyboard reaches the row, not the chip. */
function threadItems(v) {
  const d = current(), t = d && paneThread(d, v.id);
  const m = t && threadMenu({ dataset: { t: String(t.id) } });
  if (!m) return [];
  const say = { "Done": "Thread done", "Rename…": "Rename thread…", "Remove": "Remove thread" };
  return ["rule", ...m.items.filter(Boolean).map(x => x === "rule" ? x : { ...x, label: say[x.label] || x.label }), "rule"];
}

async function moveThread(d, t, body, again = { a: "th-move", t: String(t.id), stage: body.stage || "" }) {
  const was = { ...t };
  Object.assign(t, body.stage ? { stage: body.stage } : {}, body.name ? { name: body.name } : {}, body.next != null ? { next: body.next } : {});
  rail();
  if (await told(again, `t${t.id}`, "Could not move it", () => Object.assign(t, was),
    () => ctx.api(`/api/desks/${d.id}/threads/${t.id}/move`, body))) await getFiled(d.id, true);
}

async function answer(d, w, text, again = { a: "tn-pick", w: String(w.id), v: text }, send = true) {
  if (!text.trim()) return;
  const was = { ...w };
  w.answered_at = Date.now() / 1000; w.answer = text.trim();
  // A dialog the mod holds is answered by this; nothing is left to send. Nor
  // is a command Run typed: its output is the answer, already on its way.
  if (w.via !== "dialog" && send) sendable.set(w.id, true);
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

/** Send answers: a card's answers typed into the panel that asked as one
 *  message, a line each, and Enter apart -- on the click alone, while that
 *  panel is idle, as Send now. */
function sendGroup(d, g) {
  const ms = filed.turns.filter(w => w.ask_group === g && w.answered_at && sendable.has(w.id));
  if (!ms.length) return;
  const v = views.get(ms[0].pane), n = slotOf(d, ms[0].pane);
  if (!idle(v)) {
    clearTimeout(rowTimer);
    rowSaid = { p: ms[0].pane, text: `Panel ${n || "?"} is busy, so nothing is typed into it. Your answers go with your next message.` };
    rowTimer = setTimeout(() => { rowSaid = null; if (current()) rail(); }, 5000);
    rail();
    return;
  }
  const text = ["Answered in snyvi:", ...ms.map(w => `"${w.text}" → ${w.answer}`)].join("\r");
  input(v, bracket(v, text));
  setTimeout(() => input(v, "\r"), 120);
  for (const w of ms) sendable.delete(w.id);
  rail();
}

/** Run: `! <cmd>` pasted into the panel that asked and Enter pressed apart,
 *  as Send now does, on the reader's click and never otherwise. Pasted text
 *  that starts with `!` puts Claude Code's prompt in shell mode; mid-turn it
 *  queues and runs when the turn ends. The command was refused at the door if
 *  it held a control character, so the paste cannot be closed early. */
function runHere(d, w) {
  const v = views.get(w.pane), n = slotOf(d, w.pane);
  if (!runsHere(v)) {
    clearTimeout(rowTimer);
    rowSaid = { p: w.pane, text: `Panel ${n || "?"} has no Claude to run it in. New panel runs it in a shell of its own.` };
    rowTimer = setTimeout(() => { rowSaid = null; if (current()) rail(); }, 5000);
    rail();
    return;
  }
  input(v, bracket(v, `! ${w.cmd}`));
  setTimeout(() => input(v, "\r"), 120);
  answer(d, w, `Ran in panel ${n}`, { a: "tn-run", w: String(w.id) }, false);
}

/** New panel: the command in a shell panel of its own, on the route Open
 *  panel takes, and the turn answered so the agent hears where it ran. */
async function runNewPanel(d, w) {
  const why = noNew(d);
  if (why) return ctx.toast("New panel", why);
  let p;
  try { p = await ctx.api(`/api/desks/${d.id}/panes`, { cmd: w.cmd }); }
  catch (e) { rowErr = { k: `w${w.id}`, why: "Could not open a panel", raw: e.message, again: { a: "tn-newpanel", w: String(w.id) } }; rail(); return; }
  focused = p.pane.id;
  await ctx.refresh();
  const nv = views.get(p.pane.id);
  if (nv) { await run(nv, w.cmd); nv.body.focus(); }
  await answer(d, w, `Ran in a new panel, ${p.pane.slot ? `panel ${p.pane.slot}` : "its own"}; its output is there, not here`);
}

/** The section's clicks; true when one of them was this file's. */
async function filedAct(a, b, d) {
  if (!a.startsWith("th-") && !a.startsWith("tn-") && !a.startsWith("sg-") && a !== "fd-back") return false;
  const t = filed.threads.find(x => x.id === +b.dataset.t);
  const w = filed.turns.find(x => x.id === +b.dataset.w);
  const s = filed.suggestions.find(x => x.id === +b.dataset.s);
  if (a === "th-move" && t) { if (b.dataset.stage) await moveThread(d, t, { stage: b.dataset.stage }); }
  else if (a === "th-x" && t) {
    filed.threads = filed.threads.filter(x => x !== t);
    putAway("t", t.id, t.name, restOf(d, t) ? "" : t.pane); rail();
    await told({ ...b.dataset }, `t${t.id}`, "Could not remove it", () => { filed.threads.push(t); filedGone = null; },
      () => ctx.api(`/api/desks/${d.id}/threads/${t.id}/remove`, {}));
  } else if (a === "tn-pick" && w) await answer(d, w, b.dataset.v);
  else if ((a === "tn-other" || a === "tn-change") && w) { thField = { kind: a === "tn-other" ? "other" : "change", id: w.id }; thDraft = ""; rail(); }
  else if (a === "tn-link") { if (/^https?:\/\//.test(b.dataset.u)) openLink(b.dataset.u); }
  else if (a === "tn-send" && w) sendNow(d, w);
  else if (a === "tn-gsend") sendGroup(d, +b.dataset.g);
  else if (a === "tn-gunsend") { for (const x of filed.turns) if (x.ask_group === +b.dataset.g) sendable.delete(x.id); rail(); }
  else if (a === "tn-run" && w) runHere(d, w);
  else if (a === "tn-newpanel" && w) await runNewPanel(d, w);
  else if (a === "tn-copy" && w) copySha(b, "Copied");
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
  catch (e) { rowErr = { k: `s${s.id}`, why: s.kind === "widget" ? "Could not add it" : "Could not open it", raw: e.message, again: { a: "sg-open", s: String(s.id) } }; rail(); return; }
  filed.suggestions = filed.suggestions.filter(x => x !== s);
  // Added: it runs at the runner's next look, and its seat comes with it.
  if (s.kind === "widget") { rail(); return; }
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
  if (f.kind === "rename") {
    const t = filed.threads.find(x => x.id === f.id);
    if (t && text) await moveThread(d, t, { name: text }); else rail();
  } else {
    const w = filed.turns.find(x => x.id === f.id);
    if (w && text) await answer(d, w, f.kind === "change" ? `Needs changes: ${text}` : text); else rail();
  }
}

const THREAD_CSS = `
.dk-threads, .dk-turn-list { list-style: none; margin: 4px 0 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.dk-turn, .dk-sugcard { padding: 7px 8px 8px; border: 1px solid var(--rule); border-radius: var(--r-sm); background: var(--bg-raise); font-size: var(--fs-ui); }
/* A panel's thread: its stage, a chip on the panel's row between the name
   and the context, in the rail's quiet ink; the name gives way before it does. */
.dk-pth { flex: none; margin-left: auto; padding: 0 6px; border-radius: var(--r-pill); background: var(--rule); font-size: var(--fs-micro); font-weight: 500; line-height: 16px; color: var(--fg-2); }
.dk-pth.shipped { color: var(--ok); background: color-mix(in srgb, var(--ok) 12%, transparent); }
.dk-pane.on .dk-pth { background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--fg); }
.dk-focus .dk-pth + .ctx { margin-left: 0; padding-left: 0; }
.th-edit { padding: 0 3px 2px 51px; }
.th-edit .th-in { margin: 0; }
.th-in { display: block; width: 100%; box-sizing: border-box; margin-top: 6px; padding: 3px 6px; border: 1px solid var(--accent); border-radius: var(--r-sm); background: var(--bg); color: var(--fg); font: inherit; font-size: var(--fs-micro); }
.tn-q, .sg-what { margin: 0; color: var(--fg); }
.tn-by { margin: 2px 0 0; font-size: var(--fs-micro); color: var(--fg-3); }
.tn-by b { font-weight: inherit; color: var(--fg-2); }
.tn-acts { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; margin-top: 6px; }
.tn-opt { padding: 1px 7px; border: 1px solid var(--rule-2); border-radius: var(--r-sm); background: none; font: inherit; font-size: var(--fs-micro); color: var(--fg-2); cursor: pointer; }
.tn-opt:hover { color: var(--fg); border-color: var(--accent); }
.tn-opt.rec { border-color: var(--accent); color: var(--fg); }
.tn-opt.quiet { border-style: dashed; }
.tn-x { margin-left: auto; display: grid; place-items: center; width: 20px; height: 20px; border: 0; border-radius: var(--r-xs); background: none; color: var(--fg-3); cursor: pointer; }
.tn-x:hover { background: var(--rule-2); color: var(--fg); }
.tn-wait { font-size: var(--fs-micro); color: var(--fg-3); }
.dk-turn.said { border-style: dashed; }
/* Questions asked together: one card, a row for each, ruled apart. */
.tn-gq { padding: 6px 0 0; margin-top: 6px; border-top: 1px solid var(--rule); }
.tn-gq .tn-acts { margin-top: 4px; }
.tn-gq.said .tn-q { color: var(--fg-2); }
.tn-gfoot { padding-top: 6px; border-top: 1px solid var(--rule); }
/* A handed-over command is shown whole: what Run types is what is read. */
.sg-cmd.tn-cmd { white-space: pre-wrap; overflow-wrap: anywhere; text-overflow: clip; max-height: 9em; overflow-y: auto; }
.sg-cmd { display: block; margin-top: 4px; padding: 2px 5px; border-radius: var(--r-xs); background: var(--bg); font-family: var(--mono); font-size: var(--fs-micro); color: var(--fg-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
`;
