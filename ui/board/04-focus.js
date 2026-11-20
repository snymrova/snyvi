/** Select a section: a click picks it alone, shift (or cmd, ctrl) adds or
 *  takes it away, a click on nothing clears. Every change is the reader's
 *  focus, sent through `o.focus` (POST /api/desks/{id}/focus), so the agent
 *  in the docked panel reads "this one" as the frames named. */
function pick(id, add) {
  const was = picked.join(",");
  if (!id) picked = add ? picked : [];
  else if (add) picked = picked.includes(id) ? picked.filter(x => x !== id) : [...picked, id];
  else picked = [id];
  if (picked.join(",") === was) return;
  barMode = ""; barSaid = ""; barUndo = "";
  paintFrames();
  paintBar();
  if (o && o.focus) o.focus({ view: `board:${board.id}`, path: `${o.dir || "design"}/${board.id}`, items: picked.slice() });
  paintList();
}

/** The bar at the foot of the board: what the agent will read as "this",
 *  and what the reader can do with it (07-acts.js). It is always there, the
 *  same height, so nothing moves when a frame is picked. */
function paintBar() {
  if (!bar || !o) return;
  const esc = o.esc, fs = pickedFrames();
  const names = fs.map(f => f.name || f.id);
  let html;
  if (barMode === "change" && fs.length === 1) {
    html = `<form class="bd-change" data-bd-change="${esc(fs[0].id)}"><span class="bd-bar-k">Change ${esc(names[0])}</span>` +
      `<input name="what" maxlength="300" autocomplete="off" aria-label="What should change?" placeholder="What should change?">` +
      `<button type="submit">Ask Claude</button><button type="button" data-bd-act="cancel">Cancel</button></form>`;
  } else if (fs.length) {
    html = `<span class="bd-bar-k">Claude reads</span> <span class="bd-bar-v">${names.map(esc).join(", ")}</span>` +
      (barSaid ? `<span class="bd-bar-said">${esc(barSaid)}</span>` : barActs(fs, esc));
  } else if (barSaid) {
    html = `<span class="bd-bar-v">${esc(barSaid)}</span>` + (barUndo ? `<button type="button" class="bd-act" data-bd-act="unhide">Undo</button>` : "");
  } else {
    html = shown().length
      ? `<span class="bd-bar-k">Pick a section</span> <span class="bd-bar-v">to say "this one", change it, or take it out.</span>`
      : `<span class="bd-bar-k">An empty board</span> <span class="bd-bar-v">Claude in the panel draws on it.</span>`;
  }
  // Not redrawn while it has not changed: a field in it keeps what is typed.
  if (bar.$html !== html) { bar.innerHTML = html; bar.$html = html; }
}
