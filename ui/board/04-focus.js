/** Select a frame: a click picks it alone, shift (or cmd, ctrl) adds or
 *  takes it away, a click on nothing clears. Every change is the reader's
 *  focus, sent through `o.focus` (POST /api/desks/{id}/focus), so the agent
 *  in the docked panel reads "this one" as the frames named. */
function pick(id, add) {
  const was = picked.join(",");
  if (!id) picked = add ? picked : [];
  else if (add) picked = picked.includes(id) ? picked.filter(x => x !== id) : [...picked, id];
  else picked = [id];
  if (picked.join(",") === was) return;
  paintFrames();
  paintBar();
  if (o && o.focus) o.focus({ view: `board:${board.id}`, path: `${o.dir || "design"}/${board.id}`, items: picked.slice() });
  if (o && o.rail) o.rail();
}

/** The bar at the foot of the board: what the agent will read as "this". It
 *  is always there, the same height, so nothing moves when a frame is picked. */
function paintBar() {
  if (!bar || !o) return;
  const esc = o.esc;
  const names = picked.map(id => { const f = shown().find(x => x.id === id); return f ? (f.name || f.id) : id; });
  bar.innerHTML = names.length
    ? `<span class="bd-bar-k">Claude reads</span> <span class="bd-bar-v">${names.map(esc).join(", ")}</span>`
    : `<span class="bd-bar-k">Pick a frame</span> <span class="bd-bar-v">and say what to change in the panel.</span>`;
}
