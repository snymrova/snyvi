/* ui/desk/10-onyou.js: a part of desk.js, one module. build.rs joins ui/desk/*.js in name
 * order (src/strip.rs `source`); SNYVI_UI_DIR serves the same join. */
// ---------- on you: what only the reader can do, in the rail's corner ----------
/*
 * Your turn was a block of cards at the top of the rail: fixed, in the
 * accent, and it came and went above the panels, so every question an agent
 * asked pushed the desk down and every answer pulled it back up. Half of
 * what it showed was Claude's own question dialog, already on screen in its
 * panel and answered there (audit e467fa057a).
 *
 * So it lives in a corner, floating, where nothing it does moves the page:
 * the rail's, at the rail's width, over the rail's own foot. The window's
 * bottom-right, where it was first, is the rightmost panel's, and the card
 * sat on Claude Code's prompt there (audit e0a854b732, U1). A turn new to
 * this page rises as a small card, with a soft chime; untouched for a few
 * seconds, or once the reader clicks elsewhere, it settles into the foot's
 * On you button, an icon and "2" at the right end of the rail's foot, which
 * opens the tray: every fresh turn, newest first, the older ones under them,
 * dimmed, with their age, and Suggested (1.43: an unanswered ask is on the
 * reader whatever its age, so "N older" was a fold and a pill too many).
 * Claude's own dialog never rises
 * (09-thread.js `shown`), and a turn that has gone quiet -- its panel
 * closed, half an hour old, or its panel prompted since -- never rises or
 * rings. With no rail in view (folded, or a narrow window) nothing rises
 * over a panel: the pill lights, in the window's corner.
 *
 * It is the one corner every page has (ui/corner.js, plan b0bca0a11f): the
 * look is corner.js's, and so are the cards that rise from outside -- a page
 * from another desk, an aside, a friend's word -- an agent's offer, which
 * is On you here too. Lately is not in the tray any more: it is every
 * desk's, so it is the sidebar's, which is every page's (1.43). This file
 * draws the rest where the desk's corner is, and hands their clicks back.
 *
 * 1.44 (#174, plan d5e4cee7a7). The button is the foot's, always there
 * and as wide with nothing on the reader as with twelve: a notch half over
 * the foot's rule, gone at nought and gone while the tray was open, was a
 * place no one looked. The tray asked for is wider than the rail (`wide`):
 * the rail's width is for what rises unasked, kept off Claude's prompt
 * (U1), and at it every card folded -- four-line titles, a command split
 * mid-word, two rows of buttons. A pinned tray stays at the rail's width,
 * since the reader works beside it. An older ask is one line until it is
 * opened, and a card an agent removed says who and why, with Bring back.
 */

/** How long a risen card stays before it settles into the pill. */
const RISE_MS = 8000;
/** The corner's state: the tray open; the turn
 *  risen as a card (its id, or its group's first id) and the one whose rise
 *  has been drawn; the hover that holds a card; the turns this page has
 *  seen, for this desk, so only a new one rises; the tray pinned open
 *  (#115); and where the focus was when the tray opened, to give it back. */
const oy = { empty: false, open: false, rise: 0, drawnRise: 0, timer: 0, hover: false, seen: null, at: null, pin: false, pinAt: null, back: null, inRail: false, more: 0, rang: 0, quiet: false };
/** Whether the last thing the reader did was a key: the tray opened with
 *  the pointer takes the focus without a ring (app.css .ring-quiet). */
let viaKey = false;
addEventListener("keydown", () => { viaKey = true; }, true);
addEventListener("pointerdown", () => { viaKey = false; }, true);
/** Arrivals this close together are one: one chime, and the card says the
 *  rest as "+N more" (U7). Four hand-overs in a second rang twice and
 *  showed only the last. */
const BURST_MS = 1500;
let oyEl = null;
/** The turns seen on each desk this page has been on (#116). Leaving a desk
 *  used to forget them, so a turn asked while the reader was on another desk
 *  or reading a document came back already counted and never rose: it sat in
 *  the pill, unsaid. Kept per desk, only a desk's first read learns quietly. */
const oySeen = new Map();

/** A tray pinned open stays open on this desk while the reader works in its
 *  panels (#115): remembered in this browser, per desk, as a convenience. */
const PIN_KEY = "snyvi.onyou.pin";
function pinned(id) {
  try { return (JSON.parse(localStorage.getItem(PIN_KEY) || "[]") || []).includes(id); } catch { return false; }
}
function setPinned(id, on) {
  oy.pin = on;
  try {
    const all = (JSON.parse(localStorage.getItem(PIN_KEY) || "[]") || []).filter(x => x !== id);
    if (on) all.push(id);
    localStorage.setItem(PIN_KEY, JSON.stringify(all));
  } catch {}
}

/** The corner's element, made once a desk draws it, at the toast's level. */
function oyNode() {
  if (oyEl && oyEl.isConnected) return oyEl;
  oyEl = document.createElement("div");
  oyEl.id = "onyou";
  oyEl.className = "oy";
  oyEl.setAttribute("role", "region");
  oyEl.setAttribute("aria-label", "On you");
  oyEl.addEventListener("click", click);
  // A question cut to its lines opens with Enter or Space, as a button would.
  oyEl.addEventListener("keydown", e => {
    if ((e.key === "Enter" || e.key === " ") && e.target.matches?.('.tn-q[data-a="tn-more"]')) { e.preventDefault(); e.target.click(); }
  });
  // The first key in it brings the focus ring back.
  oyEl.addEventListener("keydown", () => { if (oy.quiet) { oy.quiet = false; oyEl.querySelector(".ring-quiet")?.classList.remove("ring-quiet"); } });
  oyEl.addEventListener("mouseenter", () => { oy.hover = true; });
  oyEl.addEventListener("mouseleave", () => { oy.hover = false; });
  document.body.append(oyEl);
  return oyEl;
}

/** What the notch counts: fresh waiting turns, suggestions and an agent's
 *  offers, which are in amber; and the older ones, which are not. */
function oyCounts(d, f) {
  const waiting = f.turns.filter(w => shown(w) && !w.answered_at);
  const now = waiting.filter(w => fresh(d, w)).length;
  return { now: now + f.suggestions.length + (ctx.corner?.()?.offerCount() || 0), old: waiting.length - now };
}

/** On you in the rail's foot (1.44): the icon, and the count while anything
 *  waits -- amber while something is fresh. Its box is one width whatever
 *  the count, so the links beside it never move (#163). It opens the tray,
 *  and says so while the tray is open. */
function oyFoot(d) {
  const n = oyCounts(d, filedNow(d)), count = n.now + n.old;
  const label = !count ? "Nothing on you right now" : `${count} on you${n.now && n.old ? `, ${n.old} of them older` : !n.now ? ", all older" : ""}`;
  // What On you is, always, then how it stands: with nothing on the reader
  // the tip said only that, and a first hover never learned what it was for.
  const sub = `What only you can do on this desk · ${n.now ? "new" : count ? "older asks waiting" : "nothing right now"}`;
  return `<button type="button" class="oy-foot${n.now ? " on" : ""}${count ? "" : " none"}" data-a="oy-open" aria-expanded="${oy.open}" aria-label="${label}" data-tip="On you" data-tip-sub="${sub}" data-key="ctrl+alt+y">${oyIco()}<span class="n">${count || ""}</span></button>`;
}

/** On you's mark, the hand, drawn by the corner (ui/corner.js `hand`),
 *  which the window loads with the desk. */
const oyIco = () => ctx.corner?.()?.hand?.() || "";

/** The pin, in the tray's head (#115): pinned, the tray stays open while
 *  the reader works in the panels, and a click elsewhere leaves it. The pill
 *  or Esc in it closes it, and unpins. On the head's line, not over the
 *  scrollbar, nor on the risen card, whose corner is its ✕ (U3, U4). */
const pinBtn = () => `<button type="button" class="oy-pin${oy.pin ? " on" : ""}" data-a="oy-pin" aria-pressed="${oy.pin}" aria-label="${oy.pin ? "Unpin" : "Pin open"}" data-tip="${oy.pin ? "Unpin" : "Pin open"}" data-tip-sub="${oy.pin ? "It closes again on a click elsewhere" : "Stays open while you work in the panels"}">${ico("pin")}</button>`;

/** The risen card: the one turn, as the tray would draw it, or its Undo
 *  once it was put away. Nothing, once it is answered and has nothing left
 *  to send, or gone from the list. */
function riseHtml(d, f, esc) {
  const w = f.turns.find(x => x.id === oy.rise || x.ask_group === oy.rise);
  const gone = filedGone && (filedGone.k === "w" || filedGone.k === "g") && filedGone.id === oy.rise ? filedGone : null;
  const body = gone ? goneRow(gone.k, gone.id, gone.text, esc)
    : !w || !shown(w) || (w.answered_at && !sendable.has(w.id) && !w.ask_group) ? "" : turnCard(d, f, w, esc);
  if (!body) return "";
  const first = oy.drawnRise !== oy.rise;
  oy.drawnRise = oy.rise;
  // What came with it, in the same burst: in the tray, a click away.
  const more = oy.more && !gone ? `<button type="button" class="oy-more" data-a="oy-open">+${oy.more} more</button>` : "";
  return `<div class="oy-card${first ? " rise" : ""}"><ul class="dk-turn-list" data-part="desk.turns">${body}</ul>${more}</div>`;
}

/** The tray, over the notch: under its head (On you, the pin, and its ✕),
 *  what is fresh, newest first, then the older ones, dimmed, each with its
 *  age, and Suggested. Older is not a fold of its own: an unanswered ask is
 *  on the reader however old it is, and the fold was one more thing to open
 *  before it could be answered. Each question is its title line and two
 *  lines of the rest here (`qClamp`), a click from the whole. */
function trayHtml(d, f, esc) {
  const gone = filedGone && (filedGone.k === "w" || filedGone.k === "g") ? goneRow(filedGone.k, filedGone.id, filedGone.text, esc) : "";
  qClamp = true;
  const rows = gone + turnRows(d, f, esc, false), old = turnRows(d, f, esc, true);
  qClamp = false;
  const said = rows ? `<ul class="dk-turn-list" data-part="desk.turns">${rows}</ul>` : "";
  const older = old ? `<ul class="cn-list cn-old oy-old" aria-label="Older" data-tip="Older" data-tip-sub="Its panel closed, asked over half an hour ago, or its panel was prompted since. It goes by itself after three days, and can come back">${old}</ul>` : "";
  const K = ctx.corner?.(), offers = K ? K.offersHtml() : "";
  const away = awayRows(f, esc);
  const all = said + older + (away ? `<ul class="cn-list oy-away" aria-label="Removed by agents">${away}</ul>` : "") +
    (offers ? `<ul class="dk-turn-list cn-list">${offers}</ul>` : "") + sugRows(f, d);
  const n = oyCounts(d, f), count = n.now + n.old;
  oy.empty = !all;
  const title = `<span class="oy-hi" aria-hidden="true">${oyIco()}</span><h3 class="oy-h" data-tip="On you" data-tip-sub="What only you can do on this desk. Your answer goes with your next message to the panel that asked">On you</h3>` +
    (count ? `<span class="sec-n${n.now ? " warn" : ""}">${count}</span>` : "");
  const close = `<button type="button" class="oy-x" data-a="oy-open" aria-label="Close" data-tip="Close" data-tip-sub="Esc" data-key="ctrl+alt+y">${ico("x")}</button>`;
  // Nothing to keep open beside the panels, so no pin, unless it is pinned.
  const head = `<div class="oy-head">${title}<span class="oy-gap"></span>${all || oy.pin ? pinBtn() : ""}${close}</div>`;
  return `<div class="oy-tray${oy.quiet ? " ring-quiet" : ""}" role="dialog" aria-label="On you" tabindex="-1">${head}<div class="oy-scroll">${all || `<p class="oy-none">Nothing on you right now.</p>`}</div></div>`;
}

/** Where the corner sits: in the rail's column, at its width, its foot just
 *  above the rail's foot (its repository and links, `ctx.metaEl`),
 *  so it covers neither a panel nor the foot (U1, U2). With no rail in
 *  view -- folded to its strip, hidden, or a sheet on a narrow window -- the
 *  window's corner, and nothing rises there (`arrived`). */
function oyPlace(el) {
  const r = ctx.rail, rr = r && r.offsetParent && r.getBoundingClientRect();
  oy.inRail = !!rr && rr.width >= 180 && getComputedStyle(r).position !== "fixed";
  el.classList.toggle("in-rail", oy.inRail);
  if (!oy.inRail) return;
  // It stands on the cards when there are any (15-cards.js), on the foot when not.
  const m = ctx.metaEl?.getBoundingClientRect(), foot = (m && m.height ? m.top : rr.bottom) - cardsLift();
  el.style.setProperty("--oy-l", `${Math.round(rr.left + 8)}px`);
  el.style.setProperty("--oy-w", `${Math.round(rr.width - 16)}px`);
  el.style.setProperty("--oy-b", `${Math.round(innerHeight - foot + 6)}px`);
  el.style.setProperty("--oy-max", `${Math.max(160, Math.round(foot - rr.top - 40))}px`);
  // The tray asked for may be wider than the rail: it grows away from the
  // window's edge the rail is nearer, over the panels, never past the
  // window. A rail on the right grew into the edge and stayed 208 px wide.
  const right = rr.left + rr.width / 2 > innerWidth / 2;
  el.classList.toggle("from-r", right);
  el.style.setProperty("--oy-r", `${Math.round(innerWidth - rr.right + 8)}px`);
  el.style.setProperty("--oy-wmax", `${Math.max(0, Math.round(right ? rr.right - 24 : innerWidth - rr.left - 24))}px`);
}
addEventListener("resize", () => { if (oyEl?.isConnected) oyPlace(oyEl); });

/** The corner, drawn after the rail: the tray or the risen card, and the
 *  pill under them. Not there at all while nothing is on the reader. A desk
 *  whose tray was pinned opens with it open. */
function onYou(d) {
  const f = filedNow(d), { esc } = ctx, n = oyCounts(d, f);
  if (oy.pinAt !== d.id) { oy.pinAt = d.id; oy.pin = pinned(d.id); oy.open ||= oy.pin; }
  const el = oyNode();
  oyPlace(el);
  // Every draw asks what is new, not only a read of the list: a turn read
  // while the desk was out of view -- Home, a document -- rises when it is
  // back in view (#116). Only once this desk's list is in, or its first read
  // would learn an empty list and every waiting turn would rise.
  if (filedAt === d.id) arrived(d);
  if (oy.rise && oy.open) { oy.rise = 0; oy.more = 0; }
  const card = oy.rise ? riseHtml(d, f, esc) : "";
  if (oy.rise && !card) { oy.rise = 0; oy.more = 0; clearTimeout(oy.timer); }
  const tray = oy.open ? trayHtml(d, f, esc) : "";
  // Wide for what it holds; an empty tray says so at the rail's width.
  el.classList.toggle("wide", oy.open && !oy.pin && !oy.empty);
  // What came from outside rises here too, over a turn's card never.
  const K = ctx.corner?.(), news = K && !tray && !card ? K.cardHtml(true) : "";
  // In the rail it is the foot's button (`oyFoot`). With no rail in view
  // it is the pill in the window's corner, as before, and not there at all
  // while nothing is on the reader.
  const count = n.now + n.old;
  const label = `${count} on you${n.now && n.old ? `, ${n.old} of them older` : !n.now ? ", all older" : ""}`;
  const pill = !tray && count && !oy.inRail
    ? `<button type="button" class="oy-pill${n.now ? " on" : ""}" data-a="oy-open" aria-expanded="false" aria-label="${label}" data-tip="On you" data-tip-sub="${n.now ? "What only you can do on this desk" : "Older asks, still waiting on you"}" data-key="ctrl+alt+y">${oyIco()}<span class="n">${count}</span></button>` : "";
  // A redraw replaces every button: the one the keyboard was on gets the
  // focus back, by what it does and to which row, or a press on a card
  // button dropped the hand to the page's body (W24).
  const was = el.contains(document.activeElement) && document.activeElement.dataset?.a ? keyOf(document.activeElement) : "";
  drawing = true;
  const drew = drawIn(el, news + card + tray + pill);
  drawing = false;
  if (drew && was && !el.contains(document.activeElement)) el.querySelector(was)?.focus({ preventScroll: true });
  // The corner's toasts sit above it while it shows, not on it (toast.js,
  // whose own foot is 20 px up from the window's).
  const top = el.offsetHeight ? el.getBoundingClientRect().top : innerHeight;
  document.documentElement.style.setProperty("--oy-h", el.offsetHeight ? `${Math.max(0, Math.round(innerHeight - top - 20 + 8))}px` : "0px");
  if (drew) threadFocus(el);
}

/** A button's selector by what it does and which row it is on. */
function keyOf(b) {
  const ds = b.dataset, esc = window.CSS.escape;
  return `[data-a="${esc(ds.a)}"]` + ["w", "s", "g", "v", "f"].filter(k => ds[k] != null).map(k => `[data-${k}="${esc(ds[k])}"]`).join("");
}

/** A read of this desk's turns: one new to this page, fresh and not
 *  Claude's own dialog, rises with a chime -- over the pill, whatever it
 *  says (#116). The first read of a desk on this page only learns what is
 *  there -- what was waiting before is the pill's to say; after that a turn
 *  asked while the reader was elsewhere rises when they come back. In an
 *  open tray it does not rise -- it is drawn there already -- but it still
 *  rings, since a pinned tray is open while the reader works. */
function arrived(d) {
  const waiting = filed.turns.filter(w => shown(w) && !w.answered_at);
  if (oy.at !== d.id || !oy.seen) {
    oy.at = d.id;
    oy.seen = oySeen.get(d.id);
    if (!oy.seen) { oySeen.set(d.id, oy.seen = new Set(waiting.map(w => w.id))); return; }
  }
  const fresh_ = waiting.filter(w => !oy.seen.has(w.id) && fresh(d, w));
  for (const w of waiting) oy.seen.add(w.id);
  if (!fresh_.length) return;
  const w = fresh_[fresh_.length - 1];
  // Said, for a reader of the screen, in the desk's own live region (U8).
  const n = slotOf(d, w.pane);
  announce(w.kind === "due" ? `Due now: ${w.text}` : w.kind === "tell" ? w.text : `${n ? `Panel ${n}` : "An agent"} ${w.kind === "decide" ? "asks" : "hands you"}: ${w.text}`);
  // One chime for a burst, and the card's "+N more" counts the rest (U7):
  // cards, so a card of four questions is one.
  const burst = Date.now() - oy.rang < BURST_MS;
  if (!burst) ring();
  oy.rang = Date.now();
  if (oy.open || !oy.inRail) return;
  const cards = new Set(fresh_.map(x => x.ask_group || x.id)).size;
  oy.more = burst && oy.rise ? oy.more + cards : cards - 1;
  oy.rise = w.ask_group || w.id;
  oy.drawnRise = 0;
  riseFor(RISE_MS);
}

/** The card settles into the pill after `ms`: held while the cursor is on
 *  it, or a field in it is open, and while the page is out of sight -- a
 *  turn that rose in a minimised window had settled before anyone saw it,
 *  so it waits for the page to show (`visibilitychange` below). */
function riseFor(ms) {
  clearTimeout(oy.timer);
  oy.timer = setTimeout(() => {
    if (document.hidden) return;
    if (oy.hover || (thField && oyEl?.querySelector(".th-in"))) return riseFor(1500);
    settle();
  }, ms);
}
document.addEventListener("visibilitychange", () => { if (!document.hidden && oy.rise) riseFor(RISE_MS); });
function settle() {
  clearTimeout(oy.timer);
  if (!oy.rise) return;
  oy.rise = 0; oy.more = 0;
  if (current()) rail();
}

/** The pill: the tray opens over it, or closes. */
function oyToggle() {
  if (oy.open) return oyClose(true);
  const at = document.activeElement;
  oy.back = at && !oyEl?.contains(at) ? at : null;
  oy.open = true; oy.rise = 0; oy.quiet = !viaKey; clearTimeout(oy.timer);
  rail();
  oyEl?.querySelector(".oy-tray")?.focus({ preventScroll: true });
}
/** The tray asked for from outside the desk's own buttons: a desktop
 *  notification's click (`#onyou`), ⌘K. */
export function openTray() { if (!oy.open && current()) oyToggle(); }
/** The pin: on, the tray opens if it was a risen card, and stays; off, it
 *  stays open until a click elsewhere, as an unpinned tray does. */
function oyPin(d) {
  setPinned(d.id, !oy.pin);
  if (oy.pin && !oy.open) { oy.open = true; oy.rise = 0; clearTimeout(oy.timer); }
  rail();
  oyEl?.querySelector(".oy-pin")?.focus({ preventScroll: true });
}
/** Closed: by Esc or the pill, the focus goes back where it was, and a pin
 *  comes off -- closing it is saying so; by a click elsewhere, it stays
 *  where that click put it. */
function oyClose(back) {
  if (back && oy.pin) setPinned(deskId, false);
  oy.open = false; oldOpen.clear();
  if (current()) rail();
  if (back && oy.back?.isConnected) oy.back.focus({ preventScroll: true });
  oy.back = null;
}

// A press anywhere else settles a risen card and closes the tray, unless it
// is pinned; Esc closes the tray before the desk's own keys see it -- a
// pinned one only from inside it, so Esc in a panel still reaches the panel.
document.addEventListener("pointerdown", e => {
  if (!oyEl?.isConnected || oyEl.contains(e.target) || e.target.closest?.(".oy-foot")) return;
  if (oy.open) { if (!oy.pin) oyClose(false); }
  else if (oy.rise && !(thField && oyEl.querySelector(".th-in"))) settle();
}, true);
document.addEventListener("keydown", e => {
  // Ctrl+Alt+Y ("you") opens and closes the tray from anywhere on the desk,
  // a panel's keys included: before the panel's own handler, so nothing of
  // it is typed there (U8).
  if (e.code === "KeyY" && e.ctrlKey && e.altKey && !e.metaKey && !e.shiftKey && !altGr(e) && oyEl?.isConnected && current()) {
    e.preventDefault(); e.stopPropagation(); oyToggle(); return;
  }
  if (e.key !== "Escape" || !oy.open || !oyEl?.isConnected) return;
  if (oy.pin && !oyEl.contains(document.activeElement)) return;
  e.preventDefault(); e.stopPropagation();
  oyClose(true);
}, true);

/** Leaving the desk: the corner goes with it, to be the page's own again
 *  (ui/corner.js). What it has seen stays, in `oySeen`, and the pin, in
 *  this browser. */
function forgetOnYou() {
  clearTimeout(oy.timer);
  Object.assign(oy, { open: false, rise: 0, drawnRise: 0, hover: false, seen: null, at: null, pin: false, pinAt: null, back: null, more: 0 });
  oyEl?.remove(); oyEl = null;
  document.documentElement.style.setProperty("--oy-h", "0px");
}

/** A new turn's sound, and the taskbar's nudge in a window not in front:
 *  the corner's, one chime for every page (ui/corner.js `ring`). */
function ring() { ctx.corner?.()?.ring(); }

const ONYOU_CSS = `
/* In the rail's column (oyPlace): its width, its foot above the rail's own
   last lines; the card and the tray as wide as the column. */
.oy.in-rail { left: var(--oy-l); right: auto; bottom: var(--oy-b); width: var(--oy-w); align-items: stretch; }
.oy.in-rail > .oy-card, .oy.in-rail > .oy-tray { width: auto; }
/* The tray asked for (oy.open, not pinned): wide enough for a command's
   line and buttons with their words, over the edge of the first panel while
   it is open, never past the window. */
.oy.in-rail.wide { width: min(max(var(--oy-w), 360px), var(--oy-wmax)); }
.oy.in-rail.wide.from-r { left: auto; right: var(--oy-r); }
/* As tall as what it holds, to a ceiling, then it scrolls. */
.oy.in-rail.wide .oy-scroll { max-height: min(calc(70vh - 40px), 520px, calc(var(--oy-max) - 40px)); }
/* On you in the rail's foot (oyFoot): one width whatever the count, so the
   links beside it hold still. Amber while something is fresh, quiet ink
   when only older asks wait, and with nothing the quiet ink alone: dimmed
   below it, it read as switched off, and fell to 2.1:1. As tall as the
   repository's button beside it. */
#meta .oy-foot { flex: none; display: inline-flex; align-items: center; justify-content: flex-end; gap: 3px; min-width: 38px; height: 26px; margin-left: auto; padding: 0 6px; border: 0; border-radius: var(--r-sm); background: none; color: var(--fg-3); font-size: var(--fs-micro); font-variant-numeric: tabular-nums; cursor: pointer; }
#meta .oy-foot svg { width: 13px; height: 13px; }
#meta .oy-foot .n { min-width: 2ch; text-align: left; font-weight: 600; color: var(--fg-2); }
#meta .oy-foot.on, #meta .oy-foot.on .n { color: var(--warn); }
#meta .oy-foot:hover, #meta .oy-foot:focus-visible, #meta .oy-foot[aria-expanded="true"] { background: var(--rule); color: var(--fg); opacity: 1; }
.oy-hi { display: grid; place-items: center; width: 14px; margin-right: 4px; color: var(--fg-3); }
.oy-hi svg { width: 13px; height: 13px; }
.oy.in-rail .oy-scroll { max-height: calc(var(--oy-max) - 40px); }
/* The card that rises: one turn, small. Its question is said whole (#114):
   cut at two lines, a key's steps ended in "then..." with no way to read on.
   A long one scrolls in its card rather than push the card off the screen. */
.oy-card > .dk-turn-list { margin: 0; }
.oy-card .tn-q { max-height: 9.6em; overflow-y: auto; overflow-wrap: anywhere; }
.oy.in-rail .oy-card .tn-q { max-height: 16em; }
.oy-more { display: block; width: 100%; padding: 3px 8px; border: 1px solid var(--rule); border-top: 0; border-radius: 0 0 var(--r-sm) var(--r-sm); background: var(--bg-raise); font-size: var(--fs-micro); color: var(--fg-2); text-align: left; }
.oy-more:hover { color: var(--fg); }
/* The tray's look is corner.js's: its head (On you, and the pin) stays;
   the rest scrolls under it. */
/* In the tray a turn is a row, ruled off from the next, not a card in the
   tray's box: a box in a box, at the rail's width, wrapped its answers onto
   two lines. The risen card, alone over the rail, keeps its card. */
.oy-tray .dk-turn-list { gap: 0; margin: 0; }
.oy-tray .dk-turn, .oy-tray .dk-sugcard { padding: 8px 0; border: 0; border-radius: 0; background: none; }
.oy-tray .dk-turn-list > li + li, .oy-tray .dk-turn-list + .dk-turn-list > li:first-child { border-top: 1px solid var(--rule); }
.oy-tray .dk-turn:not(.grp) > .tn-acts > .tn-x, .oy-tray .tn-gx { top: 6px; right: -4px; }
.oy-pin { display: grid; place-items: center; flex: none; width: 20px; height: 20px; border: 0; border-radius: var(--r-xs); background: none; color: var(--fg-3); cursor: pointer; }
.oy-pin:hover { background: var(--rule-2); color: var(--fg); }
.oy-pin.on { color: var(--accent); }
.oy-pin.on svg { fill: currentColor; }
/* Older asks, under the fresh ones: dimmed, their age in their own line. */
.oy-tray .oy-old > li { opacity: .72; }
.oy-tray .oy-old > li:hover, .oy-tray .oy-old > li:focus-within { opacity: 1; }
.oy-tray .dk-turn-list + .oy-old > li:first-child { border-top: 1px solid var(--rule); }
/* An older ask and a card an agent removed are the corner's log rows (corner.js
   .cn-row): the title, then where and when, quiet (09-thread.js olderLine,
   awayRows). Removed says who and why under its title, and may take two
   lines for it. */
.oy-tray .cn-list { padding: 0 8px 0 0; }
.oy-tray .cn-list > li { opacity: .72; }
.oy-tray .cn-list > li:is(:hover, :focus-within) { opacity: 1; }
.oy-tray .dk-turn-list + .cn-list > li:first-child, .oy-tray .cn-list + .cn-list > li:first-child { border-top: 1px solid var(--rule); }
.oy-away .cn-bl { white-space: normal; }
.oy-away .cn-tl > .tn-opt { flex: none; }
.oy .dk-note.gone { list-style: none; display: flex; align-items: center; gap: 6px; border: 1px dashed var(--rule-2); background: var(--bg-raise); }
`;
