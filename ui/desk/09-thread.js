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
/** A row just put away, holding its Undo: { k: "t" | "w" | "g" | "s", id,
 *  text, pane, ids }, a thread's pane when it was that panel's, so its Undo
 *  stays there; for "g", a card's open questions put away as one, by `ids`. */
let filedGone = null, filedTimer = 0;
/* The write a ✕ here is making. Its Undo waits for it: a restore that
 * reached the daemon before its remove would be undone by the remove. */
let filedWrite = Promise.resolve();
const filedAway = call => () => (filedWrite = call());
/** The field open on a thread or a turn: { kind: "rename" | "other" | "change", id }. */
let thField = null, thDraft = "";
/** Answers given here, kept for Send now until sent or the panel moves on. */
const sendable = new Map();

/** What is filed on this desk, asked for once (`getFiled`). */
function filedNow(d) {
  if (filedAt !== d.id && filedOff !== d.id) getFiled(d.id);
  return filedAt === d.id ? filed : { threads: [], turns: [], suggestions: [] };
}

/** Your turn and Suggested are not on the rail any more: they rise in the
 *  corner and wait behind its pill (10-onyou.js), where nothing they do
 *  moves the page. A thread is on its panel's row (`threadChip`); one no
 *  panel is moving is on no list (#109). */

/** A turn this desk shows. Claude's own question dialog is on screen in its
 *  panel already, and answered there nine times in ten: Home lists it, the
 *  band above the prompt leaves it out, and so does this. */
const shown = w => w.via !== "dialog";
/** How long a turn waits before it goes quiet: no rising, no sound, no
 *  accent, folded under "older". The daemon's `thread::OLDER_S` too. */
const OLDER_S = 30 * 60;
/** A waiting turn still worth saying. The daemon marks the rest `stale` --
 *  its panel gone, over the half hour, or its panel prompted since, the
 *  question maybe answered there (src/thread.rs `mark_stale`) -- so Home,
 *  the brief and this agree; the page still sees a panel closed or the
 *  half hour pass between two reads. */
const fresh = (d, w) => !w.answered_at && !w.stale && (!w.pane || !!slotOf(d, w.pane)) && Date.now() / 1000 - w.created_at < OLDER_S;

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
  // Answered rows come newest first (src/thread.rs `turns`): its last two.
  const decided = filed.turns.filter(w => w.thread_id === t.id && w.kind === "decide" && w.answered_at).slice(0, 2);
  return [
    t.folder ? tilde(t.folder) : "",
    t.branch ? `${t.branch}${t.commits ? `, ${ctx.plural(t.commits, "commit")}` : ""}${t.seen ? " (seen)" : ""}` : "",
    t.next ? `next: ${t.next}` : "",
    ...decided.map(w => `${w.text} → ${w.answer}`),
  ].filter(Boolean).join(" · ") || `filed by ${t.by || "an agent"}`;
}


/** The field a thread's Rename… opens, in its line. */
const thInput = t => !thField || thField.id !== t.id ? ""
  : thField.kind === "rename" ? `<input class="th-in" data-for="rename" placeholder="The thread's name" aria-label="A new name" spellcheck="false">`
  : thField.kind === "told" ? `<input class="th-in" data-for="told" type="url" placeholder="Where it went out: https://…" aria-label="Where it was told: a URL" spellcheck="false">` : "";

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
  // Shipped by a merge and not yet told is a hollow ✓; told, with where, is
  // the solid one (1.48, src/told.rs).
  const untold = shipped && t.merged_at && !t.told_at;
  const facts = [
    t.pr ? `PR ${t.pr}` : "",
    t.merged ? `merged ${t.merged.slice(0, 7)}` : t.ci ? `CI ${t.ci}` : "",
    t.notes.length ? t.notes.map(n => `#${n}`).join(" ") : "",
    t.told_at ? `told${t.told_url ? ` at ${t.told_url}` : t.told_how === "none" ? ": no one needed to know" : ""}` : untold ? "not told yet: Told at… in its menu" : "",
  ].filter(Boolean);
  return `<span class="dk-pth${shipped ? " shipped" : ""}${untold ? " untold" : ""}" data-t="${t.id}" data-tip="${esc(t.name)}" data-tip-sub="${esc([...facts, threadSub(t)].join(" · "))}">` +
    `<span class="th-word">${t.told_at ? "✓ told" : shipped ? "✓ shipped" : esc(t.stage)}</span></span>`;
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

/** The one card (ui/turn.js, 1.64 C1): the desk's own, moved out so the
 *  corner and Home draw the very same. Fetched with the desk; a tray drawn
 *  before it is in is drawn again once it is. */
let T = null;
import(`/assets/turn.js${new URL(import.meta.url).search}`).then(m => { T = m; m.style(); if (ctx && current()) rail(); }, () => {});

/** The questions opened whole in the tray, by turn id; whether the rows
 *  drawn now are the tray's (`trayHtml`), where a question is cut to its
 *  lines; the card whose Later menu is open, and its Not mine field; and
 *  the answers being changed before they are sent (C7). */
const qOpen = new Set();
let qClamp = false;
const tLater = { key: "", not: false };
const changing = new Set();
const inlineCode = (t, esc) => esc(t).replace(/`([^`\n]+)`/g, "<code>$1</code>");
/* The walk-through's card (16-steps.js) draws its own question and by-line
 * with these, as the one card does. */
function qHtml(w, esc, text = w.text) {
  const [head, body] = T ? T.qParts(text || "") : ["", text || ""];
  const open = qOpen.has(w.id), more = qClamp && body;
  const attrs = more ? ` data-a="tn-more" data-w="${w.id}" role="button" tabindex="0" aria-expanded="${open}"` : "";
  return `<div class="tn-q${open ? " open" : ""}"${attrs}>` + (head ? `<b class="tn-qh">${inlineCode(head, esc)}</b>` : "") +
    (body ? `<span class="tn-qb">${inlineCode(body, esc)}</span>` : "") + `</div>`;
}
function byHtml(w, d, esc, extra = "") {
  const n = slotOf(d, w.pane), v = views.get(w.pane);
  const panel = (v?.pane?.name) || (n ? `panel ${n}` : "");
  const who = /^claude/i.test(w.by || "") ? "Claude" : w.by || "an agent";
  return `<p class="tn-by"><span data-tip="${esc(`${w.kind} · ${fromOf(d, w)}`)}">${esc(`${who} · ${panel || "panel closed"}`)} · ${esc(ctx.relShort(w.created_at))}</span>${extra}</p>`;
}
const fromOf = (d, w) => {
  const n = slotOf(d, w.pane);
  return w.via === "dialog" ? `Claude is asking in panel ${n || "?"}` : n ? `from panel ${n}` : "from a panel since closed";
};

/** What the one card needs to know of this desk (ui/turn.js `env`). */
function tEnv(d, esc) {
  return {
    esc, ico, rel: t => ctx.relShort(t), off: false, deskName: () => d.name,
    panel: w => { const n = slotOf(d, w.pane); return n ? { slot: n, name: views.get(w.pane)?.pane?.name || `panel ${n}` } : null; },
    runsHere: w => runsHere(views.get(w.pane)), sendsHere: w => sendsHere(views.get(w.pane)),
    routine: w => { const rt = rtPane(w.pane); return rt ? { name: rt.name, ok: !!w.waits_ok } : null; },
    anyway: w => !!(rowErr && rowErr.k === `w${w.id}` && /Waits list/.test(rowErr.raw || "")),
    steps: w => stepsRow(d, w, slotOf(d, w.pane), fromOf(d, w), esc),
    sendable: w => sendable.has(w.id),
    field: w => thField && thField.id === w.id ? thField.kind : "",
    open: id => qOpen.has(id), clamp: qClamp,
    later: k => tLater.key === k ? (tLater.not && thField?.kind === "not" ? "not" : "menu") : "",
    changing: id => changing.has(id),
    err: k => errLine(k, esc),
  };
}

/** A card's questions as the one card draws them: the open ones, and the
 *  answered ones while any is open or theirs is still to send, so an
 *  answer keeps its place (C7). */
function groupOf(f, g) {
  const ms = f.turns.filter(x => x.ask_group === g);
  const open = ms.some(x => !x.answered_at || changing.has(x.id));
  return ms.filter(x => !x.answered_at || open || sendable.has(x.id));
}

/** A turn's card, or its group's (#110): questions asked together are one
 *  card, each still a turn of its own. A due card is the desk's own. */
function turnCard(d, f, w, esc) {
  if (!T) return "";
  if (w.kind === "due" && !w.answered_at) return dueRow(w, esc);
  const env = tEnv(d, esc);
  if (!w.ask_group) return T.card(env, w);
  const ms = groupOf(f, w.ask_group);
  return ms.length ? T.card(env, ms[0], ms) : "";
}

/** Which of the tray's lists a card is in: `fresh`, `quiet` -- its panel
 *  prompted since, so maybe done there (C3) -- or `older`. A card of
 *  questions goes by its open ones. An answer still to be sent, or being
 *  changed, stays with the fresh. */
/** The cards a panel has open on the reader (C6): fresh and not quieted,
 *  a group once. Its head says "asks you · N". */
function asksOf(pane) {
  const d = current();
  if (!d || filedAt !== d.id) return 0;
  const ws = filed.turns.filter(w => w.pane === pane && shown(w) && fresh(d, w) && !(w.quiet_at > 0) && w.kind !== "due" && w.kind !== "tell");
  return new Set(ws.map(w => w.ask_group || w.id)).size;
}
/** The chip's click: the tray, at that panel's newest card, lit. */
function asksAt(pane) {
  const d = current();
  const w = d && filed.turns.filter(x => x.pane === pane && shown(x) && fresh(d, x)).sort((a, b) => b.id - a.id)[0];
  if (!w) return;
  oy.lit = w.ask_group ? `[data-g="${w.ask_group}"]` : `[data-w="${w.id}"]`;
  if (oy.open) rail(); else oyToggle();
}

function trayOf(d, f, w) {
  const ms = w.ask_group ? groupOf(f, w.ask_group) : [w];
  const open = ms.filter(x => !x.answered_at);
  if (!open.length || ms.some(x => changing.has(x.id))) return ms.some(x => sendable.has(x.id) || changing.has(x.id)) ? "fresh" : "";
  if (open.some(x => fresh(d, x))) return "fresh";
  return open.every(x => x.quiet_at > 0) ? "quiet" : "older";
}

/** The tray's cards of one list, newest first, so the one that just rang
 *  is at the top (U6); by when each was asked, so an answer keeps its card's
 *  place. An older one is one line until opened. */
function turnRows(d, f, esc, which) {
  const drawn = new Set(), env = T && tEnv(d, esc);
  return f.turns.filter(w => shown(w) && (!w.answered_at || sendable.has(w.id) || changing.has(w.id) || w.ask_group))
    .sort((a, b) => b.id - a.id)
    .map(w => {
      const k = w.ask_group || w.id;
      if (drawn.has(k) || trayOf(d, f, w) !== which) return "";
      drawn.add(k);
      if (which === "older" && qClamp && !oldOpen.has(k) && T) {
        const n = w.ask_group ? groupOf(f, k).filter(x => !x.answered_at).length : 1;
        return T.olderLine(env, w, n);
      }
      return turnCard(d, f, w, esc);
    }).join("");
}

/** The older asks opened from their line in the tray, by turn or card id;
 *  forgotten when the tray closes. */
const oldOpen = new Set();

/** Cards an agent removed in the last day (#174): Lately's row, its title
 *  and Bring back, then who removed it and why -- "Removed by panel 1:
 *  v1.43.0 is released" -- and when. An agent may remove any card on its
 *  desk, so what it did is said where the card was, not only told to the
 *  agent; Bring back puts it on the reader again. */
function awayRows(f, esc) {
  return (f.away || []).map(w => `<li class="cn-row" data-w="${w.id}"><span class="cn-b">` +
    `<span class="cn-tl"><span class="cn-t" data-tip="${esc(w.text)}" data-tip-overflow><span class="cn-tx">${inlineCode(w.text, esc)}</span></span>` +
    `<button type="button" class="tn-opt quiet" data-a="tn-back" data-w="${w.id}">Bring back</button></span>` +
    `<span class="cn-bl"><span class="cn-w">Removed by ${esc(w.away)}</span><span class="cn-at">${esc(ctx.relShort(w.removed_at))}</span></span>` +
    `</span></li>` + errLine(`b${w.id}`, esc)).join("");
}

/** At the hour a line was due (1.47, src/due.rs): snyvi's own card, on no
 *  panel. Done ticks the line as the reader's; a time moves it there and it
 *  rings again then; ✕ leaves the line as it is. Nothing goes to a panel
 *  but the next prompt's one line, which the daemon writes. */
/** Due cards whose Later… is open (1.48): the rest of the times, and a field. */
const dueMore = new Set();
function dueRow(w, esc) {
  const more = dueMore.has(w.id);
  const later = (more ? DUE_TO : DUE_TO.slice(1, 3)).map(([v, l]) => `<button type="button" class="tn-opt quiet" data-a="tn-later" data-w="${w.id}" data-v="${v}">${l}</button>`).join("") +
    (more ? `<input class="th-in tn-due-in" data-w="${w.id}" maxlength="40" spellcheck="false" placeholder="Pick a time: fri 16" aria-label="Pick a time for ${esc(w.text)}">`
      : `<button type="button" class="tn-opt quiet" data-a="tn-due-more" data-w="${w.id}" aria-expanded="false">Later…</button>`);
  return `<li class="dk-turn" data-w="${w.id}">${qHtml(w, esc)}` +
    `<p class="tn-by"><span data-tip="Due" data-tip-sub="by the date you gave this note">due · ${esc(ctx.relShort(w.created_at))}</span></p>` +
    `<div class="tn-acts"><button type="button" class="tn-opt rec" data-a="tn-due-done" data-w="${w.id}">Done</button>${later}` +
    `<button type="button" class="tn-x" data-a="tn-x" data-w="${w.id}" data-tip="Not now" data-tip-sub="the line keeps its date; nothing is deleted" aria-label="Not now: ${esc(w.text)}">${ico("x")}</button></div></li>` + errLine(`w${w.id}`, esc);
}

/** A due card's answer: Done, or a time to move the line to. Not one to
 *  send into a panel, so it leaves the card at once. */
async function dueAnswer(d, w, later) {
  const was = { ...w };
  w.answered_at = Date.now() / 1000; w.answer = later ? "Later" : "Done";
  rail();
  if (await told({ a: later ? "tn-later" : "tn-due-done", w: String(w.id), v: later || "" }, `w${w.id}`, later ? "Could not move it" : "Could not tick it",
    () => Object.assign(w, was), () => ctx.api(`/api/desks/${d.id}/turns/${w.id}/answer`, later ? { answer: "Later", later } : { answer: "Done" }))) {
    await getFiled(d.id, true); getNotes(d.id, true);
  }
}

/** Whether Run can type into a panel: running, with a Claude Code session
 *  in it -- the agent whose `!` shell mode Run uses. Busy is fine: a `!`
 *  command sent mid-turn waits in Claude Code's queue and runs when the turn
 *  ends. */
const runsHere = v => !!(v && v.status.running && v.status.agent_in && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(v.pane.agent_session || ""));

/** Whether a panel is at its prompt with nothing under way. */
const idle = v => v && v.status.running && v.mode && v.mode[1] && v.status.agent !== "working" && Date.now() - (v.typed || 0) > TYPED_MS;
/** Whether Send now may type into a panel: idle, and a Claude session in
 *  it, as Run asks. Idle alone let it type into a shell whose Claude had
 *  exited, where what it typed ran as a command (audit e0a854b732, S1). */
const sendsHere = v => idle(v) && runsHere(v);



/** What the reader picked on a widget's or a box's card: how long it
 *  lasts, by card id; what Try once printed; whose script is open. */
const sgFor = new Map(), sgTry = new Map(), sgScript = new Set();
/** Whose card shows every duration (1.56): one default is said, and
 *  "change" opens the four. One yes had seven controls (audit B3). */
const sgForOpen = new Set();
/** How long a widget lasts, in the card's words. `panel` only for one an
 *  agent in a panel still open asked for. */
const LASTS = [["", "Until I turn it off"], ["today", "For today"], ["week", "For a week"], ["panel", "While panel"]];
/** Seconds as the card says them. */
const every = n => n < 60 ? `${n} s` : n % 60 ? `${Math.round(n / 6) / 10} min` : `${n / 60} min`;
/** The card's pick as the daemon keeps it: until when, and whose panel. */
function lastsBody(s) {
  const k = sgFor.has(s.id) ? sgFor.get(s.id) : s.lasts || "";
  if (k === "today") { const t = new Date(); t.setHours(24, 0, 0, 0); return { until: Math.floor(t / 1000), until_pane: "" }; }
  if (k === "week") return { until: Math.floor(Date.now() / 1000) + 7 * 86400, until_pane: "" };
  if (k === "panel") return { until: 0, until_pane: s.pane || "" };
  return { until: 0, until_pane: "" };
}

/** Suggested, under Your turn in the tray: panels, desks and widgets an
 *  agent thinks the work wants. Nothing opens or runs until a click. */
function sugRows(f, d) {
  const { esc } = ctx;
  const gone = filedGone && filedGone.k === "s" ? filedGone : null;
  if (!f.suggestions.length && !gone) return "";
  // A widget is a widget file an agent wrote (propose_widget): the card
  // shows all that will run, where and how often, and can try it once; Add
  // puts it with the rest, on this desk unless the card says otherwise, for
  // as long as the reader picks. A box is a panel's first set_widget here:
  // what it would show, and Allow or Not now (#111).
  const what = s => s.kind === "desk" ? `A desk for <span class="mono">${esc(tilde(s.folder))}</span>`
    : s.kind === "widget" ? `A widget: ${esc(s.name)}`
    : s.kind === "box" ? `A box on this desk: ${esc(s.name)}`
    : esc(s.name || "A panel");
  const lastsRow = s => {
    const n = slotOf(d, s.pane), pick = sgFor.has(s.id) ? sgFor.get(s.id) : s.lasts || "";
    const say = ([k, l]) => `${l}${k === "panel" ? ` ${n} is open` : ""}`;
    if (!sgForOpen.has(s.id)) {
      const cur = LASTS.find(([k]) => k === pick) || LASTS[0];
      return `<p class="sg-for" role="group" aria-label="How long"><span class="tn-by">${esc(say(cur).toLowerCase())}</span><button type="button" class="tn-opt quiet" data-a="sg-for-open" data-s="${s.id}" data-tip="How long it stays" data-tip-sub="today, a week, while its panel is open, or until you turn it off">change</button></p>`;
    }
    return `<p class="sg-for" role="group" aria-label="How long">` + LASTS.filter(([k]) => k !== "panel" || n).map(([k, l]) =>
      `<button type="button" class="sg-chip" data-a="sg-for" data-s="${s.id}" data-v="${k}" aria-pressed="${pick === k}">${say([k, l])}</button>`).join("") + `</p>`;
  };
  const widgetBits = s => {
    // A card from before 1.32 may say every desk, or global; an agent's
    // widget is its desk's own since.
    const x = s.detail || {}, at = x.where === "global" ? "on the left, on every page, run in its own folder"
      : x.where === "every" ? "on every desk, each run in its desk's folder"
      : `this desk's own, run in <span class="mono">${esc(tilde(d.root || ""))}</span>`;
    // Every file the proposal brings is on the card, folded, as the script
    // is: Add allows the whole folder, so the reader can read all of it.
    const tried = sgTry.get(s.id);
    const fold = (key, name, text, f) => {
      const open = sgScript.has(key), n = text.split("\n").length;
      return `<button type="button" class="sg-fold" data-a="sg-script" data-s="${s.id}"${f ? ` data-f="${esc(f)}"` : ""} aria-expanded="${open}">${open ? "Hide" : "Show"} ${esc(name)} (${n} line${n === 1 ? "" : "s"})</button>` +
        (open ? `<pre class="sg-script">${esc(text)}</pre>` : "");
    };
    // A setting as the script gets it: its key, what /sidebars calls it,
    // and the value it starts with.
    const sets = Object.entries(x.settings || {}).map(([k, v]) => `<span class="mono">${esc(k)}</span>` +
      (v?.label ? ` (${esc(v.label)})` : "") + (v?.default != null && v.default !== "" ? ` = <span class="mono">${esc(JSON.stringify(v.default))}</span>` : ""));
    // The keys it names (1.46): Add gives the run each from this desk's
    // Keys, and the reader sees which before they do.
    const keys = (x.keys || []).map(k => `<span class="mono">${esc(k)}</span>`);
    // What Try once printed: whole, scrolling past the box's room, with
    // the count and tone it would show -- a card is not a seat.
    const printed = tried && !tried.busy && !tried.error
      ? `<div class="wg-body sg-tried" role="status">${tried.count ? `<p class="sg-count ${esc(tried.tone || "")}">${esc(tried.count)}</p>` : ""}${tried.html || "<p>(it printed nothing)</p>"}</div>` : "";
    return `<p class="tn-by">${at} · every ${every(x.every || 60)} while in view</p>` +
      `<code class="sg-cmd" data-tip="Runs this on a timer while the widget is in view" data-tip-sub="${esc(s.cmd)}" data-tip-overflow>${esc(s.cmd)}</code>` +
      (x.script ? fold(s.id, x.script_name || "script", x.script, "") : "") +
      (x.files || []).map(f => fold(`${s.id}/${f.name}`, f.name, f.text || "", f.name)).join("") +
      (sets.length ? `<p class="tn-by">Settings on /sidebars: ${sets.join(", ")}</p>` : "") +
      (keys.length ? `<p class="tn-by" data-tip="Keys it is given" data-tip-sub="Each from this desk's Keys list, in the run's environment; nothing else of the desk's">Uses ${keys.length === 1 ? "the key" : "the keys"} ${keys.join(", ")}</p>` : "") +
      (tried ? tried.busy ? `<p class="tn-by" role="status">Running it once…</p>`
        : tried.error ? `<p class="wg-err sg-tried" role="status">${esc(tried.error)}</p>`
        : printed : "");
  };
  const act = s => s.kind === "desk" ? "Open desk" : s.kind === "widget" ? "Add" : s.kind === "box" ? "Allow" : s.lasts === "back" ? "Open in the back" : "Open panel";
  const rows = f.suggestions.map(s => `<li class="dk-sugcard"><p class="sg-what">${what(s)}</p>` +
    (s.kind === "widget" ? widgetBits(s)
      : s.kind === "box" ? (s.cmd ? `<p class="sg-box">${esc(s.cmd)}</p>` : "")
      : s.kind !== "desk" ? `<code class="sg-cmd" data-tip="Runs exactly this" data-tip-sub="${esc(s.cmd)}" data-tip-overflow>${esc(s.cmd)}</code>` : "") +
    `<p class="tn-by">${esc(s.why)}${s.by && s.kind !== "box" ? ` · ${esc(s.by)}` : ""}</p>` +
    (s.kind === "widget" || s.kind === "box" ? lastsRow(s) : "") +
    `<div class="tn-acts"><button type="button" class="tn-opt" data-a="sg-open" data-s="${s.id}">${act(s)}</button>` +
    (s.kind === "widget" ? `<button type="button" class="tn-opt" data-a="sg-try" data-s="${s.id}" data-tip="Run it once, here" data-tip-sub="As it would run, and nothing kept"${sgTry.get(s.id)?.busy ? " disabled" : ""}>Try once</button>` : "") +
    `<button type="button" class="tn-x" data-a="sg-x" data-s="${s.id}" data-tip="${s.kind === "box" ? "Not now" : "Not this one"}" data-tip-sub="${s.kind === "box" ? "the panel is told, and later pushes refused" : "nothing is deleted"}" aria-label="${s.kind === "box" ? "Not now" : "Not this one"}">${ico("x")}</button></div></li>` + errLine(`s${s.id}`, esc)).join("") +
    (gone ? goneRow("s", gone.id, gone.text, esc) : "");
  return `<h3 class="oy-h" data-tip="Suggested" data-tip-sub="Panels, desks and widgets an agent thinks the work wants. Nothing opens or runs until you click">Suggested</h3><ul class="dk-turn-list" data-part="desk.suggested">${rows}</ul>`;
}

/** Try once: the proposed widget run here, as it would run, and what it
 *  printed in the card. */
async function trySuggested(d, s) {
  sgTry.set(s.id, { busy: true }); rail();
  let j;
  try { j = await ctx.api(`/api/desks/${d.id}/suggestions/${s.id}/try`, {}); }
  catch (e) { j = { error: `Could not run it · ${ctx.sayErr(e).why}` }; }
  sgTry.set(s.id, j); rail();
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
  filed = { threads: j.threads || [], turns: j.turns || [], suggestions: j.suggestions || [], away: j.away || [] };
  filedAt = id;
  // An answer that is not here any more, or was taken up by the panel, has
  // nothing left to send.
  for (const k of sendable.keys()) if (!filed.turns.some(w => w.id === k)) sendable.delete(k);
  // Each panel's head says whether it asks the reader something (C6).
  for (const v of views.values()) header(v);
  // The corner sees what is new as it draws (onYou).
  if (current()) rail();
}

function forgetFiled() {
  filed = { threads: [], turns: [], suggestions: [] }; filedAt = null; filedGet = null;
  filedGone = null; clearTimeout(filedTimer); thField = null; thDraft = ""; sendable.clear();
  forgetOnYou();
}

/** A ✕ here: the row goes at once and holds its Undo for as long as a
 *  note's does. */
function putAway(k, id, text, pane = "", ids = null) {
  clearTimeout(filedTimer);
  filedGone = { k, id, text, pane, ids };
  filedTimer = setTimeout(() => { filedGone = null; if (current()) rail(); }, BACK_MS);
}

const PATH = { t: "threads", w: "turns", g: "turns", s: "suggestions" };

/** The menu on a thread, on its panel's row: right-click, or its ⋯. What a
 *  reader does to a thread, not the agent's stages: Done, for work that
 *  shipped where the panel did not see it, which the panel hears at its next
 *  prompt. No Park: a thread no panel is moving is on no list (#109). */
function threadMenu(card) {
  const t = filed.threads.find(x => x.id === +card.dataset.t), d = current();
  if (!t || !d) return null;
  return { head: t.name, items: [
    t.stage !== "shipped" && { label: "Done", run: () => act({ dataset: { a: "th-move", t: String(t.id), stage: "shipped" } }) },
    // Where the world heard of it: a release, a post (1.48, src/told.rs).
    t.stage === "shipped" && { label: t.told_at ? "Told at… (change)" : "Told at…", moves: 1, run: () => { thField = { kind: "told", id: t.id }; thDraft = t.told_url || ""; rail(); } },
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
  // Told is a move, not a stage: the thread stays shipped, with where.
  const stage = body.stage === "told" ? { stage: "shipped", told_at: Date.now() / 1000, told_url: body.url } : body.stage ? { stage: body.stage } : {};
  Object.assign(t, stage, body.name ? { name: body.name } : {}, body.next != null ? { next: body.next } : {});
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
  // A routine's answers start its next run (routine_run), so are not typed.
  if (w.via !== "dialog" && send && !rtPane(w.pane)) sendable.set(w.id, true);
  rail();
  // A no puts the card back as it was: keys the daemon left out (an
  // unanswered card has no `answered_at`) are taken off again too, or the
  // card stayed answered here and left On you with nothing on the daemon.
  const back = () => { for (const k of Object.keys(w)) if (!(k in was)) delete w[k]; Object.assign(w, was); sendable.delete(w.id); };
  if (!await told(again, `w${w.id}`, "Could not answer", back,
    () => ctx.api(`/api/desks/${d.id}/turns/${w.id}/answer`, { answer: w.answer }))) return;
  await getFiled(d.id, true);
  // 1.66, pressing is sending: the answer goes now, typed into a Claude at
  // its prompt, a card's once its last question is answered. A panel at
  // work hears it as its turn stops (the daemon's Stop hook carries it), and
  // the row says which. Send now stays for a panel that was busy.
  if (!sendable.has(w.id)) return;
  if (!w.ask_group) return sendNow(d, w);
  const rest = filed.turns.some(x => x.ask_group === w.ask_group && !x.answered_at);
  if (!rest) sendGroup(d, w.ask_group);
}

/** Send now: the answer typed into the panel that asked, and Enter pressed
 *  apart from the text -- a bracketed paste with its Enter inside it is not
 *  submitted by every program. Only into a Claude at its prompt, and only on
 *  the reader's click: snyvi never starts a turn by itself. Only the
 *  reader's answer is typed, never the agent's question: what is typed into
 *  a terminal is input, and the question is text an agent sent (S1). The
 *  agent has its question; the answer comes back numbered as it asked. */
async function sendNow(d, w) {
  if (!sendable.has(w.id)) return;
  const v = views.get(w.pane), n = slotOf(d, w.pane);
  if (!sendsHere(v)) return notSent(w.pane, n, "It hears your answer when its turn ends, or with your next message.");
  // Out of `sendable` before the wait, so a second click types nothing.
  sendable.delete(w.id);
  await sent(d, [w]);
  input(v, bracket(v, `Answered in snyvi: ${oneLine(w.answer)}`));
  setTimeout(() => input(v, "\r"), 120);
  rail();
}

/** Why nothing was typed, in the row, for a moment. */
function notSent(pane, n, what) {
  clearTimeout(rowTimer);
  rowSaid = { p: pane, text: `Panel ${n || "?"} is not at its prompt, so nothing is typed into it. ${what}` };
  rowTimer = setTimeout(() => { rowSaid = null; if (current()) rail(); }, 5000);
  rail();
}

/** Go ahead (#223): an approved plan's panel told so in its own prompt.
 *  The daemon tells a panel of an Approve at its next prompt, but a Claude
 *  that sent its plan and stopped has no next prompt until the reader gives
 *  one: it sat there, approved and idle. So an Approve pressed on this desk,
 *  and the approved line's Start, type the go-ahead as Send now types an
 *  answer: only into a Claude at its prompt, only on the reader's press,
 *  and only snyvi's own words with the plan's id and the lines' numbers,
 *  never anything an agent wrote. A panel at work hears it at its next
 *  prompt, as before, and the row says so. */
function goAhead(d, doc) {
  const xs = noteList.filter(x => x.stage_doc === doc && x.stage === "planned" && x.ok_at && !x.done);
  const pane = xs[0]?.stage_pane, v = pane && views.get(pane), n = pane && slotOf(d, pane);
  if (!xs.length || !v) return;
  if (!sendsHere(v)) return notSent(pane, n, "It hears the approval with your next message.");
  const lines = xs.map(x => `#${x.id}`).join(" ");
  input(v, bracket(v, oneLine(`Approved in snyvi: go ahead with the plan ${doc} for ${lines}.`)));
  setTimeout(() => input(v, "\r"), 120);
}

/** An answer on one line: the reader's Other… is a field, but a pasted line
 *  break would submit half of it. */
const oneLine = s => String(s).replace(/[\x00-\x1f\x7f]+/g, " ").trim();

/** What Send now types is how the panel hears these answers: each marked
 *  told before it is typed, so the prompt it starts does not bring them a
 *  second time among the changes. A mark that fails costs only that. */
async function sent(d, ws) {
  await Promise.all(ws.map(w => ctx.api(`/api/desks/${d.id}/turns/${w.id}/sent`, {}).catch(() => {})));
}

/** Send answers: a card's answers typed into the panel that asked as one
 *  message, a line each, numbered as the agent asked them (the card's
 *  questions are one after another from its first id), and Enter apart --
 *  on the click alone, into a Claude at its prompt, as Send now. */
async function sendGroup(d, g) {
  const ms = filed.turns.filter(w => w.ask_group === g && w.answered_at && sendable.has(w.id)).sort((a, b) => a.id - b.id);
  if (!ms.length) return;
  const v = views.get(ms[0].pane), n = slotOf(d, ms[0].pane);
  if (!sendsHere(v)) return notSent(ms[0].pane, n, "It hears your answers when its turn ends, or with your next message.");
  const text = ["Answered in snyvi:", ...ms.map(w => `${w.id - g + 1}. ${oneLine(w.answer)}`)].join("\r");
  for (const w of ms) sendable.delete(w.id);
  await sent(d, ms);
  input(v, bracket(v, text));
  setTimeout(() => input(v, "\r"), 120);
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
  try { p = await ctx.api(`/api/desks/${d.id}/panes`, { cmd: w.cmd, ...(d.grp ? { grp: d.grp } : {}) }); }
  catch (e) { rowErr = { k: `w${w.id}`, why: "Could not open a panel", raw: e.message, again: { a: "tn-newpanel", w: String(w.id) } }; rail(); return; }
  focused = p.pane.id;
  await ctx.refresh();
  const nv = views.get(p.pane.id);
  if (nv) { await run(nv, w.cmd); nv.body.focus(); }
  await answer(d, w, `Ran in a new panel, ${p.pane.slot ? `panel ${p.pane.slot}` : "its own"}; its output is there, not here`);
}

/** Add key… on a key turn: this desk's keys sheet, with its Add a key form
 *  already unfolded, which puts the cursor in the name. */
function addKeyOpen(d) {
  if (keysOpen !== d.id) keysSheet(d);
  const more = ctx.docEl.querySelector(".dk-keys-sheet .dk-key-more");
  if (more) more.open = true;
}

/** The section's clicks; true when one of them was this file's. */
async function filedAct(a, b, d) {
  // The corner's own -- Lately's rows, an offer, a card from outside.
  if (a.startsWith("cn-")) return !!ctx.corner?.()?.act(a, b);
  if (!a.startsWith("th-") && !a.startsWith("tn-") && !a.startsWith("sg-") && !a.startsWith("oy-") && a !== "fd-back") return false;
  // Any other press closes a card's Later menu (C5).
  if (!a.startsWith("tn-lt") && tLater.key) { tLater.key = ""; tLater.not = false; if (a === "oy-open") rail(); }
  if (a.startsWith("tn-lt")) { await laterAct(a, b, d); return true; }
  if (a === "oy-open") { oyToggle(); return true; }
  if (a === "tn-more") { const id = +b.dataset.w; if (!qOpen.delete(id)) qOpen.add(id); rail(); return true; }
  if (a === "oy-pin") { oyPin(d); return true; }
  if (a === "tn-key") { addKeyOpen(d); return true; }
  if (a === "tn-old") { oldOpen.add(+b.dataset.w); rail(); oyEl?.querySelector(`.dk-turn[data-w="${+b.dataset.w}"] button, .dk-turn[data-g="${+b.dataset.w}"] button`)?.focus({ preventScroll: true }); return true; }
  if (a === "tn-back") {
    // An agent's removal undone: on the reader again, as it was.
    const id = +b.dataset.w;
    if (await told({ ...b.dataset }, `b${id}`, "Could not bring it back", () => {},
      () => ctx.api(`/api/desks/${d.id}/turns/${id}/restore`, {}))) await getFiled(d.id, true);
    return true;
  }
  const t = filed.threads.find(x => x.id === +b.dataset.t);
  const w = filed.turns.find(x => x.id === +b.dataset.w);
  const s = filed.suggestions.find(x => x.id === +b.dataset.s);
  if (a === "th-move" && t) { if (b.dataset.stage) await moveThread(d, t, { stage: b.dataset.stage }); }
  else if (a === "th-x" && t) {
    filed.threads = filed.threads.filter(x => x !== t);
    putAway("t", t.id, t.name, restOf(d, t) ? "" : t.pane); rail();
    await told({ ...b.dataset }, `t${t.id}`, "Could not remove it", () => { filed.threads.push(t); filedGone = null; },
      filedAway(() => ctx.api(`/api/desks/${d.id}/threads/${t.id}/remove`, {})));
  } else if (a === "tn-pick" && w) { changing.delete(w.id); await answer(d, w, b.dataset.v, undefined, w.kind !== "tell"); }
  else if (a === "tn-rechange" && w) { changing.add(w.id); rail(); }
  else if (a === "tn-keep" && w) {
    // Still to do (C3): back in amber, and it does not go quiet again.
    if (await told({ ...b.dataset }, `w${w.id}`, "Could not keep it", () => {},
      () => ctx.api(`/api/desks/${d.id}/turns/${w.id}/restore`, {}))) await getFiled(d.id, true);
  }
  else if ((a === "tn-due-done" || a === "tn-later") && w) { dueMore.delete(w.id); await dueAnswer(d, w, a === "tn-later" ? b.dataset.v : ""); }
  else if (a === "tn-due-more" && w) { dueMore.add(w.id); rail(); ctx.tocEl.querySelector(`.tn-due-in[data-w="${w.id}"]`)?.focus(); }
  else if ((a === "tn-other" || a === "tn-change") && w) { thField = { kind: a === "tn-other" ? "other" : "change", id: w.id }; thDraft = ""; rail(); }
  else if (a === "tn-link") { if (/^https?:\/\//.test(b.dataset.u)) openLink(b.dataset.u); }
  else if (a === "tn-send" && w) await sendNow(d, w);
  else if (a === "tn-gsend") await sendGroup(d, +b.dataset.g);
  else if (a === "tn-gunsend") { for (const x of filed.turns) if (x.ask_group === +b.dataset.g) sendable.delete(x.id); rail(); }
  else if (a === "tn-run" && w) runHere(d, w);
  else if (a === "tn-step-run" && w) await stepRun(d, w, +b.dataset.i, b.dataset.to);
  else if (a === "tn-step-done" && w) await stepDone(d, w, +b.dataset.i);
  else if (a === "tn-newpanel" && w) await runNewPanel(d, w);
  else if (a === "tn-copy" && w) copySha(b, "Copied");
  else if (a === "tn-unsend" && w) { sendable.delete(w.id); rail(); }
  else if (a === "tn-x" && w) {
    filed.turns = filed.turns.filter(x => x !== w);
    stepsForget(w.id);
    putAway("w", w.id, w.text); rail();
    await told({ ...b.dataset }, `w${w.id}`, "Could not put it away", () => { filed.turns.push(w); filedGone = null; },
      filedAway(() => ctx.api(`/api/desks/${d.id}/turns/${w.id}/remove`, {})));
  } else if (a === "sg-x" && s) {
    filed.suggestions = filed.suggestions.filter(x => x !== s);
    putAway("s", s.id, s.kind === "desk" ? s.folder : s.name || s.cmd); rail();
    await told({ ...b.dataset }, `s${s.id}`, "Could not put it away", () => { filed.suggestions.push(s); filedGone = null; },
      filedAway(() => ctx.api(`/api/desks/${d.id}/suggestions/${s.id}/dismiss`, {})));
  } else if (a === "sg-open" && s) await openSuggested(d, s);
  else if (a === "sg-try" && s) await trySuggested(d, s);
  else if (a === "sg-for" && s) { sgFor.set(s.id, b.dataset.v); sgForOpen.delete(s.id); rail(); }
  else if (a === "sg-for-open" && s) { sgForOpen.add(s.id); rail(); }
  else if (a === "sg-script" && s) { const k = b.dataset.f ? `${s.id}/${b.dataset.f}` : s.id; if (!sgScript.delete(k)) sgScript.add(k); rail(); }
  else if (a === "fd-back") {
    const k = b.dataset.k, id = +b.dataset.i;
    // A card put away as one comes back as one: each of its questions.
    const ids = k === "g" && filedGone?.ids || [id];
    clearTimeout(filedTimer); filedGone = null; rail();
    if (await told({ ...b.dataset }, `${k}${id}`, "Could not put it back", () => {},
      () => filedWrite.catch(() => {}).then(() => Promise.all(ids.map(x => ctx.api(`/api/desks/${d.id}/${PATH[k]}/${x}/restore`, {})))))) await getFiled(d.id, true);
  }
  return true;
}

/** Open a suggested panel on the route + New panel takes, running the
 *  command the card showed and named as the card named it; or the desk the
 *  daemon makes for a suggested folder. */
async function openSuggested(d, s) {
  // A panel for the back (1.49): the back's cap, not the grid's.
  const back = s.kind === "panel" && s.lasts === "back";
  if (back && backViews(d).length >= ctx.desks.in_back) return ctx.toast("Open panel", `The back holds ${ctx.desks.in_back}`);
  if (s.kind === "panel" && !back) {
    const why = noNew(d);
    if (why) return ctx.toast("Open panel", why);
  }
  let j;
  const asked = s.kind === "widget" || s.kind === "box";
  try { j = await ctx.api(`/api/desks/${d.id}/suggestions/${s.id}/open`, asked ? lastsBody(s) : {}); }
  catch (e) { rowErr = { k: `s${s.id}`, why: s.kind === "widget" ? "Could not add it" : s.kind === "box" ? "Could not allow it" : "Could not open it", raw: e.message, again: { a: "sg-open", s: String(s.id) } }; rail(); return; }
  filed.suggestions = filed.suggestions.filter(x => x !== s);
  sgFor.delete(s.id); sgTry.delete(s.id); sgScript.delete(s.id);
  for (const k of sgScript) if (String(k).startsWith(`${s.id}/`)) sgScript.delete(k);
  // Added, or allowed: it runs at the runner's next look, or its body is
  // drawn now, and its seat comes with it.
  if (asked) { rail(); return; }
  if (s.kind === "desk") {
    if (j.desk && j.desk.id) { await ctx.refresh(); ctx.go(j.desk.id); }
    return;
  }
  // In the asking panel's own tab, else the one shown (1.57).
  const grp = (s.pane && views.get(s.pane)?.pane.grp) || d.grp || 0;
  const p = await ctx.api(`/api/desks/${d.id}/panes`, { cmd: s.cmd, back, ...(grp ? { grp } : {}) });
  if (!back) focused = p.pane.id;
  if (s.name) { try { await ctx.api(`/api/panes/${p.pane.id}/rename`, { name: s.name }); } catch {} }
  await ctx.refresh();
  const nv = views.get(p.pane.id);
  if (nv) { await run(nv, s.cmd, back); if (!back) nv.body.focus(); }
}

/** After a redraw of `root` -- the rail, or the corner's tray: the open
 *  field back, with what was typed and the keys kept from the panel, as the
 *  note field does. */
function threadFocus(root = ctx.tocEl) {
  const inp = root.querySelector(".th-in");
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
  } else if (f.kind === "told") {
    const t = filed.threads.find(x => x.id === f.id);
    if (t && text) await moveThread(d, t, { stage: "told", url: text }); else rail();
  } else {
    const w = filed.turns.find(x => x.id === f.id);
    if (f.kind === "not") await laterGo(d, f.id, "not", text);
    else if (w && text) { changing.delete(w.id); await answer(d, w, f.kind === "change" ? `Something's off: ${text}` : text); } else rail();
  }
}

/** The turns a Later key names: one, or a card's open questions. */
function laterTurns(key) {
  const id = +key.slice(1);
  return key[0] === "g" ? filed.turns.filter(x => x.ask_group === id && !x.answered_at) : filed.turns.filter(x => x.id === id);
}

/** Later's clicks (C5): its menu opened or shut, Not mine's field, and its
 *  answers. */
async function laterAct(a, b, d) {
  const key = b.dataset.k;
  if (a === "tn-lt-open") { tLater.not = false; tLater.key = tLater.key === key ? "" : key; return rail(); }
  if (a === "tn-lt-not") { tLater.key = key; tLater.not = true; thField = { kind: "not", id: key }; thDraft = ""; return rail(); }
  if (a === "tn-lt") return laterGo(d, key, b.dataset.v, "");
}

/** Tomorrow, Next week, Already done or Not mine, on a card or a card of
 *  questions: it goes from the tray at once and holds its Undo (undo where
 *  the click was), and the daemon is told -- the agent hears it in its
 *  brief. Already done answers it, which the agent is told as an answer. */
async function laterGo(d, key, v, word) {
  const ws = laterTurns(key);
  tLater.key = ""; tLater.not = false;
  if (!ws.length) return rail();
  const said = v === "done" ? "Done" : v === "not" ? `Not mine${word ? ` (“${word}”)` : ""}` : `Back ${v}`;
  const k = key[0] === "g" ? "g" : "w", id = +key.slice(1);
  filed.turns = filed.turns.filter(x => !ws.includes(x));
  for (const w of ws) stepsForget(w.id);
  putAway(k, id, `${said}: ${ws[0].text}`, "", ws.map(x => x.id)); rail();
  const one = w => v === "done"
    ? ctx.api(`/api/desks/${d.id}/turns/${w.id}/answer`, { answer: w.kind === "decide" ? "answered in the chat" : T.DONE[w.kind] || "Done" })
    : ctx.api(`/api/desks/${d.id}/turns/${w.id}/remove`, v === "not" ? { not: word } : { later: v });
  await told({ a: "tn-lt", k: key, v }, `${k}${id}`, "Could not do that", () => { filed.turns.push(...ws); filedGone = null; },
    filedAway(() => Promise.all(ws.map(one))));
}

const THREAD_CSS = `
.dk-threads { list-style: none; margin: 4px 0 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.dk-sugcard { position: relative; padding: 7px 8px 8px; border: 1px solid var(--rule); border-radius: var(--r-sm); background: var(--bg-raise); font-size: var(--fs-ui); }
.sg-what { margin: 0; color: var(--fg); }
.th-in { display: block; width: 100%; box-sizing: border-box; margin-top: 6px; padding: 3px 6px; border: 1px solid var(--accent); border-radius: var(--r-sm); background: var(--bg); color: var(--fg); font: inherit; font-size: var(--fs-micro); }
/* A panel's thread: its stage, a chip on the panel's row between the name
   and the context, in the rail's quiet ink; the name gives way before it does. */
.dk-pth { flex: none; margin-left: auto; padding: 0 6px; border-radius: var(--r-pill); background: var(--rule); font-size: var(--fs-micro); font-weight: 500; line-height: 16px; color: var(--fg-2); }
.dk-pth.shipped { color: var(--ok); background: color-mix(in srgb, var(--ok) 12%, transparent); }
/* Shipped, not told: the same ✓ hollow, an outline where the fill was. */
.dk-pth.untold { background: none; box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ok) 45%, transparent); }
.dk-pane.on .dk-pth { background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--fg); }
.dk-focus .dk-pth + .ctx { margin-left: 0; padding-left: 0; }
.th-edit { padding: 0 3px 2px 51px; }
.th-edit .th-in { margin: 0; }
.sg-for { display: flex; flex-wrap: wrap; gap: 4px; margin: 6px 0 0; }
.sg-chip { padding: 1px 8px; border: 1px solid var(--rule-2); border-radius: var(--r-pill); font-size: var(--fs-micro); color: var(--fg-2); }
.sg-chip[aria-pressed="true"] { border-color: var(--accent); color: var(--accent); font-weight: 600; }
.sg-fold { display: block; margin-top: 4px; padding: 0; font-size: var(--fs-micro); color: var(--fg-3); text-decoration: underline dotted; }
.sg-script { margin: 4px 0 0; padding: 4px 6px; max-height: 12em; overflow: auto; border-radius: var(--r-xs); background: var(--bg); font-family: var(--mono); font-size: var(--fs-micro); color: var(--fg-2); white-space: pre; }
.sg-box { margin: 4px 0 0; color: var(--fg-2); font-size: var(--fs-small); overflow-wrap: anywhere; }
.sg-tried { margin-top: 6px; }
.sg-cmd { display: block; margin-top: 4px; padding: 2px 5px; border-radius: var(--r-xs); background: var(--bg); font-family: var(--mono); font-size: var(--fs-micro); color: var(--fg-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
`;
