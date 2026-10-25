/* The corner: where every message lives (plan b0bca0a11f, design
 * df6879689f, docs/DESIGN.md §4.5).
 *
 * A message used to reach the reader in eight places, and three of them
 * forgot it: the card for a page from another desk went at the first click
 * elsewhere, a news toast lasted a few seconds, and asides lived in the
 * daemon's memory until its next restart. A reader who looked away had no
 * way back to any of them. So one corner, bottom-right, on every page:
 *
 * - **Rise.** What came from outside -- a page from another desk, a newer
 *   version of the one open, an agent's aside, a friend's line, reply or
 *   tick, an offer -- rises as a small card. One at a time: a burst is one
 *   card that says "+N more".
 * - **Settle.** After a few seconds, at a click elsewhere, or at Later, the
 *   card goes into the pill. Nothing that came goes on a timer.
 * - **Stay.** What only the reader can do is On you: the pill, counted in
 *   amber, opens its tray. What came is Lately, kept by the daemon
 *   (`src/lately.rs`) -- every desk's, so the sidebar's, which is every
 *   page's (1.43): a button in its head and its rail, with a dot while some
 *   of it is unseen, never a number, opening in the rail's popover
 *   (`lately`, menu.js `pop`).
 *
 * On a desk the corner is the desk's own (ui/desk/10-onyou.js), in the
 * rail's column: it asks this file for the card and the offers, and hands
 * this file their clicks. Anywhere else this file draws it, with what waits
 * on the reader across desks.
 */

/** How long a risen card stays before it settles into the pill. */
const RISE_MS = 8000;
/** Arrivals this close together are one card, and one chime. */
const BURST_MS = 1500;
/** Home shows the newest few, as Arrived did; the tray holds the rest, so a
 *  busy day does not make Home as long as the log. */
const HOME_ROWS = 5;
/** Lately's Today, in the sidebar, before the rest of it is a word away. */
const TODAY_ROWS = 10;
/** How long what a row's button did is said in the row. */
const SAID_MS = 6000;
/** What a hand-over is answered with, by kind, as Home and the desk say. */
const TURN_ANSWERS = { try: ["Looks good"], merge: ["Merged"], key: ["Added"], do: ["Done"], due: ["Done", "Tomorrow 9"] };

/** snyvi's own asides, by the moment that says each (app.js `snyviSays`),
 *  and the part of /start each one points into. */
const OWN = {
  "first-doc": ["Your first document. What arrives stays, filed with its project: nothing scrolls away.", "arrives"],
  "two-waiting": ["Two are waiting now. n opens the newest and takes it off; one key each, from the latest back.", "waiting"],
  "blocked": ["A panel needs you. Its row stays amber until you answer it, and Desks counts it.", "desks"],
  "version": ["A newer version of this file came in. c shows what changed; the older one is still here.", "versions"],
};

const CSS = `
/* The corner's shell, on every page: the pill, the tray over it, the card
   that rises. A desk places it in its rail's column (10-onyou.js, .in-rail). */
.oy { position: fixed; right: 20px; bottom: 20px; z-index: var(--z-toast); display: flex; flex-direction: column; align-items: flex-end; gap: 6px; pointer-events: none; }
.oy > * { pointer-events: auto; }
.oy[hidden] { display: none; }
.oy-pill { display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; border: 1px solid var(--rule-2); border-radius: var(--r-pill); background: var(--bg-raise); box-shadow: var(--shadow); font-size: var(--fs-micro); color: var(--fg-2); }
/* What waits on the reader is counted in amber (§5.2); what came is a dot
   in the accent, never a number. */
.oy-pill.on { border-color: var(--warn); color: var(--fg); }
.oy-pill .n { font-weight: 600; color: var(--warn); }
.oy-pill:hover, .oy-pill[aria-expanded="true"] { color: var(--fg); border-color: var(--rule-2); background: var(--bg); }
.cn-dot { flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--accent); }
.oy-card { position: relative; width: 300px; box-shadow: var(--shadow); border-radius: var(--r-sm); }
.oy-card.rise { animation: oy-in var(--dur-move) var(--ease-out); }
@keyframes oy-in { from { opacity: 0; transform: translateY(12px) scale(.96); } to { opacity: 1; transform: none; } }
/* The tray is the app's popover (audit 98b9d67a7d): raised, --r-sm, the
   rule and the shadow, as the sidebar's section popover and Lately are. */
.oy-tray { position: relative; width: 360px; box-sizing: border-box; border: 1px solid var(--rule); border-radius: var(--r-sm); background: var(--bg-raise); box-shadow: var(--shadow); animation: oy-in var(--dur-move) var(--ease-out); }
.oy-head { display: flex; align-items: center; gap: 2px; padding: 6px 6px 2px 10px; }
.oy-gap { flex: 1; }
.oy-head .oy-h { margin: 0; }
.oy-scroll { max-height: 60vh; overflow-y: auto; padding: 0 10px 4px; }
.oy-x { display: grid; place-items: center; flex: none; width: 20px; height: 20px; border: 0; border-radius: var(--r-xs); background: none; color: var(--fg-3); cursor: pointer; }
.oy-x:hover { background: var(--rule-2); color: var(--fg); }
/* A head here is a section head (.sec-fold): sentence case, the micro size,
   600, its count after it (.sec-n). Uppercase read as another app's. */
.oy-h { margin: 2px 2px 0; font-size: var(--fs-micro); font-weight: 600; color: var(--fg-3); letter-spacing: .01em; }
.oy-head .sec-n { padding: 0 2px; }
.oy-hi { display: grid; place-items: center; width: 14px; margin-right: 4px; color: var(--fg-3); }
.oy-hi svg { width: 13px; height: 13px; }
.oy-scroll .oy-h { margin-top: 10px; }
.oy-scroll > .oy-h:first-child { margin-top: 2px; }
.oy-none { margin: 4px; font-size: var(--fs-small); color: var(--fg-3); }
/* The card that rises from outside: who, what, and its two buttons. */
.cn-card { box-sizing: border-box; padding: 10px 12px; border: 1px solid var(--rule); background: var(--bg-raise); overflow: hidden; isolation: isolate; }
.cn-card > :not(.cn-peek) { position: relative; z-index: 1; }
.cn-from { margin: 0; font-size: var(--fs-micro); color: var(--fg-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cn-from b { font-weight: 600; color: var(--fg-2); }
.cn-from b.cn-snyvi { color: var(--accent); }
.cn-title { margin: 2px 0 8px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cn-text { margin: 2px 0 8px; font-size: var(--fs-ui); line-height: 1.38; color: var(--fg); overflow-wrap: anywhere; max-height: 9.6em; overflow-y: auto; }
.cn-acts { display: flex; flex-wrap: wrap; gap: 6px; }
.cn-where { margin: 8px 0 0; font-size: var(--fs-micro); color: var(--fg-3); }
.cn-where b { font-weight: 600; color: var(--fg-2); }
.cn-more { display: block; width: 100%; padding: 3px 8px; border: 1px solid var(--rule); border-top: 0; border-radius: 0 0 var(--r-sm) var(--r-sm); background: var(--bg-raise); font-size: var(--fs-micro); color: var(--fg-2); text-align: left; }
.cn-more:hover { color: var(--fg); }
/* Off a desk an aside, and only an aside, has snyvi peeking from behind it
   (docs/DESIGN.md §2.3): large, tilted, faint. On a desk, no face. */
.cn-peek { position: absolute; right: -12px; bottom: -22px; width: 72px; height: 72px; z-index: 0; pointer-events: none; opacity: var(--mascot-peek); transform: rotate(-14deg); }
.cn-card:has(.cn-peek) .cn-acts { padding-right: 44px; }
/* Lately: a log. Rows ruled off, newest first, a dot on what is unseen. */
.cn-list { margin: 0; padding: 0; list-style: none; }
.cn-row { position: relative; display: flex; gap: 8px; align-items: flex-start; padding: 7px 18px 7px 0; }
.cn-list > .cn-row + .cn-row, .cn-list > li + li { border-top: 1px solid var(--rule); }
.cn-ico { flex: none; display: grid; place-items: center; width: 18px; height: 18px; margin-top: 1px; color: var(--fg-3); }
.cn-b { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.cn-by { font-size: var(--fs-micro); color: var(--fg-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
/* Lately's byline: where it came from, which gives way, and when, which
   never does -- it was last, and the first thing an ellipsis ate. */
.cn-bl { display: flex; gap: 8px; font-size: var(--fs-micro); color: var(--fg-3); white-space: nowrap; }
.cn-w { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.cn-w b { font-weight: 600; color: var(--fg-2); }
.cn-w b.cn-snyvi { color: var(--accent); }
.cn-at { flex: none; }
/* The title, at most two lines (one for the reader's own answers, which a
   click opens in place), and a file's versions counted beside it. */
.cn-tl { display: flex; align-items: flex-end; gap: 8px; }
.cn-tl > .cn-t { flex: 1; min-width: 0; }
.cn-tx { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
.cn-row.mine .cn-tx { -webkit-line-clamp: 1; }
.cn-row.open .cn-tx { display: block; }
.cn-n { flex: none; font-size: var(--fs-micro); color: var(--fg-3); white-space: nowrap; }
:is(.cn-tx, .cn-text) code { font-family: var(--mono); font-size: .92em; padding: 0 3px; border-radius: var(--r-xs); background: var(--rule); }
/* Lately's rows are On you's tray's rows: the title first, whole, in the
   page's ink, and where and when under it, quiet. In a list of titles a
   filled chip was a box in a box, so code there is only its face. */
.cn-lately .cn-t { color: var(--fg); }
.cn-lately .cn-tl + .cn-bl { margin-top: 1px; }
.cn-lately .cn-tx code { padding: 0; background: none; }
/* Earlier is On you's Older: a line each, dimmed until the pointer or the
   focus is on it, the whole title in its tip. */
.cn-old .cn-b { flex-direction: row; align-items: baseline; gap: 8px; }
.cn-old .cn-tl { flex: 1; min-width: 0; }
.cn-old .cn-tx { -webkit-line-clamp: 1; }
.cn-old .cn-bl { flex: none; max-width: 45%; }
.cn-old > li { opacity: .72; }
.cn-old > li:is(:hover, :focus-within) { opacity: 1; }
/* On you's older asks: whole rows, as the fresh ones, only quieter. */
.cn-dim { border-top: 1px solid var(--rule); }
.cn-dim > li { opacity: .72; }
.cn-dim > li:is(:hover, :focus-within) { opacity: 1; }
.cn-by b { font-weight: 600; color: var(--fg-2); }
.cn-by b.cn-snyvi { color: var(--accent); }
.cn-t { display: block; padding: 0; border: 0; background: none; font: inherit; font-size: var(--fs-small); line-height: 1.35; color: var(--fg-2); text-align: left; overflow-wrap: anywhere; }
button.cn-t { cursor: pointer; }
button.cn-t:hover { color: var(--fg); text-decoration: underline; }
.cn-row.new .cn-t { color: var(--fg); }
.cn-row.new::before { content: ""; position: absolute; left: -7px; top: 13px; width: 5px; height: 5px; border-radius: 50%; background: var(--accent); }
.cn-row.mine .cn-t { color: var(--fg-3); }
.cn-rx { position: absolute; top: 6px; right: -4px; display: grid; place-items: center; width: 18px; height: 18px; padding: 0; border: 0; border-radius: var(--r-xs); background: none; color: var(--fg-3); opacity: 0; cursor: pointer; }
.cn-row:is(:hover, :focus-within) .cn-rx { opacity: 1; }
.cn-rx:hover { background: var(--rule-2); color: var(--fg); }
.cn-said { font-size: var(--fs-micro); color: var(--fg-3); }
.cn-undo { padding: 0 4px; border: 0; background: none; font: inherit; font-size: var(--fs-micro); color: var(--accent); cursor: pointer; }
.cn-fold { display: block; margin: 8px 2px 0; padding: 0; border: 0; background: none; font-size: var(--fs-micro); color: var(--fg-3); text-decoration: underline dotted; cursor: pointer; }
.cn-all { padding: 0; border: 0; background: none; font-size: var(--fs-micro); color: var(--fg-3); cursor: pointer; }
.cn-all:hover { color: var(--fg); }
/* On you, off a desk: a turn or an offer with its buttons in the row. */
.cn-ask .cn-acts { margin-top: 4px; }
.cn-opt { padding: 2px 9px; border: 1px solid var(--rule-2); border-radius: var(--r-sm); background: var(--bg); font-size: var(--fs-small); color: var(--fg); cursor: pointer; }
.cn-opt.rec { border-color: var(--accent); }
.cn-opt:hover { background: var(--bg-side); }
.cn-link { padding: 2px 4px; border: 0; background: none; font-size: var(--fs-small); color: var(--fg-3); text-decoration: underline dotted; cursor: pointer; }
.cn-link:hover { color: var(--fg); }
.cn-cmd { display: block; font-family: var(--mono); font-size: var(--fs-micro); color: var(--fg-2); overflow-wrap: anywhere; }
/* Lately in the sidebar's popover: kept out of sight in #trees between
   openings, as menu.js puts a section back where it lives. It is On you's
   tray in all but what it holds: the same head (its mark, its name, its
   count), held at the top while the rows scroll under it, and the same
   row, an older ask's (09-thread.js olderLine): one line, the title, then
   where and when at its right, the whole title in the tip. Seen rows are
   quiet ink; a new one is the page's ink with its dot in the margin. */
#trees > #lately-nav { display: none; }
#lately-nav .oy-head { position: sticky; top: 0; z-index: 1; background: var(--bg-raise); }
#lately-nav .cn-all { margin-right: 4px; }
#lately-nav .cn-list { padding: 0 18px 0 10px; }
#lately-nav .cn-b { flex-direction: row; align-items: baseline; gap: 8px; }
#lately-nav .cn-tl { flex: 1; min-width: 0; }
#lately-nav .cn-tx { -webkit-line-clamp: 1; }
#lately-nav .cn-bl { flex: none; max-width: 45%; }
#lately-nav .cn-t { color: var(--fg-2); }
#lately-nav .cn-row.new .cn-t { color: var(--fg); }
#lately-nav .cn-row.mine .cn-t { color: var(--fg-3); }
#lately-nav .cn-fold { margin-left: 10px; }
#lately-nav .oy-none { margin: 4px 10px; }
/* Home draws Lately large, in its own column: the same rows, more room. */
.cn-large .cn-row { padding: 9px 20px 9px 0; }
.cn-large .cn-t { font-size: var(--fs-ui); }
@media (prefers-reduced-motion: reduce) { .oy-card.rise, .oy-tray { animation: cn-fade var(--dur-move) linear; } }
@keyframes cn-fade { from { opacity: 0; } to { opacity: 1; } }
`;

let c = null, el = null;
/** On you's mark: a raised hand, what is handed to the reader (`hand_over`).
 *  It wore the Inbox's tray, and Inbox is what came to read, not what only
 *  the reader can do. The desk's corner draws it from here too. */
const hand = (px = 13) => `<svg viewBox="0 0 24 24" width="${px}" height="${px}" fill="none" stroke="currentColor" stroke-width="${+(36 / px).toFixed(2)}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 11V6a2 2 0 0 0-4 0"/><path d="M14 10V4a2 2 0 0 0-4 0v2"/><path d="M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-6-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/></svg>`;
/** Lately as this page holds it, the corner's state, and what waits off a
 *  desk: the turns across desks (the window only) and the offers. */
const L = {
  rows: [], loaded: false, loading: null, more: false, unseen: false,
  turns: [], turnsSeen: null, offers: [],
  open: false, earlier: false, allToday: false, back: null,
  card: null, cardDrawn: null, timer: 0, rang: 0,
  /** A card settled since the tray was last opened: the pill stays, to say
   *  where it went, though nothing in it is unseen any more. */
  kept: false,
  /** Rows taken out here, their Undo in the row: id -> { text, err }. */
  gone: new Map(),
  /** What a turn's or an offer's button did, said in its row: key -> text. */
  said: new Map(),
  /** The reader's own answers opened to their full text, by row id. */
  expanded: new Set(),
};

export function init(ctx) {
  c = ctx;
  document.head.append(Object.assign(document.createElement("style"), { id: "corner-drawn", textContent: CSS }));
  document.addEventListener("pointerdown", pressed, true);
  document.addEventListener("keydown", escape, true);
  document.addEventListener("visibilitychange", () => { if (!document.hidden && L.card) riseFor(RISE_MS); });
  // Back in front from another app: a card that waited for the reader has
  // its few seconds from now, as one that waited out a minimised window has.
  addEventListener("blur", () => setTimeout(() => { away = !document.hasFocus(); }));
  addEventListener("focus", () => { if (!away) return; away = false; if (L.card) riseFor(RISE_MS); });
  // A toast the pointer was on keeps its place until the pointer leaves it.
  c.root.querySelector("#toasts")?.addEventListener("pointerleave", () => { if (liftHeld != null) { const h = liftHeld; liftHeld = null; lift(h); } });
  addEventListener("snyvi:chime", e => { if (e.detail) chime(); });
  // "3 min ago" stays true in an open tray.
  setInterval(() => { if (!document.hidden && L.open) redraw(); }, 60000);
  load();
  if (c.friends()) offersLoad();
  return { event, refresh, moved, rise, offer, says, sayHeld, toggle, open: openTray, draw, redraw, lately,
    cardHtml, trayHtml: latelyHtml, offersHtml, offerCount: () => liveOffers().length, dot, keep: () => L.kept,
    act, opened, chime, ring, mark, hand, cornerHeld, away: () => away, lift, chimed: chimedLine,
    /** The desk's first page while its card is up: its row in the rail is ringed. */
    rising: id => L.card?.kind === "first" && L.card.key === `d${id}` };
}

/* ---------- what the page holds ---------- */

/** Lately's first page, and the turns across desks with it: read once,
 *  then kept by the stream's `lately` events. */
async function load(before = 0) {
  const url = `/api/lately${before ? `?before=${before}` : ""}`;
  try {
    const j = await (c.capability ? c.deskApi(url) : fetch(url).then(r => r.json()));
    // A row removed here keeps its place while its Undo stands: the
    // daemon's word on the removal reads the list again without it.
    const held = new Set([...L.gone.values()].flatMap(g => g.ids.map(String)));
    const keep = before ? [] : L.rows.filter(r => held.has(String(r.id)) && !(j.rows || []).some(x => x.id === r.id));
    L.rows = before ? L.rows.concat(j.rows || []) : (j.rows || []).concat(keep).sort((a, b) => b.id - a.id);
    L.more = !!j.more; L.unseen = !!j.unseen; L.loaded = true;
    if (!before && Array.isArray(j.turns)) turnsIn(j.turns);
  } catch { return; }
  mark();
  redraw();
}
function refresh() { L.loading = null; load(); if (c.friends()) offersLoad(); }

/** Something on a desk moved, or an offer: what waits across desks is read
 *  again, soon, when it is this file's to draw. */
let movedTimer = 0;
function moved(what) {
  if (what === "peeroffers") return void offersLoad();
  if (c.onDesk() || !c.capability) return;
  clearTimeout(movedTimer);
  movedTimer = setTimeout(() => load(), 400);
}

async function offersLoad() {
  try {
    const j = await fetch("/api/peers").then(r => r.json());
    L.offers = Array.isArray(j.offers) ? j.offers : [];
  } catch { return; }
  redraw();
}

/** The turns across desks, as `/api/lately` read them: a fresh one new to
 *  this page rises, with the chime. The first read only learns them. */
function turnsIn(turns) {
  L.turns = turns;
  const fresh = turns.filter(w => !w.stale && !w.answered_at);
  if (!L.turnsSeen) { L.turnsSeen = new Set(fresh.map(w => w.id)); return; }
  const novel = fresh.filter(w => !L.turnsSeen.has(w.id));
  for (const w of fresh) L.turnsSeen.add(w.id);
  if (!novel.length || c.onDesk()) return;
  const w = novel[novel.length - 1];
  rise({ kind: "turn", key: `t${w.id}`, turn: w, more: novel.length - 1, ring: true });
}

/** The stream's word (`lately` event): a new row, a look somewhere, or a
 *  row taken out or put back. */
function event(j) {
  if (j.row) {
    const r = j.row;
    if (!L.rows.some(x => x.id === r.id)) L.rows.unshift(r);
    if (r.kind !== "answered" && r.kind !== "offered") L.unseen = true;
    // An aside rises when it arrived lit; the rest rise where the page
    // hears of them (`rise`), with what they need to say.
    if (r.kind === "aside" && r.lit) rise({ kind: "aside", key: `r${r.id}`, row: r });
    mark();
    redraw();
  } else if (j.seen) {
    L.unseen = false;
    for (const r of L.rows) r.seen = true;
    mark();
    redraw();
  } else if (j.changed) load();
}

/* ---------- snyvi's own lines ---------- */
/* Five lines at five first moments, each once, each pointing into /start
 * (app.js `snyviSays` names them). Kept in this browser, as Lately rows of
 * kind `snyvi`; a moment that comes while an agent's aside is unseen, or
 * inside the ten quiet minutes, is held in `snyvi.own.held` and said when
 * the way is clear. */
let ownTimer = 0;
const held = () => { try { return JSON.parse(c.store.get("snyvi.own.held") || "[]"); } catch { return []; } };
function ownRows() {
  let said = [];
  try { said = JSON.parse(c.store.get("snyvi.own.said") || "[]"); } catch {}
  const seenAt = +c.store.get("snyvi.own.seen") || 0;
  return said.filter(s => OWN[s.key]).map(s => ({ id: `snyvi:${s.key}`, kind: "snyvi", at: s.at, text: OWN[s.key][0], href: `/start#${OWN[s.key][1]}`, who: "snyvi", seen: s.at <= seenAt, data: {} }));
}
function says(key) {
  const { store } = c;
  if (!OWN[key] || store.get(`snyvi.seen.${key}`)) return;
  const quiet = 600e3 - (Date.now() - (+store.get("snyvi.seen.at") || 0));
  if (quiet > 0 || L.rows.some(r => r.kind === "aside" && !r.seen)) {
    const h = held();
    if (!h.includes(key)) store.set("snyvi.own.held", JSON.stringify(h.concat(key)));
    clearTimeout(ownTimer);
    ownTimer = setTimeout(sayHeld, Math.max(quiet, 30e3));
    return;
  }
  store.set("snyvi.own.held", JSON.stringify(held().filter(k => k !== key)));
  store.set(`snyvi.seen.${key}`, "1"); store.set("snyvi.seen.at", String(Date.now()));
  let said = [];
  try { said = JSON.parse(store.get("snyvi.own.said") || "[]"); } catch {}
  const at = Math.floor(Date.now() / 1000);
  store.set("snyvi.own.said", JSON.stringify(said.filter(s => s.key !== key).concat({ key, at })));
  const row = ownRows().find(r => r.id === `snyvi:${key}`);
  if (row) rise({ kind: "aside", key: row.id, row });
  redraw();
}
/** The first held moment, if the way is clear now; the rest keep waiting. */
function sayHeld() {
  const k = held().find(k => !c.store.get(`snyvi.seen.${k}`));
  if (k) says(k); else c.store.set("snyvi.own.held", "[]");
}

/* ---------- rise and settle ---------- */

/** A card rises: `kind` is doc, version, first, aside, friend, offer or
 *  turn. A burst is one card that counts the rest; a turn or an offer,
 *  which waits on the reader, rings. In an open tray nothing rises: it is
 *  drawn there already. */
function rise(card) {
  const burst = L.card && Date.now() - L.card.since < BURST_MS;
  if (card.ring && Date.now() - L.rang >= BURST_MS) ring(card.turn ? `${card.turn.desk_name || "A desk"}: ${card.turn.text}` : `An offer to ${card.offer?.to || "a friend"}: ${card.offer?.title || card.offer?.text || ""}`);
  if (card.ring) L.rang = Date.now();
  if (L.open) return redraw();
  card.since = Date.now();
  card.more = (card.more || 0) + (burst ? 1 + (L.card.more || 0) : 0);
  L.card = card;
  if (card.kind === "aside" && !c.onDesk()) c.hop?.();
  riseFor(RISE_MS);
  redraw();
}

/** The card settles after `ms`: held while the cursor is on the corner,
 *  and while the page is out of sight or the reader is in another app -- a
 *  card that rose in a minimised window, or behind the editor, waits for
 *  them to be back (#190). */
function riseFor(ms) {
  clearTimeout(L.timer);
  L.timer = setTimeout(() => {
    if (document.hidden || away) return;
    if (cornerHeld()) return riseFor(1500);
    settle();
  }, ms);
}

/* ---------- the hold (#189) ----------
 * Nothing in the corner moves or goes while the pointer is on any of it:
 * the card, its pill, and the toasts that stand above them on `--oy-h`.
 * A card that settled under a toast the reader was reaching for dropped the
 * toast by the card's height, under the pointer. */

/** Whether the reader left this window for another app: not a blur into a
 *  document's frame, which is still this page. */
let away = false;
/** Whether the pointer is on the corner: the desk's, this file's, or a toast. */
function cornerHeld() { return !!document.querySelector("#onyou:hover, #cn:hover, #toasts .toast:hover"); }
/** The height the toasts stand on, kept while the pointer is on one. */
let liftHeld = null;
function lift(px) {
  const toasts = c.root.querySelector("#toasts");
  if (toasts?.querySelector(".toast:hover")) { liftHeld = px; return; }
  document.documentElement.style.setProperty("--oy-h", `${px}px`);
}
/** Into the pill: what it said is in the tray, under Lately or On you. */
function settle() {
  clearTimeout(L.timer);
  if (!L.card) return;
  L.card = null; L.cardDrawn = null; L.kept = true;
  redraw();
}

/** A press anywhere but the corner settles a card and closes the tray. */
function pressed(e) {
  const inside = e.target.closest?.("#cn, #onyou");
  if (inside) return;
  if (L.card) settle();
  if (L.open && !c.onDesk()) closeTray(false);
}
function escape(e) {
  if (e.key !== "Escape" || !L.open || c.onDesk() || !el?.isConnected) return;
  e.preventDefault(); e.stopPropagation();
  closeTray(true);
}

/* ---------- the pill and the tray ---------- */

/** The dot: something in Lately, or one of snyvi's own lines, unseen. */
function dot() { return !!c.lately && (L.unseen || ownRows().some(r => !r.seen)); }
const liveOffers = () => L.offers.filter(o => !L.said.has(`o${o.id}`));
const freshTurns = () => L.turns.filter(w => !w.stale && !w.answered_at && !L.said.has(`t${w.id}`));

function toggle() { L.open ? closeTray(true) : openTray(); }
function openTray(tries = 0) {
  if (c.onDesk()) return c.deskTray?.();
  // On a desk still loading, its corner is the one to open.
  if (c.view() === "desk") { if (tries < 20 && c.capability) setTimeout(() => openTray(tries + 1), 150); return; }
  const at = document.activeElement;
  L.back = at && !el?.contains(at) ? at : null;
  L.open = true; L.card = null; clearTimeout(L.timer);
  redraw();
  el?.querySelector(".oy-tray")?.focus({ preventScroll: true });
}
function closeTray(back) {
  L.open = false;
  if (!dot()) L.kept = false;
  redraw();
  if (back && L.back?.isConnected) L.back.focus({ preventScroll: true });
  L.back = null;
}
/** Lately opened, in the sidebar or on Home: everything in it is seen, in
 *  every page (`/api/lately/seen`), and snyvi's own lines in this browser. */
function opened() {
  L.kept = false;
  c.store.set("snyvi.own.seen", String(Math.floor(Date.now() / 1000)));
  if (!L.unseen) return mark();
  L.unseen = false;
  mark();
  fetch("/api/lately/seen", { method: "POST" }).catch(() => {});
}

/** The logo's mark while an agent's aside waits unseen: it blinks, as it
 *  did for the sidebar's card. */
function mark() {
  const a = L.rows.find(r => r.kind === "aside" && !r.removed);
  if (c.lately && a && !a.seen && L.unseen) c.root.dataset.note = a.lit ? "lit" : "new";
  else delete c.root.dataset.note;
  // The sidebar's Lately button wears the dot (app.css).
  c.root.toggleAttribute("data-lately", dot());
}

/** Redraw wherever the corner is drawn: the desk's, or this file's; and
 *  Lately, in the sidebar's popover, wherever that is open. */
function redraw() {
  drawLately();
  c.root.toggleAttribute("data-lately", dot());
  if (c.onDesk()) return c.deskRedraw?.();
  draw();
  c.homeRedraw?.();
}

/** The corner off a desk: the card or the tray, and the pill under them.
 *  Not there at all while nothing is in it. */
function draw() {
  if (c.onDesk()) { if (el) el.hidden = true; return; }
  const { esc } = c;
  const onYou = c.capability ? freshTurns().length : 0, offers = liveOffers().length;
  const card = L.card ? cardHtml(false) : "";
  const tray = L.open ? offTray(esc) : "";
  const n = onYou + offers;
  // Only what waits on the reader: what came is the sidebar's (Lately).
  const pill = !tray && n
    ? `<button type="button" class="oy-pill on" data-a="cn-open" aria-expanded="false" data-tip="On you" data-tip-sub="What only you can do, across your desks${esc(chimedLine(" · "))}" data-key="ctrl+alt+y">On you <span class="n">${n}</span></button>` : "";
  if (!card && !tray && !pill) {
    if (el) { el.hidden = true; el.innerHTML = el.$html = ""; }
    lift(0);
    return;
  }
  node().hidden = false;
  const html = card + tray + pill;
  if (el.$html !== html) {
    const was = el.contains(document.activeElement) ? keyOf(document.activeElement) : "";
    el.innerHTML = el.$html = html;
    if (was) el.querySelector(was)?.focus({ preventScroll: true });
  }
  // The toasts sit above the corner while it shows (toast.js --oy-h).
  const top = el.getBoundingClientRect().top;
  lift(Math.max(0, Math.round(innerHeight - top - 20 + 8)));
}
function node() {
  if (el?.isConnected) return el;
  el = document.createElement("div");
  el.id = "cn"; el.className = "oy";
  el.setAttribute("role", "region");
  el.setAttribute("aria-label", "On you");
  el.addEventListener("click", e => { const b = e.target.closest("[data-a]"); if (b) act(b.dataset.a, b); });
  // The logo looks down at whoever rests on an aside's card: a smile, a heart.
  el.addEventListener("mouseover", e => { if (e.target.closest(".cn-card:has(.cn-peek)")) c.root.dataset.noteNear = "1"; });
  el.addEventListener("mouseout", e => { if (!e.relatedTarget?.closest?.(".cn-card:has(.cn-peek)")) delete c.root.dataset.noteNear; });
  document.body.append(el);
  return el;
}
/** A button's selector by what it does and which row it is on. */
function keyOf(b) {
  const ds = b.dataset || {}, q = window.CSS.escape;
  return ds.a ? `[data-a="${q(ds.a)}"]` + ["r", "k", "v"].filter(k => ds[k] != null).map(k => `[data-${k}="${q(ds[k])}"]`).join("") : "";
}

/** The tray off a desk: On you across desks -- turns, offers. */
function offTray(esc) {
  const turns = c.capability ? L.turns.filter(w => !w.answered_at) : [];
  const fresh = turns.filter(w => !w.stale), old = turns.filter(w => w.stale);
  const said = [...L.said].filter(([k]) => k[0] === "t").map(([, s]) => `<li class="cn-row mine" role="status"><span class="cn-b"><span class="cn-t">${esc(s.text)}</span></span></li>`).join("");
  // Older asks under the fresh, dimmed, not folded: an unanswered ask is on
  // the reader whatever its age, as the desk's tray has it (1.43).
  const asks = said + fresh.map(turnRow).join("") + offersHtml();
  const older = old.length ? `<ul class="cn-list cn-dim" aria-label="Older">${old.map(turnRow).join("")}</ul>` : "";
  const close = `<button type="button" class="oy-x" data-a="cn-open" aria-label="Close" data-tip="Close" data-tip-sub="Esc" data-key="ctrl+alt+y">${c.glyph("x", 12)}</button>`;
  return `<div class="oy-tray" role="dialog" aria-label="On you" tabindex="-1"><div class="oy-head"><span class="oy-hi" aria-hidden="true">${hand()}</span><h3 class="oy-h" data-tip="On you" data-tip-sub="What only you can do, across your desks">On you</h3><span class="oy-gap"></span>${close}</div>` +
    `<div class="oy-scroll">${asks || older ? (asks ? `<ul class="cn-list">${asks}</ul>` : "") + older : `<p class="oy-none">Nothing on you right now.</p>`}</div></div>`;
}

/** Who asked, as the reader knows them. */
const whoOf = w => /^claude\b/.test(w.by || "") ? "Claude" : w.slot ? `Panel ${w.slot}` : "An agent";

/** A turn across desks, with its answers in the row, as Home had them. A
 *  command runs on its desk, where Run types it into the panel that asked. */
function turnRow(w) {
  const { esc } = c;
  const opts = w.kind === "decide" || w.kind === "tell" ? w.options || [] : w.kind === "run" ? [] : TURN_ANSWERS[w.kind] || ["Done"];
  const where = `${esc(w.desk_name || "a desk")}${w.slot ? ` · panel ${w.slot}` : ""}`;
  return `<li class="cn-row cn-ask"><span class="cn-ico">${c.glyph("aside", 12)}</span><span class="cn-b">` +
    `<span class="cn-by"><b>${esc(w.by || whoOf(w))}</b> · ${where} · ${c.relShort(w.created_at)}</span>` +
    `<span class="cn-t">${code(w.text)}</span>${w.kind === "run" && w.options && w.options.length ? `<span class="cn-by">${w.options.filter(o => !o.startsWith("# ")).length} steps, run one at a time on the desk</span>` : w.kind === "run" && w.cmd ? `<code class="cn-cmd">${esc(w.cmd)}</code>` : ""}` +
    `<span class="cn-acts">${opts.map((o, i) => `<button type="button" class="cn-opt${i === w.recommended ? " rec" : ""}" data-a="cn-answer" data-k="${w.id}" data-v="${esc(o)}"${i === w.recommended ? ` data-tip="Recommended"` : ""}>${esc(o)}</button>`).join("")}` +
    `<button type="button" class="cn-link" data-a="cn-desk" data-k="${w.desk_id}" data-v="${w.slot || 0}">${w.kind === "run" ? "Run on the desk" : "Go to desk"}</button></span></span>` +
    `<button type="button" class="cn-rx" data-a="cn-notnow" data-k="${w.id}" aria-label="Not now: ${esc(w.text)}" data-tip="Not now" data-tip-sub="nothing is deleted">${c.glyph("x", 10)}</button></li>`;
}

/** An agent's offer to send a friend something: On you, since it waits on
 *  the reader's Send (it was a sheet over whatever they were doing). */
function offersHtml() { return L.offers.map(offerRow).join(""); }
function offerRow(o) {
  const { esc } = c, s = L.said.get(`o${o.id}`);
  const what = o.text ? `a line, “${esc(o.text)}”` : `<b>${esc(o.title || "a document")}</b>`;
  return `<li class="cn-row cn-ask${s ? " mine" : ""}"><span class="cn-ico">${c.who(o.to)}</span><span class="cn-b">` +
    `<span class="cn-by"><b>${esc(o.by || "An agent")}</b> · ${c.relShort(o.offered_at)}</span>` +
    `<span class="cn-t">Send ${what} to ${esc(o.to)}?</span>` +
    `<span class="cn-acts">${s ? `<span class="cn-said" role="status">${esc(s.text)}</span>${s.undo ? `<button type="button" class="cn-undo" data-a="cn-offer-undo" data-k="${o.id}">Undo</button>` : ""}`
      : `<button type="button" class="cn-opt rec" data-a="cn-send" data-k="${o.id}">Send</button><button type="button" class="cn-opt" data-a="cn-notsend" data-k="${o.id}">Not now</button>`}</span></span></li>`;
}

/* ---------- Lately ---------- */

/** Text with its `inline code` drawn as code, as a document draws it: an
 *  agent's titles carry backticks, and they read as noise left in. */
const code = s => c.esc(s).replace(/`([^`\n]+)`/g, "<code>$1</code>");

/** Lately in the sidebar's popover (app.js `openLately`, menu.js `pop`):
 *  its element, made once and kept in #trees, out of sight, between
 *  openings. Opening it is looking at it, as the tray's opening was. */
let latelyEl = null;
function lately() {
  L.allToday = false;
  if (!latelyEl?.isConnected) {
    latelyEl = document.createElement("section");
    latelyEl.id = "lately-nav";
    latelyEl.setAttribute("aria-label", "Lately");
    // Its clicks are this file's; the tree's own delegate has no business with them.
    latelyEl.addEventListener("click", e => { const b = e.target.closest("[data-a]"); if (b && act(b.dataset.a, b)) e.stopPropagation(); });
    document.getElementById("trees").append(latelyEl);
  }
  opened();
  redraw();
}
/** What arrives while it is open lands in it, the focus kept on its button. */
function drawLately() {
  if (!latelyEl?.isConnected) return;
  const html = latelyHtml();
  if (latelyEl.$html === html) return;
  const was = latelyEl.contains(document.activeElement) ? keyOf(document.activeElement) : "";
  latelyEl.innerHTML = latelyEl.$html = html;
  if (was) latelyEl.querySelector(was)?.focus({ preventScroll: true });
}

/** What a row says, by kind, and where a click on it goes. The reader's own
 *  answer leads with what they chose; its question is the rest of the line. */
function rowText(r) {
  const d = r.data || {};
  switch (r.kind) {
    case "version": return [r.text, "doc"];
    case "reply": return [`Replied: ${r.text}`, r.doc ? "doc" : "home"];
    case "tick": return [`Ticked your line: ${r.text}`, "home"];
    case "line": return [`“${r.text}”`, d.desk ? "desk" : "home"];
    case "answered": return [`You chose “${d.answer || ""}” · ${r.text}`, ""];
    case "told": return [`Told: ${r.text}${d.url ? ` · ${d.url.replace(/^https?:\/\//, "")}` : ""}`, "desk"];
    case "offered": return [`${d.sent ? "Sent" : "Not sent"} to ${d.to || "a friend"}: ${r.text}`, ""];
    case "aside": return [r.text, r.doc ? "doc" : r.from ? "desk" : ""];
    case "snyvi": return [r.text, "start"];
    default: return [r.text, "doc"];
  }
}
/** The byline says where it came from, the desk (its panel is in the tip:
 *  `snyvi · 1` beside `snyvi · 2` read as a count), how many versions a
 *  document has had, and when, pinned right where no ellipsis reaches it. Lately is
 *  every desk's, so the desk is what tells two rows apart; who sent it is
 *  named only when it is not Claude Code, which every agent row was --
 *  a friend, another agent. snyvi's own lines say snyvi, in the accent. */
const CLAUDE = /^claude[ -]?code$/i;
function byline(r, n = 1) {
  const { esc } = c, d = r.data || {};
  const who = r.kind === "snyvi" ? `<b class="cn-snyvi">snyvi</b>` : r.who && !CLAUDE.test(r.who) ? `<b>${esc(r.who)}</b>` : "";
  const where = r.from ? esc(r.from.name) : esc(d.desk_name || d.project || "");
  const w = [who, where].filter(Boolean).join(" · ") || (r.who ? esc(r.who) : "");
  const tip = r.from?.slot ? ` data-tip="${esc(r.from.name)}, panel ${+r.from.slot}"` : "";
  const vs = n > 1 ? `<span class="cn-n" data-tip="${n} versions">×${n}</span>` : "";
  return `<span class="cn-w"${tip}>${w}</span>${vs}<span class="cn-at">${c.relShort(r.at)}</span>`;
}
/** A row's mark, only where it says something: a friend's face, an
 *  aside, the reader's own. A document is most of the list, and a page
 *  glyph on every row said nothing in 26 px of it. */
function rowIco(r) {
  if (r.kind === "version" || (r.kind === "doc" && r.data?.origin !== "peer")) return "";
  if (["line", "reply", "tick"].includes(r.kind) || (r.kind === "doc" && r.data?.origin === "peer")) return c.who(r.who);
  return c.glyph(r.kind === "aside" || r.kind === "snyvi" ? "aside" : r.kind === "answered" || r.kind === "offered" ? "checks" : "doc", 12);
}

/** Lately's rows, newest first, snyvi's own among them; one row per
 *  document. A plan sent five times was five rows, as "2 documents" and "3
 *  documents" with the same title in each, because a send from another desk
 *  fell between them: so the sends of one document -- one sender, one desk,
 *  one title -- are one row wherever they fall, at the newest's place, and
 *  it counts its versions. */
function rows() {
  // The reader's own answers are not something that came: the answer is on
  // the ask's thread and goes with the agent's next turn. They stay in the
  // daemon's log, only not here.
  const all = L.rows.concat(ownRows()).filter(r => r.kind !== "answered").sort((a, b) => b.at - a.at || (b.id > a.id ? 1 : -1));
  const out = [], by = new Map();
  for (const r of all) {
    if (r.kind !== "doc" && r.kind !== "version") { out.push(r); continue; }
    const k = `${r.who}\n${r.from?.id ?? r.data?.project ?? ""}\n${r.text}`, g = by.get(k);
    if (g) { g.group.push(r); continue; }
    const row = { ...r, group: [r] };
    by.set(k, row); out.push(row);
  }
  return out;
}

/** A row: its byline, then its title -- two lines at most, the whole of it
 *  in the tip -- and a document's versions beside it. The reader's own
 *  answers are one dimmed line, which a click opens in place. */
function rowHtml(r) {
  const { esc } = c, id = esc(String(r.id)), gone = L.gone.get(String(r.id));
  if (gone) return `<li class="cn-row mine cn-gone" role="status"><span class="cn-b"><span class="cn-t">${esc(gone.err || "Removed")}</span></span><button type="button" class="cn-undo" data-a="cn-back" data-r="${id}">${gone.err ? "Retry" : "Undo"}</button></li>`;
  const unseen = r.group ? r.group.some(x => !x.seen) : !r.seen;
  const mine = r.kind === "answered" || r.kind === "offered", open = mine && L.expanded.has(String(r.id));
  const [text, to] = rowText(r), n = r.group ? r.group.length : 1;
  const tx = `<span class="cn-tx" data-tip-cut>${code(text)}</span>`, tip = `data-tip="${esc(text)}" data-tip-overflow`;
  const t = to ? `<button type="button" class="cn-t" data-a="cn-go" data-r="${id}" ${tip}>${tx}</button>`
    : mine ? `<button type="button" class="cn-t" data-a="cn-expand" data-r="${id}" aria-expanded="${open}">${tx}</button>`
    : `<span class="cn-t" ${tip}>${tx}</span>`;
  const ids = r.group ? r.group.map(x => x.id).join(",") : r.id;
  const ico = rowIco(r);
  return `<li class="cn-row${unseen && !mine ? " new" : ""}${mine ? " mine" : ""}${open ? " open" : ""}" data-part="corner.lately.${r.kind}">${ico ? `<span class="cn-ico">${ico}</span>` : ""}<span class="cn-b">` +
    `<span class="cn-tl">${t}</span><span class="cn-bl">${byline(r, n)}</span></span>` +
    `<button type="button" class="cn-rx" data-a="cn-x" data-r="${esc(String(ids))}" aria-label="Remove" data-tip="Remove" data-tip-sub="Undo brings it back, and so does Removed on Home">${c.glyph("x", 10)}</button></li>`;
}

/** Lately: Today, then Earlier folded (open when Today is empty). `large`
 *  is Home's, which draws it in a column of its own, without the rows
 *  `skip` says it draws itself. */
function latelyHtml(large = false, skip = null) {
  const all = skip ? rows().filter(r => !skip(r)) : rows(), day = new Date().setHours(0, 0, 0, 0) / 1000;
  const today = all.filter(r => r.at >= day), earlier = all.filter(r => r.at < day);
  const open = L.earlier || !today.length;
  const list = (xs, cls = "") => xs.length ? `<ul class="cn-list${cls}">${xs.map(rowHtml).join("")}</ul>` : "";
  const more = L.more && open ? `<button type="button" class="cn-fold" data-a="cn-more">Older…</button>` : "";
  // Today, ten rows and then the rest on a word, as Earlier is: a day of
  // agents' sends was twenty rows, a wall with no end in sight.
  const cut = large || L.allToday ? today.length : TODAY_ROWS, shown = today.slice(0, cut);
  const rest = today.length > cut ? `<button type="button" class="cn-fold" data-a="cn-today">${today.length - cut} more today</button>` : "";
  const body = !all.length ? `<p class="oy-none">${L.loaded ? "Nothing has come lately. What agents and friends send lands here." : "…"}</p>`
    : list(shown) + rest + (earlier.length ? (today.length ? `<button type="button" class="cn-fold" data-a="cn-earlier" aria-expanded="${open}">Earlier</button>` : "") + (open ? list(earlier, today.length ? " cn-old" : "") + more : "") : "");
  if (large) {
    const rest = all.length - HOME_ROWS;
    return `<section class="cn-lately cn-large" data-part="corner.lately" aria-label="Lately">` + (all.length ? list(all.slice(0, HOME_ROWS)) : body) +
      (rest > 0 || L.more ? `<button type="button" class="cn-fold" data-a="cn-lately" data-tip="All of Lately" data-tip-sub="In the sidebar">${rest > 0 && !L.more ? `${rest} more` : "All of Lately"}</button>` : "") + `</section>`;
  }
  // On you's head: its mark, its name and its count -- here what is new,
  // in the accent its rows' dots are -- then what acts on all of it, and ✕.
  const n = all.filter(r => r.kind !== "offered" && (r.group ? r.group.some(x => !x.seen) : !r.seen)).length;
  const count = n ? `<span class="sec-n accent" data-tip="${n} new">${n}</span>` : "";
  const all_ = dot() ? `<button type="button" class="cn-all" data-a="cn-seen">Mark all seen</button>` : "";
  const close = `<button type="button" class="oy-x" data-a="cn-close" aria-label="Close" data-tip="Close" data-tip-sub="Esc">${c.glyph("x", 12)}</button>`;
  return `<section class="cn-lately" data-part="corner.lately" aria-label="Lately">` +
    `<div class="oy-head"><span class="oy-hi" aria-hidden="true">${c.glyph("clock", 13)}</span><h3 class="oy-h" data-tip="Lately" data-tip-sub="What came: documents, asides, friends. Kept 14 days; asides until you remove them">Lately</h3>${count}<span class="oy-gap"></span>${all_}${close}</div>` + body + `</section>`;
}

/** The card that rises, by kind. `desk` is the desk's corner drawing it,
 *  which carries no face (docs/DESIGN.md §2.3). */
function cardHtml(desk) {
  const k = L.card;
  if (!k) return "";
  const { esc } = c, first = L.cardDrawn !== k;
  L.cardDrawn = k;
  // What waits on the reader is On you's; anything else came, and is
  // Lately's, which has no "+N more" while it is hidden.
  const mine = k.kind === "turn" || k.kind === "offer";
  const more = k.more && (mine || c.lately) ? `<button type="button" class="cn-more" data-a="${mine ? "cn-open" : "cn-lately"}">+${k.more} more</button>` : "";
  let body = "";
  if (k.kind === "turn") body = `<ul class="cn-list">${turnRow(k.turn)}</ul>`;
  else if (k.kind === "offer") body = `<ul class="cn-list">${offerRow(L.offers.find(o => o.id === k.offer.id) || k.offer)}</ul>`;
  else if (k.kind === "aside") {
    const r = k.row, [, to] = rowText(r);
    const face = !desk && c.peek ? `<span class="cn-peek" aria-hidden="true">${c.peek(r.kind === "snyvi" ? "glad" : "rest")}</span>` : "";
    body = face + `<p class="cn-from cn-bl">${byline(r)}</p><p class="cn-text">${code(r.text)}</p>` +
      `<div class="cn-acts">${to ? `<button type="button" class="tn-opt cn-opt rec" data-a="cn-go" data-r="${esc(String(r.id))}">${r.kind === "snyvi" ? "Read more" : r.doc ? "Open" : "Go to its panel"}</button>` : ""}<button type="button" class="tn-opt cn-opt" data-a="cn-later">Later</button></div>`;
  } else {
    // A document, a version, a friend's word: who, what, and its way there.
    body = `<p class="cn-from oy-from">${k.from || ""}</p><p class="cn-title oy-title" data-tip="${esc(k.title || "")}" data-tip-overflow>${esc(k.title || "")}</p>` +
      (k.text ? `<p class="cn-text">${esc(k.text)}</p>` : "") +
      `<div class="cn-acts">${k.go ? `<button type="button" class="tn-opt cn-opt rec" data-a="cn-card-go">${esc(k.label || "Open")}</button>` : ""}<button type="button" class="tn-opt cn-opt" data-a="cn-later" data-tip="Later" data-tip-sub="It stays in Lately, in the sidebar">Later</button></div>` +
      (k.where ? `<p class="cn-where">${k.where}</p>` : "");
  }
  // A document's card keeps the name it had on a desk (`oy-doc`).
  const doc = k.kind === "doc" || k.kind === "version" || k.kind === "first" ? " oy-doc" : "";
  return `<div class="oy-card cn-card${doc}${first ? " rise" : ""}" role="status" data-part="corner.card">${body}${more}</div>`;
}

/* ---------- the clicks ---------- */

/** A click on something of the corner's, here or in the desk's corner or on
 *  Home. True when it was. */
function act(a, b) {
  if (!a?.startsWith("cn-")) return false;
  const k = b.dataset.k, r = b.dataset.r;
  const go = {
    "cn-open": () => toggle(),
    "cn-lately": () => { settle(); if (L.open && !c.onDesk()) closeTray(false); c.openLately?.(); },
    "cn-expand": () => { const k = String(r); L.expanded.has(k) ? L.expanded.delete(k) : L.expanded.add(k); redraw(); },
    "cn-later": () => settle(),
    "cn-card-go": () => { const card = L.card; settle(); card?.go?.(); },
    "cn-go": () => { const row = findRow(r); if (row) { settle(); follow(row); } },
    "cn-x": () => remove(r.split(",")),
    "cn-back": () => restore(r),
    "cn-earlier": () => { L.earlier = !L.earlier; redraw(); },
    "cn-today": () => { L.allToday = true; redraw(); },
    "cn-close": () => { c.unpop?.(); [...document.querySelectorAll(".lt-btn")].find(x => x.getClientRects().length)?.focus({ preventScroll: true }); },
    "cn-more": () => load(L.rows[L.rows.length - 1]?.id || 0),
    "cn-seen": () => { opened(); for (const x of L.rows) x.seen = true; redraw(); },
    "cn-answer": () => answer(+k, b.dataset.v),
    "cn-notnow": () => notNow(+k),
    "cn-desk": () => { settle(); closeTray(false); c.showDesk(+k, true, +b.dataset.v || 0); },
    "cn-send": () => offerAnswer(+k, true),
    "cn-notsend": () => offerAnswer(+k, false),
    "cn-offer-undo": () => offerUndo(+k),
  }[a];
  if (!go) return false;
  go();
  return true;
}

const findRow = id => L.rows.concat(ownRows()).find(x => String(x.id) === String(id));

/** Where a row leads: its document, read over the page; an aside's panel;
 *  a friend's word on Home; snyvi's own line into /start. */
function follow(r) {
  const [, to] = rowText(r);
  if (L.open && !c.onDesk()) closeTray(false);
  if (c.root.dataset.pop === "lately") c.unpop?.();
  if (to === "doc" && r.doc) c.showDoc(r.doc);
  else if (to === "desk" && r.from && c.capability) c.showDesk(r.from.id, true, r.from.slot || 0);
  else if (to === "desk" && r.data?.desk && c.capability) c.showDesk(r.data.desk, true, 0);
  else if (to === "start") c.showStart(true, r.href.slice(r.href.indexOf("#")));
  else if (to === "home" || to === "desk") c.showHome(true);
}

/** ✕ on rows: out of the list at once, in every page once the daemon has
 *  it; the row holds its Undo for a moment (undo where the click was), and
 *  Home's Removed has it after. snyvi's own lines live in this browser, and
 *  go from it when the Undo does. */
async function remove(ids) {
  const g = { ids, err: "", asking: false };
  L.gone.set(String(ids[0]), g);
  redraw();
  const theirs = ids.filter(id => !String(id).startsWith("snyvi:")).map(Number);
  try { if (theirs.length) await post("/api/lately/remove", { ids: theirs }); }
  catch { L.gone.delete(String(ids[0])); c.toast("Could not remove it"); redraw(); return; }
  setTimeout(() => {
    if (L.gone.get(String(ids[0])) !== g || g.err || g.asking) return;
    L.gone.delete(String(ids[0]));
    L.rows = L.rows.filter(x => !ids.includes(String(x.id)));
    const own = ids.filter(id => String(id).startsWith("snyvi:"));
    if (own.length) {
      let said = [];
      try { said = JSON.parse(c.store.get("snyvi.own.said") || "[]"); } catch {}
      c.store.set("snyvi.own.said", JSON.stringify(said.filter(s => !own.includes(`snyvi:${s.key}`))));
    }
    redraw();
  }, SAID_MS);
}
/** Undo: the daemon first, so a row put back here is not gone again at the
 *  next read. A no is said in the row, whose Undo is then its Retry. */
async function restore(id) {
  const g = L.gone.get(String(id));
  if (!g || g.asking) return;
  g.asking = true;
  const theirs = g.ids.filter(x => !String(x).startsWith("snyvi:")).map(Number);
  try { if (theirs.length) await post("/api/lately/restore", { ids: theirs }); }
  catch { g.asking = false; g.err = "Could not bring it back"; redraw(); return; }
  L.gone.delete(String(id));
  redraw();
}

async function post(url, body) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
  let j = null; try { j = r && r.status !== 204 ? await r.json() : {}; } catch { j = {}; }
  if (!r?.ok) throw new Error(j?.error || (r ? `snyvi answered ${r.status}` : "snyvi did not answer"));
  return j;
}

/** A turn answered off a desk: it reaches the agent with its panel's next
 *  prompt, and the row says so for a moment. */
async function answer(id, v) {
  const w = L.turns.find(x => x.id === id);
  if (!w) return;
  // A due card is snyvi's (1.47): Done ticks its line, a time moves it.
  sayIn(`t${id}`, w.kind === "due" ? (v === "Done" ? `Ticked: ${w.text}` : `Moved to ${v.toLowerCase()}: ${w.text}`) : w.kind === "tell" ? (v === "No one" ? "Told no one: it counts as told" : `${v}: a dated line is on its desk`) : `You said “${v}” · it goes with your next message on ${w.desk_name || "its desk"}`);
  try { await c.deskApi(`/api/desks/${w.desk_id}/turns/${id}/answer`, { answer: v }); }
  catch (e) { sayIn(`t${id}`, `Could not answer it: ${c.sayErr(e).why}`); }
  if (L.card?.key === `t${id}`) settle();
  load();
}
async function notNow(id) {
  const w = L.turns.find(x => x.id === id);
  if (!w) return;
  sayIn(`t${id}`, `Not now: ${w.text}`);
  try { await c.deskApi(`/api/desks/${w.desk_id}/turns/${id}/remove`, {}); }
  catch { sayIn(`t${id}`, "Could not put it away; try again on the desk"); }
  load();
}
function sayIn(key, text, undo = false) {
  L.said.set(key, { text, undo });
  redraw();
  setTimeout(() => { if (L.said.get(key)?.text === text) { L.said.delete(key); redraw(); } }, SAID_MS);
}

/* ---------- an agent's offer ---------- */

/** The stream's `peeroffers` with an offer in it: an On you row, risen with
 *  the chime, since it waits on the reader's Send. */
function offer(j) {
  const id = j.offer;
  const o = { id, to: j.to, title: j.title || "", text: j.text || "", by: j.by || "", offered_at: Math.floor(Date.now() / 1000), desk: j.desk };
  if (!L.offers.some(x => x.id === id)) L.offers.unshift(o);
  rise({ kind: "offer", key: `o${id}`, offer: o, ring: true });
  offersLoad();
}
async function offerAnswer(id, send) {
  const o = L.offers.find(x => x.id === id);
  if (!o) return;
  try {
    const r = await post(`/api/peers/offers/${id}`, { send });
    L.said.set(`o${id}`, { text: !send ? "Not sent" : r.sent ? `Sent to ${o.to}` : `Queued for ${o.to}; it goes when the relay can be reached`, undo: !send });
  } catch (e) { L.said.set(`o${id}`, { text: `Could not answer it: ${c.sayErr(e).why}` }); }
  if (L.card?.key === `o${id}`) settle();
  redraw();
  setTimeout(() => { L.said.delete(`o${id}`); offersLoad(); }, SAID_MS);
}
async function offerUndo(id) {
  try { await post(`/api/peers/offers/${id}`, { undo: true }); } catch (e) { c.toast("Could not take it back", { sub: c.sayErr(e).why }); return; }
  L.said.delete(`o${id}`);
  offersLoad();
}

/* ---------- the chime ---------- */

/** What waits on the reader rings: a soft two-note chime, and in the
 *  desktop window, when it is not the one in front, the taskbar's quiet
 *  nudge, which a click on the window clears. News is silent. `what` is
 *  what rang, kept for On you's tip: a sound with nothing to look up after
 *  it was a mystery (#190). */
function ring(what) {
  if (what && chimeOn()) chimedLast = { what, at: Date.now() };
  chime();
  if (!document.hasFocus()) window.__TAURI_INTERNALS__?.invoke("plugin:window|request_user_attention", { label: "main", value: { type: "Informational" } }).catch(() => {});
}

let chimedLast = null;
/** "Last chime: …, 3 min ago", after `sep`, for a tip; nothing before one. */
function chimedLine(sep = "") {
  if (!chimedLast) return "";
  const s = Math.round((Date.now() - chimedLast.at) / 1000), w = chimedLast.what;
  const ago = s < 60 ? "just now" : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
  return `${sep}Last chime: ${w.length > 80 ? `${w.slice(0, 79)}…` : w}, ${ago}`;
}

/** The chime's own switch (#190), "Chime when something waits on you", in
 *  ⌘K and the mark's menu (palette.js, menu.js), which set `snyvi.chime`
 *  and say `snyvi:chime`. It was the quiet mascot's, which no one read as
 *  mute; a reader who had the mascot quiet, and so no chime, keeps none. */
function chimeOn() {
  const v = c.store.get("snyvi.chime");
  return v ? v === "1" : document.documentElement.dataset.mascot !== "quiet";
}

/** Made here rather than loaded: quiet, short, and only with its switch on.
 *  A page may sound only after the reader has clicked in it; before that the
 *  card still rises, silently. */
let audio = null;
function chime() {
  if (!chimeOn()) return;
  try {
    audio ||= new AudioContext();
    if (audio.state === "suspended") audio.resume().catch(() => {});
    const t = audio.currentTime;
    for (const [hz, at] of [[880, 0], [1318.5, 0.1]]) {
      const o = audio.createOscillator(), g = audio.createGain();
      o.type = "sine"; o.frequency.value = hz;
      g.gain.setValueAtTime(0.0001, t + at);
      g.gain.exponentialRampToValueAtTime(0.05, t + at + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + at + 0.22);
      o.connect(g).connect(audio.destination);
      o.start(t + at); o.stop(t + at + 0.24);
    }
  } catch {}
}
