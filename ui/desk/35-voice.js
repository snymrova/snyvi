/* ui/desk/35-voice.js: a part of desk.js, one module. build.rs joins ui/desk/*.js in name
 * order (src/strip.rs `source`); SNYVI_UI_DIR serves the same join. */
// ---------- what voice can say of a desk (1.70, plan ed0af62be2) ----------
/*
 * ui/voice.js matches a spoken phrase against what the window can do, and on
 * a desk that includes its panels: "panel two", or a panel by the name it was
 * given. These two are that list and the focus it moves -- the same focus
 * ⌃⌥2 moves, and nothing more. Voice never types into a panel. The desk's
 * views it reads from `viewsHere` and opens with `viewHere` (25-views.js),
 * as the ⋯ menu does.
 */

/** The panels on screen, by their place and their name. None while a
 *  document is read over the desk: there is no panel there to focus. */
export function panelsHere() {
  const d = current();
  return d && reading == null ? gridPanes(d).map(p => ({ id: p.id, slot: p.slot, name: p.name || "" })) : [];
}
export const panelHere = id => focusPane(id);
