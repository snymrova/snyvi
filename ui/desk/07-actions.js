/* ui/desk/07-actions.js: a part of desk.js, one module. build.rs joins ui/desk/*.js in name
 * order (src/strip.rs `source`); SNYVI_UI_DIR serves the same join. */
// ---------- actions ----------

async function act(b, byKey) {
  const a = b.dataset.a, d = current(), v = views.get(b.dataset.p || focused);
  const e0 = rowErr;
  rowErr = null;
  if (a === "retry") { if (current()) rail(); return e0 && act({ dataset: e0.again }); }
  try {
    if (a === "make") ctx.make(b, byKey);
    else if (a === "swap") ctx.swap();
    else if (a === "new") {
      // Pressed while it cannot: it says why, as ⌃⌥N does.
      const why = noNew(d);
      if (why) return ctx.toast("New panel", why);
      const j = await ctx.api(`/api/desks/${d.id}/panes`, {});
      focused = j.pane.id;
      await ctx.refresh();
      // Asking for a pane is asking for a shell: it starts, and the Start bar
      // is for a pane whose process ended, not one just made.
      const nv = views.get(j.pane.id);
      if (nv) { await run(nv, ""); nv.body.focus(); }
    } else if (a === "stop" && v) await ctx.api(`/api/panes/${v.id}/stop`, {});
    else if (a === "start" && v) run(v, v.start.querySelector("input").value);
    else if (a === "all") { for (const x of views.values()) if (!x.status.running) await run(x, x.status.cmd || x.pane.cmd || ""); }
    else if (a === "close" && v) await closePanel(v, byKey);
    else if (a === "pane-back") await restorePanel(b.dataset.p);
    else if (a === "pane-rename" && v) renamePanel(v);
    else if (a === "drop") {
      // Closed, not deleted: its notes wait on it, and Undo brings it back
      // with the panels that closed with it, stopped.
      await ctx.api(`/api/desks/${d.id}/delete`, {}); await ctx.refresh(); ctx.go(null, true);
      ctx.toast(`Closed ${d.name}`, "Its notes are kept", null, { label: "Undo", run: async () => { await ctx.api(`/api/desks/${d.id}/reopen`, {}); await ctx.refresh(); ctx.go(d.id, true); } });
    }
    else if (a === "rename") renameDesk(d);
    else if (a === "reveal") ctx.reveal({ desk: d.id });
    else if (a === "desk") ctx.go(deskId, true);
    else if (a === "copy") { await navigator.clipboard?.writeText(b.dataset.path); ctx.toast("Copied", b.dataset.path); }
    else if (a === "more") { docsAll = !docsAll; rail(); }
    else if (a === "notes-more") { notesAll = !notesAll; rail(); }
    // Off this desk's list, and back: the row keeps its place with an Undo,
    // as a note's does, and the daemon is told after the rail has changed.
    else if (a === "doc-x") {
      const i = docList.findIndex(y => y.id === b.dataset.d), x = docList[i];
      if (x) {
        clearTimeout(docTimer);
        if (docGone) { const g = docGone.x; docList = docList.filter(y => y !== g); if (!docOff.some(y => y.id === g.id)) docOff = [g, ...docOff]; }
        docGone = { at: d.id, x, i: docList.indexOf(x) };
        docTimer = setTimeout(() => {
          if (docGone && docGone.x === x) { docGone = null; docList = docList.filter(y => y !== x); if (!docOff.some(y => y.id === x.id)) docOff = [x, ...docOff]; }
          if (current()) rail();
        }, BACK_MS);
        rail();
        if (byKey) ctx.tocEl.querySelector(`[data-a="doc-back"][data-d="${window.CSS.escape(x.id)}"]`)?.focus();
        await told(b.dataset, `d${x.id}`, "Could not remove it", () => { clearTimeout(docTimer); docGone = null; },
          () => ctx.api(`/api/desks/${d.id}/docs/${encodeURIComponent(x.id)}/remove`, {}));
      }
    } else if (a === "doc-back") {
      const id = b.dataset.d, g = docGone && docGone.x.id === id ? docGone : null;
      const x = g ? g.x : docOff.find(y => y.id === id);
      if (x) {
        if (g) { clearTimeout(docTimer); docGone = null; if (!docList.includes(x)) docList.splice(Math.min(g.i, docList.length), 0, x); }
        else { docOff = docOff.filter(y => y !== x); docList = [...docList, x].sort((p, q) => q.received_at - p.received_at); }
        rail();
        if (await told(b.dataset, `d${id}`, "Could not put it back", () => { docList = docList.filter(y => y !== x); if (g) docGone = g; else docOff = [x, ...docOff]; },
          () => ctx.api(`/api/desks/${d.id}/docs/${encodeURIComponent(id)}/restore`, {}))) docs();
      }
    } else if (a === "doc-offs") { offShown = !offShown; rail(); }
    else if (a === "reload") { if (b.dataset.w === "docs") { docsOff = null; docs(); } else { notesOff = null; getNotes(d.id, true); } }
    else if (a === "put" && v) put(v);
    else if (a === "again" && v) again(v);
    else if (a === "point-x" || a === "point-back") {
      const ps = points.get(b.dataset.p) || [], x = ps[+b.dataset.n];
      if (x) {
        // As a note does: the row holds the offer to bring it back, and only
        // the newest offer stands.
        clearTimeout(pointTimer);
        for (const [id, list] of points) points.set(id, list.filter(y => y === x || !y.gone));
        if (a === "point-x") {
          x.gone = true;
          pointTimer = setTimeout(() => {
            for (const [id, list] of points) { const k = list.filter(y => !y.gone); if (k.length) points.set(id, k); else points.delete(id); }
            if (current()) rail();
          }, BACK_MS);
        } else delete x.gone;
        rail();
        if (byKey && x.gone) ctx.tocEl.querySelector(`[data-a="point-back"][data-p="${b.dataset.p}"][data-n="${b.dataset.n}"]`)?.focus();
      }
    }
    // The list. Each of these draws first and tells the daemon after: on a
    // list, the thing that has to feel instant is the tick.
    else if (a === "note-new") {
      // From the head of a folded list: the list opens, and stays open.
      if (secFolded("notes")) { try { localStorage.setItem(FOLD("notes"), "0"); } catch {} }
      noteField = { kind: "new" }; noteDraft = ""; noteCaret = 0; rail();
    }
    else if (a === "note-edit") {
      const x = noteList.find(y => y.id === +b.dataset.n);
      if (x) { noteField = { kind: "edit", id: x.id }; noteDraft = x.text; noteCaret = x.text.length; rail(); }
    } else if (a === "note-tick") {
      const x = noteList.find(y => y.id === +b.dataset.n);
      if (x) {
        // The last open line, ticked: the mark says so once the daemon has it.
        const last = stillOpen(x) && !noteList.some(y => y !== x && stillOpen(y));
        x.done = !x.done;
        rail();
        // The daemon owns the order -- a line just ticked goes to the end of
        // the done half -- so the list is read back rather than guessed at.
        if (await told(b.dataset, `n${x.id}`, `Could not ${x.done ? "tick" : "untick"} this`, () => { x.done = !x.done; },
          () => ctx.api(`/api/desks/${d.id}/notes/${x.id}`, { done: x.done }))) { if (last && ctx.done) ctx.done(); await getNotes(d.id, true); }
      }
    } else if (a === "note-img") openLightbox(+b.dataset.n, +b.dataset.i, b);
    else if (a === "img-x") dropImage(+b.dataset.n, +b.dataset.i);
    else if (a === "img-back") imgBack();
    else if (a === "pend-x") { pending = []; rail(); }
    else if (a === "note-sha" || a === "want-copy") copySha(b);
    else if (a === "note-doc") ctx.read(b.dataset.d);
    else if (a === "note-ev") { if (/^https?:\/\//.test(b.dataset.u)) openLink(b.dataset.u); }
    else if (a === "note-keep") {
      const x = noteList.find(y => y.id === +b.dataset.n);
      if (x) {
        const by = x.suggested_by;
        x.suggested_by = "";
        rail();
        if (await told(b.dataset, `n${x.id}`, "Could not keep it", () => { x.suggested_by = by; },
          () => ctx.api(`/api/desks/${d.id}/notes/${x.id}/keep`, {}))) await getNotes(d.id, true);
      }
    }
    else if (a === "left-edit") leftOffEdit(d);
    else if (a === "left-back") leftOffBack(d);
    else if (a === "keys") keysSheet(d);
    else if (a === "key-x") keyRemove(d, b.dataset.n, !!b.dataset.every);
    else if (a === "key-back") keyBack(d);
    else if (a === "note-x") {
      const x = noteList.find(y => y.id === +b.dataset.n);
      if (x) {
        // Only the newest offer stands: two rows both saying Undo cannot both
        // mean the last thing that happened.
        clearTimeout(backTimer);
        noteList = noteList.filter(y => y === x || !y.gone);
        cleared = null;
        x.gone = true;
        backTimer = setTimeout(() => {
          noteList = noteList.filter(y => !y.gone);
          if (current()) rail();
        }, BACK_MS);
        rail();
        // A removal a key made leaves the hand on its Undo.
        if (byKey) ctx.tocEl.querySelector(`[data-a="note-back"][data-n="${x.id}"]`)?.focus();
        await told(b.dataset, `n${x.id}`, "Could not take it off", () => { clearTimeout(backTimer); delete x.gone; },
          () => ctx.api(`/api/desks/${d.id}/notes/${x.id}/remove`, {}));
      }
    } else if (a === "note-back") {
      const x = noteList.find(y => y.id === +b.dataset.n);
      clearTimeout(backTimer);
      if (x) {
        delete x.gone;
        rail();
        if (await told(b.dataset, `n${x.id}`, "Could not bring it back", () => { x.gone = true; },
          () => ctx.api(`/api/desks/${d.id}/notes/${x.id}/restore`, {}))) await getNotes(d.id, true);
      }
    } else if (a === "note-clear") {
      const xs = noteList.filter(y => y.done && !y.gone);
      if (xs.length) {
        const was = noteList;
        clearTimeout(backTimer);
        noteList = noteList.filter(y => !y.done && !y.gone);
        cleared = { at: d.id, xs };
        backTimer = setTimeout(() => { cleared = null; if (current()) rail(); }, BACK_MS);
        rail();
        if (!(await told(b.dataset, "clear", "Could not remove the done notes", () => { clearTimeout(backTimer); cleared = null; noteList = was; },
          () => Promise.all(xs.map(x => ctx.api(`/api/desks/${d.id}/notes/${x.id}/remove`, {})))))) getNotes(d.id, true);
      }
    } else if (a === "note-unclear" && cleared) {
      const c = cleared, xs = c.xs;
      clearTimeout(backTimer);
      cleared = null;
      noteList = noteList.concat(xs);
      rail();
      if (await told(b.dataset, "clear", "Could not bring them back", () => { noteList = noteList.filter(y => !xs.includes(y)); cleared = c; },
        () => Promise.all(xs.map(x => ctx.api(`/api/desks/${d.id}/notes/${x.id}/restore`, {}))))) await getNotes(d.id, true);
    }
  } catch (e) { ctx.toast(`Could not ${VERB[a] || "do it"}`, e); }
}

/** What each of the rail's other buttons was asked to do, for its error. */
const VERB = { new: "open a new panel", stop: "stop the panel", start: "start the panel", all: "start the panels", drop: "close the desk",
  copy: "copy it", put: "put the points in", again: "resume it", "pane-rename": "rename the panel" };

/** The daemon, asked for what the rail already shows. A no puts back what
 *  was changed (`back`) and says so in the row that asked (`k`), with a
 *  Retry that does the same thing again (`again`, the button's data).
 *  True when the daemon said yes. */
async function told(again, k, why, back, call) {
  try { await call(); return true; }
  catch (e) {
    back();
    rowErr = { k, why, raw: e.message, again: { ...again } };
    if (current()) rail();
    return false;
  }
}

/** Close a panel: its process stops, its row stays in the rail for BACK_MS
 *  with Undo, and the panels after it close up. Nothing asks first, since
 *  nothing is lost: the daemon keeps it until `prune`. */
async function closePanel(v, byKey) {
  const d = current();
  // The keyboard goes on to a neighbour, if it was in the one that closed:
  // it is not left on nothing, typing into nowhere.
  const ps = d.panes, i = ps.findIndex(p => p.id === v.id), next = (ps[i + 1] || ps[i - 1] || {}).id;
  const had = v.el.contains(document.activeElement);
  // "Closed · Undo" is said once it is true: until the daemon has it, the
  // panel's row says it is closing, and a no leaves it running.
  v.closing = true; rail();
  const ok = await told({ a: "close", p: v.id }, `p${v.id}`, `Could not close panel ${v.pane.slot}`, () => { v.closing = false; },
    () => ctx.api(`/api/panes/${v.id}/delete`, {}));
  if (!ok) return;
  clearTimeout(closedTimer);
  closedRow = { id: v.id, desk: d.id, name: `${v.pane.slot} ${short(v)}`, said: "" };
  closedTimer = setTimeout(() => { closedRow = null; if (current()) rail(); }, BACK_MS);
  await ctx.refresh();
  // A key's close leaves the hand on the Undo; a pointer's, on a neighbour.
  if (byKey) ctx.tocEl.querySelector("[data-a=pane-back]")?.focus();
  else if (next && (had || document.activeElement === document.body)) focusPane(next);
}

/** The head's ✕ asks first, in its own place: the first click turns it into
 *  "Close?", the second closes, and it goes back to a ✕ after three seconds
 *  untouched. The close is the rail's, so its Undo stands there as well. */
function closeAsked(v, b) {
  if (!b.dataset.armed) {
    b.dataset.armed = "1"; b.dataset.tip = "Click again to close";
    b.armT = setTimeout(() => { delete b.dataset.armed; b.dataset.tip = "Close panel"; }, 3000);
    return;
  }
  clearTimeout(b.armT);
  closePanel(v);
}

/** Undo a close. A desk that filled up in the meantime says so in the row,
 *  which keeps the rest of its time. */
async function restorePanel(id) {
  const c = closedRow;
  if (!c || c.id !== id) return;
  keepStopped.add(id);
  try { await ctx.api(`/api/panes/${id}/restore`, {}); }
  catch (e) {
    keepStopped.delete(id);
    if (/holds/.test(String(e))) c.said = "the desk filled up";
    else rowErr = { k: "closed", why: "Could not bring it back", raw: e.message, again: { a: "pane-back", p: id } };
    rail();
    return;
  }
  clearTimeout(closedTimer);
  closedRow = null;
  focused = id;
  await ctx.refresh();
}

/** Why a field is open again: under it, until the next key. */
function fieldErr(input, why) {
  if (input.nextElementSibling?.classList.contains("field-err")) input.nextElementSibling.remove();
  const p = Object.assign(document.createElement("span"), { className: "field-err", textContent: why });
  p.setAttribute("role", "alert");
  input.after(p);
  input.addEventListener("input", () => p.remove(), { once: true });
  input.addEventListener("blur", () => p.remove(), { once: true });
}

/** Name a panel, in its head, in place of the title its program sets. Empty
 *  gives the head back to the program. A name refused comes back in the
 *  field (`typed`), with why under it, as a note's does. */
function renamePanel(v, typed, why) {
  // A panel the grid has no room for is brought up first: its head is where the name goes.
  if (!v.el.isConnected && reading == null) focusPane(v.id);
  const nm = v.el.querySelector(".pn-cmd");
  if (!nm || !v.el.isConnected) return;
  const input = Object.assign(document.createElement("input"), { className: "ren-in", value: typed ?? (v.pane.name || ""), placeholder: short(v), spellcheck: false });
  input.setAttribute("aria-label", `Name of panel ${v.pane.slot}`);
  nm.replaceWith(input);
  input.focus(); input.select();
  if (why) fieldErr(input, why);
  let done = false;
  const finish = async keep => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    input.replaceWith(nm);
    if (keep && name !== (v.pane.name || "")) {
      try { await ctx.api(`/api/panes/${v.id}/rename`, { name }); v.pane.name = name; await ctx.refresh(); }
      catch (e) { header(v); rail(); return renamePanel(v, name, `Could not rename · ${ctx.sayErr(e).why}`); }
    }
    header(v); rail();
    v.body.focus();
  };
  input.addEventListener("keydown", e => {
    e.stopPropagation();
    if (e.key === "Enter") finish(true); else if (e.key === "Escape") finish(false);
  });
  for (const t of ["click", "dblclick", "pointerdown"]) input.addEventListener(t, e => e.stopPropagation());
  input.addEventListener("blur", () => finish(true));
}

/** The desk's name, rewritten where it is: in the desk's head. The meta
 *  pane no longer says it twice. */
function renameDesk(d, typed, why) {
  const nm = ctx.docEl.querySelector(".dk-head .dk-name");
  if (!nm) return;
  const input = Object.assign(document.createElement("input"), { className: "ren-in", value: typed ?? d.name, spellcheck: false });
  input.setAttribute("aria-label", "Name of this desk");
  nm.replaceWith(input);
  input.focus(); input.select();
  if (why) fieldErr(input, why);
  let done = false;
  const finish = async keep => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    if (keep && name && name !== d.name) {
      try { await ctx.api(`/api/desks/${d.id}/rename`, { name }); await ctx.refresh(); }
      // Refused: the field stays as typed, says why, and Enter asks again.
      catch (e) { if (input.isConnected) { done = false; fieldErr(input, `Could not rename · ${ctx.sayErr(e).why}`); input.focus(); return; } return renameDesk(d, name, `Could not rename · ${ctx.sayErr(e).why}`); }
    }
    if (input.isConnected) input.replaceWith(Object.assign(document.createElement("b"), { className: "dk-name", textContent: (current() || d).name }));
    rail();
  };
  input.addEventListener("keydown", e => {
    e.stopPropagation();
    if (e.key === "Enter") finish(true); else if (e.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(true));
}

function focusPane(id) {
  const v = views.get(id);
  if (!v) return;
  // While a document is the page, a pane's row is the way back to the desk,
  // with that pane focused.
  if (reading != null) { ctx.go(deskId, true, v.pane.slot); return; }
  focused = id;
  if (full) saveFull();
  layout();
  v.body.focus();
}

function click(e) {
  const m = e.target.closest("[data-desk-menu]");
  if (m) { const r = m.getBoundingClientRect(); ctx.menu?.(m, r.left, r.bottom + 4, e.detail === 0); return; }
  const f = e.target.closest("[data-focus]");
  if (f) { focusPane(f.dataset.focus); return; }
  const r = e.target.closest("a[data-read]");
  // The row of the document on the page is a toggle: a second click puts
  // the panes back, the way the first put the document up.
  if (r) { e.preventDefault(); if (r.dataset.read === reading) ctx.go(deskId, true); else ctx.read(r.dataset.read); return; }
  const b = e.target.closest("[data-a]");
  // `detail` is 0 for a click a key made: what it opens is then a keyboard's.
  if (b && !b.disabled) act(b, !e.detail);
}

/** Full view, as the slot it shows, kept by the daemon for this desk. */
function saveFull() {
  const d = current(), v = views.get(focused);
  if (!d) return;
  d.full_slot = full && v ? v.pane.slot : 0;
  ctx.api(`/api/desks/${d.id}/layout`, { col: d.col, row: d.row, full: d.full_slot }).catch(() => {});
}

/** The focused pane in full view, or the grid again. */
function zoom() {
  full = !full;
  saveFull();
  layout();
  const v = views.get(focused);
  if (v) v.body.focus();
}

/** ⌃⌥1 to ⌃⌥4: a pane by its slot, from anywhere on the desk. ⌃⌥Z: the
 *  focused pane alone. ⌃⌥⇧ and an arrow: the focused pane moved. ⌃⌥N a new
 *  panel, ⌃⌥W the focused one closed (with Undo in the rail), ⌃⌥] and ⌃⌥[
 *  the next and the previous focused, ⌃⌥R the focused one stopped or started. */
/** AltGr, which Windows reports as Ctrl+Alt: a character on its way (`~` on
 *  a German keyboard, `ń` on a Polish one), never a panel chord. */
const altGr = e => !!e.getModifierState?.("AltGraph");

function keys(e) {
  // F2 on a panel's row in the rail names it, as F2 on a file does.
  if (e.key === "F2" && !e.ctrlKey && !e.altKey && !e.metaKey && reading == null) {
    const f = document.activeElement?.closest?.(".dk-focus"), v = f && views.get(f.dataset.focus);
    if (v) { e.preventDefault(); e.stopPropagation(); renamePanel(v); }
    return;
  }
  if (!(e.ctrlKey && e.altKey) || e.metaKey || altGr(e)) return;
  if (e.shiftKey && NEXT[e.key]) {
    const d = current(), v = views.get(focused);
    if (reading != null || !d || !v) return;
    const to = NEXT[e.key][v.pane.slot - 1];
    e.preventDefault(); e.stopPropagation();
    if (to && d.panes.some(p => p.slot === to)) moveTo(v, to);
    return;
  }
  if (e.code === "KeyZ") { if (reading != null) return; e.preventDefault(); e.stopPropagation(); zoom(); return; }
  if (/^(Key[NWR]|Bracket(Left|Right))$/.test(e.code)) {
    const d = current(), v = views.get(focused);
    if (reading != null || !d) return;
    e.preventDefault(); e.stopPropagation();
    if (e.code === "KeyN") { const why = noNew(d); if (why) ctx.toast("New panel", why); else act({ dataset: { a: "new" } }); }
    else if (!v) return;
    else if (e.code === "KeyW") closePanel(v, true).catch(err => ctx.toast("Could not close the panel", err));
    else if (e.code === "KeyR") { if (v.status.running) ctx.api(`/api/panes/${v.id}/stop`, {}).catch(() => {}); else run(v, v.status.cmd || v.pane.cmd || ""); }
    else {
      const ps = d.panes, i = ps.findIndex(p => p.id === focused);
      focusPane(ps[(i + (e.code === "BracketRight" ? 1 : ps.length - 1)) % ps.length].id);
    }
    return;
  }
  if (!/^Digit[1-4]$/.test(e.code)) return;
  const d = current(), p = d && d.panes.find(x => x.slot === +e.code[5]);
  if (!p) return;
  e.preventDefault(); e.stopPropagation();
  focusPane(p.id);
}

const onResize = () => { if (current()) layout(); };

// ---------- the seam ----------

/** The document the desk stepped aside for, or null while the desk is the
 *  page. */
let reading = null;

function detach() {
  clearTimeout(retry);
  clearInterval(clock);
  if (!ctx) return;
  ctx.docEl.removeEventListener("click", click);
  ctx.tocEl.removeEventListener("click", click);
  ctx.tocEl.removeEventListener("toggle", folded, true);
  ctx.tocEl.removeEventListener("dragover", dragOver);
  ctx.tocEl.removeEventListener("dragleave", dragLeave);
  ctx.tocEl.removeEventListener("drop", dropped);
  window.removeEventListener("snyvi-paste-image", windowPaste);
  ctx.metaEl.removeEventListener("click", click);
  closeLightbox();
  document.removeEventListener("keydown", keys, true);
  document.removeEventListener("mouseup", pickUp);
  document.removeEventListener("keyup", pickKey);
  removeEventListener("scroll", hidePick, true);
  removeEventListener("resize", onResize);
  gridWatch?.disconnect(); gridWatch = null;
  hidePick();
}

/** The icons only a desk draws, added to the page's set when a desk opens
 *  (app.js ICONS): first paint does not carry them. */
const ICONS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  play: '<path d="M7 4.5v15l12-7.5z"/>',
  again: '<path d="M20 12a8 8 0 1 1-2.34-5.66L20 8.5"/><path d="M20 3.5v5h-5"/>',
  fill: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  unfill: '<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>',
};

export function open(c) {
  const first = !ctx;
  detach();
  ctx = c;
  Object.assign(c.icons || {}, ICONS);
  style();
  if (first) measure();
  if (deskId !== c.id) {
    for (const v of [...views.values()]) dropView(v);
    docList = []; docsAt = null; docsAll = false; forgetDocs(); forgetNotes(); hidePoints();
    focused = null; full = false; keysClose();
  }
  deskId = c.id; reading = null;
  // Home's "last touched" and the desk it offers to pick up start here.
  if (c.id != null) c.api(`/api/desks/${c.id}/visit`, {}).catch(() => {});
  keepPoints(c.desks);
  const d = current();
  if (d && c.slot) { const p = d.panes.find(x => x.slot === c.slot); if (p) focused = p.id; }
  draw();
  ctx.docEl.addEventListener("click", click);
  ctx.tocEl.addEventListener("click", click);
  ctx.tocEl.addEventListener("toggle", folded, true);
  ctx.tocEl.addEventListener("dragover", dragOver);
  ctx.tocEl.addEventListener("dragleave", dragLeave);
  ctx.tocEl.addEventListener("drop", dropped);
  window.addEventListener("snyvi-paste-image", windowPaste);
  ctx.metaEl.addEventListener("click", click);
  document.addEventListener("keydown", keys, true);
  // A passage selected in a document read over the desk can be kept as a
  // point for the panel that sent it (`picked`).
  document.addEventListener("mouseup", pickUp);
  document.addEventListener("keyup", pickKey);
  addEventListener("scroll", hidePick, true);
  addEventListener("resize", onResize);
  clock = setInterval(() => { if (current()) rail(); }, 30000);
  if (d && docsAt !== d.id) docs();
  const v = views.get(focused);
  if (v) setTimeout(() => v.body.focus(), 0);
}

/** The cell, measured in the font and size a pane is drawn in, and the
 *  drawn characters cut to it. Run once when the first desk opens, and again
 *  whenever Aa changes the size. */
function measure() {
  const [, px, line] = SIZES[sizeAt];
  LINE_PX = line;
  document.documentElement.style.setProperty("--pn-size", px + "px");
  document.documentElement.style.setProperty("--pn-line", line + "px");
  const probe = Object.assign(document.createElement("span"), { className: "pn-probe", textContent: "0".repeat(40) });
  document.body.append(probe);
  cellW = probe.getBoundingClientRect().width / 40 || cellW;
  probe.remove();
  // Measured in a stand-in if the pane's font is still on its way: measure
  // again once it is in, or every cell is the stand-in's width.
  if (document.fonts && document.fonts.status !== "loaded") document.fonts.ready.then(() => { if (ctx) remeasure(); });
  let g = document.getElementById("desk-drawn");
  if (!g) { g = document.createElement("style"); g.id = "desk-drawn"; document.head.append(g); }
  g.textContent = drawn(cellW, LINE_PX);
  for (const v of views.values()) if (v.rows) { sizeCanvas(v); drawAll(v); }
  // Cut in device pixels, so cut again when those change: a zoom, or the
  // window moved to a screen of another density.
  dprWatch?.abort(); dprWatch = new AbortController();
  matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`).addEventListener("change", measure, { once: true, signal: dprWatch.signal });
}
let dprWatch;

/** Measure again, and give every panel the columns and rows it now has. */
function remeasure() {
  measure();
  for (const v of views.values()) {
    if (v.rows) v.scr.style.height = v.rows * LINE_PX + "px";
    if (v.cur) cursor(v);
    fit(v);
  }
}

/** The terminal's text size: `step` of +1 or -1 moves it, 0 puts it back to
 *  Normal, and no step only reads it. Every panel is measured again and told
 *  its new columns and rows -- the same path a window resize takes, so the
 *  program redraws itself at the size it now has (resize-and-clear,
 *  docs/DESK.md). Returns the size's name and the next one up, for Aa. */
export function textSize(step) {
  if (step != null) {
    const to = step ? Math.max(0, Math.min(SIZES.length - 1, sizeAt + step)) : 1;
    if (to !== sizeAt) {
      sizeAt = to;
      try { localStorage.setItem("snyvi.term-size", SIZES[to][0]); } catch {}
      if (ctx) remeasure();
    }
  }
  return { name: SIZES[sizeAt][0], next: SIZES[(sizeAt + 1) % SIZES.length][0], at: sizeAt, of: SIZES.length };
}

/** The focused panel alone, or the grid again: what the width control means
 *  on a desk. How many panels there are, so it can say when one already fills
 *  it. */
/** What the context menu offers on this desk's surfaces (menu.js asks, with
 *  the element under the pointer or the focus): a panel, from its rail row,
 *  its head or its body; a document in the rail; a note; a point. Each entry
 *  runs what that surface's own control runs -- `act` with the same data a
 *  button carries -- so the two cannot disagree. "rule" is a rule. */
export function actions(el) {
  const R = "rule", d = current();
  if (!d) return null;
  const pane = el.closest(".dk-pane, .pn-head, .pn-body");
  if (pane) {
    const id = pane.matches(".dk-pane") ? pane.querySelector("[data-focus]")?.dataset.focus : pane.closest(".pn")?.dataset.id;
    const v = id && views.get(id);
    if (!v) return null;
    const does = a => () => act({ dataset: { a, p: v.id } });
    const body = pane.matches(".pn-body"), sel = getSelection();
    const picked = body && !sel.isCollapsed && v.body.contains(sel.anchorNode);
    const s = v.status;
    return { head: `Panel ${v.pane.slot} · ${short(v)}`, items: [
      picked && { label: "Copy", key: ctx.keyHint("ctrl+shift+c"), run: () => copy(v, true) },
      body && s.running && { label: "Paste", key: ctx.keyHint("ctrl+shift+v"), run: () => pasteText(v) },
      body && R,
      body && { label: "Text size +", key: ctx.keyHint("ctrl+="), run: () => { textSize(1); if (ctx.sized) ctx.sized(); } },
      body && { label: "Text size −", key: ctx.keyHint("ctrl+-"), run: () => { textSize(-1); if (ctx.sized) ctx.sized(); } },
      body && { label: "Reset text size", key: ctx.keyHint("ctrl+0"), run: () => { textSize(0); if (ctx.sized) ctx.sized(); } },
      body && R,
      v.id !== focused && { label: "Focus", key: ctx.keyHint(`ctrl+alt+${v.pane.slot}`), run: () => focusPane(v.id) },
      { label: full && v.id === focused ? "Back to the grid" : "Full view", key: ctx.keyHint("ctrl+alt+z"), run: () => { if (!(full && v.id === focused)) { focused = v.id; if (full) { saveFull(); layout(); v.body.focus(); return; } } zoom(); } },
      ...[1, 2, 3, 4].filter(n => n !== v.pane.slot).map(n => ({ label: `Move to position ${n}`, run: () => moveTo(v, n) })),
      R,
      s.running ? { label: "Stop", run: does("stop") } : { label: "Start", run: () => run(v, v.start.querySelector("input").value) },
      !s.running && talked(v) && { label: "Resume conversation", run: () => run(v, "", false, true) },
      R,
      { label: "Copy folder path", run: () => { navigator.clipboard?.writeText(v.pane.cwd); ctx.toast("Copied", v.pane.cwd); } },
      { label: "Open in file manager", run: () => ctx.reveal({ desk: d.id }) },
      R,
      { label: "Rename…", key: ctx.keyHint("f2"), moves: 1, run: () => renamePanel(v) },
      { label: "Close panel", key: ctx.keyHint("ctrl+alt+w"), danger: true, run: does("close") },
    ] };
  }
  const repo = el.closest(".dk-repo");
  if (repo) {
    const url = repo.getAttribute("href"), rn = repoName(url);
    return { head: rn ? rn.path : url, items: [
      { label: `Open on ${rn ? rn.host : "the web"}`, run: () => openLink(url) },
      { label: "Copy repo URL", run: () => { navigator.clipboard?.writeText(url); ctx.toast("Copied", url); } },
    ] };
  }
  const doc = el.closest(".dk-doc");
  if (doc) {
    const id = doc.querySelector("a[data-read]")?.dataset.read, x = docList.find(y => y.id === id);
    if (!x) return null;
    return { head: x.title, items: [
      { label: "Open", moves: 1, run: () => ctx.read(x.id) },
      x.source_path && { label: "Copy path", run: () => { navigator.clipboard?.writeText(x.source_path); ctx.toast("Copied", x.source_path); } },
      { label: "Copy link", run: () => { const u = `${location.origin}/d/${x.id}`; navigator.clipboard?.writeText(u); ctx.toast("Copied", u); } }, R,
      { label: "Remove from this list", run: () => act({ dataset: { a: "doc-x", d: x.id } }) },
    ] };
  }
  const point = el.closest(".dk-point");
  if (point) {
    const b = point.querySelector("[data-a=\"point-x\"]");
    const v = b && views.get(b.dataset.p);
    if (!v) return null;
    return { head: `A point for panel ${v.pane.slot}`, items: [
      { label: `Type into panel ${v.pane.slot}`, run: () => act({ dataset: { a: "put", p: v.id } }) }, R,
      { label: "Let go", danger: true, run: () => act({ dataset: { a: "point-x", p: b.dataset.p, n: b.dataset.n } }) },
    ] };
  }
  const note = el.closest(".dk-note");
  const n = note && note.querySelector("[data-a=\"note-tick\"]")?.dataset.n, x = n && noteList.find(y => y.id === +n);
  if (x) {
    const does = a => () => act({ dataset: { a, n: String(x.id) } });
    return { head: x.text, items: [
      { label: "Edit", run: does("note-edit") },
      { label: x.done ? "Untick" : "Tick", run: does("note-tick") },
      { label: "Add a picture…", run: () => pickImages(x.id) },
      ...(x.done && x.done_doc ? [{ label: "Open what it sent", run: () => ctx.read(x.done_doc) }] : []),
      ...(x.done && x.done_commit ? [{ label: "Copy commit", run: () => copySha(note.querySelector(".dk-sha")) }] : []), R,
      { label: "Remove from the list", danger: true, run: does("note-x") },
      ...(noteList.some(y => y.done && !y.gone) ? [{ label: "Remove done notes", run: does("note-clear") }] : []),
    ] };
  }
  return null;
}

/** Paste from the menu: the clipboard read as text, as ⌃⇧V would bring it.
 *  WebKit may refuse a read the page asks for itself; then the menu says
 *  which keys do it rather than doing nothing without a word. */
async function pasteText(v) {
  try {
    const t = await navigator.clipboard.readText();
    if (t) { v.typed = Date.now(); input(v, bracket(v, t)); }
    v.body.focus();
  } catch { ctx.toast("Paste with ⌃⇧V", "the window would not hand the clipboard to the menu"); }
}

export const zoomOn = () => { zoom(); return full; };
export const isFull = () => full;
export const startAll = () => act({ dataset: { a: "all" } });
export const renameHere = () => { const d = current(); if (d) renameDesk(d); };
export const keysHere = () => { const d = current(); if (d) keysSheet(d); };

export function update(desks) {
  if (!ctx) return;
  ctx.desks = desks;
  keepPoints(desks);
  const d = current();
  // Behind a document, the page is not the desk's to draw: the rail is.
  if (reading != null) { if (d) { sync(d); rail(); } else { ctx.tocEl.innerHTML = ctx.metaEl.innerHTML = ""; } return; }
  if (!d || !ctx.docEl.querySelector(".dk")) { draw(); return; }
  ctx.docEl.querySelector(".dk-name").textContent = d.name;
  sync(d);
  rail();
}

/** The desk steps aside for a document: the page becomes the document's,
 *  and the rail stays the desk's, with the document's row marked. The panes
 *  keep their socket and their scrollback -- a frame lands on a pane that is
 *  simply not in the page -- so coming back is a redraw, not a reconnect. */
export function aside(docId) {
  if (!ctx || deskId == null) return;
  reading = docId;
  pace();
  delete ctx.root.dataset.full;
  hidePick();
  ctx.docEl.removeEventListener("click", click);
  if (current()) rail();
}

export function close() {
  if (!ctx) return;
  say({ t: "watch", panes: [] });
  delete ctx.root.dataset.full;
  deskId = null; reading = null;
  for (const v of [...views.values()]) dropView(v);
  focused = null;
  docList = []; docsAt = null; docsAll = false;
  forgetDocs(); forgetNotes(); hidePoints();
  detach();
  ctx.tocEl.innerHTML = ctx.metaEl.innerHTML = "";
}
