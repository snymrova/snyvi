/* The board's bar of frames (1.60, views audit a5057fcd18, V6): top left
 * over the canvas, the board's name, a chip for each shown frame that picks
 * and fits it, how many are hidden, and a button of swatches that opens the
 * look -- DESIGN.md's first paragraph and the tokens. It was a section of the
 * desk's rail; a rail folded under 1200 px took it away, and it pushed the
 * desk's own Panels and Notes down while a board was open. On the board it
 * is where the frames are, at every width. */

/** Whether the look's box is open under its button. */
let lookOpen = false;

function paintList() {
  if (!list || !o) return;
  const esc = o.esc;
  if (!board) { list.innerHTML = ""; list.$html = ""; return; }
  const chips = shown().map(f =>
    `<button type="button" class="bd-chip${picked.includes(f.id) ? " bd-on" : ""}" data-bd-pick="${esc(f.id)}" aria-pressed="${picked.includes(f.id)}" ` +
    `data-tip="${esc(f.name || f.id)}" data-tip-sub="${f.w}×${f.h}${f.versions > 1 ? ` · v${f.versions}` : ""} · shift adds it">${esc(f.name || f.id)}</button>`).join("");
  const hidden = board.frames.length - shown().length;
  const t = board.tokens || {}, vars = (t.vars || []).slice(0, 24);
  const has = vars.length || t.design;
  const look = has ? `<button type="button" class="bd-look-b" data-bd-look aria-haspopup="true" aria-expanded="${lookOpen}" aria-label="The look: tokens and DESIGN.md" data-tip="The look" data-tip-sub="DESIGN.md and the tokens">` +
    (vars.length ? vars.slice(0, 3).map(([, v]) => `<span class="bd-sw" style="background:${esc(swatch(v))}"></span>`).join("") : "Aa") + `</button>` : "";
  const box = lookOpen && has ? `<div class="bd-look" role="group" aria-label="The look">` +
    (t.design ? `<p class="bd-design">${esc(t.design)}</p>` : "") +
    (vars.length ? `<ul class="bd-toks">${vars.map(([k, v]) => `<li class="bd-tok"><span class="bd-sw" style="background:${esc(swatch(v))}"></span><code>${esc(k)}</code><span class="bd-tok-v">${esc(v)}</span></li>`).join("")}</ul>` : "") +
    `</div>` : "";
  const html = `<b class="bd-title">${esc(board.name || board.id)}</b>` +
    (chips || `<span class="bd-quiet">no frames yet</span>`) +
    (hidden ? `<span class="bd-quiet">${hidden} hidden</span>` : "") + look + box;
  if (list.$html !== html) { list.innerHTML = html; list.$html = html; }
}

/** A token's value as a swatch's colour, when it is one; transparent when it
 *  is a length or a font, so the swatch is an empty box rather than a lie. */
function swatch(v) {
  return /^(#[0-9a-f]{3,8}|(rgb|hsl|oklch|oklab|lab|lch|color)a?\(.*\))$/i.test(v.trim()) ? v.trim() : "transparent";
}

/** A chip picks its frame, as a click on the board does, and fits it. */
function listClick(e) {
  if (e.target.closest("[data-bd-look]")) { lookOpen = !lookOpen; paintList(); return; }
  const b = e.target.closest("[data-bd-pick]");
  if (!b) return;
  pick(b.dataset.bdPick, e.shiftKey || e.metaKey || e.ctrlKey);
  const f = shown().find(x => x.id === b.dataset.bdPick);
  if (f) fit([f]);
}
