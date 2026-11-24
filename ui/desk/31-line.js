/* ui/desk/31-line.js: a part of desk.js, one module. build.rs joins ui/desk/*.js in name
 * order (src/strip.rs `source`); SNYVI_UI_DIR serves the same join. */
// ---------- the line (1.67), which the reader reads as "Next up" (1.68) ----------

/* A desk has a goal and an ordered queue of its notes (src/desk/line.rs,
 * plan f586a9fe09). Until now the reader picked every next piece by hand:
 * read the list, open a panel, tell its agent which note. Here the order
 * is theirs once, and Start next is one press: a panel in a worktree of
 * its own, started with snyvi's words and the note's number.
 *
 * The section sits over Notes, because it is those notes in an order. A
 * row says the note's number and words, then what it is: done, the panel
 * that has it, next, or queued; and the command it is done when it
 * passes, the reader's, which the agent is told and runs itself.
 *
 * Only the reader writes here. The goal, the order and the command go to
 * capability routes; an agent takes the next note (`next_work`) and
 * cannot reorder or start another. Every row keeps its height whatever
 * its state, and the field for the goal or a command opens in the room
 * its words had: nothing under it moves.
 *
 * 1.68: the section is headed "Next up". "The line" was a play on two
 * things at once, the goal in one line and the notes in a line, and said
 * neither to someone new; it stays the name in the code, the routes and
 * what agents are told. And a note is added from a row like every other
 * in the rail, whose menu lies over what is under it: the one native
 * select in the rail read as a field of some other form.
 *
 * 1.69 (plan 520aa866b0, A3): the section is not drawn while it has no
 * goal and no queue. A head over "Set a goal" stood in every rail, most of
 * which never had one. The ways in are where the reader already is: "Put
 * on Next up" in a note's own menu, and "Set a goal…" in the desk's ⋯.
 * Either one draws it. */

let lineAt = null, lineGot = null, lineEdit = null, lineDraft = "", lineFocused = false, lineBusy = false, lineMenu = false, lineAway = null;
const LINE_NONE = { goal: "", queue: [], next: 0 };

/** Read again: with the notes, and on their `desknotes` event. */
async function lineGet(id) {
  if (id == null || !ctx) return;
  let j;
  try { j = await ctx.api(`/api/desks/${id}/line`); } catch { return; }
  if (id !== deskId) return;
  const was = JSON.stringify(lineAt === id ? lineGot : null);
  lineAt = id; lineGot = j.line || LINE_NONE;
  if (was !== JSON.stringify(lineGot) && current()) rail();
}

const lineOf = d => lineAt === d.id && lineGot ? lineGot : LINE_NONE;

function lineRow(d, l, r, i, by, esc) {
  const x = by.get(r.id), text = x ? x.text : "a note off the list";
  const slot = r.pane ? views.get(r.pane)?.pane.slot : 0;
  const next = !r.done && r.id === l.next;
  const state = r.done ? "done" : r.pane ? `${slot ? `panel ${slot}` : "a panel"} has it` : next ? "next" : "queued";
  const tree = !r.done && r.tree ? ` · <span data-tip="Its worktree" data-tip-sub="${esc(r.tree)}">${esc(ctx.tilde(r.tree).split("/").pop())}</span>` : "";
  const editing = lineEdit && lineEdit.when === r.id;
  const when = r.done ? "" : editing
    ? `<input class="dk-ln-in" data-k="when" data-n="${r.id}" maxlength="200" placeholder="a command that passes when it is done" aria-label="Done when this command passes, for note ${r.id}" spellcheck="false" autocomplete="off">`
    : `<button type="button" class="dk-ln-when" data-a="line-when" data-n="${r.id}" data-tip="Done when" data-tip-sub="a command of yours that passes when the note is done; its agent is told it and runs it before it ticks">${r.done_when ? `done when <code>${esc(r.done_when)}</code> passes` : "no done check yet"}</button>`;
  const start = next
    ? `<button type="button" class="dk-ln-start" data-a="line-start"${lineBusy ? " disabled" : ""} data-tip="Start next" data-tip-sub="a panel in a worktree of its own, started with snyvi's words and this note's number">${lineBusy ? "Starting…" : "Start next"}</button>` : "";
  const tools = `<span class="dk-ln-tools">` +
    `<button type="button" data-a="line-up" data-n="${r.id}"${i ? "" : " disabled"} aria-label="Move note ${r.id} earlier" data-tip="Earlier">↑</button>` +
    `<button type="button" data-a="line-down" data-n="${r.id}"${i < l.queue.length - 1 ? "" : " disabled"} aria-label="Move note ${r.id} later" data-tip="Later">↓</button>` +
    `<button type="button" data-a="line-off" data-n="${r.id}" aria-label="Take note ${r.id} off Next up" data-tip="Off Next up" data-tip-sub="the note stays on your list">${ico("x")}</button></span>`;
  return `<li class="dk-ln-row${r.done ? " done" : ""}${next ? " next" : ""}"><span class="dk-ln-i" aria-hidden="true">${r.done ? "✓" : i + 1}</span>` +
    `<span class="dk-ln-b"><span class="dk-ln-t" data-tip="${esc(text)}" data-tip-overflow>#${r.id} ${esc(text)}</span>` +
    `<span class="dk-ln-s"><span class="dk-ln-st">${state}${tree}</span>${when ? " · " + when : ""}</span></span>${start}${tools}</li>`;
}

/** The section, over Notes; nothing while there is no goal, no queue, and
 *  no goal being written. */
function lineSec(d) {
  const { esc } = ctx;
  const l = lineOf(d), notes = notesAt === d.id ? noteList : [];
  if (!l.queue.length && !l.goal && !(lineEdit && lineEdit.goal)) return "";
  const by = new Map(notes.map(x => [x.id, x]));
  const done = l.queue.filter(r => r.done).length, all = l.queue.length;
  const goal = lineEdit && lineEdit.goal
    ? `<input class="dk-ln-in" data-k="goal" maxlength="120" placeholder="What is this desk for, in one line?" aria-label="This desk's goal" spellcheck="false" autocomplete="off">`
    : `<button type="button" class="dk-ln-goal" data-a="line-goal" data-tip="The goal" data-tip-sub="one line of yours; click to change it">${l.goal ? `<b>Goal:</b> ${esc(l.goal)}` : "Set a goal"}</button>`;
  const bar = all ? `<span class="dk-ln-n">${done} of ${all} done</span><span class="dk-ln-bar" aria-hidden="true"><i style="width:${Math.round(done / all * 100)}%"></i></span>` : "";
  const free = notes.filter(x => !x.done && !x.gone && !x.suggested_by && !l.queue.some(r => r.id === x.id));
  // The row is there whenever a note could be added, and its menu lies
  // over what is under it: opening it moves nothing.
  const open = lineMenu && free.length && all < 40;
  const add = free.length && all < 40
    ? `<div class="dk-ln-addrow"><button type="button" class="dk-new dk-ln-add" data-a="line-add" aria-haspopup="menu" aria-expanded="${!!open}" data-tip="Add a note" data-tip-sub="one of your open notes, put last in the order">+ Add a note</button>` +
      (open ? `<span class="dk-due-pop dk-ln-pop" role="menu" aria-label="Add a note to Next up">${free.map(x => `<button type="button" role="menuitem" data-a="line-put" data-n="${x.id}" data-tip="${esc(x.text)}" data-tip-overflow>#${x.id} ${esc(x.text)}</button>`).join("")}</span>` : "") + `</div>` : "";
  const rows = l.queue.map((r, i) => lineRow(d, l, r, i, by, esc)).join("");
  const left = all - done;
  return sec("line", "rail.line", "Next up", {
    cls: "dk-line", part: "rail.line.head", empty: !all && !l.goal,
    tip: "Next up", sub: "This desk's goal and your notes in the order to do them. Start next opens a panel for the first one that is free; agents take the next, never reorder.",
    count: left || "", countTip: left ? `${left} to go` : "",
  }, `<div class="dk-ln-head">${goal}${bar}</div>` + errLine("line", esc, "p") +
    (rows ? `<ol class="dk-ln-list">${rows}</ol>` : "") + add);
}

/** The field, put back after a redraw with what was typed in it. */
function lineFocus() {
  // The menu's keys: Escape shuts it and gives the row the focus back; the
  // arrows walk it. Stopped here, since the desk gives every other key to
  // the shell in the focused panel.
  const pop = ctx.tocEl.querySelector(".dk-ln-pop");
  if (pop && !pop.$wired) {
    pop.$wired = true;
    pop.addEventListener("keydown", e => {
      const its = [...pop.querySelectorAll("button")], at = its.indexOf(document.activeElement);
      // Tab leaves it as Escape does: shut, the focus on the row it hangs from.
      if (e.key === "Escape" || e.key === "Tab") { e.preventDefault(); e.stopPropagation(); lineMenu = false; rail(); ctx.tocEl.querySelector(".dk-ln-add")?.focus(); }
      else if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); e.stopPropagation(); its[(at + (e.key === "ArrowDown" ? 1 : its.length - 1)) % its.length]?.focus(); }
    });
  }
  // A press anywhere else shuts it too: a board's section, the page, a
  // panel. The menu is taken out where it lies, not by drawing the rail
  // again, so a press on another of the rail's buttons still lands on it.
  if (pop && !lineAway) document.addEventListener("pointerdown", lineAway = e => {
    if (lineMenu && e.target.closest?.(".dk-ln-addrow")) return;
    document.removeEventListener("pointerdown", lineAway, true);
    lineAway = null;
    if (!lineMenu) return;
    lineMenu = false;
    const row = ctx.tocEl.querySelector(".dk-ln-addrow");
    row?.querySelector(".dk-ln-pop")?.remove();
    row?.querySelector(".dk-ln-add")?.setAttribute("aria-expanded", "false");
    // The rail's last drawing still holds the menu: forget it, or opening
    // the menu again draws the same words and `drawIn` skips them.
    ctx.tocEl.$html = null;
  }, true);
  const inp = ctx.tocEl.querySelector(".dk-ln-in");
  if (!inp) { lineFocused = false; return; }
  inp.value = lineDraft;
  inp.addEventListener("input", () => { lineDraft = inp.value; });
  inp.addEventListener("focus", () => { lineFocused = true; });
  inp.addEventListener("blur", () => { lineFocused = false; });
  inp.addEventListener("keydown", e => {
    // The desk gives every other key to the shell in the focused panel.
    e.stopPropagation();
    if (e.key === "Escape") { e.preventDefault(); lineEdit = null; lineDraft = ""; rail(); return; }
    if (e.key !== "Enter") return;
    e.preventDefault();
    const d = current(), text = inp.value.replace(/\s+/g, " ").trim(), k = inp.dataset.k, n = +inp.dataset.n;
    lineEdit = null; lineDraft = "";
    if (d) lineSet(d, k === "goal" ? { goal: text } : { note: n, done_when: text });
  });
  if (lineFocused) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
}

/** The goal's field, open: from the section's own line, or the desk's ⋯
 *  (`goalHere`), which is how a desk with no Next up yet gets one. */
function lineGoal(d) {
  lineEdit = { goal: true }; lineDraft = lineOf(d).goal; lineFocused = true;
  ctx.fold("line", false);
  rail();
  ctx.tocEl.querySelector(".dk-ln-head")?.scrollIntoView({ block: "nearest" });
}
export const goalHere = () => { const d = current(); if (d) lineGoal(d); };
/** Whether the desk has a goal, for the menu's word. */
export const goalSet = () => { const d = current(); return !!(d && lineOf(d).goal); };

/** A note's menu rows for Next up (07-actions.js `menu`): put last in the
 *  order, or taken off it. Only an open line of the reader's own. */
function lineItems(d, x) {
  if (x.done || x.gone || x.suggested_by) return [];
  const ids = lineOf(d).queue.map(r => r.id);
  if (ids.includes(x.id)) return [{ label: "Remove from Next up", about: "the note stays on your list", run: () => lineSet(d, { order: ids.filter(i => i !== x.id) }) }];
  if (ids.length >= 40) return [];
  return [{ label: "Put on Next up", about: "last in the order to do them", run: async () => { ctx.fold("line", false); await lineSet(d, { order: [...ids, x.id] }); ctx.tocEl.querySelector(".dk-line")?.scrollIntoView({ block: "nearest" }); } }];
}

/** One write, answered with the line as it is now. */
async function lineSet(d, body) {
  try {
    const j = await ctx.api(`/api/desks/${d.id}/line`, body);
    lineAt = d.id; lineGot = j.line || LINE_NONE;
  } catch (e) { rowErr = { k: "line", why: "Could not change Next up", raw: e.message }; }
  rail();
}

/** The line's clicks. True when the click was one of them. Any other press
 *  shuts its menu, as the stage's is shut (22-change.js). */
async function lineAct(a, b, d) {
  if (!a?.startsWith("line-")) { lineMenu = false; return false; }
  const l = lineOf(d), ids = l.queue.map(r => r.id), n = +b.dataset.n, i = ids.indexOf(n);
  const menu = lineMenu;
  lineMenu = false;
  if (a === "line-add") {
    lineMenu = !menu;
    ctx.fold("line", false);
    rail();
    if (lineMenu) ctx.tocEl.querySelector(".dk-ln-pop button")?.focus();
  }
  else if (a === "line-put") {
    if (n && i < 0) await lineSet(d, { order: [...ids, n] }); else rail();
    // The focus back on the row the menu hung from; with no note left to
    // add, that row is gone, and the goal takes it.
    (ctx.tocEl.querySelector(".dk-ln-add") || ctx.tocEl.querySelector(".dk-ln-goal"))?.focus();
  }
  else if (a === "line-goal") lineGoal(d);
  else if (a === "line-when") { lineEdit = { when: n }; lineDraft = l.queue[i]?.done_when || ""; lineFocused = true; rail(); }
  else if ((a === "line-up" || a === "line-down") && i >= 0) {
    const j = a === "line-up" ? i - 1 : i + 1;
    if (j < 0 || j >= ids.length) return true;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    await lineSet(d, { order: ids });
  }
  else if (a === "line-off" && i >= 0) await lineSet(d, { order: ids.filter(x => x !== n) });
  else if (a === "line-start") {
    // Pressed while the desk is full: it says why, as New panel does.
    const why = noNew(d);
    if (why) { ctx.toast("Start next", `${why}: close a panel or send one to the back`); return true; }
    if (lineBusy) return true;
    lineBusy = true; rail();
    try {
      const j = await ctx.api(`/api/desks/${d.id}/line/next`, {});
      focused = j.pane.id;
      await ctx.refresh();
      const nv = views.get(j.pane.id);
      if (nv) { await run(nv, j.pane.cmd); nv.body.focus(); }
      ctx.toast(`Started #${j.note}`, `in ${ctx.tilde(j.tree)}`);
    } catch (e) { rowErr = { k: "line", why: "Could not start the next note", raw: e.message, again: { a: "line-start" } }; }
    lineBusy = false;
    await lineGet(d.id);
    rail();
  }
  return true;
}

const LINE_CSS = `
/* ---------- the line ----------
 * Over Notes. A row is two lines whatever its state; its tools come over
 * its end under the pointer, in room the row already has. */
.dk-ln-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 8px; padding: 2px 8px 6px; }
.dk-ln-goal { flex: 1 1 100%; min-width: 0; text-align: left; color: var(--fg-2); font-size: var(--fs-small); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dk-ln-goal b { color: var(--fg); font-weight: 600; }
.dk-ln-goal:hover { color: var(--accent); }
.dk-ln-n { color: var(--fg-3); font-size: var(--fs-micro); white-space: nowrap; }
.dk-ln-bar { flex: 1; height: 4px; align-self: center; border-radius: var(--r-xs); background: var(--rule); overflow: hidden; }
.dk-ln-bar i { display: block; height: 100%; border-radius: var(--r-xs); background: var(--ok); }
.dk-ln-list { list-style: none; margin: 0; padding: 0; }
.dk-ln-row { position: relative; display: flex; align-items: center; gap: 8px; min-height: 40px; padding: 4px 8px; border-top: 1px solid var(--rule); }
.dk-ln-row.next { background: var(--bg-raise); }
.dk-ln-row.done .dk-ln-t { color: var(--fg-3); }
.dk-ln-i { flex: none; width: 16px; text-align: center; color: var(--fg-3); font-size: var(--fs-micro); font-variant-numeric: tabular-nums; }
.dk-ln-row.done .dk-ln-i { color: var(--ok); }
.dk-ln-b { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.dk-ln-t { font-size: var(--fs-small); font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dk-ln-s { display: flex; align-items: baseline; gap: 4px; min-width: 0; height: 18px; color: var(--fg-3); font-size: var(--fs-micro); white-space: nowrap; overflow: hidden; }
.dk-ln-st { flex: none; }
.dk-ln-when { min-width: 0; color: var(--fg-3); font-size: var(--fs-micro); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dk-ln-when:hover { color: var(--accent); }
.dk-ln-when code { font-family: var(--mono); font-size: inherit; }
.dk-ln-in { flex: 1; min-width: 0; height: 18px; padding: 0 4px; border: 1px solid var(--rule-2); border-radius: var(--r-sm); background: var(--bg); color: var(--fg); font-size: var(--fs-micro); }
.dk-ln-head .dk-ln-in { flex: 1 1 100%; height: 20px; font-size: var(--fs-small); }
.dk-ln-start { flex: none; padding: 3px 10px; border-radius: var(--r-pill); background: var(--accent); color: var(--on-accent); font-size: var(--fs-micro); font-weight: 600; white-space: nowrap; }
.dk-ln-start:disabled { opacity: .6; cursor: default; }
.dk-ln-tools { position: absolute; top: 3px; right: 6px; display: flex; gap: 2px; padding: 0 2px; border-radius: var(--r-sm); background: var(--bg-raise); opacity: 0; pointer-events: none; }
.dk-ln-row:hover .dk-ln-tools, .dk-ln-tools:focus-within { opacity: 1; pointer-events: auto; }
.dk-ln-tools button { width: 18px; height: 18px; color: var(--fg-3); font-size: var(--fs-micro); line-height: 1; }
.dk-ln-tools button:hover:not(:disabled) { color: var(--accent); }
.dk-ln-tools button:disabled { opacity: .35; cursor: default; }
.dk-ln-tools svg { width: 10px; height: 10px; }
/* The row a note is added from, New panel's own shape, and its menu over
 * what is under it: the rail's menu (.dk-due-pop), as wide as the rail and
 * no taller than nine notes. */
.dk-ln-addrow { position: relative; margin-top: 2px; }
.dk-ln-pop { position: absolute; z-index: var(--z-pop, 30); top: calc(100% - 2px); left: 8px; right: 8px; display: grid; gap: 1px; max-height: 232px; overflow-y: auto; padding: 4px; border-radius: var(--r-sm); background: var(--bg-raise); box-shadow: var(--shadow-2, var(--shadow)); }
.dk-ln-pop > button { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
`;
