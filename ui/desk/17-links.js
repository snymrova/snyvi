/* ui/desk/17-links.js: a part of desk.js, one module. build.rs joins ui/desk/*.js in name
 * order (src/strip.rs `source`); SNYVI_UI_DIR serves the same join. */
// ---------- the desk's links, in the rail's foot (#162, 1.43) ----------
/*
 * Where this desk's work lives on the web -- the live site, a staging
 * deploy, a dashboard -- one click away in the rail's foot, beside the
 * repository. An agent pins them (MCP `pin_link`, `crate::links`); they are
 * the desk's and stay, where a card (15-cards.js) is a panel's passing word
 * and goes with its session.
 *
 * The foot used to hold the focused panel's line, `[1] Opus · 242k / 1M ·
 * working 46s`: every figure in it was said again in the panel's head, and
 * the model's name clipped to "C" in a narrow rail. Claude says it now,
 * under its own prompt (`snyvi statusline`), and the foot is the desk's
 * doorways (plan 720260bb53).
 *
 * The foot's height is set (#163), so a link coming or going moves nothing
 * above it. As many links show as fit whole, newest first; the rest are
 * under a +N, a menu like any other. A link's ✕ takes the ↗'s place on a
 * hover or the keyboard's focus, in the same box; a click leaves Undo where
 * the link was, and the daemon keeps it hidden. Nothing is deleted.
 */

/** How long a link taken out holds its Undo. */
const LK_UNDO_MS = 5000;
/** Links taken out here and holding their Undo, by `desk:id`. */
const lkUndo = new Map();
/** How many chips fit whole, as last measured, and what was measured. */
let lkFit = Infinity, lkKey = "", lkSeen = null;

/** Desk `d`'s links to show, newest first: the ones not taken out, and the
 *  ones holding their Undo. */
function linksOf(d) {
  return (d.links || []).filter(l => !l.hidden || lkUndo.has(`${d.id}:${l.id}`)).sort((a, b) => b.at - a.at || b.id - a.id);
}

/** One link in the foot; or, taken out a moment ago, its Undo in its place.
 *  The link is the chip's inside, so its ✕ is a button of its own. */
function linkChip(d, l) {
  const { esc } = ctx;
  // Its words stay, unseen, to hold its width: the chips beside it do not
  // move while the Undo stands.
  if (lkUndo.has(`${d.id}:${l.id}`)) return `<span class="dk-lk shut"><span class="dk-lk-in" aria-hidden="true"><span class="dk-lk-tx">${esc(l.label)}</span><span class="dk-lk-ic">↗</span></span>` +
    `<button type="button" class="dk-lk-undo" data-lk="${l.id}" aria-label="Bring back ${esc(l.label)}">Undo</button></span>`;
  const sub = [l.url, l.by && `pinned by ${l.by}`].filter(Boolean).join(" · ");
  return `<span class="dk-lk"><a class="dk-lk-in" href="${esc(l.url)}" target="_blank" rel="noopener noreferrer" data-lk="${l.id}" data-tip="${esc(l.label)} · ${esc(l.host)}" data-tip-sub="${esc(sub)}">` +
    `<span class="dk-lk-tx">${esc(l.label)}</span><span class="dk-lk-ic" aria-hidden="true">↗</span></a>` +
    `<button type="button" class="dk-lk-x" data-lk="${l.id}" aria-label="Take ${esc(l.label)} out of the foot" data-tip="Take out" data-tip-sub="Undo for a few seconds; nothing is deleted">${ico("x")}</button></span>`;
}

/** The foot's links: the chips that fit, and +N for the rest. */
function linksHtml(d) {
  const ls = linksOf(d);
  if (!ls.length) return "";
  const n = Math.min(ls.length, lkFit), more = ls.length - n;
  return `<span class="dk-lks">${ls.slice(0, n).map(l => linkChip(d, l)).join("")}</span>` +
    (more ? `<button type="button" class="dk-lk-more" data-tip="${more} more" aria-haspopup="menu" aria-label="${more} more links">+${more}</button>` : "");
}

/** What the fit depends on: the desk, its links' words, and the Undos. */
const linksKey = d => `${d.id}|${linksOf(d).map(l => `${l.id}:${l.label}:${lkUndo.has(`${d.id}:${l.id}`) ? 1 : 0}`).join(",")}`;

/** The foot drawn with `head`, then as many chips as fit whole -- all of
 *  them, then one fewer with a +N, until the row does not overflow; `tail`
 *  is whatever stands after them, nothing since On you's button went to
 *  the head (1.69). Measured only when
 *  the links or the rail's width change, not on a panel's every tick. */
function linksDraw(el, d, head, tail = "") {
  const key = linksKey(d);
  if (key !== lkKey) { lkKey = key; lkFit = Infinity; }
  if (lkFit !== Infinity || !el.clientWidth) { drawIn(el, head + linksHtml(d) + tail); return; }
  for (let n = linksOf(d).length; n >= 0; n--) {
    lkFit = n;
    drawIn(el, head + linksHtml(d) + tail);
    const box = el.querySelector(".dk-lks");
    if (!box || box.scrollWidth <= box.clientWidth + 1) break;
  }
  lkWatch(el);
}

/** The rail's width changes the room, and nothing else redraws the foot
 *  for it: one observer, made once. */
function lkWatch(el) {
  if (lkSeen?.el === el || typeof ResizeObserver === "undefined") return;
  lkSeen?.ro.disconnect();
  let w = el.clientWidth;
  const ro = new ResizeObserver(() => { if (el.clientWidth !== w) { w = el.clientWidth; lkFit = Infinity; meta(); } });
  ro.observe(el);
  lkSeen = { el, ro };
}

/** A link's ✕ or its Undo, from the foot or the +N menu: out of view at
 *  once here, then told to the daemon; a no puts it back. */
async function linkOut(d, id, out) {
  const k = `${d.id}:${id}`, l = (d.links || []).find(x => x.id === id);
  if (!l) return;
  clearTimeout(lkUndo.get(k)); lkUndo.delete(k);
  if (out) lkUndo.set(k, setTimeout(() => { lkUndo.delete(k); meta(); }, LK_UNDO_MS));
  l.hidden = out;
  meta();
  if (out) ctx.metaEl.querySelector(`.dk-lk-undo[data-lk="${id}"]`)?.focus({ preventScroll: true });
  try { await ctx.api(`/api/desks/${d.id}/links/${id}/${out ? "hide" : "show"}`, {}); }
  catch { l.hidden = !out; clearTimeout(lkUndo.get(k)); lkUndo.delete(k); meta(); ctx.toast(out ? "Could not take the link out" : "Could not bring the link back"); }
}

/** The foot's clicks that are the links': ✕, Undo, +N. Whether it was one. */
function linkClick(e) {
  const b = e.target.closest(".dk-lk-x, .dk-lk-undo, .dk-lk-more");
  const d = b && current();
  if (!d) return false;
  e.preventDefault(); e.stopPropagation();
  if (b.matches(".dk-lk-more")) { const r = b.getBoundingClientRect(); ctx.menu?.(b, r.left, r.top - 4, e.detail === 0); return true; }
  linkOut(d, +b.dataset.lk, b.matches(".dk-lk-x"));
  return true;
}

/** The menu on a link, or on +N: the ones that did not fit, each to open,
 *  and on a link its address to copy and its ✕. */
function linksMenu(el) {
  const d = current();
  if (!d) return null;
  const ls = linksOf(d).filter(l => !lkUndo.has(`${d.id}:${l.id}`));
  const open = l => () => window.open(l.url, "_blank", "noopener,noreferrer");
  if (el.matches(".dk-lk-more")) {
    const rest = ls.slice(lkFit);
    return { head: "Links", items: rest.map(l => ({ label: l.label, hint: l.host, run: open(l) })) };
  }
  const l = ls.find(x => x.id === +el.querySelector("[data-lk]")?.dataset.lk);
  if (!l) return null;
  return { head: l.label, items: [
    { label: "Open", hint: l.host, run: open(l) },
    { label: "Copy link", run: () => { navigator.clipboard?.writeText(l.url); ctx.toast("Copied", l.url); } },
    "rule",
    { label: "Take out", run: () => linkOut(d, l.id, true) },
  ] };
}

/** Leaving the desk: the Undos go with it. */
function linksDrop() {
  for (const t of lkUndo.values()) clearTimeout(t);
  lkUndo.clear();
  lkFit = Infinity; lkKey = "";
  lkSeen?.ro.disconnect(); lkSeen = null;
}

const LINKS_CSS = `
#meta .dk-lks { display: flex; align-items: center; gap: 2px; flex: 1; min-width: 0; overflow: hidden; }
#meta .dk-lk { position: relative; flex: none; display: flex; align-items: center; height: 22px; border-radius: var(--r-sm); }
#meta .dk-lk-in { display: flex; align-items: center; gap: 5px; height: 100%; padding: 0 7px; border-radius: inherit; color: var(--fg-3); text-decoration: none; font-size: var(--fs-small); }
#meta .dk-lk-in:hover, #meta .dk-lk-in:focus-visible { color: var(--accent); background: var(--rule); text-decoration: none; }
#meta .dk-lk-tx { max-width: 16ch; overflow: hidden; text-overflow: ellipsis; }
/* The ↗ and the ✕ are one box with two faces, crossed over, so the label
 * never moves for it. Touch has no hover: the ✕ is always there. */
#meta .dk-lk-ic { flex: none; width: 14px; text-align: center; font-size: var(--fs-micro); transition: opacity var(--dur-quick); }
#meta .dk-lk-x { position: absolute; top: 50%; right: 4px; width: 16px; height: 16px; margin-top: -8px; display: grid; place-items: center; padding: 0; border: 0; border-radius: var(--r-xs);
  background: var(--bg-side); color: var(--fg-3); opacity: 0; transition: opacity var(--dur-quick); cursor: pointer; }
#meta .dk-lk-x svg { width: 10px; height: 10px; }
#meta .dk-lk-x:hover, #meta .dk-lk-x:focus-visible { color: var(--fg); background: var(--rule-2); }
#meta .dk-lk:hover .dk-lk-x, #meta .dk-lk:focus-within .dk-lk-x { opacity: 1; }
#meta .dk-lk:hover .dk-lk-ic, #meta .dk-lk:focus-within .dk-lk-ic { opacity: 0; }
@media (hover: none) { #meta .dk-lk .dk-lk-x { opacity: 1; } #meta .dk-lk .dk-lk-ic { opacity: 0; } }
#meta .dk-lk.shut > .dk-lk-in { visibility: hidden; }
#meta .dk-lk.shut > .dk-lk-undo { position: absolute; inset: 1px; height: auto; }
#meta .dk-lk-undo, #meta .dk-lk-more { flex: none; height: 20px; padding: 0 7px; border: 0; border-radius: var(--r-xs); background: var(--rule); color: var(--fg); font-size: var(--fs-micro); font-weight: 600; cursor: pointer; }
#meta .dk-lk-more { background: none; color: var(--fg-3); font-variant-numeric: tabular-nums; }
#meta .dk-lk-undo:hover, #meta .dk-lk-undo:focus-visible, #meta .dk-lk-more:hover, #meta .dk-lk-more:focus-visible { background: var(--rule-2); color: var(--fg); }
`;
