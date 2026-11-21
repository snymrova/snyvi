/* The board's bar of frames (1.60, views audit a5057fcd18, V6): top left
 * over the canvas, the board's name, a chip for each shown frame that picks
 * and fits it, how many are hidden, and a button of swatches that opens the
 * look -- DESIGN.md's first paragraph and the tokens. It was a section of the
 * desk's rail; a rail folded under 1200 px took it away, and it pushed the
 * desk's own Panels and Notes down while a board was open. On the board it
 * is where the frames are, at every width. */

/** Whether the look's box is open under its button. */
let lookOpen = false;
/* The title opens the desk's boards list under it (1.68, ui/desk's
 * 33-switch.js `blToggle`): the one list, the same from the switcher's
 * Boards, where boards are made, renamed, moved and removed. Until 1.68 the
 * board had a list of its own here, with New board and Rename only. */

function paintList() {
  if (!list || !o) return;
  const esc = o.esc;
  if (!board) { list.innerHTML = ""; list.$html = ""; return; }
  const chips = shown().map(f =>
    `<button type="button" class="bd-chip${picked.includes(f.id) ? " bd-on" : ""}" data-bd-pick="${esc(f.id)}" aria-pressed="${picked.includes(f.id)}" ` +
    `data-tip="${esc(f.name || f.id)}" data-tip-sub="${esc(sizeSaid(f))}${f.versions > 1 ? ` · v${f.versions}` : ""} · shift adds it">${esc(f.name || f.id)}</button>`).join("");
  const t = board.tokens || {}, vars = (t.vars || []).slice(0, 24);
  const has = vars.length || t.design;
  const look = has ? `<button type="button" class="bd-look-b" data-bd-look aria-haspopup="true" aria-expanded="${lookOpen}" aria-label="The look: tokens and DESIGN.md" data-tip="The look" data-tip-sub="DESIGN.md and the tokens">` +
    (vars.length ? vars.slice(0, 3).map(([, v]) => `<span class="bd-sw" style="background:${esc(swatch(v))}"></span>`).join("") : "Aa") + `</button>` : "";
  const box = lookOpen && has ? `<div class="bd-look" role="group" aria-label="The look">` +
    (t.design ? `<p class="bd-design">${esc(t.design)}</p>` : "") +
    (vars.length ? `<ul class="bd-toks">${vars.map(([k, v]) => `<li class="bd-tok"><span class="bd-sw" style="background:${esc(swatch(v))}"></span><code>${esc(k)}</code><span class="bd-tok-v">${esc(v)}</span></li>`).join("")}</ul>` : "") +
    `</div>` : "";
  const title = `<button type="button" class="bd-title" data-bd-boards aria-haspopup="true" data-tip="This desk's boards" data-tip-sub="switch, make, rename, order, remove">${esc(board.name || board.id)}<i aria-hidden="true">▾</i></button>`;
  const html = title +
    (chips || `<span class="bd-quiet">no sections yet</span>`) +
    hiddenChip(esc) + look + box;
  if (list.$html === html) return;
  // The bar is drawn whole: the control that had the focus gets it back,
  // or a key after a click on a chip reached nothing (audit F2).
  const a = document.activeElement, k = a && list.contains(a) ? listKey(a) : "";
  list.innerHTML = html; list.$html = html;
  if (k) [...list.querySelectorAll("button")].find(b => listKey(b) === k)?.focus();
}

/** What names a control of the bar across a repaint. */
const listKey = b => b.dataset.bdPick ? `pick:${b.dataset.bdPick}` : b.dataset.bdShow ? `show:${b.dataset.bdShow}`
  : ["bdBoards", "bdLook", "bdHidden"].find(k => k in b.dataset) || "";

/** A token's value as a swatch's colour, when it is one; transparent when it
 *  is a length or a font, so the swatch is an empty box rather than a lie. */
function swatch(v) {
  return /^(#[0-9a-f]{3,8}|(rgb|hsl|oklch|oklab|lab|lch|color)a?\(.*\))$/i.test(v.trim()) ? v.trim() : "transparent";
}

/** A chip picks its frame, as a click on the board does, and fits it. */
function listClick(e) {
  if (hiddenClick(e)) return;
  if (e.target.closest("[data-bd-look]")) { lookOpen = !lookOpen; hiddenOpen = false; paintList(); return; }
  const t = e.target.closest("[data-bd-boards]");
  if (t) { lookOpen = false; hiddenOpen = false; paintList(); if (o.list) o.list(t); return; }
  if (e.target.closest(".bd-boards")) return;
  const b = e.target.closest("[data-bd-pick]");
  if (!b) return;
  pick(b.dataset.bdPick, e.shiftKey || e.metaKey || e.ctrlKey);
  const f = shown().find(x => x.id === b.dataset.bdPick);
  if (f) fit([f]);
}
