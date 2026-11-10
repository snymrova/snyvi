/* The board's bar of frames (1.60, views audit a5057fcd18, V6): top left
 * over the canvas, the board's name, a chip for each shown frame that picks
 * and fits it, how many are hidden, and a button of swatches that opens the
 * look -- DESIGN.md's first paragraph and the tokens. It was a section of the
 * desk's rail; a rail folded under 1200 px took it away, and it pushed the
 * desk's own Panels and Notes down while a board was open. On the board it
 * is where the frames are, at every width. */

/** Whether the look's box is open under its button. */
let lookOpen = false;
/** Whether the boards' list is open under the title (1.62): every board of
 *  the desk, New board, and Rename. "rename" while the field is the name. */
let boardsOpen = false;

function paintList() {
  if (!list || !o) return;
  const esc = o.esc;
  if (!board) { list.innerHTML = ""; list.$html = ""; return; }
  const chips = shown().map(f =>
    `<button type="button" class="bd-chip${picked.includes(f.id) ? " bd-on" : ""}" data-bd-pick="${esc(f.id)}" aria-pressed="${picked.includes(f.id)}" ` +
    `data-tip="${esc(f.name || f.id)}" data-tip-sub="${esc(sizeSaid(f))}${f.versions > 1 ? ` · v${f.versions}` : ""} · shift adds it">${esc(f.name || f.id)}</button>`).join("");
  const hidden = board.frames.length - shown().length;
  const t = board.tokens || {}, vars = (t.vars || []).slice(0, 24);
  const has = vars.length || t.design;
  const look = has ? `<button type="button" class="bd-look-b" data-bd-look aria-haspopup="true" aria-expanded="${lookOpen}" aria-label="The look: tokens and DESIGN.md" data-tip="The look" data-tip-sub="DESIGN.md and the tokens">` +
    (vars.length ? vars.slice(0, 3).map(([, v]) => `<span class="bd-sw" style="background:${esc(swatch(v))}"></span>`).join("") : "Aa") + `</button>` : "";
  const box = lookOpen && has ? `<div class="bd-look" role="group" aria-label="The look">` +
    (t.design ? `<p class="bd-design">${esc(t.design)}</p>` : "") +
    (vars.length ? `<ul class="bd-toks">${vars.map(([k, v]) => `<li class="bd-tok"><span class="bd-sw" style="background:${esc(swatch(v))}"></span><code>${esc(k)}</code><span class="bd-tok-v">${esc(v)}</span></li>`).join("")}</ul>` : "") +
    `</div>` : "";
  const title = `<button type="button" class="bd-title" data-bd-boards aria-haspopup="true" aria-expanded="${!!boardsOpen}" data-tip="This desk's boards" data-tip-sub="switch, make one, rename this">${esc(board.name || board.id)}<i aria-hidden="true">▾</i></button>`;
  const html = title + boardsBox(esc) +
    (chips || `<span class="bd-quiet">no sections yet</span>`) +
    (hidden ? `<span class="bd-quiet">${hidden} hidden</span>` : "") + look + box;
  if (list.$html !== html) { list.innerHTML = html; list.$html = html; }
}

/** A token's value as a swatch's colour, when it is one; transparent when it
 *  is a length or a font, so the swatch is an empty box rather than a lie. */
function swatch(v) {
  return /^(#[0-9a-f]{3,8}|(rgb|hsl|oklch|oklab|lab|lch|color)a?\(.*\))$/i.test(v.trim()) ? v.trim() : "transparent";
}

/** The boards' list under the title: each of the desk's boards (this one
 *  ticked), then New board and Rename as a field each when pressed. */
function boardsBox(esc) {
  if (!boardsOpen) return "";
  const heads = (o.boards && o.boards()) || [];
  const rows = heads.map(b => `<button type="button" class="bd-brow${b.id === board.id ? " bd-on" : ""}" data-bd-switch="${esc(b.id)}" aria-current="${b.id === board.id}">` +
    `<span>${esc(b.name || b.id)}</span><span class="bd-quiet">${b.frames || 0}</span></button>`).join("");
  const field = (k, label, val) => `<form class="bd-bform" data-bd-form="${k}"><input name="n" maxlength="80" aria-label="${label}" placeholder="${label}" value="${esc(val)}" autocomplete="off"><button type="submit">${k === "new" ? "Make" : "Rename"}</button></form>`;
  const acts = boardsOpen === "new" ? field("new", "The new board's name", "")
    : boardsOpen === "rename" ? field("rename", "This board's name", board.name || board.id)
    : `<button type="button" class="bd-brow bd-bact" data-bd-new>+ New board</button><button type="button" class="bd-brow bd-bact" data-bd-rename>Rename this board…</button>`;
  return `<div class="bd-boards" role="group" aria-label="Boards">${rows}<hr>${acts}<p class="bd-said" aria-live="polite"></p></div>`;
}

/** A field in the boards' list sent: a new board made and opened, or this
 *  one renamed. The folder's name never changes, so nothing that names it
 *  is lost. */
async function boardsSubmit(e) {
  const f = e.target.closest("[data-bd-form]");
  if (!f || !o) return;
  e.preventDefault();
  const name = f.elements.n.value.trim();
  if (!name) return;
  const said = list.querySelector(".bd-said");
  try {
    if (f.dataset.bdForm === "new") {
      const j = await o.make(name);
      boardsOpen = false;
      if (j && j.board) o.switch(j.board);
    } else {
      await o.rename(board.id, name);
      board.name = name;
      boardsOpen = false;
      paintList();
      if (o.named) o.named();
    }
  } catch (err) {
    if (said) said.textContent = `Could not do that · ${o.sayErr ? o.sayErr(err) : "try again"}`;
  }
}

/** A chip picks its frame, as a click on the board does, and fits it. */
function listClick(e) {
  if (e.target.closest("[data-bd-look]")) { lookOpen = !lookOpen; boardsOpen = false; paintList(); return; }
  if (e.target.closest("[data-bd-boards]")) { boardsOpen = boardsOpen ? false : true; lookOpen = false; paintList(); return; }
  const sw = e.target.closest("[data-bd-switch]");
  if (sw) { boardsOpen = false; if (sw.dataset.bdSwitch !== board.id) o.switch(sw.dataset.bdSwitch); else paintList(); return; }
  if (e.target.closest("[data-bd-new], [data-bd-rename]")) {
    boardsOpen = e.target.closest("[data-bd-new]") ? "new" : "rename";
    paintList();
    list.querySelector(".bd-bform input")?.select();
    return;
  }
  if (e.target.closest(".bd-boards")) return;
  const b = e.target.closest("[data-bd-pick]");
  if (!b) return;
  pick(b.dataset.bdPick, e.shiftKey || e.metaKey || e.ctrlKey);
  const f = shown().find(x => x.id === b.dataset.bdPick);
  if (f) fit([f]);
}
