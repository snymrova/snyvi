/* ⌘K: the palette -- search the library, jump to a line, open a desk or a
 * folder, try a theme.
 *
 * A chunk, like find, the desk view and the panels. It is the one box a
 * reader summons rather than meets: nothing in it is on the way to showing a
 * document, and first paint had no room left for it once the themes round
 * (docs/THEMES.md) put the controls table and the theme loader there. The
 * page keeps `#palette` in its markup, and keeps what the rest of it calls --
 * `openPalette`, `closePalette` -- so Esc and ⌘K mean the same thing whether
 * this was ever fetched or not: a palette never opened has nothing to close.
 *
 * Its CSS comes with it. The overlay and the box are shared with the help
 * dialog and stay in app.css, with the input, since the page puts the box up
 * before this lands; the list is the palette's alone.
 */

let d = null;                       // what the page handed over, kept for the listeners
let sel = 0, items = [], timer = null, seq = 0;
/** A theme tried and not kept goes back to the one stored on close. */
let previewing = false;

/** Fill the palette the page has just put up, wiring it the first time.
 *  What is already in the box is already a query: on the first ⌘K it was
 *  typed while this chunk was on its way. */
export function open(deps) {
  if (!d) { d = deps; wire(); }
  const { input, browsing, codePre, state } = d;
  input.placeholder = browsing() ? `Find a file in ${state.browseRoot.name}…  (:120 for a line)`
    : codePre() ? "Search documents…  (:120 for a line)" : "Search documents…  (p:project  kind:md|code|diff)";
  search(input.value);
}

/** Take it down. The page calls this for Esc, ⌘K and a click on the scrim. */
export function close() {
  if (!d) return;
  // A search still on its way, or a keystroke's about to start, would land
  // on a closed box: it would draw its rows and preview the first of them
  // over the theme just picked.
  seq++; clearTimeout(timer);
  if (previewing) { previewing = false; d.previewTheme(null); }
  d.pal.classList.remove("themes");
  d.closeDialog(d.pal);
}

function wire() {
  const { input, list, pal } = d;
  input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => search(input.value), 60); });
  input.addEventListener("keydown", e => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      sel = (sel + (e.key === "ArrowDown" ? 1 : -1) + items.length) % Math.max(1, items.length);
      list.querySelectorAll("li").forEach((li, i) => li.classList.toggle("sel", i === sel));
      list.querySelector("li.sel")?.scrollIntoView({ block: "nearest" });
      previewSel();
    } else if (e.key === "Enter" && items[sel]) pick(items[sel]);
  });
  list.addEventListener("click", e => { const li = e.target.closest("li"); if (li) pick(items[+li.dataset.i]); });
  pal.addEventListener("click", e => { if (e.target === pal) close(); });
}

/** `theme`, or `th`: the eight themes as rows, each drawn in its own ground
 *  and ink so the list is its own swatch. Moving the highlight puts the
 *  theme on the window behind the box -- the page is the preview, which is
 *  the swatch's "see it on the page" without a menu to read -- Enter keeps
 *  it, Esc puts the window back. While these rows are up the palette drops
 *  its scrim, since a theme seen through a dim is not the theme. */
function themeItems(q) {
  const l = q.trim().toLowerCase();
  if (l.length < 2 || !"themes".startsWith(l)) return [];
  const now = d.root.dataset.theme;
  return Object.entries(d.THEMES).map(([k, [name, side]]) => ({ theme: k, t: name,
    s: `${side === "light" ? "Light" : "Dark"}${k === now ? " · this one" : d.slot(side) === k ? ` · your ${side} theme` : ""}` }));
}
function previewSel() {
  const it = items[sel];
  if (it?.theme) { previewing = true; d.previewTheme(it.theme); }
  else if (previewing) { previewing = false; d.previewTheme(null); }
}
/** A desk to open, and -- where the reader is in a folder -- a new one
 *  there: the palette is the keyboard's way to what the folder menu does. */
function deskItems(q) {
  const { state, browsing } = d;
  if (!d.capability || !state.desks) return [];
  const l = q.trim().toLowerCase(), out = [];
  if (browsing() && "new desk here".startsWith(l || "n")) {
    const p = state.browsePath, dir = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
    out.push({ newdesk: { root: state.browseRoot.id, path: dir }, t: "New desk here", s: state.browseRoot.path + (dir ? "/" + dir : "") });
  } else if (l && "new desk".startsWith(l)) out.push({ newdesk: "home", t: "New desk", s: state.desks.home || "~" });
  for (const k of state.desks.desks) if (!l || k.name.toLowerCase().includes(l.replace(/^desk\s*/, ""))) out.push({ desk: k.id, t: `Desk · ${k.name}`, s: k.root });
  return out;
}
/** The keyboard's way to the `+` beside Folders. */
function folderItems(q) {
  const l = q.trim().toLowerCase();
  if (!d.capability || !l || !("open folder".startsWith(l) || "folder".startsWith(l) || "browse".startsWith(l))) return [];
  return [{ pick: true, t: "Open folder…", s: "The desktop's folder dialog" }];
}
const row = (it, i) => { const { esc, rel } = d; return `<li class="${i === 0 ? "sel" : ""}${it.theme ? " theme" : ""}" data-i="${i}"${it.theme ? ` data-theme="${it.theme}"` : ""}>` + (
  it.t ? `<span class="t">${esc(it.t)}</span><span class="s">${esc(it.s)}</span>`
    : it.file ? `<span class="t">${esc(it.file.split("/").pop())}</span><span class="s">${esc(it.file)}</span>`
      : `<span class="t">${esc(it.title)}</span><span class="s">${esc(it.project)} · ${esc(it.workflow_title)} · ${rel(it.received_at)}</span>${it.snippet ? `<span class="snip">${it.snippet}</span>` : ""}`) + `</li>`; };
/** Nothing matched: said, so an empty list is not a search still running.
 *  Not a row -- there is nothing to pick -- so the arrows and Enter pass it
 *  by. The face is sorry and still: it is redrawn on every keystroke that
 *  finds nothing, and a head that shook on each would be nagging. */
const none = q => `<div class="pal-none">${d.mascotHead("oops")}<span>${q.trim() ? `Nothing for <b>${d.esc(q.trim())}</b>` : "Nothing here yet"}</span></div>`;

async function search(q) {
  const { list, pal, state, browsing, codePre, esc } = d;
  // Only the latest search lands: the empty one an open starts and the typed
  // one behind it both wait on the daemon, and the first back was overwriting
  // the second -- a list of documents where the theme rows had been, with the
  // scrim back over the page they were previewing on.
  const mine = ++seq;
  // A line number is not a search term. `:120` and `L120` jump instead.
  const g = /^\s*[:lL]\s*(\d+)\s*$/.exec(q);
  if (g && codePre()) {
    items = [{ line: +g[1] }]; sel = 0;
    list.innerHTML = `<li class="sel" data-i="0"><span class="t">Go to line ${+g[1]}</span><span class="s">${esc(document.title)}</span></li>`;
    return;
  }
  let found = [];
  if (browsing()) {
    try { found = (await (await fetch(`/api/browse/${state.browseRoot.id}/find?q=${encodeURIComponent(q)}`)).json()).map(p => ({ file: p })); } catch {}
  } else if (!q.trim()) found = (await (await fetch("/api/inbox?limit=12")).json()).map(x => ({ ...x, snippet: "" }));
  else found = await (await fetch(`/api/search?q=${encodeURIComponent(q)}`)).json();
  // Theme rows are each drawn in their theme, so the sheet has to be in.
  if (themeItems(q).length) await d.loadThemes();
  if (mine !== seq || pal.hidden) return;
  items = themeItems(q).concat(deskItems(q), folderItems(q), found); sel = 0;
  list.innerHTML = items.length ? items.map(row).join("") : none(q);
  pal.classList.toggle("themes", items.some(it => it.theme));
  previewSel();
}

// Kept: the preview already drew it, so closing must not put it back first.
function pick(it) {
  if (it.theme) previewing = false;
  close();
  const { state } = d;
  it.theme ? d.setTheme(it.theme) : it.pick ? d.act("pick") : it.line ? d.gotoLine(it.line)
    : it.newdesk ? d.act("make", it.newdesk === "home" ? null : it.newdesk) : it.desk ? d.showDesk(it.desk, true)
      : it.file ? d.showBrowse(state.browseRoot.id, it.file, true) : d.showDoc(it.id, true);
}

/* The theme rows carry `data-theme`, so the theme's own block dresses each:
 * its ground, its ink, its accent resolved by its own color-scheme. The
 * highlight is that theme's wash with its accent as a rule, the way the list
 * highlights anything, only in the row's colours. While they are up the page
 * behind the box is the preview, and the scrim would dim it, so the palette
 * drops the scrim and keeps the box. A search with nothing in it: snyvi says
 * so, in the list's own row shape. */
const CSS = `
#palette-list { list-style: none; margin: 0; padding: 6px; max-height: 50vh; overflow-y: auto; }
#palette-list:empty { display: none; }
#palette-list li { padding: 8px 12px; border-radius: 6px; cursor: pointer; display: grid; gap: 1px; }
#palette-list li.sel, #palette-list li:hover { background: var(--accent-bg); }
#palette-list .t { font-weight: 550; font-size: 14px; }
#palette-list .s { font-size: 12px; color: var(--fg-3); }
#palette-list .snip { font-size: 12.5px; color: var(--fg-2); margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#palette-list mark { background: var(--mark); color: inherit; border-radius: 2px; }
#palette.themes { background: none; }
#palette-list li.theme { background: var(--bg); color: var(--fg); border: 1px solid var(--rule-2); margin-bottom: 4px; }
#palette-list li.theme.sel, #palette-list li.theme:hover { background: var(--accent-bg); box-shadow: inset 3px 0 var(--accent); }
.pal-none { display: flex; align-items: center; gap: 10px; padding: 9px 12px; font-size: 13px; color: var(--fg-3); }
.pal-none .mk { width: 22px; height: 22px; flex: none; }
.pal-none b { font-weight: 550; color: var(--fg-2); }
`;
{
  const st = document.createElement("style");
  st.id = "palette-css";
  st.textContent = CSS;
  document.head.append(st);
}
