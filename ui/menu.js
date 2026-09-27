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
 *  reader chose, opened. The page names no path. Only the window can ask --
 *  the same gate the desks are behind -- so a tab is told where it can be
 *  done instead. */
export async function pick(ctx) {
  const { capability, state, toast, browseEl } = ctx;
  if (!capability) { toast("Folders open from the snyvi window", "Or from a terminal: snyvi browse <folder>"); return; }
  if (picking) return;
  picking = true;
  browseEl.classList.add("picking");
  try {
    const r = await fetch("/api/browse/pick", { method: "POST", headers: { "x-snyvi-capability": capability } });
    if (r.status === 204) return;   // closed without a choice
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { toast("Could not open a folder", j.error || `HTTP ${r.status}`); return; }
    if (!state.browse.some(x => x.id === j.root.id)) state.browse = state.browse.concat(j.root);
    ctx.drawBrowse();
    // Open in the sidebar as well as on the page; the toggle fills its tree.
    const d = browseEl.querySelector(`.b-root[data-root="${j.root.id}"]`);
    if (d) d.open = true;
    ctx.browse(j.root.id, "", true);
  } catch (e) { toast("Could not open a folder", String(e)); }
  finally { picking = false; browseEl.classList.remove("picking"); }
}

/** A new desk on folder `f`, or with none on no folder: it starts in the home
 *  directory, which the daemon names. */
export async function make(ctx, f) {
  const { toast, api } = ctx;
  try {
    const j = await api("/api/desks", f ? { root: f.root, path: f.path } : {});
    // A new desk opens on a shell, not on an empty grid: one panel, started.
    // The view sizes it to the panel the moment it is drawn.
    try {
      const p = await api(`/api/desks/${j.desk.id}/panes`, {});
      await api(`/api/panes/${p.pane.id}/start`, { cmd: "" });
    } catch (e) { toast("The desk is made, but its shell did not start", String(e)); }
    await ctx.load();
    ctx.show(j.desk.id, true);
  } catch (e) { toast("Could not make a desk", String(e)); }
}

/** The ✕ on a desk's row. Closing a desk ends its panels' processes, and there
 *  is no undoing that, so the first click asks and the second closes, as Close
 *  desk does in the desk's own rail. */
export async function drop(ctx, b) {
  if (!b.dataset.armed) {
    b.dataset.armed = "1"; b.textContent = "Close?"; b.title = "Close the desk and its panels: click again";
    const li = b.closest("li"); li.classList.add("arming");
    setTimeout(() => { if (b.isConnected) { delete b.dataset.armed; b.textContent = "✕"; b.title = "Close desk"; li.classList.remove("arming"); } }, 3000);
    return;
  }
  await dropDesk(ctx, +b.dataset.dropdesk);
}

/** Turn a name in the tree into a field, in place. Enter and blur keep what was
 *  typed, Escape abandons it; the label goes back the moment either happens, so
 *  the tree is never left holding an input. */
export function rename(ctx, holder, what, id) {
  const { toast } = ctx;
  const label = holder.querySelector(":scope > .nm");
  if (!label || holder.querySelector("input.ren-in")) return;
  const before = label.textContent, cls = label.className;
  const input = document.createElement("input");
  input.className = "ren-in";
  input.value = before;
  input.spellcheck = false;
  input.setAttribute("aria-label", `Name of this ${what}`);
  label.replaceWith(input);
  holder.classList.add("renaming");
  input.focus(); input.select();

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
      toast("Could not rename", String(e));
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
    if (r.ok) toast("Terminal", j.dir || "opened");
    else toast("No terminal", j.error || `${r.status}`);
  } catch (e) { toast("No terminal", String(e)); }
}
/** The same place, in the file manager -- Files, Finder, Explorer. The same
 *  ids go over and the daemon resolves them the same way; a desk's folder
 *  goes with the capability, behind the desk's gate. */
export async function reveal(ctx, body) {
  const { toast } = ctx;
  try {
    const j = body.desk != null ? await ctx.api("/api/reveal", body) : await (async () => {
      const r = await fetch("/api/reveal", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `${r.status}`);
      return j;
    })();
    toast("Opened", j.dir || "the folder");
  } catch (e) { toast("Could not open the folder", e.message || String(e)); }
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

/** Pin or unpin any document, as `p` does the one on screen. */
async function pin(ctx, id) {
  const { state, toast } = ctx;
  if (state.doc && state.doc.id === id) return ctx.togglePin();
  const d = docById(ctx, id) || await fetch(`/api/docs/${id}`).then(r => r.json()).catch(() => null);
  if (!d) return;
  const pinned = !d.pinned;
  try {
    const r = await fetch(`/api/docs/${id}/pin`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pinned }) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    d.pinned = pinned; state.cache.delete(id);
    await ctx.refreshTree(d.project_id);
    toast(pinned ? "Pinned" : "Unpinned", pinned ? "Kept by prune" : "Prune may remove it", null, null, { face: pinned ? "glad" : "plain" });
  } catch (e) { toast("Could not pin", String(e)); }
}

/** Off the inbox, as the row's ✕ does: through that ✕ when the row has one,
 *  so its ghost and Undo stand where the right-click was. */
function remove(ctx, id, el) {
  const x = el && el.querySelector("[data-deldoc]");
  if (x) x.click(); else ctx.deleteDoc(docById(ctx, id) || { id, title: ctx.knownDocs.get(id)?.title || "Document" });
}

function copy(ctx, text) { navigator.clipboard?.writeText(text); ctx.toast("Copied", text); }

/** A panel on a desk, started, and the desk shown: the desk's own +. */
async function newPanel(ctx, id) {
  try {
    const p = await ctx.api(`/api/desks/${id}/panes`, {});
    await ctx.api(`/api/panes/${p.pane.id}/start`, { cmd: "" });
    await ctx.load();
    ctx.show(id, true);
  } catch (e) { ctx.toast("Could not open a panel", String(e.message || e)); }
}

/** Close a desk and its panels; the asking twice is the caller's. */
async function dropDesk(ctx, id) {
  const { state } = ctx;
  try { await ctx.api(`/api/desks/${id}/delete`, {}); }
  catch (e) { ctx.toast(`Could not close the desk: ${e.message}`); return; }
  ctx.forget(id);
  await ctx.load();
  if (state.view === "desk" && state.deskId === id) ctx.show(null, true);
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
function entries(ctx, el) {
  const { capability } = ctx, copyIt = (text, what) => ({ label: what, run: () => copy(ctx, text) });
  const term = body => capability && { label: "Open terminal here", run: () => terminal(ctx, body) };
  const files = body => ({ label: "Open in file manager", run: () => reveal(ctx, body) });
  if (el.matches(".b-root > summary, .b-dir > details > summary")) {
    const f = ctx.folderOf(el);
    if (!f) return null;
    const here = ctx.state.desks ? ctx.state.desks.desks.filter(d => d.root === f.abs) : [];
    const root = el.matches(".b-root > summary");
    return { head: f.abs.split("/").pop() || f.abs, items: [
      capability && { label: "New desk here", run: () => make(ctx, f) },
      ...(capability ? here.map(d => ({ label: `Show desk ${d.name}`, run: () => ctx.show(d.id, true) })) : []),
      capability && RULE,
      term({ root: f.root, path: f.path }), files({ root: f.root, path: f.path }), copyIt(f.abs, "Copy path"),
      root && RULE, root && { label: "Close folder", danger: true, run: () => ctx.closeRoot(f.root) },
    ] };
  }
  if (el.matches("a[data-browse]")) {
    const root = el.dataset.browse, path = el.dataset.path || "", r = ctx.state.browse.find(x => x.id === root), abs = r ? r.path + (path ? "/" + path : "") : "";
    return { head: path.split("/").pop() || abs, items: [
      { label: "Open", run: () => ctx.browse(root, path, true) }, RULE,
      term({ root, path }), files({ root, path }), abs && copyIt(abs, "Copy path"),
    ] };
  }
  if (el.matches(".t-proj > summary")) {
    const pid = +el.parentElement.dataset.pid, p = ctx.state.tree.find(x => x.id === pid);
    if (!p) return null;
    return { head: p.name, items: [
      term({ project: pid }), files({ project: pid }), p.root && copyIt(p.root, "Copy path"), RULE,
      { label: "Rename…", key: "F2", run: () => rename(ctx, el, "project", pid) },
      { label: "Remove from sidebar", danger: true, run: () => ctx.putAway(pid) },
    ] };
  }
  if (el.matches("a[data-id]")) {
    const id = el.dataset.id, d = docById(ctx, id), path = d && d.source_path;
    return { head: d ? d.title : el.querySelector(".title")?.textContent || "Document", items: [
      { label: "Open", run: () => ctx.open(id) },
      { label: d && d.pinned ? "Unpin" : "Pin", key: "p", run: () => pin(ctx, id) }, RULE,
      path && copyIt(path, "Copy path"), copyIt(`${location.origin}/d/${id}`, "Copy link"),
      term({ doc: id }), files({ doc: id }), RULE,
      { label: "Remove from inbox", key: "Del", danger: true, run: () => remove(ctx, id, el) },
    ] };
  }
  if (el.matches("a[data-desk]")) {
    const id = +el.dataset.desk, d = ctx.state.desks && ctx.state.desks.desks.find(x => x.id === id);
    if (!d || !capability) return null;
    return { head: d.name, items: [
      { label: "Show", run: () => ctx.show(id, true) },
      d.panes.length < ctx.state.desks.per_desk && { label: "New panel", run: () => newPanel(ctx, id) }, RULE,
      term({ desk: id }), files({ desk: id }), copyIt(d.root, "Copy path"), RULE,
      { label: "Rename…", key: "F2", run: () => rename(ctx, el, "desk", id) },
      { label: "Close desk", danger: true, sure: true, run: () => dropDesk(ctx, id) },
    ] };
  }
  return ctx.desk && ctx.desk.actions ? ctx.desk.actions(el) : null;
}

/** The menu for `el`, at a point -- the pointer's, or the element's corner
 *  when a key asked. Returns false when `el` has nothing to offer, so the
 *  caller can leave the browser's own menu alone. */
export function open(ctx, el, x, y, byKey = false) {
  const m = entries(ctx, el);
  // Rules only between two entries: none leading, trailing or doubled.
  const items = m ? m.items.filter(Boolean).filter((e, i, a) => e !== RULE || (i > 0 && a[i - 1] !== RULE && a.slice(i + 1).some(x => x !== RULE))) : [];
  if (!items.some(e => e !== RULE)) return false;
  if (!menu) install(ctx);
  shown = items;
  opener = byKey ? document.activeElement : null;
  menu.innerHTML = `<div class="ctx-head">${ctx.esc(m.head)}</div>` + items.map((e, i) => e === RULE ? "<hr>"
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
#ctx { position: fixed; z-index: 40; min-width: 200px; max-width: 320px; max-height: calc(100vh - 16px); overflow-y: auto; padding: 4px; background: var(--bg-raise); border: 1px solid var(--rule); border-radius: 8px; box-shadow: var(--shadow); font-size: 13px; transform-origin: 0 0; animation: ctx-in 80ms ease-out; }
@keyframes ctx-in { from { opacity: 0; transform: scale(.97); } }
@media (prefers-reduced-motion: reduce) { #ctx { animation: none; } }
/* What the menu acts on, named at its top: a right-click in a busy grid
   says which panel it meant. */
#ctx .ctx-head { padding: 4px 10px 5px; font-size: 11.5px; color: var(--fg-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; border-bottom: 1px solid var(--rule); margin-bottom: 4px; }
#ctx button { display: flex; align-items: baseline; gap: 16px; width: 100%; text-align: left; padding: 5px 10px; border-radius: 5px; color: var(--fg-2); }
#ctx button > span { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#ctx button kbd { flex: none; font-family: var(--mono); font-size: 11px; color: var(--fg-3); background: none; border: 0; padding: 0; }
#ctx button:hover, #ctx button:focus { background: var(--accent-bg); color: var(--accent); outline: none; }
#ctx button.danger { color: var(--danger); }
#ctx button.danger:hover, #ctx button.danger:focus, #ctx button[data-armed] { background: color-mix(in srgb, var(--danger) 12%, transparent); color: var(--danger); }
#ctx hr { border: 0; border-top: 1px solid var(--rule); margin: 4px 2px; }
`;

function install(ctx) {
  const st = document.createElement("style");
  st.textContent = CSS;
  document.head.append(st);
  menu = document.createElement("div");
  menu.id = "ctx"; menu.hidden = true; menu.setAttribute("role", "menu");
  document.body.append(menu);
  menu.addEventListener("click", e => {
    const b = e.target.closest("[data-i]"), it = b && shown[+b.dataset.i];
    if (!it) return;
    // Ending a process asks twice, in its own place: the entry says what the
    // next click does, and goes back after three seconds.
    if (it.sure && !b.dataset.armed) {
      b.dataset.armed = "1";
      b.firstElementChild.textContent = `${it.label}? · click again`;
      setTimeout(() => { if (b.isConnected && b.dataset.armed) { delete b.dataset.armed; b.firstElementChild.textContent = it.label; } }, 3000);
      return;
    }
    close();
    Promise.resolve().then(() => it.run()).catch(err => ctx.toast("Could not do that", String(err)));
  });
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

/** Shut the menu from outside, which is what Escape does everywhere else on
 *  the page. A page that has never opened one has never fetched this file, so
 *  app.js asks only when it holds the module. */
export { close as shut };
