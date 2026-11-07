/** The rail's Board section, while a board is open: its frames with size and
 *  version, the tokens as swatches, DESIGN.md's first line. The desk's rail
 *  draws its own Notes under it as ever; this is only the board's part. A
 *  row picks its frame, as a click on the board does. */
export function railHtml() {
  if (!board || !o) return "";
  const esc = o.esc;
  const rows = shown().map(f =>
    `<li><button type="button" class="bd-row${picked.includes(f.id) ? " bd-on" : ""}" data-bd-pick="${esc(f.id)}">` +
    `<span class="bd-row-n">${esc(f.name || f.id)}</span><span class="bd-row-m">${f.w}×${f.h}${f.versions > 1 ? ` · v${f.versions}` : ""}</span></button></li>`).join("");
  const hidden = board.frames.length - shown().length;
  const t = board.tokens || {};
  const sw = (t.vars || []).slice(0, 24).map(([k, v]) =>
    `<li class="bd-tok"><span class="bd-sw" style="background:${esc(swatch(v))}"></span><code>${esc(k)}</code></li>`).join("");
  return `<section class="bd-rail" aria-label="Board">` +
    `<h3>${esc(board.name || board.id)}</h3>` +
    (rows ? `<ul class="bd-rows">${rows}</ul>` : `<p class="bd-quiet">No frames yet. Ask the panel to draw one.</p>`) +
    (hidden ? `<p class="bd-quiet">${hidden} hidden</p>` : "") +
    (t.design ? `<p class="bd-design">${esc(t.design)}</p>` : "") +
    (sw ? `<h4>Tokens</h4><ul class="bd-toks">${sw}</ul>` : "") +
    `</section>`;
}

/** A token's value as a swatch's colour, when it is one; transparent when it
 *  is a length or a font, so the swatch is an empty box rather than a lie. */
function swatch(v) {
  return /^(#[0-9a-f]{3,8}|(rgb|hsl|oklch|oklab|lab|lch|color)a?\(.*\))$/i.test(v.trim()) ? v.trim() : "transparent";
}

/** The rail's clicks, delegated by the desk's rail to this. True when it
 *  was one of the board's. */
export function railClick(e) {
  const b = e.target.closest("[data-bd-pick]");
  if (!b) return false;
  pick(b.dataset.bdPick, e.shiftKey || e.metaKey || e.ctrlKey);
  const f = shown().find(x => x.id === b.dataset.bdPick);
  if (f) fit([f]);
  return true;
}
