/* ui/desk/38-places.js: a part of desk.js, one module. build.rs joins ui/desk/*.js in name
 * order (src/strip.rs `source`); SNYVI_UI_DIR serves the same join. */
// ---------- places in Back and Forward (plan 94e0a0f735, P7) ----------
/*
 * Up to 1.69 Back and Forward knew pages: a desk was one step however much
 * the reader moved about on it, and Back from a document read over it
 * landed on the panels "as left" only because nothing else was kept. With
 * tabs the reader moves about more, so a desk's place is kept on its own
 * history entry: the tab shown and the panel focused (the view is the
 * address's already, 32-ways.js). Back to the entry finds them as they were.
 *
 * A press that goes somewhere else on the desk -- another tab, or a chip or
 * ⌃⌥2 bringing a panel out of sight into it -- is a step of its own, so Back
 * undoes it. Steps a moment apart fold into one: ⌃⌥] five times is one
 * step, not five. A click into a panel already in sight moves nothing and
 * is no step.
 *
 * And each step says where it is: the desk's title is its place, "breeds-
 * of-dogs · Tab 2 · 2 · photos", which is what the window's title shows and
 * what Back's tip reads (ui/nav.js names a step by the title).
 */

/** Set by a press that moves the reader on the desk; the next layout pushes. */
let placeNext = false, placeAt = 0;
const PLACE_FOLD_MS = 1500;

/** The place on screen. */
function placeNow(d) {
  const v = views.get(focused);
  return { desk: d.id, grp: d.grp || 0, slot: v && !isBack(v.pane) ? v.pane.slot : 0 };
}
const samePlace = (a, b) => !!a && !!b && a.desk === b.desk && a.grp === b.grp && a.slot === b.slot;

/** What the title says: the desk, its tab when it has two, and the panel
 *  focused when the tab has two. One panel and one tab is the desk alone. */
function placeTitle(d) {
  const ps = gridPanes(d), v = views.get(focused), g = (d.groups || []).length > 1 ? (d.groups.find(x => x.id === d.grp) || {}).name : "";
  const bits = [d.name, g, ps.length > 1 && v && !isBack(v.pane) ? `${v.pane.slot} · ${short(v)}` : ""].filter(Boolean);
  return bits.length > 1 ? bits.join(" · ") : `${d.name} · desk`;
}

/** Called at the end of every layout: the entry on screen keeps the place,
 *  or, after a press that moved the reader, a new entry is pushed for it. */
function placeKeep(d) {
  if (!d || reading != null || location.pathname !== `/desk/${d.id}`) { placeNext = false; return; }
  const t = placeTitle(d);
  if (document.title !== t) document.title = t;
  const was = history.state && history.state.dk, now = placeNow(d), step = placeNext;
  placeNext = false;
  if (samePlace(was, now)) return;
  const url = location.pathname + location.hash;
  if (step && was && was.desk === d.id && Date.now() - placeAt > PLACE_FOLD_MS) history.pushState({ desk: d.id, dk: now }, "", url);
  else history.replaceState({ ...(history.state || {}), desk: d.id, dk: now }, "", url);
  if (step) placeAt = Date.now();
}

/** For `open` (07-actions.js): Back or Forward onto an entry of this desk
 *  brings its place, the tab and the panel; a press that opened the desk
 *  goes by its own word. */
function placeBack(c) {
  const p = !c.push && history.state && history.state.dk;
  return p && p.desk === c.id ? p : null;
}
