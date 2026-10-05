/* ui/studio/07-menu.js: a part of studio.js, one module. build.rs joins
 * ui/studio/*.js in name order (src/strip.rs `source`). */
// ---------- what a file and a folder can be asked ----------

/** The context menu for what is under `el` on the studio desk: a file in
 *  the viewer, or a folder in the rail. menu.js asks desk.js, and desk.js
 *  asks this. */
export function actions(el) {
  if (!S) return null;
  const R = "rule", c = S.c, d = c.desk();
  const copy = abs => ({ label: "Copy path", run: () => { navigator.clipboard?.writeText(abs); c.toast("Copied", { sub: abs }); } });
  const t = el.closest(".st-tile[data-rel]") || (viewing && el.closest(".st-view") ? { dataset: { rel: viewing } } : null);
  if (t) {
    const it = itemOf(t.dataset.rel);
    if (!it) return null;
    const on = picked(it);
    return { head: it.name, items: [
      !viewEl && { label: "Open", key: "↵", run: () => openView(it.rel) },
      { label: on ? "Take the ★ off" : "★ Keep", key: "K", run: () => pick(it.rel) },
      { label: "Tell Claude about it…", run: () => tellClaude(it.rel) },
      R,
      copy(absOf(it.rel)),
      it.info && it.info.prompt && { label: "Copy prompt", run: () => { navigator.clipboard?.writeText(it.info.prompt); c.toast("Copied", { sub: it.info.prompt.slice(0, 80) }); } },
      R,
      it.hidden ? { label: "Put back", run: () => unhide(it.rel) } : { label: "Hide", key: "⌫", danger: true, run: () => { closeView(); hide(it.rel); } },
    ] };
  }
  const f = el.closest(".dk-sf[data-rel]");
  if (f) {
    const rel = f.dataset.rel;
    return { head: f.querySelector(".nm")?.textContent || rel, items: [
      { label: "Open", run: () => openFolder(rel) },
      { label: "Tell Claude about it…", run: () => tellClaude(rel) },
      R,
      copy(absOf(rel)),
      { label: "Open in file manager", run: () => c.reveal({ desk: d.id, board: rel }) },
      rel && R,
      rel && { label: "Hide", danger: true, run: () => hide(rel) },
    ] };
  }
  return null;
}
