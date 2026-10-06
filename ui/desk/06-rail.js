/* ui/desk/06-rail.js: a part of desk.js, one module. build.rs joins ui/desk/*.js in name
 * order (src/strip.rs `source`); SNYVI_UI_DIR serves the same join. */
// ---------- the rail ----------

const ago = s => { const d = Math.max(0, Date.now() / 1000 - s); return d < 60 ? `${Math.round(d)}s` : d < 3600 ? `${Math.round(d / 60)}m` : `${Math.floor(d / 3600)}h ${Math.round((d % 3600) / 60)}m`; };

/** A pane as a row names it: the shell's title less the `user@host:` a
 *  prompt puts before the folder. Every row on a desk carries the same
 *  prefix, and it is the folder after it that tells them apart. A program's
 *  own marks at the front of its title (Claude Code's ✳, a spinner) go too:
 *  the row's dot already says what the pane is doing, and the full title is
 *  the row's tooltip. */
const short = v => { const t = what(v), m = /^[\w.-]+@[\w.-]+:(.+)$/.exec(t); return (m ? tilde(m[1]) : t).replace(/^(?:(?!~)[\p{S}\p{Co}\s])+/u, "") || t; };

/** The rail's small controls, drawn as lines the way the sidebar's icons
 *  are: stop and start on a pane, close on a pane or the desk, a pen on the
 *  desk's name. */
const ICO = {
  stop: '<rect x="3.5" y="3.5" width="9" height="9" rx="1.5" fill="currentColor" stroke="none"/>',
  play: '<path d="M5 3.5v9l7.5-4.5z" fill="currentColor" stroke="none"/>',
  x: '<path d="M4 4l8 8M12 4l-8 8"/>',
  doc: '<path d="M9.5 1.5H4.5a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V4.5z"/><path d="M9.5 1.5v3h3M6 8h4M6 10.5h4"/>',
  pen: '<path d="M11.2 2.8a1.5 1.5 0 0 1 2 2L6 12l-3 1 1-3z"/>',
  back: '<path d="M6.5 3L3 8l3.5 5M3 8h10"/>',
  copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M3.5 10.5h-.5a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v.5"/>',
  tick: '<path d="M3.5 8.5l3 3 6-7"/>',
  again: '<path d="M3 8a5 5 0 1 0 1.5-3.5M3 2.5v3h3"/>',
  plus: '<path d="M8 3.5v9M3.5 8h9"/>',
  done: '<path d="M2.5 5l1.5 1.5L7 3.5M2.5 11l1.5 1.5L7 9.5M9.5 5h4M9.5 11h4"/>',
  pic: '<rect x="2" y="3" width="12" height="10" rx="1.5"/><circle cx="5.75" cy="6.25" r="1.1"/><path d="M2.5 11.5l3.5-3.5 2.5 2.5 2-2 3 3"/>',
};
const ico = k => `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICO[k]}</svg>`;
/** The head's plus: drawn on the grid the page's own icon buttons use
 *  (#btn-side-hide, #btn-rail), so it sits on the same centre as a pane's
 *  outline and not on a text baseline. */
const HEAD = {
  plus: '<path d="M10 4.5v11M4.5 10h11"/>',
  key: '<circle cx="7" cy="13" r="3.5"/><path d="M9.5 10.5L16 4M13.5 6.5l2 2M15.5 4.5l1.5 1.5"/>',
};
const head = k => `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${HEAD[k]}</svg>`;

/** Whether the reader folded one of the rail's sections, remembered as the
 *  sidebar remembers its own folds -- and per section, so folding the list
 *  away does not take the documents with it. `docs` keeps the key it had. */
const FOLD = sec => `snyvi.dk.fold-${sec}`;
const secFolded = sec => { try { return localStorage.getItem(FOLD(sec)) === "1"; } catch { return false; } };
function folded(e) {
  const d = e.target;
  if (!d.classList || !d.classList.contains("dk-sec") || !d.dataset.sec) return;
  try { localStorage.setItem(FOLD(d.dataset.sec), d.open ? "0" : "1"); } catch {}
}

function rail() {
  const d = current();
  if (!d) return;
  const { esc } = ctx, j = ctx.desks;
  const dot = v => v.status.blocked ? "!" : v.status.agent === "done" ? "✓" : v.status.running ? "●" : "○";
  const vs = d.panes.map(p => views.get(p.id)).filter(Boolean);
  const here = `${d.panes.length} of ${j.per_desk} on this desk`, total = `${j.panes} open on every desk`;
  const why = noNew(d);
  const dl0 = docsAt === d.id ? docList : [];
  // A row just removed keeps its place through a read that no longer has it.
  const gone = docGone && docGone.at === d.id ? docGone.x : null;
  const dl = gone && !dl0.includes(gone) ? [...dl0.slice(0, docGone.i), gone, ...dl0.slice(docGone.i)] : dl0;
  // The latest six, and always the one on the page: a document being read
  // is never the one the rail hides. The count names what is not shown.
  // A search shows every title that has what was typed, and nothing folds.
  const q = docsFind.trim().toLowerCase(), found = q ? dl.filter(x => x.title.toLowerCase().includes(q)) : null;
  const shown = found || (docsAll ? dl : dl.filter((x, i) => i < DOCS_SHOWN || x.id === reading));
  const rest = found ? 0 : dl.length - shown.length, folds = !found && docsAll && dl.length > DOCS_SHOWN;
  const live = dl.filter(x => x !== gone), waiting = live.filter(x => x.unread).length;
  const offs = docsAt === d.id ? docOff.filter(x => !gone || x.id !== gone.id) : [];
  const stopped = vs.filter(x => !x.status.running).length;
  // A pane's row: the mark, the slot, the name -- and under the cursor, what
  // can be done to that pane: stopped or started, and closed. On the row
  // itself, so a control acts on the pane it sits beside and never on
  // whichever pane happens to have the focus.
  const paneRow = v => {
    const n = v.pane.slot, run = v.status.running;
    return `<li class="dk-pane${v.id === focused && reading == null ? " on" : ""}${v.status.blocked ? " blk" : run ? " run" : ""}${v.closing ? " closing" : ""}">` +
      `<button type="button" class="dk-focus" data-focus="${v.id}"><span class="dot">${dot(v)}</span><span class="slot">${n}</span><span class="nm"></span>${ctxPct(v.status) == null ? "" : `<span class="${ctxCls(ctxPct(v.status))}">${ctxPct(v.status)}%</span>`}</button>` +
      `<span class="dk-tools">` +
      (run ? `<button type="button" data-a="stop" data-p="${v.id}" data-tip="Stop" aria-label="Stop panel ${n}">${ico("stop")}</button>`
        : `<button type="button" data-a="start" data-p="${v.id}" data-tip="Start" aria-label="Start panel ${n}">${ico("play")}</button>`) +
      (talked(v) ? `<button type="button" data-a="again" data-p="${v.id}" data-tip="Resume conversation" data-tip-sub="${run ? `Types ${esc(resumeWord(v))} into the shell, for you to run` : "The one this panel last had"}" aria-label="Resume the conversation in panel ${n}">${ico("again")}</button>` : "") +
      `<button type="button" data-a="close" data-p="${v.id}" data-tip="Close panel" data-tip-sub="Undo in the rail" data-key="ctrl+alt+w" aria-label="Close panel ${n}">${ico("x")}</button>` +
      `</span></li>` +
      (rowSaid && rowSaid.p === v.id ? `<li><p class="dk-empty dk-said" role="status">${esc(rowSaid.text)}</p></li>` : "") + errLine(`p${v.id}`, esc);
  };
  // Replacing the rail takes the focus off whatever had it. A field open on
  // the list has to know that is what happened, and not a reader clicking
  // away, so the replacement says so while it is under way.
  drawing = true;
  // The documents' own scroll, which a redraw would put back to the top.
  const docsTop = ctx.tocEl.querySelector(".dk-docs:not(.dk-offs)")?.scrollTop || 0;
  const drew = drawIn(ctx.tocEl, `<div class="dk-rail">` + filedSecs(d) +
    `<div data-part="rail.panels"><div class="t-label dk-lab" data-tip="Panels" data-tip-sub="${esc(here)} · ${esc(total)}">Panels<span class="n">${d.panes.length}<i>/${j.per_desk}</i></span></div>` +
    `<ul class="dk-panes">` + vs.map(paneRow).join("") + (closedRow && closedRow.desk === d.id
      ? `<li class="dk-note gone" role="status"><span class="nm">${esc(closedRow.name)} · ${closedRow.said || "Closed"}</span><button type="button" class="dk-undo" data-a="pane-back" data-p="${closedRow.id}">Undo</button></li>` + errLine("closed", esc) : "") + `</ul>` +
    `<div class="dk-foot"><button type="button" class="dk-new${why ? ` dim" aria-disabled="true" aria-describedby="dk-new-why" data-tip="New panel" data-tip-sub="${esc(why)}` : ""}" data-a="new">+ New panel</button>${why ? `<span id="dk-new-why" class="vh">${esc(why)}</span>` : ""}` +
    (stopped > 1 ? `<button type="button" class="dk-new" data-a="all" data-tip="Start all" data-tip-sub="Every stopped panel, again">Start all</button>` : "") + `</div></div>` +
    pointSec(vs) +
    // The documents fold, as a section in the sidebar does: the chevron
    // shows under the cursor, and stays while the list is folded. The row's
    // [n] says which panel sent it.
    `<details class="dk-sec" data-sec="docs" data-part="rail.docs"${secFolded("docs") ? "" : " open"}><summary class="t-label dk-lab" data-tip="Documents" data-tip-sub="What the panels on this desk have sent, newest first">Documents<span class="s-chev" aria-hidden="true"></span>${live.length ? `<span class="n">${live.length}${waiting ? ` · <b>${waiting} waiting</b>` : ""}</span>` : ""}</summary>` +
    // A document's row: the one on the page is marked, the way a pane's row
    // is while the desk is the page. One line of title, then who sent it and
    // when: the panel by the name it was started with, which holds still, and
    // not its title, which ticks. The row on the page gets its second line.
    // The rest, named rather than listed: one row at the end of the box that
    // opens them here, met where the scroll runs out rather than under it.
    (dl.length > DOCS_FIND || docsFind ? `<input class="dk-find" type="search" spellcheck="false" autocomplete="off" placeholder="Find a document" aria-label="Find a document on this desk by its title" value="${esc(docsFind)}">` : "") +
    (dl.length ? `<ul class="dk-docs">` + shown.map(x => docRow(x, x === gone, vs, esc)).join("") +
      (found && !found.length ? `<li><p class="dk-empty">No title has “${esc(docsFind.trim())}”</p></li>` : "") +
      (rest || folds ? `<li class="dk-more-li"><button type="button" class="dk-new dk-more" data-a="more" aria-expanded="${folds}">${folds ? "Show fewer" : `${rest} more`}</button></li>` : "") + `</ul>`
      : docsOff === d.id ? noReach("docs") : offs.length ? "" : waitingFirst(d)) +
    // What the reader removed from this list, named, and there to open or put back.
    (offs.length ? `<p class="dk-offs-line">${offs.length} removed · <button type="button" class="dk-link" data-a="doc-offs" aria-expanded="${offShown}">${offShown ? "Hide" : "Show"}</button></p>` +
      (offShown ? `<ul class="dk-docs dk-offs">` + offs.map(x => `<li class="dk-doc off"><a href="/d/${x.id}" data-read="${x.id}" data-tip="${esc(x.title)}" data-tip-sub="${esc(x.project)} · ${ctx.fmt(x.received_at)}">${ico("doc")}<span class="title">${esc(x.title)}</span></a>` +
        `<button type="button" class="dk-undo" data-a="doc-back" data-d="${esc(x.id)}" aria-label="Put ${esc(x.title)} back on this desk's list">Undo</button></li>` + errLine(`d${x.id}`, esc)).join("") + `</ul>` : "") : "") +
    `</details>` + noteSec(d) + `</div>`);
  drawing = false;
  // The names go in after, and never into what the rail compares itself
  // with: a panel's name is its title, which an agent changes about once a
  // second, and a rail that counted it would find itself changed at every
  // tick of the clock.
  if (drew) { vs.forEach(named); findFocus(); noteFocus(); threadFocus(); docsScroll(docsTop); loadImgs(); }
  meta();
}

/** A document's row in the rail, or the row it leaves behind when it is
 *  removed: the title, struck through, and its Undo where the ✕ was. */
function docRow(x, gone, vs, esc) {
  if (gone) return `<li class="dk-note gone" role="status"><span class="nm">${esc(x.title)}</span><button type="button" class="dk-undo" data-a="doc-back" data-d="${esc(x.id)}">Undo</button></li>` + errLine(`d${x.id}`, esc);
  const on = x.id === reading;
  return `<li class="dk-doc${on ? " on" : ""}"><a href="/d/${x.id}" data-read="${x.id}" class="${x.unread ? "new" : ""}" data-tip="${on ? "Back to the panels" : esc(x.title)}" data-tip-sub="${on ? "click again" : `from ${esc(sentBy(vs, x.slot))} · ${ctx.fmt(x.received_at)}${x.pinned ? " · pinned" : ""}${x.unread ? " · waiting to be read" : ""}`}"${on ? ` aria-current="page"` : ""}>${ico("doc")}<span class="title">${esc(x.title)}</span><span class="age">${ctx.relShort(x.received_at)}</span></a>` +
    // Its tools: the path to copy, where there is one; on the row of the
    // document on the page, the way back to the panes, in view at rest; and
    // the ✕ that takes it off this list -- this list only.
    `<span class="dk-tools">` +
    (x.source_path ? `<button type="button" data-a="copy" data-path="${esc(x.source_path)}" data-tip="Copy path" data-tip-sub="${esc(x.source_path)}" aria-label="Copy the path of ${esc(x.title)}">${ico("copy")}</button>` : "") +
    (on ? `<button type="button" data-a="desk" data-tip="Back to the panels" data-key="ctrl+\`" aria-label="Back to the panels">${ico("back")}</button>` : "") +
    `<button type="button" data-a="doc-x" data-d="${esc(x.id)}" data-tip="Remove from this list" data-tip-sub="the Inbox keeps it" aria-label="Remove ${esc(x.title)} from this desk's list">${ico("x")}</button>` +
    `</span></li>` + errLine(`d${x.id}`, esc);
}

/** The documents' box keeps where it was scrolled through a redraw, and
 *  brings the document on the page into view when one is opened. */
function docsScroll(top) {
  const ul = ctx.tocEl.querySelector(".dk-docs:not(.dk-offs)");
  if (!ul) return;
  ul.scrollTop = top;
  if (reading === docSeen) return;
  docSeen = reading;
  const on = ul.querySelector(".dk-doc.on");
  if (!on) return;
  const a = ul.getBoundingClientRect(), b = on.getBoundingClientRect();
  if (b.top < a.top) ul.scrollTop -= a.top - b.top;
  else if (b.bottom > a.bottom) ul.scrollTop += b.bottom - a.bottom;
}

/** Leaving a desk leaves its removed list, a row's Undo and a search with it. */
function forgetDocs() {
  clearTimeout(docTimer);
  docOff = []; offShown = false; docGone = null; docSeen = null;
  docsFind = ""; findCaret = 0; findOn = false;
}

/** The documents' search field, after a redraw made it again: what was
 *  typed narrows the list as it is typed, and the focus and the caret go
 *  back where they were. */
function findFocus() {
  const inp = ctx.tocEl.querySelector(".dk-find");
  if (!inp) { findOn = false; return; }
  inp.addEventListener("focus", () => { findOn = true; });
  inp.addEventListener("blur", () => { if (!drawing) findOn = false; });
  inp.addEventListener("input", () => { docsFind = inp.value; findCaret = inp.selectionStart; rail(); });
  inp.addEventListener("keydown", e => {
    // The desk gives every other key to the shell in the focused panel.
    e.stopPropagation();
    // Enter opens the first match; Escape empties the field, and leaves it
    // when it is empty already.
    if (e.key === "Enter") { e.preventDefault(); ctx.tocEl.querySelector(".dk-docs:not(.dk-offs) a[data-read]")?.click(); }
    else if (e.key === "Escape") { e.preventDefault(); if (docsFind) { docsFind = ""; findCaret = 0; rail(); } else inp.blur(); }
  });
  if (!findOn) return;
  inp.focus();
  const at = Math.min(findCaret, inp.value.length);
  inp.setSelectionRange(at, at);
}

/** Where each desk's repository lives on the web, by desk id: `{ url, at,
 *  busy }`, read off the daemon's git (`/api/desks/{id}/git`), which keeps
 *  its answer for half a minute too. Kept across desks, so going back to one
 *  draws its line at once. */
const repos = new Map();
const REPO_FRESH = 30_000;
const REPO = `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 12.5v-9A1.5 1.5 0 0 1 5 2h7.5v9.5H5a1.5 1.5 0 0 0 0 3h7.5"/></svg>`;
const FORGES = { "github.com": "GitHub", "gitlab.com": "GitLab", "codeberg.org": "Codeberg", "bitbucket.org": "Bitbucket" };

/** The repo's web page for desk `d`, as last read, and a read when that is
 *  stale. A line that changes is redrawn when the answer comes. */
function repoOf(d) {
  const r = repos.get(d.id);
  if (!r || (!r.busy && Date.now() - r.at > REPO_FRESH)) {
    const was = r ? r.url : null;
    repos.set(d.id, { url: was, at: Date.now(), busy: true });
    ctx.api(`/api/desks/${d.id}/git`).then(j => (j && j.remote) || null, () => was).then(url => {
      repos.set(d.id, { url, at: Date.now(), busy: false });
      if (url !== was && current()?.id === d.id) meta();
    });
  }
  return r ? r.url : null;
}

/** `https://github.com/o/r` as `o/r`, and the name of where it is. */
function repoName(url) {
  try { const u = new URL(url); return { path: u.pathname.replace(/^\/+/, ""), host: FORGES[u.hostname] || u.host }; }
  catch { return null; }
}

/** The desk and its focused panel, in the pane under the rail: what the
 *  clock and the focused panel's own frames redraw, and nothing else. Under
 *  them, the desk's repository on the web, when its folder has one. */
function meta() {
  const d = current();
  if (!d) return;
  const { esc } = ctx, v = views.get(focused), s = v ? v.status : null;
  const since = !s ? "" : s.agent && s.agent_since ? `${s.agent.replace("_", " ")} ${ago(s.agent_since)}` : s.blocked && s.blocked_since ? `blocked ${ago(s.blocked_since)}` : s.running && s.since ? `up ${ago(s.since)}` : s.exit != null ? `exited ${s.exit}` : "not running";
  // The desk's name and folder are in its head, and renaming and closing it
  // are on its ⋯: this pane is the focused panel's line, and nothing twice.
  const top = "";
  const cp = ctxPct(s);
  const low = v ? `<div class="row dk-pl"><span><span class="dk-slot" data-tip="Panel ${v.pane.slot}" data-key="ctrl+alt+${v.pane.slot}">[${v.pane.slot}]</span>${s.model ? ` ${esc(s.model)}` : s.pid ? ` pid ${s.pid}` : ""}` +
    `${cp == null ? "" : ` · <span class="${ctxCls(cp)}${ctxUsed(s) == null ? " none" : ""}" data-tip="${esc(ctxTip(s))}">${ctxFig(s)}</span>`}${since ? ` · ${since}` : ""}</span></div>` +
    // The folder the panel's shell is in now, when it is not the desk's own.
    ((s.cwd || v.pane.cwd) && (s.cwd || v.pane.cwd) !== d.root ? `<div class="row dk-pl"><b>In</b><span class="dk-in" data-tip="${esc(s.cwd || v.pane.cwd)}" data-tip-mono>${esc(tilde(s.cwd || v.pane.cwd))}</span></div>` : "") : "";
  const url = repoOf(d), rn = url && repoName(url);
  const foot = rn && rn.path ? `<div class="row dk-repo-row"><a class="dk-repo" href="${esc(url)}" target="_blank" rel="noopener" data-tip="Open on ${esc(rn.host)}" data-tip-sub="${esc(url)}">${REPO}<span>${esc(rn.path)}</span><span class="dk-out">↗</span></a></div>` : "";
  // The panel's line ticks ("up 12s") on every frame that brings a status,
  // and the desk's ✎ and ✕ above it are what the pointer is on: the line is
  // written alone while the rows above it are still the ones drawn here.
  const el = ctx.metaEl, pl = el.querySelector(".dk-pl");
  if (el.$top === top && el.$foot === foot && el.firstElementChild === el.$first && (pl || !low)) {
    // The panel's lines -- its state and, when it moved, its folder -- are
    // written together: all of the old ones out, the new ones in their place.
    if (low !== el.$low) { el.querySelectorAll(".dk-pl").forEach((r, i) => { if (i) r.remove(); }); if (low) pl.outerHTML = low; else if (pl) pl.remove(); }
  } else drawIn(el, top + low + foot);
  el.$top = top; el.$low = low; el.$foot = foot;
  ctx.rail.classList.remove("empty");
}

/** Write `html` into `el`, unless `el` already holds exactly that as this
 *  filled it. A redraw that changes nothing still replaces every node, and
 *  the one under the pointer loses its hover until the pointer moves. What
 *  another hand wrote since (a clear, the document's outline) is not ours,
 *  so it is written over. */
function drawIn(el, html) {
  if (el.$html === html && el.firstElementChild && el.firstElementChild === el.$first) return false;
  el.innerHTML = html;
  el.$html = html; el.$first = el.firstElementChild;
  return true;
}

/** A pane's row in the rail takes its new name, and how full its context
 *  window is, in place. */
function named(v) {
  const b = ctx.tocEl.querySelector(`.dk-focus[data-focus="${v.id}"]`);
  if (!b) return;
  const here = v.status.cwd || v.pane.cwd;
  b.dataset.tip = what(v);
  if (here) b.dataset.tipSub = tilde(here); else delete b.dataset.tipSub;
  b.querySelector(".nm").textContent = short(v);
  const cp = ctxPct(v.status);
  let c = b.querySelector(".ctx");
  if (cp == null) { c?.remove(); return; }
  if (!c) b.append(c = document.createElement("span"));
  c.className = ctxCls(cp);
  c.textContent = `${cp}%`;
}

/* ---------- the list ----------
 *
 * A desk's third section, under the documents: what this desk owes the reader,
 * in their own words. A checklist rather than prose -- one line, a circle to
 * tick, and the done half sinking to the bottom -- because the thing a rail is
 * good for is the short list you glance at while the work is in front of you.
 *
 * Every action here is optimistic and then confirmed: the circle fills under
 * the finger and the daemon is told afterwards, because a list that waits for
 * a round trip before it ticks feels broken even on loopback. The daemon's
 * answer is then read back, since it owns the order -- done lines sit in the
 * order they were ticked, and this page does not try to guess that.
 */

/** The section, drawn from whatever this page holds. */
function noteSec(d) {
  const { esc } = ctx;
  const mine = notesAt === d.id ? noteList : [];
  // Asked for once per desk, from the draw that first needs it: the list is
  // small and it is not worth a round trip on every arrival the way the
  // documents are.
  if (notesAt !== d.id && notesOff !== d.id) getNotes(d.id);
  const left = mine.filter(x => !x.done && !x.gone && !x.suggested_by).length;
  const done = mine.filter(x => x.done && !x.gone).length;
  const seen = mine.filter((x, i) => notesAll || i < NOTES_SHOWN || x.gone || notesKept.has(x.id) || (noteField && noteField.id === x.id));
  const hid = mine.length - seen.length, folds = notesAll && mine.length > NOTES_SHOWN;
  const rows = seen.map(x => noteRow(x, esc)).join("") +
    (hid || folds ? `<li class="dk-more-li"><button type="button" class="dk-new dk-more" data-a="notes-more" aria-expanded="${folds}">${folds ? "Show fewer" : `${hid} more`}</button></li>` : "");
  // The section's two actions sit in its head, beside the count, where they
  // are in view however long the list is: a new note, and removing the done
  // half. Removing answers where it was asked, as a ✕ does: the head holds
  // the Undo until it runs out. Beside the summary and not in it -- a button
  // in a <summary> is a button in a button -- and laid over its right end,
  // which keeps the room for them whether they show or not.
  const undo = cleared && cleared.at === d.id;
  const acts = undo
    ? `<span class="dk-cleared" role="status">${cleared.xs.length} removed<button type="button" class="dk-undo" data-a="note-unclear">Undo</button></span>`
    : (done ? `<button type="button" data-a="note-clear" data-tip="Remove done notes" data-tip-sub="${ctx.plural(done, "done note")} · Undo brings them back" aria-label="Remove done notes">${ico("done")}</button>` : `<span class="dk-act-room" aria-hidden="true"></span>`) +
      `<button type="button" data-a="note-new" data-tip="New note" aria-label="New note">${ico("plus")}</button>`;
  return `<div class="dk-notes-part${undo ? " undo" : ""}" data-part="rail.notes">` +
    `<details class="dk-sec dk-notes" data-sec="notes"${secFolded("notes") ? "" : " open"}>` +
    `<summary class="t-label dk-lab" data-part="rail.notes.head" data-tip="Notes" data-tip-sub="A list of your own for this desk. It is kept on this machine and nothing on it is ever sent anywhere.">Notes<span class="s-chev" aria-hidden="true"></span>${left ? `<span class="n">${left} open</span>` : ""}</summary>` +
    errLine("clear", esc, "p") +
    (rows ? `<ul class="dk-list">${rows}</ul>` : notesOff === d.id ? noReach("notes") : "") +
    // The bar for a new line, always at the end of the list, where the line
    // will land: a quiet field until it is clicked, or the head's + is, and
    // then the live one, in the same room, so nothing under it moves as it
    // opens and shuts. On an empty list it is the whole of the list.
    (notesOff === d.id ? "" : !(noteField && noteField.kind === "new")
      ? `<div class="dk-note new idle"><span class="dk-lead"><span class="dk-tick ghost" aria-hidden="true"></span></span><input class="dk-note-in idle" placeholder="${rows ? "Add a note" : "What's the status of this project?"}" aria-label="A new note on this desk" spellcheck="false"></div>`
      : `<div class="dk-note new"><span class="dk-lead"><span class="dk-tick ghost" aria-hidden="true"></span></span><input class="dk-note-in" placeholder="${pending.length ? "What it shows" : rows ? "What has to happen" : "What's the status of this project?"}" aria-label="A new note on this desk" spellcheck="false">` +
        // Pictures waiting on the line: the picture mark a line wears, with
        // their count, and the ✕ that leaves them out.
        (pending.length ? `<span class="dk-pend" role="status" aria-label="${ctx.plural(pending.length, "picture")} with this line"><span class="dk-pic">${ico("pic")}${pending.length > 1 ? `<span class="c">${pending.length}</span>` : ""}</span><button type="button" data-a="pend-x" data-tip="Leave the pictures out" aria-label="Leave the pictures out">${ico("x")}</button></span>` : "") + noteSays(esc) + `</div>`) +
    `</details><span class="dk-sec-acts">${acts}</span></div>`;
}

/** The refusal for row `k`, under it: a list item, or `tag` outside a list. */
const errLine = (k, esc, tag = "li") => rowErr && rowErr.k === k
  ? `<${tag} class="dk-err" role="alert" data-tip="What went wrong" data-tip-sub="${esc(rowErr.raw)}">${esc(rowErr.why)}<button type="button" class="dk-undo" data-a="retry">Retry</button></${tag}>` : "";

/** Why the field is open again, after a save the daemon refused. */
const noteSays = esc => noteErr ? `<span class="field-err" role="alert">${esc(noteErr)}</span>` : "";

/** One line. A line being rewritten is a field in the row's own place, so the
 *  text does not move under the cursor as it becomes editable; a line just
 *  taken off keeps its place too, holding the offer to put it back where the
 *  ✕ was rather than in a corner of the window. */
function noteRow(x, esc) {
  if (x.gone) {
    return `<li class="dk-note gone" role="status"><span class="nm">${esc(x.text)}</span>` +
      `<button type="button" class="dk-undo" data-a="note-back" data-n="${x.id}">Undo</button></li>` + errLine(`n${x.id}`, esc);
  }
  // An agent's suggestion: a ghost of a row, not on the list until kept.
  // Keep and ✕ sit where a line's tools do, always shown, since a suggestion
  // is a question and these are its two answers.
  if (x.suggested_by) {
    return `<li class="dk-note dk-sug"><span class="dk-lead"><span class="dk-tick ghost" aria-hidden="true"></span></span>` +
      `<span class="nm" data-tip="${esc(x.text)}" data-tip-sub="${x.sent_by ? `from ${esc(x.sent_by)}, a friend` : `suggested by ${esc(x.suggested_by)}`} · Keep puts it on your list" data-tip-overflow>${esc(x.text)}</span>` +
      `<span class="dk-sug-tools"><button type="button" class="dk-keep" data-a="note-keep" data-n="${x.id}" aria-label="Keep ${esc(x.text)} on the list">Keep</button>` +
      `<button type="button" data-a="note-x" data-n="${x.id}" data-tip="Not this one" data-tip-sub="nothing is deleted" aria-label="Do not keep ${esc(x.text)}">${ico("x")}</button></span></li>` + errLine(`n${x.id}`, esc);
  }
  // A line is two lines at most; the whole of it is its tip, and rewriting
  // it opens a card over the list, as tall as the text, while the row keeps
  // its own two lines underneath: nothing below it moves either way.
  const editing = noteField && noteField.kind === "edit" && noteField.id === x.id;
  // Two columns either side of the text, each two lines tall: the circle
  // over the line's number on the left, and on the right the stage over the
  // ✕. The number is the one the reader and the agents call the line by, so
  // a click copies it, ready to paste into a panel.
  return `<li class="dk-note${x.done ? " done" : ""}${editing ? " editing" : ""}">` +
    `<span class="dk-lead"><button type="button" class="dk-tick" role="checkbox" aria-checked="${x.done}" data-a="note-tick" data-n="${x.id}" aria-label="${x.done ? "Done" : "Not done"}: ${esc(x.text)}">${x.done ? ico("tick") : ""}</button>` +
    `<button type="button" class="dk-num" data-a="note-num" data-c="#${x.id}" data-tip="Copy #${x.id}" data-tip-sub="to tell a panel which note" aria-label="Copy note number ${x.id}">#${x.id}</button></span>` +
    `<button type="button" class="nm" data-a="note-edit" data-n="${x.id}" data-tip="${esc(x.text)}" data-tip-sub="${x.done_by ? `ticked by ${esc(x.done_by)} · ` : ""}click to rewrite" data-tip-overflow>${esc(x.text)}</button>` +
    picMark(x, esc) + threadChip(x, esc) +
    `<span class="dk-tail">${stageMark(x, esc)}` +
    `<span class="dk-tools"><button type="button" data-a="note-x" data-n="${x.id}" data-tip="Take it off the list" data-tip-sub="nothing is deleted" aria-label="Take ${esc(x.text)} off the list">${ico("x")}</button></span></span>` +
    (x.done && x.done_by ? byLine(x, esc) : x.sent_by ? `<span class="dk-by"><span>from ${esc(x.sent_by)}</span></span>` : "") +
    (editing ? `<textarea class="dk-note-in dk-note-over" rows="1" aria-label="This note" spellcheck="false"></textarea>${noteSays(esc)}` : "") +
    `</li>` + errLine(`n${x.id}`, esc);
}

/* ---------- pictures on a line ----------
 *
 * A screenshot of the thing a line is about: pasted into the field, dropped
 * on the row, or added from the row's menu. Small under the line's text, whole
 * over the page on a click. The file stays when a picture comes off a line --
 * that is an Undo, not a delete -- and an agent reading the notes is given
 * each one as a file it can open.
 */

/** The pictures in a paste or a drop, of the four kinds the daemon keeps. */
const images = dt => [...(dt?.files || [])].filter(f => /^image\/(png|jpeg|gif|webp)$/.test(f.type));

/** At the end of a line's text: that it has pictures, and how many, in one
 *  small mark that opens them whole. While one just taken off can still be
 *  put back, the mark is its Undo, in the same room. */
function picMark(x, esc) {
  const n = x.images?.length || 0;
  if (imgGone && imgGone.n === x.id) {
    return `<button type="button" class="dk-pic back" data-a="img-back" data-tip="Put the picture back" data-tip-sub="it came off this note" aria-label="Put the picture back on ${esc(x.text)}">${ico("back")}</button>`;
  }
  if (!n) return "";
  return `<button type="button" class="dk-pic" data-a="note-img" data-n="${x.id}" data-i="0" data-tip="${ctx.plural(n, "picture")}" data-tip-sub="click to see ${n > 1 ? "them" : "it"} whole" aria-label="See the ${ctx.plural(n, "picture")} on ${esc(x.text)}">${ico("pic")}${n > 1 ? `<span class="c">${n}</span>` : ""}</button>`;
}

/** How far an agent has got with a line, as it said with mark_desk_note --
 *  read, planned, working -- and nothing once the line is done. Working
 *  holds only while the panel that said it has its agent at work: the
 *  moment that agent goes quiet the line is back at its plan, before the
 *  list is read again. */
function stageOf(x) {
  if (x.done || !x.stage) return "";
  if (x.stage !== "working") return x.stage;
  return views.get(x.stage_pane)?.status?.agent ? "working" : x.stage_doc ? "planned" : "read";
}

/** The stage's mark, at the line's right end over its ✕, in a slot every
 *  line keeps, so a line that is picked up does not rewrap. The plan's mark
 *  opens the plan; working names the panel by its number, as its tab does. */
function stageMark(x, esc) {
  const st = stageOf(x), by = esc(x.stage_by || "an agent");
  if (st === "planned" && x.stage_doc) {
    return `<button type="button" class="dk-stage planned" data-a="note-doc" data-d="${esc(x.stage_doc)}" data-tip="Planned by ${by}" data-tip-sub="click to open the plan" aria-label="Open the plan for ${esc(x.text)}">${ico("doc")}</button>`;
  }
  if (st === "working") {
    // The dot breathes only while that agent is at it; between its turns
    // the line is still its, and the dot holds still.
    const at = x.stage_panel ? ` in ${esc(x.stage_panel)}` : "";
    const busy = views.get(x.stage_pane)?.status?.agent === "working";
    const say = busy ? `${by} is working on it${at}` : `${by} has it${at}`;
    const slot = views.get(x.stage_pane)?.pane?.slot;
    return `<span class="dk-stage working${busy ? " busy" : ""}" role="img" data-tip="${say}"${busy ? "" : ` data-tip-sub="between turns"`} aria-label="${say}">${slot != null ? `<span class="c">${slot}</span>` : ""}</span>`;
  }
  if (st === "read" || st === "planned") return `<span class="dk-stage read" role="img" data-tip="Read by ${by}" data-tip-sub="picked up, not planned yet" aria-label="Read by ${by}"></span>`;
  return `<span class="dk-stage" aria-hidden="true"></span>`;
}

/** Fetch the pictures the rail shows and has not got yet. An <img> cannot
 *  carry the capability, so the bytes come through the page, once a name. */
function loadImgs() {
  const d = current();
  if (!d) return;
  for (const img of [...ctx.tocEl.querySelectorAll("img[data-img]:not([src])"), ...(lightbox ? lightbox.el.querySelectorAll("img[data-img]:not([src])") : [])]) {
    const n = img.dataset.img, u = imgUrls.get(n);
    if (typeof u === "string") { img.src = u; continue; }
    if (u || !ctx.blob) continue;
    imgUrls.set(n, ctx.blob(`/api/desks/${d.id}/note-images/${encodeURIComponent(n)}`).then(b => {
      imgUrls.set(n, URL.createObjectURL(b));
      for (const el of ctx.tocEl.querySelectorAll(`img[data-img="${window.CSS.escape(n)}"]`)) el.src = imgUrls.get(n);
      const lb = lightbox?.el.querySelector(`img[data-img="${window.CSS.escape(n)}"]:not([src])`);
      if (lb) lb.src = imgUrls.get(n);
    }, () => imgUrls.delete(n)));
  }
}

/** Put pictures on a line, one after another, and read the list back. A no
 *  says so in the row, with what the daemon said. */
async function putImages(id, fs) {
  const d = current();
  if (!d || !fs.length) return;
  for (const f of fs) {
    try { await ctx.api(`/api/desks/${d.id}/notes/${id}/image`, f, f.type); }
    catch (e) {
      // Its Retry reads the list again: the file itself is the reader's to paste again.
      rowErr = { k: `n${id}`, why: `Could not add the picture · ${ctx.sayErr(e).why}`, raw: e.message, again: { a: "reload", w: "notes" } };
      break;
    }
  }
  await getNotes(d.id, true);
}

/** Take picture `i` off line `id`. Its Undo is where the ✕ was, in the
 *  picture's own view, and in the line's picture mark once that is closed. */
async function dropImage(id, i) {
  const d = current(), x = noteList.find(y => y.id === id);
  if (!d || !x || !x.images?.[i]) return;
  clearTimeout(imgTimer);
  const was = x.images;
  x.images = was.filter((_, k) => k !== i);
  imgGone = { n: id, was, at: i };
  imgTimer = setTimeout(() => { imgGone = null; if (current()) rail(); lightbox?.show(); }, BACK_MS);
  rail(); lightbox?.show();
  await told({ a: "img-x", n: String(id), i: String(i) }, `n${id}`, "Could not remove the picture", () => { clearTimeout(imgTimer); imgGone = null; x.images = was; },
    () => ctx.api(`/api/desks/${d.id}/notes/${id}/images`, { images: x.images }));
  lightbox?.show();
}

/** The Undo: the line's pictures as they were. */
async function imgBack() {
  const d = current(), g = imgGone, x = g && noteList.find(y => y.id === g.n);
  clearTimeout(imgTimer);
  imgGone = null;
  if (!d || !x) { if (current()) rail(); return; }
  const now = x.images;
  x.images = g.was;
  if (lightbox?.id === x.id) lightbox.i = g.at;
  rail(); lightbox?.show();
  if (await told({ a: "img-back" }, `n${x.id}`, "Could not put the picture back", () => { x.images = now; imgGone = g; },
    () => ctx.api(`/api/desks/${d.id}/notes/${x.id}/images`, { images: g.was }))) await getNotes(d.id, true);
}

/** A picture whole, over the page: the line it is on under it, ‹ and › to
 *  the line's others, and the way to take it off the line. Esc, or a click
 *  on the dark around it, closes it, and the focus goes back to the row. */
function openLightbox(id, i, from) {
  const x = noteList.find(y => y.id === id);
  if (!x || !x.images?.length) return;
  closeLightbox();
  const el = document.createElement("div");
  el.className = "dk-lb"; el.setAttribute("role", "dialog"); el.setAttribute("aria-modal", "true"); el.setAttribute("aria-label", "A picture on a note");
  lightbox = { el, id, i: Math.max(0, Math.min(i, x.images.length - 1)), from };
  const show = () => {
    const y = noteList.find(z => z.id === lightbox.id);
    if (!y) return closeLightbox();
    const imgs = y.images || [], gone = imgGone && imgGone.n === y.id;
    // The last one taken off: the view stays, holding its Undo, until it
    // is closed or the Undo runs out.
    if (!imgs.length && !gone) return closeLightbox();
    lightbox.i = Math.max(0, Math.min(lightbox.i, imgs.length - 1));
    const n = imgs[lightbox.i], u = n && imgUrls.get(n), many = imgs.length > 1;
    const back = gone ? `<span class="lb-gone" role="status">Picture removed<button type="button" class="dk-undo" data-lb="undo">Undo</button></span>` : "";
    el.innerHTML = `<figure${n ? "" : ` class="none"`}>` + (n ? `<img alt="${ctx.esc(y.text)}" data-img="${ctx.esc(n)}"${typeof u === "string" ? ` src="${u}"` : ""}>` : "") +
      `<figcaption><span class="t">${ctx.esc(y.text)}</span>${many ? `<span class="k">${lightbox.i + 1} of ${imgs.length}</span>` : ""}` +
      (many ? `<button type="button" data-lb="prev" aria-label="The picture before">‹</button><button type="button" data-lb="next" aria-label="The picture after">›</button>` : "") +
      back + (n ? `<button type="button" data-lb="off">Remove from this note</button>` : "") + `<button type="button" data-lb="close">Close</button></figcaption></figure>`;
    if (n && typeof u !== "string") loadImgs();
    el.querySelector(gone ? "[data-lb=undo]" : "[data-lb=close]").focus();
  };
  lightbox.show = show;
  el.addEventListener("click", e => {
    const b = e.target.closest("[data-lb]");
    if (!b) { if (e.target === el) closeLightbox(); return; }
    const y = noteList.find(z => z.id === lightbox.id), k = b.dataset.lb;
    if (k === "close") closeLightbox();
    else if (k === "off") dropImage(id, lightbox.i);
    else if (k === "undo") imgBack();
    else if (y) { lightbox.i = (lightbox.i + (k === "next" ? 1 : y.images.length - 1)) % y.images.length; show(); }
  });
  el.addEventListener("keydown", e => {
    // The desk gives keys to the focused panel; these are the picture's.
    e.stopPropagation();
    if (e.key === "Escape") { e.preventDefault(); closeLightbox(); }
    else if (e.key === "ArrowRight" || e.key === "ArrowLeft") el.querySelector(`[data-lb=${e.key === "ArrowRight" ? "next" : "prev"}]`)?.click();
  });
  document.body.append(el);
  show();
}
function closeLightbox() {
  if (!lightbox) return;
  const { el, from } = lightbox;
  const n = lightbox.id;
  lightbox = null;
  el.remove();
  // The rail was drawn again under it: back to the line's picture mark.
  (from?.isConnected ? from : ctx.tocEl.querySelector(`.dk-pic[data-n="${n}"], .dk-pic.back`))?.focus({ preventScroll: true });
}

/** Pictures dropped on a line's row go on that line; dropped on the new-line
 *  field, they wait for it. The row the drop would land on is marked. */
function dragOver(e) {
  if (![...(e.dataTransfer?.types || [])].includes("Files")) return;
  const row = e.target.closest(".dk-note:not(.gone, .dk-sug)");
  ctx.tocEl.querySelector(".dk-note.drop")?.classList.remove("drop");
  if (!row || !ctx.tocEl.querySelector(".dk-notes")?.contains(row)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "copy";
  row.classList.add("drop");
}
function dragLeave(e) { if (!ctx.tocEl.contains(e.relatedTarget)) ctx.tocEl.querySelector(".dk-note.drop")?.classList.remove("drop"); }
function dropped(e) {
  const row = e.target.closest(".dk-note:not(.gone, .dk-sug)");
  ctx.tocEl.querySelector(".dk-note.drop")?.classList.remove("drop");
  if (!row) return;
  const fs = images(e.dataTransfer);
  e.preventDefault();
  if (!fs.length) return;
  if (row.classList.contains("new")) {
    if (noteField && noteField.kind === "edit") return;
    if (!noteField) { noteField = { kind: "new" }; noteDraft = ""; noteCaret = 0; }
    pending = [...pending, ...fs]; rail(); return;
  }
  const n = row.querySelector("[data-a=note-tick]")?.dataset.n;
  if (n) putImages(+n, fs);
}

/** From the row's menu: the system's file picker, pictures only. */
function pickImages(id) {
  const inp = Object.assign(document.createElement("input"), { type: "file", accept: "image/png,image/jpeg,image/gif,image/webp", multiple: true });
  inp.addEventListener("change", () => putImages(id, images(inp)));
  inp.click();
}

/** Copy a tick's commit, or a line's number, and say so where it is: the
 *  hash reads "copied" for a moment, in its own place, rather than in a
 *  corner of the window. */
function copySha(b, said = "copied") {
  if (!b) return;
  navigator.clipboard?.writeText(b.dataset.c);
  if (b.dataset.said != null) return;
  const was = b.textContent;
  b.textContent = said; b.dataset.said = "";
  setTimeout(() => { if (b.isConnected) { b.textContent = was; delete b.dataset.said; } }, 1200);
}

/** Under a line an agent ticked: who, and where the work went when it said --
 *  the commit (a click copies the whole hash, and says so in its own place)
 *  and the document it sent (a click opens it). A line of its own, so a long
 *  note keeps the rail's width and nothing beside it moves. */
function byLine(x, esc) {
  const sha = x.done_commit ? `<button type="button" class="dk-sha" data-a="note-sha" data-c="${esc(x.done_commit)}" data-tip="Copy commit" data-tip-sub="${esc(x.done_commit)}">${esc(x.done_commit.slice(0, 7))}</button>` : "";
  const doc = x.done_doc ? `<button type="button" class="dk-sent" data-a="note-doc" data-d="${esc(x.done_doc)}" data-tip="Open the document" data-tip-sub="What ${esc(x.done_by)} sent about it" aria-label="Open what ${esc(x.done_by)} sent about it">${ico("doc")}</button>` : "";
  // Where the finished work can be seen -- a PR, a deploy -- by its host.
  let host = "";
  try { host = x.done_evidence ? new URL(x.done_evidence).host.replace(/^www\./, "") : ""; } catch { host = ""; }
  const ev = host ? `<button type="button" class="dk-ev" data-a="note-ev" data-u="${esc(x.done_evidence)}" data-tip="${esc(x.done_evidence)}" data-tip-sub="where the work can be seen">${esc(host)} ↗</button>` : "";
  return `<span class="dk-by"><span data-tip="Ticked by" data-tip-sub="${esc(x.done_by)}">${esc(x.done_by)}</span>${sha}${doc}${ev}</span>`;
}

/** A desk with nothing sent yet waits for its first document, and says how
 *  to get one: the sentence to give Claude, with its Copy. After five
 *  minutes of waiting it names the usual reason nothing comes. */
const WANT = "Plan what's next here and send it to snyvi";
const waitSince = new Map();
function waitingFirst(d) {
  if (!waitSince.has(d.id)) waitSince.set(d.id, Date.now());
  const ago = Date.now() - waitSince.get(d.id), long = ago > 300e3;
  // The rail is drawn again on every change of a panel's status, and the
  // ring with it: started as far along as the wait is, so a redraw does not
  // set its few turns going again.
  return `<div class="dk-wait"><p class="dk-empty"><span class="dk-spin" aria-hidden="true" style="animation-delay:-${ago}ms"></span>Waiting for the first one…</p>` +
    `<p class="dk-ask">Ask Claude: <q>${WANT}</q> <button type="button" class="dk-sha" data-a="want-copy" data-c="${WANT}">copy</button></p>` +
    (long ? `<p class="dk-empty">Nothing yet? A Claude session started before snyvi was connected cannot see it: start a new one.</p>` : "") + `</div>`;
}

/** Leaving a desk leaves its list with it: another desk's notes are another
 *  desk's, and a field left open on this one must not reopen on that one. */
function forgetNotes() {
  clearTimeout(backTimer);
  forgetFiled();
  noteList = []; notesAt = null; notesGet = null; noteField = null; noteDraft = ""; noteCaret = 0; cleared = null; notesAll = false; notesKept.clear();
  clearTimeout(imgTimer); pending = []; imgGone = null; closeLightbox();
}

/** This desk's list. Asked for once, unless a write says to look again. */
async function getNotes(id, again) {
  if (id == null || !ctx) return;
  if (!again && (notesAt === id || notesGet === id)) return;
  notesGet = id;
  let j;
  try { j = await ctx.api(`/api/desks/${id}/notes`); }
  catch { notesGet = null; if (id === deskId) { notesOff = id; if (current()) rail(); } return; }
  notesGet = null; notesOff = null;
  // The desk was swapped while this was in flight: its list is not this one's.
  if (id !== deskId) return;
  // A read that lands between Remove done notes and the daemon hearing of it would
  // put the cleared lines back for a moment.
  const off = cleared && cleared.at === id ? new Set(cleared.xs.map(x => x.id)) : null;
  // A line just taken off keeps its row and its Undo through a read: this
  // window's own write comes back to it as `desknotes`, and the row holding
  // the offer must not vanish under the hand reaching for it.
  const was = notesAt === id ? noteList : [];
  const next = (j.notes || []).filter(x => !off || !off.has(x.id));
  was.forEach((x, i) => { if (x.gone && !next.some(y => y.id === x.id)) next.splice(Math.min(i, next.length), 0, x); });
  // An agent, or another window, ticked the last open line: the milestone is
  // the mark's to say, in the sidebar, never this rail's (docs/DESIGN.md
  // §2.3). A tick here says it itself, below, before the list is read back.
  const ticked = notesAt === id && was.some(stillOpen) && !next.some(stillOpen) && next.filter(x => x.done).length > was.filter(x => x.done).length;
  noteList = next; notesAt = id;
  if (ticked && ctx.done) ctx.done();
  if (current()) rail();
}
/** A line still to do: not ticked, not on its way out, not a suggestion. */
const stillOpen = x => !x.done && !x.gone && !x.suggested_by;

/** A desk's list changed -- an agent ticked or suggested a line, or another
 *  window wrote on it: read this desk's list again if it is that desk. A field being typed in is left be --
 *  the list is read, and the rail redraws around it, as after a tick here. */
export function notesChanged(id) {
  if (ctx && id === deskId) { getNotes(id, true); getFiled(id, true); }
}

/** Put the open field back after a redraw, with what was typed into it and the
 *  caret where the reader left it. */
function noteFocus() {
  ctx.tocEl.querySelector(".dk-note-in.idle")?.addEventListener("focus", () => {
    noteField = { kind: "new" }; noteDraft = ""; noteCaret = 0; rail();
  }, { once: true });
  const inp = ctx.tocEl.querySelector(".dk-note-in:not(.idle)");
  if (!inp) return;
  inp.value = noteDraft;
  // The card over a line being rewritten grows with its text, up to twelve
  // lines, and scrolls after that; the list under it stays where it is.
  const grow = () => { if (inp.tagName === "TEXTAREA") { inp.style.height = "auto"; inp.style.height = Math.min(inp.scrollHeight + 2, 12 * 18 + 8) + "px"; } };
  grow();
  inp.addEventListener("input", grow);
  inp.addEventListener("input", () => { noteDraft = inp.value; noteCaret = inp.selectionStart; if (noteErr) { noteErr = ""; inp.nextElementSibling?.remove(); } });
  // Where the caret was, not the end of the line: the rail redraws on the
  // clock every 30 seconds, and a caret that jumped to the end each time
  // would make a long note impossible to correct in the middle.
  for (const e of ["keyup", "click"]) inp.addEventListener(e, () => { noteCaret = inp.selectionStart; });
  inp.addEventListener("keydown", e => {
    // The desk gives every other key to the shell in the focused panel.
    e.stopPropagation();
    // Shift+Enter is a new line in the card; Enter alone keeps it.
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); saveNote(true); }
    else if (e.key === "Escape") { e.preventDefault(); noteField = null; noteDraft = ""; noteCaret = 0; noteErr = ""; pending = []; rail(); }
  });
  // A picture pasted into the field: onto the line being rewritten at once,
  // or held for the new line until Enter makes it.
  inp.addEventListener("paste", e => {
    const fs = images(e.clipboardData);
    if (!fs.length) return;
    e.preventDefault();
    pasted(fs);
  });
  // Its ✕ must not take the focus from the field: leaving the field keeps the line.
  ctx.tocEl.querySelector("[data-a=pend-x]")?.addEventListener("mousedown", e => e.preventDefault());
  inp.addEventListener("blur", () => { if (!drawing) saveNote(false); });
  inp.focus();
  const at = Math.min(noteCaret, inp.value.length);
  inp.setSelectionRange(at, at);
}

/** Pictures pasted into the open field: onto the line being rewritten at
 *  once, or held for the new line until Enter makes it. */
function pasted(fs) {
  if (noteField && noteField.kind === "edit") putImages(noteField.id, fs);
  else { pending = [...pending, ...fs]; rail(); }
}

/** A picture the Linux window read off the clipboard itself, on Ctrl+V: its
 *  engine gives the paste event nothing for an image (src/bin/app.rs). Taken
 *  where it was pasted: a note's field, or a panel, which gets it as it gets
 *  any pasted picture, as a document whose path is typed -- except Claude on a
 *  plain ⌃V, which takes the picture itself. */
function windowPaste(e) {
  const at = document.activeElement;
  if (typeof e.detail !== "string" || !at) return;
  const note = at.classList.contains("dk-note-in") && ctx.tocEl.contains(at);
  const v = !note && [...views.values()].find(x => x.body === at);
  if (!note && !v) return;
  // Claude, live in the panel, was sent ^V and has the picture already;
  // typing its path as well would give it the picture twice.
  if (v && (v.status.agent_in || v.status.agent) && Date.now() - (v.ctrlV || 0) < 2000) return;
  const b64 = e.detail.slice(e.detail.indexOf(",") + 1), bin = atob(b64), buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  const file = new File([buf], "pasted.png", { type: "image/png" });
  if (note) pasted([file]);
  else paste(v, { items: [{ kind: "file", type: file.type, getAsFile: () => file }], getData: () => "" });
}

/** Keep what is in the field. `again` is Enter, which on a new line opens the
 *  next one: a list is written in a run, not one visit per line. An emptied
 *  line is taken off, with its Undo, rather than kept blank. */
async function saveNote(again) {
  const f = noteField, d = current(), pics = f && f.kind === "new" ? pending : [];
  // A line that is only a picture still needs words to be a line: these,
  // until the reader writes their own.
  const text = noteDraft.trim() || (pics.length ? "A picture" : "");
  if (!f || !d) return;
  noteField = again && f.kind === "new" ? { kind: "new" } : null;
  noteDraft = ""; noteCaret = 0; noteErr = ""; if (f.kind === "new") pending = [];
  rail();
  if (f.kind === "new" && !text) return;
  // A line rewritten to nothing is a line taken off, which is what the ✕
  // does: it goes the ✕'s way, so it leaves its ghost and its Undo, and the
  // Undo brings back the text it had.
  if (!text) return act({ dataset: { a: "note-x", n: String(f.id) } });
  try {
    if (f.kind === "new") {
      const j = await ctx.api(`/api/desks/${d.id}/notes`, { text });
      if (j.note) notesKept.add(j.note.id);
      if (pics.length && j.note) await putImages(j.note.id, pics);
    }
    else await ctx.api(`/api/desks/${d.id}/notes/${f.id}`, { text });
    await getNotes(d.id, true);
  } catch (e) {
    // What was typed is not lost to a no: the field opens again with it,
    // and the reason stands under it until the next key.
    const why = `Could not ${f.kind === "new" ? "add the note" : "keep the change"} · ${ctx.sayErr(e).why}`;
    if (d !== current()) return ctx.toast(why, text);
    noteField = f; noteDraft = text; noteCaret = text.length; noteErr = why; if (f.kind === "new") pending = pics;
    rail();
  }
}

/** The documents this desk's panes sent, for the rail. Fetched when the desk
 *  opens, and again whenever the page hears a document arrive, get opened or
 *  go; the rail draws whatever it has meanwhile. */
export async function docs() {
  const id = deskId;
  if (id == null || !ctx) return;
  let j;
  try { j = await ctx.api(`/api/desks/${id}/docs`); }
  catch { if (id === deskId) { docsOff = id; if (current()) rail(); } return; }
  if (id !== deskId) return;
  docList = j.docs || []; docOff = j.removed || []; docsAt = id; docsOff = null;
  // The row holding an Undo is the same document as the one in the list,
  // not a stale copy of it, so the draw can find it by identity.
  if (docGone) { const x = docList.find(y => y.id === docGone.x.id); if (x) docGone.x = x; }
  if (current()) rail();
}

/* ---------- points ----------
 *
 * Reading what an agent sent, the reader selects a passage and keeps it as a
 * point for the panel that sent it. The points gather under that panel in the
 * rail, and one click puts them all in its input -- quoted, under the name of
 * the document they came from -- and goes to the panel, where the reader
 * writes what they want done about them and presses Enter themselves.
 *
 * Nothing is ever sent for them: the text goes in as a bracketed paste, which
 * a program that asked for one holds in its input rather than running, and
 * there is no Enter at the end. A program that did not ask for pasted text --
 * a bare shell would run each line -- is not typed into at all. And the text
 * waits while the agent is working, or while the reader is typing in that
 * panel, so it never lands in the middle of either.
 */

/** The panel a document read over the desk came from: the one in the slot it
 *  was sent from, or the focused one when that slot has been closed since. */
function sender() {
  const d = current();
  if (!d || reading == null) return null;
  const x = docList.find(y => String(y.id) === String(reading));
  const p = x && d.panes.find(q => q.slot === x.slot);
  return views.get(p ? p.id : focused) || (d.panes[0] && views.get(d.panes[0].id)) || null;
}

function hidePick() { if (pickEl) { pickEl.remove(); pickEl = null; } }

/** A selection in the document: offer to keep it, beside where it ends. */
function picked(e) {
  if (e && e.target.closest && e.target.closest(".dk-pick")) return;
  hidePick();
  const sel = getSelection();
  if (reading == null || !sel || sel.isCollapsed || !sel.rangeCount) return;
  if (!ctx.docEl.contains(sel.anchorNode) || !ctx.docEl.contains(sel.focusNode)) return;
  const text = sel.toString().replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  const v = sender();
  if (!text || !v) return;
  const rs = sel.getRangeAt(0).getClientRects(), r = rs.length ? rs[rs.length - 1] : sel.getRangeAt(0).getBoundingClientRect();
  const b = Object.assign(document.createElement("button"), { type: "button", className: "dk-pick", textContent: `+ Point for panel ${v.pane.slot}` });
  b.dataset.tip = "Keep this passage";
  b.dataset.tipSub = "To put in that panel's input with the rest";
  // Pressing the control must not take the selection it is about away.
  b.addEventListener("mousedown", ev => ev.preventDefault());
  b.addEventListener("click", () => {
    const x = docList.find(y => String(y.id) === String(reading));
    const ps = points.get(v.id) || [];
    ps.push({ text, from: x ? x.source_path || x.title : "" });
    points.set(v.id, ps);
    getSelection().removeAllRanges();
    // Said where the click was, then gone: the rail has the point now.
    b.textContent = `✓ Kept for panel ${v.pane.slot}`; b.disabled = true;
    setTimeout(() => { if (pickEl === b) hidePick(); }, 900);
    rail();
  });
  document.body.append(b);
  const w = b.offsetWidth;
  b.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, r.right - w / 2))}px`;
  b.style.top = `${r.bottom + 34 > innerHeight ? r.top - 32 : r.bottom + 6}px`;
  pickEl = b;
}
const pickKey = e => { if (e.key === "Escape") hidePick(); else if (e.shiftKey || e.key === "Shift") picked(e); };
const pickUp = e => setTimeout(() => picked(e), 0);

/** Under the panes: each panel's points, and the one control that puts them
 *  in. Drawn only while there are some, or a word to say about them. */
function pointSec(vs) {
  const { esc } = ctx;
  const has = vs.filter(v => (points.get(v.id) || []).length || (pointSaid && pointSaid.p === v.id));
  if (!has.length) return "";
  return `<div class="dk-points" data-part="rail.points"><div class="t-label dk-lab" data-tip="Points" data-tip-sub="Passages you kept from the documents, for the panel that sent each. Nothing is sent: they go into the panel's input, and you press Enter there.">Points</div>` +
    has.map(v => {
      const ps = points.get(v.id) || [], live = ps.filter(x => !x.gone).length;
      return `<ul class="dk-list">` + ps.map((x, i) => x.gone
        ? `<li class="dk-note gone" role="status"><span class="nm">${esc(x.text)}</span><button type="button" class="dk-undo" data-a="point-back" data-p="${v.id}" data-n="${i}">Undo</button></li>`
        : `<li class="dk-note dk-point"><span class="nm" data-tip="Kept from" data-tip-sub="${esc(x.from)}">${esc(x.text)}</span>` +
          `<span class="dk-tools"><button type="button" data-a="point-x" data-p="${v.id}" data-n="${i}" data-tip="Let this point go" aria-label="Let this point go">${ico("x")}</button></span></li>`).join("") + `</ul>` +
        (live ? `<button type="button" class="dk-new dk-put" data-a="put" data-p="${v.id}" data-tip="Put into the panel" data-tip-sub="Typed into panel ${v.pane.slot}'s input, quoted. Nothing is sent until you press Enter there.">Put ${live === 1 ? "it" : ctx.plural(live, "point")} in panel ${v.pane.slot}</button>` : "") +
        (pointSaid && pointSaid.p === v.id ? `<p class="dk-empty dk-said" role="status">${esc(pointSaid.text)}</p>` : "");
    }).join("") + `</div>`;
}

/** A word under a panel's points, in their place, for a few seconds. */
function sayPoint(p, text) {
  clearTimeout(saidTimer);
  pointSaid = { p, text };
  saidTimer = setTimeout(() => { pointSaid = null; if (current()) rail(); }, 5000);
  rail();
}

/** Quote a panel's points into its input, and go to it. */
function put(v) {
  const ps = (points.get(v.id) || []).filter(x => !x.gone), n = v.pane.slot;
  if (!ps.length) return;
  const why = !v.status.running ? `Panel ${n} is not running.`
    : !v.mode[1] ? `The program in panel ${n} does not take pasted text, so nothing is typed into it.`
    : v.status.agent === "working" ? `Panel ${n} is working. Put them in when it is done.`
    : Date.now() - (v.typed || 0) < TYPED_MS ? `You are typing in panel ${n}.` : "";
  if (why) { sayPoint(v.id, why); return; }
  // Under the name of the document each came from, once per run of points
  // from the same one, and a blank line to write under.
  let from = null;
  const text = ps.map(x => {
    const head = x.from !== from && x.from ? `From ${x.from}:\n` : "";
    from = x.from;
    return head + x.text.split("\n").map(l => `> ${l}`.trimEnd()).join("\n");
  }).join("\n\n") + "\n\n";
  input(v, bracket(v, text.replace(/\r?\n/g, "\r")));
  points.delete(v.id);
  clearTimeout(pointTimer);
  if (reading != null) ctx.go(deskId, true, n); else { rail(); focusPane(v.id); }
}

/** Resume the conversation a pane last had. A stopped pane starts it; a pane
 *  whose shell is running gets the command typed at its prompt, the way points
 *  are put -- not run, so Enter is the reader's -- and only where points
 *  would be let in. A refusal is said under the pane's own row. */
function again(v) {
  const n = v.pane.slot;
  if (!talked(v) || !v.pane.resume) return;
  if (!v.status.running) { run(v, "", false, true); return; }
  const why = !v.mode[1] ? `Panel ${n} is not at a prompt, so nothing is typed into it.`
    : Date.now() - (v.typed || 0) < TYPED_MS ? `You are typing in panel ${n}.` : "";
  if (why) {
    clearTimeout(rowTimer);
    rowSaid = { p: v.id, text: why };
    rowTimer = setTimeout(() => { rowSaid = null; if (current()) rail(); }, 5000);
    rail();
    return;
  }
  input(v, bracket(v, v.pane.resume));
  if (reading != null) ctx.go(deskId, true, n); else focusPane(v.id);
}

/** Leaving a desk hides its points and keeps them: they are the reader's,
 *  and coming back finds them where they were. A point whose Undo was still
 *  standing goes, as any offer does once its row is left. They are kept by
 *  panel, for the life of the page; only a panel that is no longer on any
 *  desk takes its points with it (`keepPoints`). */
function hidePoints() {
  hidePick();
  clearTimeout(saidTimer); clearTimeout(pointTimer);
  pointSaid = null;
  for (const [id, list] of points) { const k = list.filter(y => !y.gone); if (k.length) points.set(id, k); else points.delete(id); }
}
function keepPoints(desks) {
  if (!desks) return;
  const live = new Set(desks.desks.flatMap(d => d.panes.map(p => p.id)));
  for (const id of points.keys()) if (!live.has(id)) points.delete(id);
}
