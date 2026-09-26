/* What a folder and a desk can be asked to do, after a click.
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

/** The menu element, and the folder it was opened on. Made on the first
 *  right-click and kept after that: a reader who uses it once uses it again. */
let menu = null, menuAt = null;
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
  const { state, toast, api } = ctx;
  if (!b.dataset.armed) {
    b.dataset.armed = "1"; b.textContent = "Close?"; b.title = "Close the desk and its panels: click again";
    const li = b.closest("li"); li.classList.add("arming");
    setTimeout(() => { if (b.isConnected) { delete b.dataset.armed; b.textContent = "✕"; b.title = "Close desk"; li.classList.remove("arming"); } }, 3000);
    return;
  }
  const id = +b.dataset.dropdesk;
  try { await api(`/api/desks/${id}/delete`, {}); }
  catch (err) { toast(`Could not close the desk: ${err.message}`); return; }
  ctx.forget(id);
  await ctx.load();
  if (state.view === "desk" && state.deskId === id) ctx.show(null, true);
}

/** The first context menu in snyvi, on the one row that has a use for it: a
 *  folder. `New desk here` always, `Show desk` for each desk already on it --
 *  two on one folder is a workflow, not a mistake -- and in a tab neither,
 *  rather than both greyed. Right-click cannot be reached from a keyboard,
 *  which this codebase cares about, so the desk glyph on the row and the
 *  palette are its peers; and the menu itself is arrow keys and Escape. */
export function open(ctx, f, x, y) {
  const { state, capability, esc } = ctx;
  if (!menu) install(ctx);
  menuAt = f;
  const here = state.desks ? state.desks.desks.filter(d => d.root === f.abs) : [];
  menu.innerHTML = (capability ? `<button role="menuitem" data-m="new">New desk here</button>` +
    here.map(d => `<button role="menuitem" data-m="show" data-id="${d.id}">Show desk ${esc(d.name)}</button>`).join("") + `<hr>` : "") +
    `<button role="menuitem" data-m="copy">Copy path</button><button role="menuitem" data-m="term">Open terminal here</button>` +
    `<button role="menuitem" data-m="reveal">Open in file manager</button>`;
  menu.hidden = false;
  menu.style.left = Math.max(4, Math.min(x, innerWidth - menu.offsetWidth - 8)) + "px";
  menu.style.top = Math.max(4, Math.min(y, innerHeight - menu.offsetHeight - 8)) + "px";
  menu.querySelector("button").focus();
}

const close = () => { if (menu) { menu.hidden = true; menuAt = null; } };

/** The element and its listeners, once. The `contextmenu` that brings us here
 *  stays in app.js -- something has to be listening before this file is
 *  fetched -- and everything that acts on an open menu is hung here. */
function install(ctx) {
  menu = document.createElement("div");
  menu.id = "ctx"; menu.hidden = true; menu.setAttribute("role", "menu");
  document.body.append(menu);
  menu.addEventListener("click", e => {
    const b = e.target.closest("[data-m]"), f = menuAt;
    if (!b || !f) return;
    close();
    const m = b.dataset.m;
    if (m === "new") make(ctx, f);
    else if (m === "show") ctx.show(+b.dataset.id, true);
    else if (m === "copy") { navigator.clipboard?.writeText(f.abs); ctx.toast("Copied", f.abs); }
    else if (m === "reveal") ctx.reveal({ root: f.root, path: f.path });
    else ctx.terminal({ root: f.root, path: f.path });
  });
  menu.addEventListener("keydown", e => {
    const bs = [...menu.querySelectorAll("button")], at = bs.indexOf(document.activeElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") bs[(at + (e.key === "ArrowDown" ? 1 : -1) + bs.length) % bs.length].focus();
    else if (e.key === "Escape") close();
    else return;
    e.preventDefault(); e.stopPropagation();
  });
  document.addEventListener("pointerdown", e => { if (!menu.hidden && !menu.contains(e.target)) close(); }, true);
  addEventListener("blur", close);
}

/** Shut the menu from outside, which is what Escape does everywhere else on
 *  the page. A page that has never opened one has never fetched this file, so
 *  app.js asks only when it holds the module. */
export { close as shut };
