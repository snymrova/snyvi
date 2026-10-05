/* What a folder, a document, a project and a desk can be asked to do, after
 * a click -- and the context menu, for every one of them.
 *
 * Every entry point here waits for a pointer: the right-click that opens the
 * folder menu, the desk glyph on a folder's row, the row that opens a folder,
 * the ✕ on a desk. None of it runs while the page is being painted, and a
 * reader who only ever reads documents never fetches a byte of it -- which is
 * the whole reason it is a file rather than a block in app.js. The sidebar
 * still *draws* its desks at first paint; `renderDesks` stays there. This is
 * only what happens when one is asked for.
 *
 * Nothing here holds page state of its own but the menu element and the two
 * flags that guard a dialog and a double click. Everything else arrives in
 * `ctx`, made once by app.js, so this file cannot drift into a second copy of
 * what the page already knows.
 */

/** The menu element. Made on the first right-click and kept after that: a
 *  reader who uses it once uses it again. */
let menu = null;
/** A folder dialog is the desktop's, and it is modal there: asking twice puts
 *  two of them on the screen and the second has no window to come back to. */
let picking = false;

/** The desktop's own folder dialog, which the daemon shows, and the folder the
 *  reader chose, opened -- or, for a desk, a desk made on it. The page names
 *  no path. Only the window can ask -- the same gate the desks are behind --
 *  so a tab is told where it can be done instead. */
export async function pick(ctx, forDesk = false) {
  const { capability, state, toast, browseEl } = ctx;
  if (!capability) { toast("Folders open from the snyvi window", { sub: "or from a terminal · snyvi browse <folder>", face: null }); return; }
  if (picking) return;
  picking = true;
  browseEl.classList.add("picking");
  try {
    const r = await fetch("/api/browse/pick", { method: "POST", headers: { "x-snyvi-capability": capability } });
    if (r.status === 204) return;   // closed without a choice
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { toast("Could not open a folder", { sub: new Error(j.error || `${r.status}`) }); return; }
    if (!state.browse.some(x => x.id === j.root.id)) state.browse = state.browse.concat(j.root);
    ctx.drawBrowse();
    // Kept under Folders either way: it is a folder the reader works in now.
    // One that has a desk already shows it, as a project's desk glyph does;
    // a second desk on it is its own menu's New desk here.
    if (forDesk) {
      const trim = p => p && p.replace(/(.)\/+$/, "$1");
      const had = state.desks && state.desks.desks.find(d => trim(d.root) === trim(j.root.path));
      if (had) ctx.show(had.id, true);
      else await make(ctx, { root: j.root.id, path: "" });
      return;
    }
    // Open in the sidebar as well as on the page; the toggle fills its tree.
    const d = browseEl.querySelector(`.b-root[data-root="${j.root.id}"]`);
    if (d) d.open = true;
    ctx.browse(j.root.id, "", true);
  } catch (e) { toast("Could not open a folder", { sub: e }); }
  finally { picking = false; browseEl.classList.remove("picking"); }
}

/** A new desk on folder `f` -- a folder under Folders, or a project by its
 *  id -- or with none on no folder: it starts in the home directory, which
 *  the daemon names. */
export async function make(ctx, f) {
  const { toast, api } = ctx;
  try {
    const j = await api("/api/desks", !f ? {} : f.project != null ? { project: f.project, name: f.name } : { root: f.root, path: f.path });
    // A desk for a project opens on Claude, ready: the first panel holds
    // `claude` in its Start field, and the reader's Enter runs it -- nothing
    // starts in their name. Without Claude Code here, and on the home
    // folder's desk, it opens on a shell, started, as it always did.
    const claude = !!f && await hasClaude();
    try {
      const p = await api(`/api/desks/${j.desk.id}/panes`, claude ? { cmd: "claude" } : {});
      if (claude) ctx.hold(p.pane.id);
      else await api(`/api/panes/${p.pane.id}/start`, { cmd: "" });
    } catch (e) { toast(claude ? "Could not open Claude's panel" : "Could not start the new desk's shell", { sub: e }); }
    await ctx.load();
    ctx.show(j.desk.id, true);
  } catch (e) { toast("Could not make a desk", { sub: e }); }
}

/** The studio desk: the one there is, the closed one back, or New studio
 *  desk's dialog (studio.js) -- from the + menu, the palette and Home. */
export function studioDesk(ctx) {
  return ctx.studio().then(m => m.newDesk(ctx, { hold: claudeHere }), e => ctx.toast("Could not open the studio", { sub: e }));
}

/** Whether `claude` can run here: on the daemon's PATH, or set up (which
 *  it would not be without it). */
const claudeHere = () => hasClaude();
async function hasClaude() {
  try {
    const a = await (await fetch("/api/agents")).json();
    return !!a.claude_on_path || a.rows.some(r => r.id === "claude" && r.state === "connected");
  } catch { return false; }
}

/** The desk glyph on a project's row: the project's desk when it has one,
 *  and a new one on its folder, named for it, when it does not. */
export async function projectDesk(ctx, pid) {
  const p = ctx.state.tree.find(x => x.id === pid);
  if (!p) return;
  const trim = s => s && s.replace(/(.)\/+$/, "$1");
  const d = ctx.state.desks && ctx.state.desks.desks.find(x => trim(x.root) === trim(p.root));
  if (d) ctx.show(d.id, true);
  else await make(ctx, { project: pid, name: p.name });
}

/** The ✕ on a desk's row. Closing a desk ends its panels' processes, and there
 *  is no undoing that, so the first click asks and the second closes, as Close
 *  desk does in the desk's own rail. */
export async function drop(ctx, b) {
  if (ctx.armed(b, { label: "Close desk?", sub: ends(ctx, +b.dataset.dropdesk) })) await dropDesk(ctx, +b.dataset.dropdesk);
}
/** What closing a desk ends, in the words the ask uses: "Ends 3 panels". */
function ends(ctx, id) {
  const n = ctx.state.desks?.desks.find(d => d.id === id)?.panes.length || 0;
  return n ? `Ends ${n} panel${n === 1 ? "" : "s"}` : "Nothing is running on it";
}

/** Turn a name in the tree into a field, in place. Enter and blur keep what was
 *  typed, Escape abandons it; the label goes back the moment either happens, so
 *  the tree is never left holding an input. */
/** Why a field is open again: under it, until the next key. */
function fieldErr(input, why) {
  const p = Object.assign(document.createElement("span"), { className: "field-err", textContent: why });
  p.setAttribute("role", "alert");
  input.after(p);
  input.addEventListener("input", () => p.remove(), { once: true });
  input.addEventListener("blur", () => p.remove(), { once: true });
}

/** A name typed and refused comes back in the field (`typed`), with why. */
export function rename(ctx, holder, what, id, typed, why) {
  const { toast } = ctx;
  const label = holder.querySelector(":scope > .nm");
  if (!label || holder.querySelector("input.ren-in")) return;
  const before = label.textContent, cls = label.className;
  const input = document.createElement("input");
  input.className = "ren-in";
  input.value = typed ?? before;
  input.spellcheck = false; input.autocomplete = "off";
  input.setAttribute("aria-label", `Name of this ${what}`);
  label.replaceWith(input);
  holder.classList.add("renaming");
  input.focus(); input.select();
  if (why) fieldErr(input, why);

  let settled = false;
  const finish = async keep => {
    if (settled) return;
    settled = true;
    const next = input.value.trim();
    const label = document.createElement("span");
    label.className = cls;
    label.textContent = before;
    input.replaceWith(label);
    holder.classList.remove("renaming");
    if (!keep || !next || next === before) return;
    label.textContent = next;   // stands in until the tree comes back
    try {
      // A desk is renamed behind the window's capability, as everything
      // about a desk is; a project or a workflow by anyone reading.
      if (what === "desk") { await ctx.api(`/api/desks/${id}/rename`, { name: next }); await ctx.load(); }
      else {
        const where = what === "project" ? "projects" : "workflows";
        const r = await fetch(`/api/${where}/${id}/rename`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: next }),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        await ctx.applyRename(what, id);
      }
    } catch (e) {
      label.textContent = before;
      if (holder.isConnected) rename(ctx, holder, what, id, next, `Could not rename · ${ctx.sayErr(e).why}`);
      else toast(`Could not rename ${before}`, { sub: e });
    }
  };
  // The app answers single keys, and Escape closes find and the palette.
  input.addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); finish(true); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(false); }
    else e.stopPropagation();
  });
  input.addEventListener("blur", () => finish(true));
  // A click in the field must not open the document or fold the project.
  input.addEventListener("click", e => { e.preventDefault(); e.stopPropagation(); });
}

export async function terminal(ctx, body) {
  const { toast } = ctx;
  try {
    const r = await fetch("/api/terminal", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    // The terminal opening is the answer; only a refusal is said.
    if (!r.ok) toast("Could not open a terminal", { sub: new Error(j.error || `${r.status}`) });
  } catch (e) { toast("Could not open a terminal", { sub: e }); }
}
/** The same place, in the file manager -- Files, Finder, Explorer. The same
 *  ids go over and the daemon resolves them the same way; a desk's folder
 *  goes with the capability, behind the desk's gate. */
export async function reveal(ctx, body) {
  const { toast } = ctx;
  try {
    await (body.desk != null ? ctx.api("/api/reveal", body) : (async () => {
      const r = await fetch("/api/reveal", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `${r.status}`);
    })());
    // The file manager opening is the answer; only a refusal is said.
  } catch (e) { toast("Could not open the folder", { sub: e }); }
}

/** A document the page holds, wherever it is: on screen, waiting, or in a
 *  project whose rows are filled. The menu reads its title, pin and path. */
function docById(ctx, id) {
  const { state } = ctx;
  if (state.doc && state.doc.id === id) return state.doc;
  const q = state.queue.find(d => d.id === id);
  if (q) return q;
  for (const wfs of state.sub.values()) for (const w of wfs) for (const d of w.docs) if (d.id === id) return d;
  return null;
}

/** Pin or unpin any document, as `p` does the one on screen: app.js's
 *  `pin`, with where the item stood, since the menu has gone by the answer. */
async function pin(ctx, id, at) {
  const { state } = ctx;
  const d = (state.doc?.id === id && state.doc) || docById(ctx, id) || await fetch(`/api/docs/${id}`).then(r => r.json()).then(j => j.doc).catch(() => null);
  if (d) ctx.pin(d, at);
}

/** Off the inbox, as the row's ✕ does: through that ✕ when the row has one,
 *  so its ghost and Undo stand where the right-click was. */
function remove(ctx, id, el) {
  const x = el && el.querySelector("[data-deldoc]");
  if (x) x.click(); else ctx.deleteDoc(docById(ctx, id) || { id, title: ctx.knownDocs.get(id)?.title || "Document" });
}



/** A panel on a desk, started, and the desk shown: the desk's own +. A
 *  studio desk's is its Claude. */
async function newPanel(ctx, d) {
  const id = d.id, studio = d.kind === "studio";
  try {
    const p = await ctx.api(`/api/desks/${id}/panes`, studio ? { cmd: "claude" } : {});
    await ctx.api(`/api/panes/${p.pane.id}/start`, { cmd: studio ? p.pane.cmd || "claude" : "" });
    await ctx.load();
    ctx.show(id, true);
  } catch (e) { ctx.toast("Could not open a panel", { sub: e }); }
}

/** Close a desk and its panels, with Undo; the asking twice is the caller's. */
async function dropDesk(ctx, id) {
  const { state } = ctx;
  const name = state.desks?.desks.find(d => d.id === id)?.name || "the desk";
  try { await ctx.api(`/api/desks/${id}/delete`, {}); }
  catch (e) { ctx.toast("Could not close the desk", { sub: e }); return; }
  ctx.forget(id);
  await ctx.load();
  if (state.view === "desk" && state.deskId === id) ctx.show(null, true);
  // Closed, not deleted: its notes wait on it until prune.
  ctx.toast(`Closed ${name}`, { sub: "Its notes are kept", action: { label: "Undo", run: async () => {
    try { await ctx.api(`/api/desks/${id}/reopen`, {}); } catch (e) { ctx.toast("Could not reopen the desk", { sub: e }); return; }
    await ctx.load(); ctx.show(id, true);
  } } });
}

/** What a right-click can be asked about, one list per kind of thing, and
 *  the one menu that draws them. An entry is `{ label, key, danger, sure,
 *  run }`, and `RULE` between two is a rule; anything falsy is an entry
 *  that does not apply here, and is left out. What an entry does is the same
 *  code its button already runs -- the row's ✕, the rail's Close, the desk
 *  glyph -- reached through `ctx`, so the menu cannot drift into a second
 *  copy of any of it. A thing that cannot be done here is left out, never
 *  greyed: a browser tab has no desks and no terminals, and its menus say so
 *  by not offering them. Open or show comes first, then change it, then copy
 *  or reveal, and remove or close last, in the danger colour, below a rule.
 *  The desk's own surfaces -- a panel, a rail row, a note, a point -- are the
 *  desk module's to describe (`actions` in desk.js), since it holds their
 *  state; it is asked only when it is already loaded, which it is whenever
 *  one of them is on the page. */
const RULE = "rule";
function entries(ctx, el, byKey = false) {
  const { capability } = ctx, copyIt = (text, what) => ({ label: what, run: at => ctx.copied(text, at) });
  const term = body => capability && { label: "Open terminal here", run: () => terminal(ctx, body) };
  const files = body => ({ label: "Open in file manager", run: () => reveal(ctx, body) });
  // snyvi's own mark: the one setting that is about snyvi itself.
  if (el.matches(".brand-mark")) return { head: "snyvi", items: [
    { label: "Check for updates", run: at => ctx.checkUpdates(at) },
    { label: document.documentElement.dataset.mascot === "quiet" ? "Lively mascot" : "Quiet mascot", run: () => ctx.toggleQuiet() },
  ] };
  if (el.matches(".b-root > summary, .b-dir > details > summary")) {
    const f = ctx.folderOf(el);
    if (!f) return null;
    const here = ctx.state.desks ? ctx.state.desks.desks.filter(d => d.root === f.abs) : [];
    const root = el.matches(".b-root > summary");
    return { head: f.abs.split("/").pop() || f.abs, items: [
      capability && { label: "New desk here", run: () => make(ctx, f) },
      ...(capability ? here.map(d => ({ label: `Show desk ${d.name}`, moves: 1, run: () => ctx.show(d.id, true) })) : []),
      capability && RULE,
      term({ root: f.root, path: f.path }), files({ root: f.root, path: f.path }), copyIt(f.abs, "Copy path"),
      root && RULE, root && { label: "Close folder", danger: true, run: () => ctx.closeRoot(f.root) },
    ] };
  }
  if (el.matches("a[data-browse]")) {
    const root = el.dataset.browse, path = el.dataset.path || "", r = ctx.state.browse.find(x => x.id === root), abs = r ? r.path + (path ? "/" + path : "") : "";
    return { head: path.split("/").pop() || abs, items: [
      { label: "Open", moves: 1, run: () => ctx.browse(root, path, true) }, RULE,
      term({ root, path }), files({ root, path }), abs && copyIt(abs, "Copy path"),
    ] };
  }
  if (el.matches(".t-proj > summary")) {
    const pid = +el.parentElement.dataset.pid, p = ctx.state.tree.find(x => x.id === pid);
    if (!p) return null;
    const here = capability && p.root && ctx.state.desks ? ctx.state.desks.desks.filter(d => d.root === p.root) : [];
    return { head: p.name, items: [
      capability && p.root && { label: "New desk here", run: () => make(ctx, { project: pid, name: p.name }) },
      ...here.map(d => ({ label: `Show desk ${d.name}`, moves: 1, run: () => ctx.show(d.id, true) })),
      { label: "Rename…", key: "F2", moves: 1, run: () => rename(ctx, el, "project", pid) }, RULE,
      term({ project: pid }), files({ project: pid }), p.root && copyIt(p.root, "Copy path"), RULE,
      { label: "Remove from the sidebar", danger: true, run: () => ctx.putAway(pid) },
    ] };
  }
  if (el.matches("a[data-id]")) {
    const id = el.dataset.id, d = docById(ctx, id), path = d && d.source_path;
    return { head: d ? d.title : el.querySelector(".title")?.textContent || "Document", items: [
      { label: "Open", moves: 1, run: () => ctx.open(id) },
      { label: d && d.pinned ? "Unpin" : "Pin", key: "p", run: at => pin(ctx, id, at) }, RULE,
      path && copyIt(path, "Copy path"), copyIt(`${location.origin}/d/${id}`, "Copy link"),
      term({ doc: id }), files({ doc: id }), RULE,
      { label: "Remove", key: "Del", danger: true, run: () => remove(ctx, id, el) },
    ] };
  }
  // A desk's row in the sidebar, and the ⋯ at the end of the desk's own
  // head: one menu, less Show on the desk that is already the page, with
  // what the head's desk can do besides -- start what is stopped, and full view.
  if (el.matches("a[data-desk], [data-desk-menu]")) {
    const here = el.matches("[data-desk-menu]"), dk = here && ctx.desk;
    const id = +(el.dataset.desk || el.dataset.deskMenu), d = ctx.state.desks && ctx.state.desks.desks.find(x => x.id === id);
    if (!d || !capability) return null;
    return { head: d.name, items: [
      !here && { label: "Show", run: () => ctx.show(id, true) },
      d.panes.length < (d.kind === "studio" ? 1 : ctx.state.desks.per_desk) && { label: "New panel", key: here ? ctx.keyHint("ctrl+alt+n") : "", run: () => newPanel(ctx, d) },
      dk && d.panes.some(p => !(p.status && p.status.running)) && { label: "Start all", run: () => dk.startAll() },
      dk && d.panes.length && { label: dk.isFull() ? "Back to the grid" : "Full view", key: ctx.keyHint("ctrl+alt+z"), run: () => dk.zoomOn() },
      { label: "Rename…", key: here ? "" : "F2", moves: 1, run: () => dk ? dk.renameHere() : rename(ctx, el, "desk", id) },
      dk && { label: "Keys…", run: () => dk.keysHere() },
      dk && d.kind === "studio" && { label: "Studio folder…", run: () => dk.studioHere() }, RULE,
      // Where it is in the list; what cannot move it is not offered.
      ...(here ? [] : moves(ctx, id, byKey)),
      term({ desk: id }), files({ desk: id }), copyIt(d.root, "Copy path"), RULE,
      { label: "Close desk", danger: true, sure: ends(ctx, id), run: () => dropDesk(ctx, id) },
    ] };
  }
  // `+ New desk`, wherever it is -- the Desks head, the empty Desks row, the
  // Desks page -- asks where before it makes anything: a desk is for a
  // project, and one in the home folder is the exception, so it is last.
  if (el.matches("[data-newdesk]:not(.b-new), [data-a=make]")) {
    if (!capability) return null;
    const places = ctx.places();
    return { head: "New desk in…", items: [
      ...places.map(f => ({ label: f.name, moves: 1, run: () => make(ctx, f) })),
      places.length && RULE,
      { label: "Another folder…", run: () => pick(ctx, true) },
      { label: "A shell in your home folder", moves: 1, run: () => make(ctx, null) },
      RULE,
      // The studio desk is a folder's pictures, video and sound with one
      // Claude under them; its dialog asks for the folder, and once there
      // is one, this opens it (studio.js).
      { label: "Studio desk…", moves: 1, run: () => studioDesk(ctx) },
    ] };
  }
  return ctx.desk && ctx.desk.actions ? ctx.desk.actions(el) : null;
}

/** The desks in the reader's order: `ids`, top first, drawn at once and then
 *  sent. A no puts the list back as it was, and the row that moved says so. */
async function order(ctx, ids, moved, byKey) {
  const ds = ctx.state.desks;
  if (!ds) return;
  const was = ds.desks, by = new Map(was.map(d => [d.id, d]));
  if (ids.join() === was.map(d => d.id).join() || ids.some(id => !by.has(id))) return;
  ds.desks = ids.map(id => by.get(id));
  ctx.drawDesks();
  if (byKey) ctx.focusDesk(moved);
  try { await ctx.api("/api/desks/order", { ids }); }
  catch (e) { ds.desks = was; ctx.deskSaid(moved, "Couldn't move it", e); if (byKey) ctx.focusDesk(moved); }
}

/** Desk `id` one place up (-1) or down (1), or to the top ("top"): its menu
 *  and ⌥↑ ⌥↓ on its row. */
export function moveDesk(ctx, id, by, byKey = false) {
  const ids = (ctx.state.desks ? ctx.state.desks.desks : []).map(d => d.id), i = ids.indexOf(id);
  const to = by === "top" ? 0 : Math.max(0, Math.min(ids.length - 1, i + by));
  if (i < 0 || to === i) return;
  ids.splice(i, 1); ids.splice(to, 0, id);
  return order(ctx, ids, id, byKey);
}

/** A desk row's menu entries for its place in the list. */
function moves(ctx, id, byKey) {
  const ids = ctx.state.desks.desks.map(d => d.id), i = ids.indexOf(id), last = ids.length - 1;
  return [
    i > 1 && { label: "Move to top", run: () => moveDesk(ctx, id, "top", byKey) },
    i > 0 && { label: "Move up", key: ctx.keyHint("alt+↑"), run: () => moveDesk(ctx, id, -1, byKey) },
    i < last && { label: "Move down", key: ctx.keyHint("alt+↓"), run: () => moveDesk(ctx, id, 1, byKey) },
    ids.length > 1 && RULE,
  ];
}

/** A desk's row, dragged to another place. The rows stay where they are
 *  while it moves -- nothing shifts under the pointer -- and a line says
 *  where it will land; the list changes once, on the drop. Esc puts it back,
 *  and a press that never travelled is the click it was. */
export function dragDesk(ctx, a, e) {
  const rows = [...a.closest(".t-desks").querySelectorAll(".t-desk > a[data-desk]")];
  if (rows.length < 2 || e.button !== 0) return;
  const id = +a.dataset.desk, x0 = e.clientX, y0 = e.clientY;
  let line = null, at = -1;
  const move = ev => {
    if (!line) {
      if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 6) return;
      line = document.createElement("div");
      line.className = "t-drop";
      document.body.append(line);
      a.classList.add("dragging");
      document.documentElement.classList.add("desk-drag");
    }
    // The gap nearest the pointer: before the first row whose middle is below it.
    at = rows.findIndex(r => { const b = r.getBoundingClientRect(); return ev.clientY < b.top + b.height / 2; });
    if (at < 0) at = rows.length;
    const b = rows[Math.min(at, rows.length - 1)].getBoundingClientRect();
    line.style.cssText = `left:${b.left}px;width:${b.width}px;top:${(at < rows.length ? b.top : b.bottom) - 1}px`;
  };
  const end = go => {
    removeEventListener("pointermove", move);
    removeEventListener("pointerup", up);
    removeEventListener("pointercancel", off);
    removeEventListener("keydown", key, true);
    if (!line) return;
    line.remove();
    a.classList.remove("dragging");
    document.documentElement.classList.remove("desk-drag");
    // The click that ends a drag is not a click on the row.
    const eat = c => { c.preventDefault(); c.stopPropagation(); };
    addEventListener("click", eat, { capture: true, once: true });
    setTimeout(() => removeEventListener("click", eat, true), 0);
    if (!go) return;
    const ids = rows.map(r => +r.dataset.desk), from = ids.indexOf(id);
    ids.splice(from, 1);
    ids.splice(at > from ? at - 1 : at, 0, id);
    order(ctx, ids, id, false);
  };
  const up = () => end(true), off = () => end(false);
  const key = k => { if (k.key === "Escape" && line) { k.preventDefault(); k.stopPropagation(); end(false); } };
  addEventListener("pointermove", move);
  addEventListener("pointerup", up);
  addEventListener("pointercancel", off);
  addEventListener("keydown", key, true);
}

/** The menu for `el`, at a point -- the pointer's, or the element's corner
 *  when a key asked. Returns false when `el` has nothing to offer, so the
 *  caller can leave the browser's own menu alone. */
export function open(ctx, el, x, y, byKey = false) {
  const m = entries(ctx, el, byKey);
  // Rules only between two entries: none leading, trailing or doubled.
  const items = m ? m.items.filter(Boolean).filter((e, i, a) => e !== RULE || (i > 0 && a[i - 1] !== RULE && a.slice(i + 1).some(x => x !== RULE))) : [];
  if (!items.some(e => e !== RULE)) return false;
  if (!menu) install(ctx);
  shown = items;
  // Where the focus goes back to when the menu goes: what had it, for a
  // key; for a pointer, the row that was right-clicked (or the nearest
  // thing in it that takes focus), so a keyboard picks up where it was.
  opener = byKey ? document.activeElement : el.closest("a[href], button, summary, [tabindex]") || el;
  menu.innerHTML = `<div class="ctx-head">${ctx.esc(m.head)}</div>` + items.map((e, i) => e === RULE ? `<hr role="separator">`
    : `<button type="button" role="menuitem" data-i="${i}"${e.danger ? ' class="danger"' : ""}><span>${ctx.esc(e.label)}</span>${e.key ? `<kbd>${ctx.esc(e.key)}</kbd>` : ""}</button>`).join("");
  menu.hidden = false;
  // Below the point when it fits, above it when it does not, and scrolled
  // when the window is shorter than the menu.
  const w = menu.offsetWidth, h = menu.offsetHeight;
  menu.style.left = Math.max(4, Math.min(x, innerWidth - w - 8)) + "px";
  menu.style.top = (y + h <= innerHeight - 8 ? y : Math.max(4, y - h)) + "px";
  menu.querySelector("button").focus({ preventScroll: true });
  return true;
}

/** The entries the menu on screen was drawn from, and the element that had
 *  the focus when a key opened it -- where Escape puts the focus back. */
let shown = [], opener = null;

const close = (back = false) => {
  if (!menu || menu.hidden) return;
  menu.hidden = true; shown = [];
  if (back && opener && opener.isConnected) opener.focus({ preventScroll: true });
  opener = null;
};

/** The element and its listeners, once. The `contextmenu` that brings us here
 *  stays in app.js -- something has to be listening before this file is
 *  fetched -- and everything that acts on an open menu is hung here. */
/** The menu's look, with the menu: a page that never right-clicks never
 *  pays for it (bench/bytes.mjs). Theme tokens only, so every theme has it. */
const CSS = `
/* The folded sidebar's popover: it only ever opens through pop() below. */
#pop { position: fixed; left: 50px; top: 8px; z-index: var(--z-pop); width: var(--side-w); max-height: calc(100vh - 16px); overflow: auto; overscroll-behavior: contain;
  padding: 2px 8px 8px; background: var(--bg-raise); border: 1px solid var(--rule); border-radius: var(--r-sm); box-shadow: var(--shadow);
  animation: sheet-l var(--dur-quick) var(--ease-out); }
#pop > #note { margin: 6px 0 0; }
#pop > :first-child .s-head { margin-top: 4px; }
@media (max-width: 760px) { #pop { inset: 0 auto 0 44px; top: 0 !important; width: min(88vw, var(--side-w)); max-height: none; border-radius: 0; border-width: 0 1px 0 0; } }
#ctx { position: fixed; z-index: var(--z-pop); min-width: 200px; max-width: 320px; max-height: calc(100vh - 16px); overflow-y: auto; padding: 4px; background: var(--bg-raise); border: 1px solid var(--rule); border-radius: 8px; box-shadow: var(--shadow); font-size: var(--fs-ui); transform-origin: 0 0; animation: ctx-in var(--dur-instant) ease-out; }
@keyframes ctx-in { from { opacity: 0; transform: scale(.97); } }
@media (prefers-reduced-motion: reduce) { #ctx { animation: none; } }
/* What the menu acts on, named at its top: a right-click in a busy grid
   says which panel it meant. */
#ctx .ctx-head { padding: 4px 10px 5px; font-size: var(--fs-small); color: var(--fg-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; border-bottom: 1px solid var(--rule); margin-bottom: 4px; }
#ctx button { display: flex; align-items: baseline; gap: 16px; width: 100%; text-align: left; padding: 5px 10px; border-radius: var(--r-sm); color: var(--fg-2); }
#ctx button > span { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#ctx button kbd { flex: none; min-width: 0; color: var(--fg-3); background: none; border: 0; padding: 0; }
#ctx button:hover { background: var(--rule); }
#ctx button:focus { background: var(--accent-bg); color: var(--accent); outline: none; }
#ctx button.danger { color: var(--danger); }
#ctx button.danger:hover, #ctx button.danger:focus, #ctx button[data-armed] { background: color-mix(in srgb, var(--danger) 12%, transparent); color: var(--danger); }
#ctx hr { border: 0; border-top: 1px solid var(--rule); margin: 4px 2px; }
`;

/** The look goes in with whichever comes first, a menu or a popover: the
 *  rail's popover is styled here too, and a reader who folds the sidebar
 *  may never have right-clicked. */
let styled = false;
function sheet() {
  if (styled) return;
  styled = true;
  const st = document.createElement("style");
  st.textContent = CSS;
  document.head.append(st);
}

function install(ctx) {
  sheet();
  menu = document.createElement("div");
  menu.id = "ctx"; menu.hidden = true; menu.setAttribute("role", "menu");
  document.body.append(menu);
  menu.addEventListener("click", e => {
    const b = e.target.closest("[data-i]"), it = b && shown[+b.dataset.i];
    if (!it) return;
    // Ending a process asks twice, in its own place: the entry says what the
    // next click does, and goes back after three seconds.
    if (it.sure && !ctx.armed(b, { label: `${it.label}?`, sub: it.sure, text: b.firstElementChild })) return;
    // Where the item stood, taken before the menu goes: an answer that has
    // no control left to stand beside stands there (`pin`).
    const at = b.getBoundingClientRect();
    // The focus goes back where the menu came from, unless the entry moves
    // it itself -- renaming, opening, going to a desk (`moves`).
    close(!it.moves);
    Promise.resolve().then(() => it.run(at)).catch(err => ctx.toast(`Could not ${it.label.replace(/…$/, "").toLowerCase()}`, { sub: err, at }));
  });
  // The item under the pointer is the one with the focus: one row lit, and
  // Enter acts on it.
  menu.addEventListener("pointermove", e => { const b = e.target.closest("button"); if (b && b !== document.activeElement) b.focus({ preventScroll: true }); });
  menu.addEventListener("keydown", e => {
    const bs = [...menu.querySelectorAll("button")], at = bs.indexOf(document.activeElement);
    const go = i => bs[(i + bs.length) % bs.length].focus();
    if (e.key === "ArrowDown") go(at + 1);
    else if (e.key === "ArrowUp") go(at - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(-1);
    else if (e.key === "Escape") close(true);
    else if (e.key === "Tab") close(true);
    else if (e.key.length === 1 && /\S/.test(e.key)) {
      // The first letter jumps to the next entry that starts with it.
      const k = e.key.toLowerCase(), n = bs.length;
      for (let j = 1; j <= n; j++) { const b = bs[(at + j) % n]; if (b.textContent.trim().toLowerCase().startsWith(k)) { b.focus(); break; } }
    } else return;
    e.preventDefault(); e.stopPropagation();
  });
  document.addEventListener("pointerdown", e => { if (!menu.hidden && !menu.contains(e.target)) close(); }, true);
  addEventListener("blur", () => close());
  addEventListener("resize", () => close());
}

/* ---------- the rail's popovers ----------
 * With the sidebar folded to its rail, each icon opens its section in #pop,
 * beside the rail: the section's own element, moved in, and moved back to
 * its place when the popover closes. Every renderer writes by id, so what
 * arrives while it is open lands in the popover; #pop is inside #trees, so
 * the clicks the tree delegates still reach it. One at a time; Esc, a click
 * outside it, a link followed in it and `\` close it. app.js's until 1.7.2:
 * it is fetched on the first press of a rail icon, and a reader whose
 * sidebar is never folded never pays for it. */
const $ = s => document.querySelector(s), root = document.documentElement;
const POPS = { inbox: ["#inbox-row", "#queue"], tree: ["#tree"], desks: ["#desk-nav"], browse: ["#browse-nav"], note: ["#note"] };
const HOME = ["#inbox-row", "#queue", "#tree", "#desk-nav", "#browse-nav"];   // #trees' order, as index.html has it
let popBtn = null, popWired = false;
export function pop(ctx, sec, btn) {
  sheet();
  const popEl = $("#pop");
  if (!popWired) wirePop(popEl);
  if (root.dataset.pop === sec) { unpop(); return; }
  unpop(false);
  root.dataset.pop = sec; popBtn = btn;
  btn.classList.add("on"); btn.setAttribute("aria-expanded", "true");
  popEl.setAttribute("aria-label", btn.getAttribute("aria-label"));
  popEl.append(...POPS[sec].map(id => $(id)));
  popEl.hidden = false;
  // Drawn while folded, the titles were cut to a column that was not there.
  if (sec === "tree") ctx.drawTree();
  // Level with the icon, and moved only as far as it takes to stay on the
  // window, the way a toast answers a control in the rail.
  const r = btn.getBoundingClientRect(), h = popEl.offsetHeight;
  popEl.style.top = Math.round(Math.max(8, Math.min(r.top - 8, innerHeight - h - 8))) + "px";
  (popEl.querySelector("a[aria-current], a[href], button, summary, [tabindex]") || popEl).focus({ preventScroll: true });
}
/** Put the section back where it lives. `back` gives the focus to its icon. */
export function unpop(back = true) {
  const sec = root.dataset.pop, popEl = $("#pop"), treesEl = $("#trees");
  if (!sec) return false;
  delete root.dataset.pop;
  popEl.hidden = true;
  // Each back before the first section that follows it in #trees' order,
  // whatever else is still at home: the end is not its place.
  for (const id of POPS[sec]) {
    if (id === "#note") { $("#side").insertBefore($(id), $(".side-foot")); continue; }
    const after = HOME.slice(HOME.indexOf(id) + 1).map(s => $(s)).find(el => el.parentElement === treesEl);
    treesEl.insertBefore($(id), after || popEl);
  }
  const b = popBtn; popBtn = null;
  b?.classList.remove("on"); b?.setAttribute("aria-expanded", "false");
  if (back && b?.isConnected) b.focus({ preventScroll: true });
  return true;
}
function wirePop(popEl) {
  popWired = true;
  const railNav = $("#rail-nav");
  // The menu's keys: the arrows walk its rows, Home and End go to its ends,
  // a letter to the next row that starts with it. Tabbing out of it closes it.
  popEl.addEventListener("keydown", e => {
    if (e.target.closest("input") || e.ctrlKey || e.metaKey || e.altKey) return;
    const bs = [...popEl.querySelectorAll("a[href], button, summary")].filter(x => x.offsetParent), at = bs.indexOf(document.activeElement), n = bs.length;
    const go = i => bs[(i + n) % n]?.focus();
    if (e.key === "ArrowDown") go(at + 1);
    else if (e.key === "ArrowUp") go(at - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(-1);
    // Letters and digits find a row; every other key -- \, Escape, ? --
    // is the page's, as it is outside the popover.
    else if (/^[a-z0-9]$/i.test(e.key)) {
      const k = e.key.toLowerCase();
      for (let j = 1; j <= n; j++) { const b = bs[(at + j) % n]; if (b.textContent.trim().toLowerCase().startsWith(k)) { b.focus(); break; } }
    } else return;
    e.preventDefault(); e.stopPropagation();
  });
  popEl.addEventListener("focusout", e => { const t = e.relatedTarget; if (t && !popEl.contains(t) && !t.closest("#ctx")) unpop(false); });
  // The aside's section empties when its last line goes, and its icon with
  // it: the popover goes too, and a keyboard that was in it lands on the
  // rail rather than on nothing.
  new MutationObserver(() => {
    if (root.dataset.pop !== "note" || !$("#note").hidden) return;
    const had = popEl.contains(document.activeElement) || document.activeElement === document.body;
    unpop(false);
    if (had) [...railNav.querySelectorAll(".icon")].find(x => x.offsetParent)?.focus({ preventScroll: true });
  }).observe($("#note"), { attributes: true, attributeFilter: ["hidden"] });
  // Following a link in it is being done with it; opening a row's fold is not.
  popEl.addEventListener("click", e => { if (e.target.closest("a[href]")) queueMicrotask(() => unpop()); });
  // The context menu is on <body>, but a row's menu is the popover's own: an
  // action there (Rename, Remove with its Undo) happens in the row, in here.
  document.addEventListener("pointerdown", e => { if (root.dataset.pop && !popEl.contains(e.target) && !railNav.contains(e.target) && !e.target.closest?.("#ctx")) unpop(false); }, true);
}

/** Shut the menu from outside, which is what Escape does everywhere else on
 *  the page. A page that has never opened one has never fetched this file, so
 *  app.js asks only when it holds the module. */
export { close as shut };
