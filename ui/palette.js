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
  input.placeholder = browsing() ? `Find a file in ${state.browseRoot.name} · :120 for a line`
    : codePre() ? "Search documents · :120 for a line" : "Search documents · p:project · kind:md · > commands";
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

/** The one row lit, to the eye and to a screen reader: the input is a
 *  combobox, and the row it points at is its active descendant. */
function lit() {
  const { input, list } = d;
  list.querySelectorAll("li[data-i]").forEach((x, i) => { x.classList.toggle("sel", i === sel); x.setAttribute("aria-selected", String(i === sel)); });
  items[sel] ? input.setAttribute("aria-activedescendant", `pal-${sel}`) : input.removeAttribute("aria-activedescendant");
}

function wire() {
  const { input, list, pal } = d;
  input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => search(input.value), 60); });
  input.addEventListener("keydown", e => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      sel = (sel + (e.key === "ArrowDown" ? 1 : -1) + items.length) % Math.max(1, items.length);
      lit();
      list.querySelector("li.sel")?.scrollIntoView({ block: "nearest" });
      previewSel();
    } else if (e.key === "Enter" && items[sel]) pick(items[sel]);
  });
  // The row under the pointer is the selection, so one row is lit and
  // Enter picks the one that is.
  list.addEventListener("pointermove", e => {
    const li = e.target.closest("li[data-i]");
    if (!li || +li.dataset.i === sel) return;
    sel = +li.dataset.i;
    lit();
    previewSel();
  });
  list.addEventListener("click", e => {
    if (e.target.closest("[data-retry]")) { e.stopPropagation(); search(d.input.value); return; }
    const li = e.target.closest("li[data-i]"); if (li) pick(items[+li.dataset.i]);
  });
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
  } else if (l && ("new desk".startsWith(l) || l.startsWith("new desk "))) {
    // Where, as the + asks: each project and folder with no desk yet, then
    // the home folder last. A word after "new desk" narrows the list.
    // Until the words are nearly typed, one row that opens the list, so an
    // "n" is not answered with every project.
    const w = l.slice(9).trim();
    if (l.length < 5) out.push({ cmd: "desk", t: "New desk…", s: "For a project, another folder, or a shell" });
    else {
      for (const f of d.places()) if (!w || f.name.toLowerCase().includes(w)) out.push({ newdesk: f, t: `New desk · ${f.name}`, s: f.abs });
      if (!w) out.push({ newdesk: "home", t: "New desk · a shell", s: state.desks.home || "~" });
    }
  }
  for (const k of state.desks.desks) if (!l || k.name.toLowerCase().includes(l.replace(/^desk\s*/, ""))) out.push({ desk: k.id, t: `Desk · ${k.name}`, s: k.root });
  return out;
}
/** `>` and a word: what snyvi can do, rather than what it holds. A static
 *  list; the menus' registry (CONTEXT-MENU.md, phase 5) is per element and
 *  has no list of its own to read yet. */
const COMMANDS = [
  { cmd: "home", t: "Home", key: "h", s: "What needs you, the desks, and what is waiting" },
  { cmd: "inbox", t: "Inbox", key: "i", s: "Every document, newest first" },
  { cmd: "theme", t: "Theme…", s: "The eight, each tried on the window as you move" },
  { cmd: "desk", t: "New desk…", s: "For a project, another folder, or a shell", window: true },
  { cmd: "folder", t: "Open folder…", s: "Read a folder as it is on disk", window: true },
  { cmd: "welcome", t: "Welcome", s: "Which project first: the page a new window opens on" },
  { cmd: "connect", t: "Agents", s: "Claude Code, and any other agent" },
  { cmd: "start", t: "How snyvi works", s: "Desks, notes, documents, keys: a paragraph each" },
  { cmd: "quiet", get t() { return document.documentElement.dataset.mascot === "quiet" ? "Lively mascot" : "Quiet mascot"; }, s: "snyvi's face at rest, nothing of it moving" },
  { cmd: "keys", t: "Keys", key: "?", s: `Every key, and ${/Mac/.test(navigator.platform) ? "⌃B" : "Ctrl B"} for the letters` },
  { cmd: "updates", t: "Check for updates", s: "Ask now, rather than at the next check" },
  { cmd: "about", t: "About snyvi", s: "The version, where it keeps things, and updates" },
  { cmd: "parts", get t() { return document.documentElement.dataset.parts ? "Hide section names" : "Show section names"; }, s: "Each part of the window with its name, to point at (docs/LAYOUT.md)" },
];
function commandItems(q) {
  const m = /^\s*>\s*(.*)$/.exec(q);
  if (!m) return null;
  const l = m[1].trim().toLowerCase();
  return COMMANDS.filter(c => (!c.window || d.capability) && (!l || c.t.toLowerCase().includes(l)));
}

/** The keyboard's way to the `+` beside Folders. */
function folderItems(q) {
  const l = q.trim().toLowerCase();
  if (!d.capability || !l || !("open folder".startsWith(l) || "folder".startsWith(l) || "browse".startsWith(l))) return [];
  return [{ pick: true, t: "Open folder…", s: "The desktop's folder dialog" }];
}
const row = (it, i) => { const { esc, rel } = d; return `<li role="option" id="pal-${i}" aria-selected="${i === 0}" class="${i === 0 ? "sel" : ""}${it.theme ? " theme" : ""}" data-i="${i}"${it.theme ? ` data-theme="${it.theme}"` : ""}>` + (
  it.t ? `<span class="t">${esc(it.t)}${it.key ? `<kbd>${esc(it.key)}</kbd>` : ""}</span><span class="s">${esc(it.s)}</span>`
    : it.file ? `<span class="t">${esc(it.file.split("/").pop())}</span><span class="s">${esc(it.file)}</span>`
      : `<span class="t">${esc(it.title)}</span><span class="s">${esc(it.project)} · ${esc(it.workflow_title)} · ${rel(it.received_at)}</span>${it.snippet ? `<span class="snip">${it.snippet}</span>` : ""}`) + `</li>`; };
/** Nothing matched: said, so an empty list is not a search still running.
 *  Not a row -- there is nothing to pick -- so the arrows and Enter pass it
 *  by. A search that finds nothing is the reader's miss, not snyvi's, and
 *  gets no face (docs/DESIGN.md §2.3); an empty library gets snyvi at rest. */
const none = q => `<div class="pal-none">${q.trim() ? `<span>Nothing for <b>${d.esc(q.trim())}</b></span>` : `${d.mascotHead("rest")}<span>Nothing here yet</span>`}</div>`;

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
  const commands = commandItems(q);
  if (commands) {
    items = commands; sel = 0;
    list.innerHTML = items.length ? items.map(row).join("") : none(q);
    pal.classList.remove("themes");
    previewSel();
    return;
  }
  // A search the daemon did not answer is not a search that found nothing:
  // the list says which, with a Retry.
  let found = null;
  try {
    const r = await fetch(browsing() ? `/api/browse/${state.browseRoot.id}/find?q=${encodeURIComponent(q)}` : q.trim() ? `/api/search?q=${encodeURIComponent(q)}` : "/api/inbox?limit=12");
    found = r.ok ? await r.json() : null;
  } catch {}
  const off = !Array.isArray(found);
  found = off ? [] : browsing() ? found.map(p => ({ file: p })) : q.trim() ? found : found.map(x => ({ ...x, snippet: "" }));
  // Theme rows are each drawn in their theme, so the sheet has to be in.
  if (themeItems(q).length) await d.loadThemes();
  if (mine !== seq || pal.hidden) return;
  items = themeItems(q).concat(deskItems(q), folderItems(q), found); sel = 0;
  list.innerHTML = items.map(row).join("") + (off ? `<li class="no-reach" role="alert">Could not reach snyvi<button type="button" data-retry>Retry</button></li>` : items.length ? "" : none(q));
  pal.classList.toggle("themes", items.some(it => it.theme));
  lit();
  previewSel();
}

// Kept: the preview already drew it, so closing must not put it back first.
function pick(it) {
  // Theme… is a way into the theme rows, which preview as they are walked.
  if (it.cmd === "theme") { d.input.value = "theme"; search("theme"); return; }
  // New desk… is a way into the rows that say where, as the + asks.
  if (it.cmd === "desk") { d.input.value = "new desk"; search("new desk"); return; }
  if (it.theme) previewing = false;
  close();
  if (it.cmd === "parts") { parts(); return; }
  if (it.cmd) {
    const c = it.cmd;
    c === "home" ? d.showHome(true) : c === "inbox" ? d.showInbox(true) : c === "quiet" ? d.toggleQuiet() : c === "updates" ? d.checkUpdates() : c === "about" ? d.panel("about") : c === "folder" ? d.act("pick") : c === "connect" ? d.showConnect(true)
      : c === "start" ? d.showStart(true, "") : c === "welcome" ? d.showWelcome(true) : d.openHelp();
    return;
  }
  const { state } = d;
  it.theme ? d.setTheme(it.theme) : it.pick ? d.act("pick") : it.line ? d.gotoLine(it.line)
    : it.newdesk ? d.act("make", it.newdesk === "home" ? null : it.newdesk) : it.desk ? d.showDesk(it.desk, true)
      : it.file ? d.showBrowse(state.browseRoot.id, it.file, true) : d.showDoc(it.id, true);
}

/** Every part of the window that has a name wears it, until asked again:
 *  so "the by-line in rail.docs.row" is a place on the screen as well as a
 *  line in docs/LAYOUT.md. */
let partsLayer = null, partsTimer = 0;
function parts() {
  const r = document.documentElement;
  if (r.dataset.parts) {
    delete r.dataset.parts;
    clearInterval(partsTimer); removeEventListener("scroll", placeParts, true); removeEventListener("resize", placeParts);
    partsLayer?.remove(); partsLayer = null;
    return;
  }
  // Its look comes with the first ask, not with the page: nobody pays for it
  // who never asks.
  if (!document.getElementById("parts-css")) document.head.append(Object.assign(document.createElement("style"), { id: "parts-css", textContent: PARTS_CSS }));
  r.dataset.parts = "1";
  partsLayer = Object.assign(document.createElement("div"), { className: "parts-layer" });
  partsLayer.setAttribute("aria-hidden", "true");
  document.body.append(partsLayer);
  placeParts();
  // The labels sit in a layer of their own, over the page, so no part is
  // restyled to hold one; they follow a scroll, and a redraw within a beat.
  addEventListener("scroll", placeParts, { capture: true, passive: true });
  addEventListener("resize", placeParts);
  partsTimer = setInterval(placeParts, 700);
}
/** A label at each named part's top right corner. Parts that share a corner
 *  (main, main.head, main.page) stack down rather than cover each other. */
function placeParts() {
  if (!partsLayer) return;
  const taken = [], out = [];
  for (const el of document.querySelectorAll("[data-part]")) {
    const b = el.getBoundingClientRect();
    if (!b.width || !b.height || b.bottom < 0 || b.top > innerHeight) continue;
    let y = Math.max(0, b.top);
    while (taken.some(t => Math.abs(t.x - b.right) < 120 && Math.abs(t.y - y) < 16)) y += 16;
    taken.push({ x: b.right, y });
    out.push(`<span style="left:${Math.round(b.right)}px;top:${Math.round(y)}px">${el.dataset.part}</span>`);
  }
  partsLayer.innerHTML = out.join("");
}
const PARTS_CSS = `
:root[data-parts] [data-part] { outline: 1px dashed var(--accent); outline-offset: -1px; }
.parts-layer { position: fixed; inset: 0; z-index: var(--z-dialog); pointer-events: none; }
.parts-layer > span { position: absolute; transform: translateX(-100%); padding: 0 4px; border-radius: 0 0 0 4px; opacity: .92;
  font: 500 var(--fs-micro)/16px var(--mono); letter-spacing: 0; white-space: nowrap; color: var(--bg); background: var(--accent); }
`;

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
#palette-list li { padding: 8px 12px; border-radius: var(--r-sm); cursor: pointer; display: grid; gap: 1px; }
#palette-list li:hover { background: var(--rule); }
#palette-list li.sel { background: var(--accent-bg); }
#palette-list .t { font-weight: 500; font-size: var(--fs-body-s); }
#palette-list .s { font-size: var(--fs-small); color: var(--fg-3); }
#palette-list .snip { font-size: var(--fs-small); color: var(--fg-2); margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#palette-list mark { background: var(--mark); color: inherit; border-radius: var(--r-xs); }
#palette.themes { background: none; }
#palette-list li.theme { background: var(--bg); color: var(--fg); border: 1px solid var(--rule-2); margin-bottom: 4px; }
#palette-list li.theme.sel { background: var(--accent-bg); box-shadow: inset 3px 0 var(--accent); }
.pal-none { display: flex; align-items: center; gap: 10px; padding: 9px 12px; font-size: var(--fs-ui); color: var(--fg-3); }
.pal-none .mk { width: 22px; height: 22px; flex: none; }
#palette-list .t kbd { float: right; margin-left: 8px; }
.pal-none b { font-weight: 600; color: var(--fg-2); }
`;
{
  const st = document.createElement("style");
  st.id = "palette-css";
  st.textContent = CSS;
  document.head.append(st);
}
