/* ui/desk/30-closed.js: a part of desk.js, one module. build.rs joins ui/desk/*.js in name
 * order (src/strip.rs `source`); SNYVI_UI_DIR serves the same join. */
// ---------- recently closed (1.67) ----------

/* A panel's ✕ leaves a row with Undo in the rail for six seconds. After
 * that the panel was still on disk -- nothing is deleted -- and nowhere on
 * the page: the only way back was not to have closed it. This is the list
 * (src/desk/closed.rs), from the desk's ⋯: each panel and tab closed here,
 * newest first, with Reopen. A panel comes back stopped, as the Undo
 * brings it; one that held a Claude session says it can resume.
 *
 * A sheet under the ⋯, over the grid: it pushes nothing. Esc, a click
 * outside or the ⋯ again puts it away. */

let closedSheet = null;

function closedShut() {
  if (!closedSheet) return;
  closedSheet.remove();
  closedSheet = null;
  document.removeEventListener("keydown", closedKey, true);
  document.removeEventListener("pointerdown", closedOut, true);
}
function closedKey(e) {
  if (e.key !== "Escape") return;
  e.preventDefault(); e.stopPropagation();
  closedShut();
  ctx.docEl.querySelector(".dk-menu")?.focus();
}
function closedOut(e) { if (closedSheet && !closedSheet.contains(e.target)) closedShut(); }

/** How long ago, in the list's own words. */
function closedWhen(at) {
  const s = Date.now() / 1000 - at;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  const d = Math.round(s / 86400);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

function closedRows(rows) {
  const { esc, plural } = ctx;
  if (!rows.length) return `<p class="dk-cl-none">Nothing closed on this desk. A panel or a tab you close is kept here, to reopen.</p>`;
  return `<ul class="dk-cl-list">` + rows.map(r => {
    const what = r.kind === "tab" ? `tab with ${plural(r.panes || 0, "panel")}`
      : `panel${r.cmd ? ` · ${esc(r.cmd.length > 28 ? r.cmd.slice(0, 27) + "…" : r.cmd)}` : ""}`;
    const keeps = r.kind === "tab" ? "" : r.session ? " · its Claude session can resume" : "";
    const name = r.name || (r.kind === "tab" ? "A tab" : "A panel");
    return `<li class="dk-cl-row"><span class="dk-cl-b"><b>${esc(name)}</b><span class="dk-cl-s">${what} · closed ${closedWhen(r.closed_at)}${keeps}</span></span>` +
      `<button type="button" class="dk-new" data-cl="${esc(r.id)}" data-kind="${r.kind}" aria-label="Reopen ${esc(name)}">Reopen</button></li>`;
  }).join("") + `</ul>`;
}

/** The sheet, open under the desk's ⋯ (or shut, when it was open). */
async function closedOpen(d) {
  // A desk drawn again took the sheet with it: that one is not open.
  const was = closedSheet && closedSheet.isConnected;
  closedShut();
  if (was) return;
  const host = ctx.docEl.querySelector(".dk");
  if (!host) return;
  const el = closedSheet = Object.assign(document.createElement("div"), { className: "dk-closed" });
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-label", "Recently closed on this desk");
  el.innerHTML = `<div class="dk-cl-h">Recently closed</div><div class="dk-cl-body"><p class="dk-cl-none">Reading…</p></div><p class="dk-cl-said" role="status"></p>`;
  host.append(el);
  document.addEventListener("keydown", closedKey, true);
  document.addEventListener("pointerdown", closedOut, true);
  el.addEventListener("click", e => { const b = e.target.closest("[data-cl]"); if (b) closedBack(d, b); });
  await closedFill(d);
  el.querySelector("[data-cl]")?.focus();
}

async function closedFill(d) {
  const el = closedSheet;
  if (!el) return;
  let rows;
  try { rows = (await ctx.api(`/api/desks/${d.id}/closed`)).closed || []; }
  catch (e) { if (closedSheet === el) el.querySelector(".dk-cl-body").innerHTML = `<p class="dk-cl-none">Could not read what was closed: ${ctx.esc(ctx.sayErr(e).why)}</p>`; return; }
  if (closedSheet === el) el.querySelector(".dk-cl-body").innerHTML = closedRows(rows);
}

/** Reopen: the panel stopped in the lowest free slot of the side it was
 *  on, the tab with the panels that closed with it. What cannot come back
 *  -- the desk filled up since -- is said in the sheet, and the row stays. */
async function closedBack(d, b) {
  const id = b.dataset.cl, tab = b.dataset.kind === "tab", el = closedSheet;
  const say = t => { const p = el?.querySelector(".dk-cl-said"); if (p) p.textContent = t; };
  b.disabled = true;
  if (!tab) keepStopped.add(id);
  try { await ctx.api(tab ? `/api/desks/${d.id}/groups/${id}/restore` : `/api/panes/${id}/restore`, {}); }
  catch (e) {
    if (!tab) keepStopped.delete(id);
    b.disabled = false;
    const why = ctx.sayErr(e);
    say(/holds/.test(`${why.why} ${why.raw || ""}`) ? "The desk is full: close or move a panel first." : `Could not reopen it: ${why.why}`);
    return;
  }
  if (closedRow && closedRow.id === id) { clearTimeout(closedTimer); closedRow = null; }
  say("Reopened");
  await ctx.refresh();
  if (!tab) focusPane(id);
  await closedFill(d);
}

/** For the ⋯ menu (menu.js). */
export const closedHere = () => { const d = current(); if (d) closedOpen(d); };

const CLOSED_CSS = `
/* ---------- recently closed ----------
 * Under the ⋯ at the head's end, over the grid; its body scrolls, the page
 * does not move. */
.dk-closed { position: absolute; top: 34px; right: 0; z-index: 5; width: min(440px, calc(100% - 16px)); max-height: 60%; display: flex; flex-direction: column; padding: 10px 12px; border: 1px solid var(--rule-2); border-radius: var(--r-sm); background: var(--bg-raise); box-shadow: var(--shadow); font-size: var(--fs-small); animation: dk-fade 120ms ease-out; }
.dk-cl-h { font-weight: 600; margin-bottom: 6px; }
.dk-cl-body { min-height: 0; overflow-y: auto; }
.dk-cl-list { list-style: none; margin: 0; padding: 0; }
.dk-cl-row { display: flex; align-items: center; gap: 10px; padding: 6px 0; border-top: 1px solid var(--rule); }
.dk-cl-row:first-child { border-top: 0; }
.dk-cl-b { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.dk-cl-b b { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dk-cl-s { color: var(--fg-3); font-size: var(--fs-micro); }
.dk-cl-none { margin: 4px 0; color: var(--fg-3); }
.dk-cl-said { margin: 6px 0 0; min-height: 16px; color: var(--fg-3); font-size: var(--fs-micro); }
`;

/* ---------- the desk's documents, in the Inbox (1.67, #236) ---------- */

/** The Inbox, on this desk's chip: where the rail's list of documents went.
 *  The chip is said once, for the Inbox to read as it draws (ui/home.js
 *  `inboxHtml`), and the way there is the page's own link to the Inbox. */
function docsInbox(d) {
  try { sessionStorage.setItem("snyvi.inbox.desk", String(d.id)); } catch {}
  const a = Object.assign(document.createElement("a"), { href: "/inbox", hidden: true });
  a.dataset.nav = "inbox";
  document.body.append(a);
  a.click();
  a.remove();
}
