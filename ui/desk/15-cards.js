/* ui/desk/15-cards.js: a part of desk.js, one module. build.rs joins ui/desk/*.js in name
 * order (src/strip.rs `source`); SNYVI_UI_DIR serves the same join. */
// ---------- the cards above the rail's foot (#162) ----------
/*
 * The focused panel's passing word: a link to where its work can be seen (a
 * preview, a deploy, its PR) or one line on where it is ("Building 3/7"),
 * each for as long as it says. An agent puts them there with show_card
 * (`crate::card`, they come in the pane's status); the PR card snyvi works
 * out for itself from the panel's thread, so an agent never has to.
 *
 * Where they live is the point. The rail's foot is a fixed band (#163), and
 * the cards stand on it, over the bottom of the list, rather than in the
 * list's flow: a card coming or going moves no row of the rail. The list
 * always ends in room for three of them, so its last line can be scrolled
 * clear. They rise from *behind* the foot -- it is opaque and in front --
 * on a spring, and sink back behind it when their time is up, the
 * panel's focus moves, or the agent takes them off. The newest is nearest
 * the foot; three show, and the third counts the rest.
 *
 * Every card has a ✕ (1.43): on a hover or the keyboard's focus the host
 * at its right end gives way to it in the same box, so nothing moves. A
 * click leaves an Undo where the card was for a few seconds, and the
 * daemon keeps the card closed for that panel's session (`closed` in the
 * pane's status), so every window agrees and an agent putting the same card
 * again does not bring it back. Nothing is deleted.
 *
 * They hold still for a pointer on its way to them (#189). With focus
 * following the pointer, a reader reaching from a panel across another
 * for a card ("PR #108 · checks failing") gave the focus to the panel
 * crossed, and the card was that panel's no more: it sank behind the foot
 * as the pointer got there. So the stack keeps the panel it shows for a
 * moment after the pointer takes another, and for as long as the pointer
 * is in the rail; and a card the pointer is on outlives its time until
 * the pointer leaves it.
 *
 * The spring is the one motion here that is not the page's quiet ease: the
 * maker asked for cards that land like something with weight. It is
 * transform and opacity only, on the compositor, so the panels' canvases
 * are never repainted for it, and nothing runs once a card has landed.
 */

const CARD_H = 30, CARD_GAP = 6, CARD_LIFT = 8, CARDS_SHOWN = 3;
/** How long the stack keeps the panel it shows after the pointer took
 *  another: long enough to cross into the rail, short enough that a reader
 *  who meant the new panel sees its cards as they settle in it. */
const CARDS_GRACE = 700;
/** Far enough down that a card is wholly behind the foot. */
const CARD_HIDE = CARD_H + CARD_LIFT + 4;

/** A spring of stiffness 260 and damping 21, as a `linear()` curve: one
 *  overshoot of about 6% and a soft settle, the way a card with some weight
 *  lands. A WebKit too old for `linear()` gets the page's one overshooting
 *  bezier instead. `window.CSS`: this module's own CSS is a stylesheet. */
const SPRING = (() => {
  if (!window.CSS?.supports?.("transition-timing-function", "linear(0, 1)")) return { ease: "cubic-bezier(.3,1.6,.5,1)", ms: 520 };
  let x = 0, v = 0, t = 0;
  const pts = [0], dt = 1 / 1000;
  for (let next = 1 / 120; t < 2;) {
    v += (260 * (1 - x) - 21 * v) * dt; x += v * dt; t += dt;
    if (t >= next) { pts.push(+x.toFixed(4)); next += 1 / 120; }
    if (t > .12 && Math.abs(1 - x) < .0012 && Math.abs(v) < .02) break;
  }
  pts.push(1);
  return { ease: `linear(${pts.join(", ")})`, ms: Math.round(t * 1000) };
})();
const stillPlease = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

let cardsEl = null, cardsPane = null, cardsTimer = 0, cardsUp = 0, cardsHoldTimer = 0;
/** The cards drawn, by panel, id and kind. */
const cardEls = new Map();

/** Where a forge keeps pull request `n` of the repository at `url`. */
function prUrl(url, n) {
  try {
    const h = new URL(url).hostname;
    return h === "gitlab.com" ? `${url}/-/merge_requests/${n}` : h === "bitbucket.org" ? `${url}/pull-requests/${n}`
      : h === "codeberg.org" ? `${url}/pulls/${n}` : `${url}/pull/${n}`;
  } catch { return null; }
}

/** How long a closed card's Undo stands where it was. */
const UNDO_MS = 5000;
/** Cards the reader closed here and the daemon has not said back yet, and
 *  the ones holding their Undo, by `pane:id`. */
const cardsShut = new Set(), cardUndo = new Map();

/** Panel `v`'s cards on desk `d`, oldest first: its thread's PR, worked out
 *  here, then what its agent showed, less what has run its time and what the
 *  reader closed -- unless it is still holding its Undo. The PR card is
 *  there only while the PR is open (1.43): a merged one said "merged" for
 *  twelve hours, and once said it before the merge it named (#167). The
 *  merge is told where it belongs -- the notes tick, the thread's row says
 *  it -- and a closed PR is not news for the foot. */
function cardsOf(d, v, onCard = false) {
  if (!v) return [];
  const out = [], now = Date.now() / 1000, t = paneThread(d, v.id), url = repoOf(d);
  const open = t && t.pr && (t.pr_state === "open" || (!t.pr_state && !t.merged));
  const pr = open && url && prUrl(url, t.pr);
  if (pr) {
    const ci = t.ci || "";
    out.push({ id: `pr-${t.id}-${t.pr}`, kind: "link", label: `PR #${t.pr} · ${ci ? `checks ${ci}` : "open"}`, url: pr,
      host: repoName(url)?.host || "", at: 0, life: 0, by: "snyvi, from this panel's thread",
      tone: /pass|success/i.test(ci) ? "ok" : /fail|error/i.test(ci) ? "bad" : "" });
  }
  // A card whose time is up stays while the pointer is on the stack.
  for (const c of v.status.cards || []) if (!c.for || now < c.at + c.for || (onCard && cardEls.has(`${v.id}:${c.id}:${c.kind}`))) out.push({ ...c, life: c.for || 0 });
  const closed = new Set(v.status.closed || []);
  return out.flatMap(c => {
    const k = `${v.id}:${c.id}`;
    if (cardUndo.has(k)) return [{ ...c, undo: true }];
    return closed.has(c.id) || cardsShut.has(k) ? [] : [c];
  });
}

/** What is inside a card: its mark, its words, where a link goes, and its
 *  ✕; or, closed a moment ago, its Undo in the same place. A link is the
 *  card's inside, not the card, so the ✕ beside it is a button of its own. */
function cardFill(el, c) {
  const { esc } = ctx;
  el.classList.toggle("shut", !!c.undo);
  if (c.undo) {
    el.innerHTML = `<span class="dk-card-in"><span class="dk-card-tx">Closed</span><button type="button" class="dk-card-undo" data-card="${esc(c.id)}">Undo</button></span>`;
    delete el.dataset.tip; delete el.dataset.tipSub;
    return;
  }
  const mark = c.kind === "link" ? `<span class="dk-card-ic" aria-hidden="true">↗</span>` : `<span class="dk-card-tone${c.tone ? ` ${c.tone}` : ""}" aria-hidden="true"></span>`;
  const inner = `${mark}<span class="dk-card-tx">${esc(c.label)}</span><span class="dk-card-host">${esc(c.host || "")}</span>`;
  el.innerHTML = (c.kind === "link" ? `<a class="dk-card-in" href="${esc(c.url)}" target="_blank" rel="noopener noreferrer">${inner}</a>` : `<span class="dk-card-in">${inner}</span>`) +
    `<button type="button" class="dk-card-x" data-card="${esc(c.id)}" aria-label="Close card: ${esc(c.label)}" data-tip="Close" data-tip-sub="Undo for a few seconds; nothing is deleted">${ico("x")}</button>`;
  el.dataset.tip = c.label;
  el.dataset.tipSub = [c.kind === "link" ? c.url : "", c.by || (c.life ? `for ${c.life}s` : "while this panel's session runs")].filter(Boolean).join(" · ");
  if (c.life) {
    const left = Math.max(0, c.at + c.life - Date.now() / 1000), bar = document.createElement("span");
    bar.className = "dk-card-drain";
    el.append(bar);
    bar.animate([{ transform: `scaleX(${left / c.life})` }, { transform: "scaleX(0)" }], { duration: left * 1000, easing: "linear", fill: "forwards" });
  }
}

/** A card's ✕ or its Undo. Closed at once here, then told to the daemon;
 *  a no puts it back, with the reason in the card's place. */
async function cardClick(e) {
  const b = e.target.closest(".dk-card-x, .dk-card-undo");
  if (!b) return;
  e.preventDefault(); e.stopPropagation();
  const d = current(), v = d && views.get(cardsPane);
  if (!v) return;
  const id = b.dataset.card, k = `${v.id}:${id}`, path = `/api/desks/${d.id}/panes/${v.id}/cards/${encodeURIComponent(id)}`;
  if (b.classList.contains("dk-card-x")) {
    cardsShut.add(k);
    clearTimeout(cardUndo.get(k));
    cardUndo.set(k, setTimeout(() => { cardUndo.delete(k); cards(); }, UNDO_MS));
    cards();
    cardsEl?.querySelector(".dk-card.shut .dk-card-undo")?.focus({ preventScroll: true });
    try { await ctx.api(`${path}/hide`, {}); }
    catch { cardsShut.delete(k); clearTimeout(cardUndo.get(k)); cardUndo.delete(k); cards(); ctx.toast("Could not close the card"); }
    return;
  }
  clearTimeout(cardUndo.get(k)); cardUndo.delete(k);
  cardsShut.delete(k);
  cards();
  try { await ctx.api(`${path}/show`, {}); }
  catch { cardsShut.add(k); cards(); ctx.toast("Could not bring the card back"); }
}

function cardMake(c) {
  const el = document.createElement("div");
  el.className = "dk-card";
  el.setAttribute("role", "listitem");
  cardFill(el, c);
  el.style.transform = `translateY(${CARD_HIDE}px)`;
  cardsEl.append(el);
  return el;
}

/** Card `el` to `y`, from wherever it is now -- mid-flight included -- on
 *  the spring, or on `ease` over `ms`. */
function cardMove(el, y, ease = SPRING.ease, ms = SPRING.ms) {
  const from = new DOMMatrixReadOnly(getComputedStyle(el).transform).m42;
  for (const a of el.getAnimations()) if (a.id === "move") a.cancel();
  el.style.transform = `translateY(${y}px)`;
  if (stillPlease() || Math.abs(from - y) < .5) return;
  el.animate([{ transform: `translateY(${from}px)` }, { transform: `translateY(${y}px)` }], { duration: ms, easing: ease }).id = "move";
}

function cardFade(el, to, ms) {
  const from = getComputedStyle(el).opacity;
  for (const a of el.getAnimations()) if (a.id === "fade") a.cancel();
  el.style.opacity = to;
  const a = el.animate([{ opacity: from }, { opacity: to }], { duration: stillPlease() ? 150 : ms, easing: "ease-out" });
  a.id = "fade";
  return a;
}

/** Up from behind the foot, to where it stands now. */
function cardIn(el) {
  if (!el.isConnected || el.$out) return;
  el.$up = true;
  cardMove(el, el.$y);
  cardFade(el, 1, 200);
}

/** Back down behind the foot, and gone. */
function cardOut(k, el, swap) {
  cardEls.delete(k);
  el.$out = true;
  const ms = swap ? 180 : 220;
  cardMove(el, CARD_HIDE, "cubic-bezier(.4,0,1,1)", ms);
  cardFade(el, 0, ms).finished.then(() => el.remove(), () => {});
}

/** The third card counts the ones behind it, and names them in its tip. */
function cardMore(el, rest) {
  let m = el.querySelector(".dk-card-more");
  if (!rest.length) { m?.remove(); return; }
  if (!m) { m = document.createElement("span"); m.className = "dk-card-more"; el.append(m); }
  m.textContent = `+${rest.length}`;
  m.dataset.tip = rest.map(c => c.label).join(" · ");
}

/** The stack, brought to what the focused panel holds: what left sinks,
 *  what came rises (a burst one after another, bottom first), what moved
 *  springs to its new place, and a card updated in place is only rewritten.
 *  Called with the foot's line (`meta`), so on every frame of the focused
 *  panel and every redraw of the rail; a call that changes nothing touches
 *  nothing. */
function cards() {
  const d = current(), held = cardsHeld(), v = d ? views.get(held && views.get(cardsPane) ? cardsPane : focused) : null;
  // Looked at again while held, so the stack follows the focus once the
  // pointer has gone back to the panels.
  clearTimeout(cardsHoldTimer);
  if (held) cardsHoldTimer = setTimeout(cards, 300);
  if (!cardsEl || !cardsEl.isConnected) {
    cardsEl = Object.assign(document.createElement("div"), { id: "dk-cards" });
    cardsEl.setAttribute("role", "list");
    cardsEl.setAttribute("aria-label", "Cards");
    cardsEl.addEventListener("click", cardClick);
    ctx.metaEl.before(cardsEl);
  }
  const onCard = !!document.querySelector("#dk-cards .dk-card:hover");
  const list = d ? cardsOf(d, v, onCard) : [], shown = list.slice(-CARDS_SHOWN).reverse();
  const swap = cardsPane !== (v ? v.id : null);
  cardsPane = v ? v.id : null;
  const key = c => `${v.id}:${c.id}:${c.kind}`, want = new Set(shown.map(key));
  for (const [k, el] of cardEls) if (!want.has(k)) cardOut(k, el, swap);
  let rising = 0;
  shown.forEach((c, i) => {
    const k = key(c), y = -i * (CARD_H + CARD_GAP), sig = JSON.stringify([c.label, c.url, c.host, c.tone, c.at, c.life, !!c.undo]);
    let el = cardEls.get(k);
    if (!el) {
      el = cardMake(c);
      cardEls.set(k, el);
      el.$y = y; el.$sig = sig;
      setTimeout(() => cardIn(el), (swap ? 120 : 0) + rising++ * 60);
    } else {
      if (el.$sig !== sig) { cardFill(el, c); el.$sig = sig; }
      if (el.$y !== y) { el.$y = y; if (el.$up) cardMove(el, y); }
    }
    cardMore(el, i === shown.length - 1 ? list.slice(0, -CARDS_SHOWN) : []);
  });
  // The corner stands on the cards: it moves when their count does.
  if (shown.length !== cardsUp) { cardsUp = shown.length; if (oyEl?.isConnected) oyPlace(oyEl); }
  // The next card whose time runs out takes itself off then.
  clearTimeout(cardsTimer);
  const next = Math.min(...list.filter(c => c.life && !c.undo).map(c => c.at + c.life));
  if (Number.isFinite(next)) cardsTimer = setTimeout(cards, Math.max(onCard ? 300 : 0, next * 1000 - Date.now()) + 50);
}

/** Whether the stack keeps the panel it shows (#189): only when the focus
 *  went to another panel by the pointer, not a click or a key; then a
 *  moment after, the pointer crossing that panel on its way here, and for
 *  as long as the pointer is in the rail, on a card or on On you. */
function cardsHeld() {
  if (!cardsPane || cardsPane === focused || focused !== hvFocusId) return false;
  return performance.now() - hvFocusAt < CARDS_GRACE || !!(ctx.rail?.matches(":hover") || document.querySelector("#dk-cards .dk-card:hover, #onyou:hover"));
}

/** How far above the foot the cards reach: where the On you corner stands. */
const cardsLift = () => cardsUp ? cardsUp * (CARD_H + CARD_GAP) - CARD_GAP + CARD_LIFT : 0;

/** Off the desk: no stack, no timer. */
function cardsDrop() {
  clearTimeout(cardsTimer); clearTimeout(cardsHoldTimer);
  for (const t of cardUndo.values()) clearTimeout(t);
  cardUndo.clear(); cardsShut.clear();
  cardEls.clear();
  cardsEl?.remove();
  cardsEl = null; cardsPane = null; cardsUp = 0;
}

const CARDS_CSS = `
#dk-cards { position: absolute; left: 8px; right: 10px; bottom: var(--foot-h); height: 0; z-index: 1; pointer-events: none; }
:root:not([data-view="desk"]) #dk-cards { display: none; }
/* The list always ends in room for three cards, so its last line can be
 * scrolled clear of them; that room never changes, so nothing moves. */
:root[data-view="desk"] #toc { padding-bottom: calc(14px + 3 * 36px + 8px); }
.dk-card { position: absolute; left: 0; right: 0; bottom: 8px; height: 30px;
  border-radius: var(--r-md); background: var(--bg-raise); border: 1px solid var(--rule-2); box-shadow: var(--shadow-1);
  color: var(--fg-2); font-size: var(--fs-small); white-space: nowrap; pointer-events: auto; opacity: 0; }
.dk-card-in { display: flex; align-items: center; gap: 7px; height: 100%; padding: 0 10px; border-radius: inherit; color: inherit; text-decoration: none; }
.dk-card:has(a.dk-card-in:hover), .dk-card:has(a.dk-card-in:focus-visible) { border-color: var(--accent); color: var(--fg); }
a.dk-card-in:hover, a.dk-card-in:focus-visible { text-decoration: none; outline: none; }
.dk-card-ic { flex: none; color: var(--accent); }
.dk-card-tx { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
/* The host holds the card's right end, at least as wide as the ✕, which
 * takes its place on a hover or the keyboard's focus: one box, two faces,
 * crossed over, so the label never moves for it. Touch has no hover, so
 * there the ✕ is always shown. */
.dk-card-host { flex: none; min-width: 18px; margin-left: auto; text-align: right; font-family: var(--mono); font-size: var(--fs-micro); color: var(--fg-3); transition: opacity var(--dur-quick); }
.dk-card-x { position: absolute; top: 50%; right: 6px; width: 20px; height: 20px; margin-top: -10px; display: grid; place-items: center; padding: 0; border: 0; border-radius: var(--r-xs);
  background: var(--bg-raise); color: var(--fg-3); opacity: 0; transition: opacity var(--dur-quick); cursor: pointer; }
.dk-card-x svg { width: 11px; height: 11px; }
.dk-card-x:hover, .dk-card-x:focus-visible { color: var(--fg); background: var(--rule-2); }
.dk-card:hover .dk-card-x, .dk-card:focus-within .dk-card-x { opacity: 1; }
.dk-card:hover .dk-card-host, .dk-card:focus-within .dk-card-host { opacity: 0; }
@media (hover: none) { .dk-card .dk-card-x { opacity: 1; } .dk-card .dk-card-host { opacity: 0; } }
/* Closed a moment ago: its Undo, in the card's own place. */
.dk-card.shut { border-style: dashed; box-shadow: none; }
.dk-card.shut .dk-card-tx { color: var(--fg-3); }
.dk-card-undo { margin-left: auto; padding: 1px 8px; border: 0; border-radius: var(--r-xs); background: var(--rule); color: var(--fg); font-size: var(--fs-micro); font-weight: 600; cursor: pointer; }
.dk-card-undo:hover, .dk-card-undo:focus-visible { background: var(--rule-2); }
.dk-card-tone { flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--fg-3); }
.dk-card-tone.ok { background: var(--ok); }
.dk-card-tone.warn { background: var(--warn); }
.dk-card-tone.bad { background: var(--danger); }
/* Under way is a ring, not a colour: the accent can be any hue, and a
 * Crimson one filled in read as "bad". */
.dk-card-tone.run { background: none; box-shadow: inset 0 0 0 1.5px var(--fg-2); }
/* The time a card has left, draining right to left under it. */
.dk-card-drain { position: absolute; left: 10px; right: 10px; bottom: 3px; height: 1.5px; border-radius: var(--r-xs); background: var(--accent); opacity: .55; transform-origin: left center; pointer-events: none; }
.dk-card-more { position: absolute; top: -7px; right: 8px; padding: 0 6px; border-radius: var(--r-pill); background: var(--rule-2); color: var(--fg-2); font-size: var(--fs-micro); font-weight: 600; line-height: 14px; }
`;
