/* What the reader can do with a section (1.67, boards audit ef7024c7dc).
 *
 * Until now their hands were select, pan and zoom, and everything else was
 * the agent's: a section hidden had no way back, "v3" on a label opened
 * nothing, a pick reached the agent only if it read the board again, and
 * nothing left the board. The foot bar, which was one sentence, now carries
 * what can be done with what is picked. It is the same bar at the same
 * height, so nothing moves when a section is picked.
 *
 *   This one / Change…   the reader's own press, typed into the docked
 *                        Claude in snyvi's sentence (`o.ask`, the desk's
 *                        askClaude: only at its prompt, else copied). The
 *                        sentence names the board's folder and the section's
 *                        id, which are slugs, and never a name or anything
 *                        else an agent wrote; "Change…" adds the reader's
 *                        own words.
 *   ‹ v2 of 3 ›          an earlier version drawn in the section's place.
 *   Open as a document   the section's document, read over the desk.
 *   Copy picture         a PNG of the section, drawn by the board's runtime.
 *   Hide                 off the board, kept; "2 hidden" in the top bar
 *                        shows one again.
 *
 * The board also keeps the zoom the reader left it at, and can draw a
 * picture of a section that is not on screen (`shoot`), which is what an
 * agent's `frame_look` gets.
 */

/** A section shown at an older version, by frame id: {doc, at}. */
const verAt = new Map();
/** Each frame's versions as last read, oldest first: [{doc, at}]. */
const verList = new Map();
/** Whether the hidden sections' list is open under its chip. */
let hiddenOpen = false;
/** "change" while the bar is the field for what to change. */
let barMode = "";
/** What the bar last said of a press, and the one frame a hide can undo. */
let barSaid = "", barUndo = "", barT = 0;
let shotN = 0;

/** A frame as it is drawn: at the version the reader stepped to, if any. */
function asShown(f) {
  const v = verAt.get(f.id);
  return v ? { ...f, doc: v.doc, hash: `v:${v.doc}`, vAt: v.at } : f;
}

/** The frames picked, as drawn, in the order they were picked. */
const pickedFrames = () => picked.map(id => shown().find(x => x.id === id)).filter(Boolean);

function say(text) {
  barSaid = text;
  clearTimeout(barT);
  if (text) barT = setTimeout(() => { barSaid = ""; barUndo = ""; paintBar(); }, 6000);
  paintBar();
}

/** The bar's buttons for what is picked. */
function barActs(fs, esc) {
  const one = fs.length === 1 ? fs[0] : null;
  const b = (a, label, tip, off) => `<button type="button" class="bd-act" data-bd-act="${a}"${tip ? ` data-tip="${esc(tip)}"` : ""}${off ? " disabled" : ""}>${label}</button>`;
  let ver = "";
  if (one && one.versions > 1) {
    const at = one.vAt || one.versions;
    ver = `<span class="bd-vers">${b("older", "‹", "The version before", at <= 1)}<span>v${at} of ${one.versions}</span>${b("newer", "›", "The version after", at >= one.versions)}</span>`;
  }
  return `<span class="bd-acts">${ver}` +
    b("this", fs.length > 1 ? "These" : "This one", "Tells Claude in the panel this is your pick") +
    (one ? b("change", "Change…", "Say what to change, to Claude in the panel") : "") +
    (one && one.doc ? b("doc", "Open as a document") : "") +
    (one && one.doc && !one.island ? b("copy", "Copy picture") : "") +
    b("hide", "Hide", "Off the board. Nothing is deleted") + `</span>`;
}

/** The board as snyvi's sentence names it: its folder, a slug. */
const where = () => `On the snyvi board ${o.dir || "design"}/${board.id}/`;

/** The reader's press, typed into the docked Claude or copied (`o.ask`). */
function tellClaude(text, ok) {
  const why = o.ask ? o.ask(text) : "No panel beside this board.";
  say(why || ok);
}

function barClick(e) {
  const b = e.target.closest("[data-bd-act]");
  if (!b || !o || !board) return;
  const a = b.dataset.bdAct, fs = pickedFrames(), one = fs.length === 1 ? fs[0] : null;
  if (a === "unhide") { const id = barUndo; barUndo = ""; barSaid = ""; if (id) hideSet([id], false); return; }
  if (a === "cancel") { barMode = ""; paintBar(); return; }
  if (!fs.length) return;
  if (a === "older" || a === "newer") { if (one) verStep(one.id, a === "older" ? -1 : 1); return; }
  if (a === "change") { barMode = "change"; paintBar(); bar.querySelector("input")?.focus(); return; }
  if (a === "this") {
    const said = fs.map(f => `the section ${f.id}${f.vAt ? ` at its version ${f.vAt} of ${f.versions}` : ""}`).join(" and ");
    tellClaude(`${where()}, I pick ${said}. Go with ${fs.length > 1 ? "these" : "this one"}.`, "Told Claude your pick.");
    return;
  }
  if (a === "doc") { if (one && one.doc && o.read) o.read(one.doc); return; }
  if (a === "copy") { if (one) copyPicture(one); return; }
  if (a === "hide") hideSet(fs.map(f => f.id), true);
}

/** "Change…" sent: the reader's words, in snyvi's sentence. */
function barSubmit(e) {
  const f = e.target.closest("[data-bd-change]");
  if (!f || !o || !board) return;
  e.preventDefault();
  const what = f.elements.what.value.replace(/[\x00-\x1f\x7f]+/g, " ").trim();
  if (!what) return;
  barMode = "";
  tellClaude(`${where()}, change the section ${f.dataset.bdChange}: ${what}. board_read it first.`, "Asked Claude to change it.");
}

/** Hide sections, or show them again. A flag in board.json: the file and
 *  every version stay. One hidden can be undone where the press was. */
async function hideSet(ids, hidden) {
  if (!o || !o.hide) return;
  const at = o;
  try { for (const id of ids) await at.hide(id, hidden); }
  catch (e) { say(`Could not do that · ${at.sayErr ? at.sayErr(e) : "try again"}`); return; }
  if (at !== o) return;
  if (hidden) {
    pick(null, false);
    barUndo = ids.length === 1 ? ids[0] : "";
    say(ids.length > 1 ? `${ids.length} sections hidden. They are kept, under "hidden" above.` : `Hidden. It is kept, under "hidden" above.`);
  }
  // The view was where the picked section is; a hide leaves it looking at
  // nothing and a show puts one where it may not be. Fit what is shown.
  await load();
  if (at === o && shown().length) fit();
}

/** The hidden sections' chip in the top bar, and its list when open. */
function hiddenChip(esc) {
  const hs = board.frames.filter(f => f.hidden);
  if (!hs.length) return "";
  return `<button type="button" class="bd-chip bd-hid" data-bd-hidden aria-haspopup="true" aria-expanded="${hiddenOpen}" data-tip="Hidden sections" data-tip-sub="nothing is deleted: show one again">${hs.length} hidden</button>` +
    (hiddenOpen ? `<div class="bd-boards bd-hidbox" role="group" aria-label="Hidden sections">` +
      hs.map(f => `<button type="button" class="bd-brow" data-bd-show="${esc(f.id)}"><span>${esc(f.name || f.id)}</span><span class="bd-quiet">Show</span></button>`).join("") + `</div>` : "");
}

/** A click on the hidden chip or a row of its list. True when it was one. */
function hiddenClick(e) {
  if (e.target.closest("[data-bd-hidden]")) { hiddenOpen = !hiddenOpen; lookOpen = false; paintList(); return true; }
  const sh = e.target.closest("[data-bd-show]");
  if (!sh) return false;
  hiddenOpen = false;
  hideSet([sh.dataset.bdShow], false);
  return true;
}

/** Step the picked section to the version before or after. The newest is
 *  the board as it is; an older one is drawn in its place until the reader
 *  steps back or the section is written again. */
async function verStep(id, by) {
  const f = board && board.frames.find(x => x.id === id);
  if (!f || !o || !o.versions) return;
  let l = verList.get(id);
  if (!l || l.length !== f.versions) {
    try { l = (await o.versions(id)).versions || []; } catch { l = []; }
    verList.set(id, l);
  }
  if (l.length < 2 || !board) return;
  const now = verAt.has(id) ? verAt.get(id).at : l.length;
  const at = Math.min(l.length, Math.max(1, now + by));
  if (at === l.length) verAt.delete(id); else verAt.set(id, { doc: l[at - 1].doc, at });
  paintFrames();
  syncDoc();
  paintBar();
}

/** After a read: a section written again is shown as it is now. */
function versKeep() {
  for (const id of [...verAt.keys()]) {
    const f = board.frames.find(x => x.id === id);
    if (!f || f.hidden || f.versions !== (verList.get(id) || []).length) verAt.delete(id);
  }
}

/* The zoom and place the reader left a board at, by desk and board, kept in
 * this window's storage: a reload, Back or a link lands where they were.
 * Only what their own hands set; a fit is made again each time. */
const VIEW_KEY = "snyvi.board.view";
let viewT = 0;
function viewKept() {
  if (!fitted || !touched || !o || !board) return;
  clearTimeout(viewT);
  const key = `${o.desk}/${board.id}`, v = { x: Math.round(view.x), y: Math.round(view.y), k: +view.k.toFixed(4) };
  viewT = setTimeout(() => {
    try {
      const all = JSON.parse(localStorage.getItem(VIEW_KEY) || "{}");
      all[key] = v;
      localStorage.setItem(VIEW_KEY, JSON.stringify(all));
    } catch { /* a window without storage fits each time */ }
  }, 400);
}
function viewSaved() {
  try {
    const v = JSON.parse(localStorage.getItem(VIEW_KEY) || "{}")[`${o.desk}/${o.board}`];
    return v && Number.isFinite(v.x) && Number.isFinite(v.y) && v.k >= ZOOM_MIN && v.k <= ZOOM_MAX ? { x: v.x, y: v.y, k: v.k } : null;
  } catch { return null; }
}

/** A picture of one section, as a PNG data URL, or "" when none could be
 *  made: the section drawn alone in a runtime of its own (`/board-frame`),
 *  out of sight, and asked for its picture. On the page but not seen, and
 *  fixed, so it moves nothing; gone when it has answered or 3 s passed. */
function picture(f, html, from) {
  return new Promise(done => {
    const fr = document.createElement("iframe");
    fr.setAttribute("sandbox", "allow-scripts");
    fr.setAttribute("referrerpolicy", "no-referrer");
    fr.setAttribute("aria-hidden", "true");
    fr.tabIndex = -1;
    fr.style.cssText = `position:fixed;left:0;top:0;width:${f.w}px;height:${f.h || 2000}px;border:0;opacity:0;pointer-events:none;z-index:-1;color-scheme:light`;
    const n = ++shotN;
    const tell1 = m => fr.contentWindow?.postMessage({ snyvi: "board", ...m }, "*");
    const end = png => {
      clearTimeout(t);
      removeEventListener("message", on);
      fr.remove();
      done(typeof png === "string" && png.startsWith("data:image/png;base64,") && png.length < 6e6 ? png : "");
    };
    const t = setTimeout(() => end(""), 3000);
    const on = e => {
      if (e.source !== fr.contentWindow) return;
      const m = e.data;
      if (!m || m.snyvi !== "board") return;
      if (m.t === "ready") {
        tell1({ t: "tokens", vars: ((from.tokens && from.tokens.vars) || []).slice(0, 200) });
        tell1({ t: "css", css: from.css || "" });
        tell1({ t: "sections", ox: 0, oy: 0, list: [{ id: f.id, hash: f.hash, x: 0, y: 0, w: f.w, h: f.h, html }] });
        setTimeout(() => tell1({ t: "shot", id: f.id, n }), 150);
      } else if (m.t === "shot" && m.n === n) end(m.png);
    };
    addEventListener("message", on);
    fr.src = "/board-frame";
    document.body.append(fr);
  });
}

/** Copy picture: the PNG to the clipboard. The item is given the promise,
 *  so the press that asked is still the one that writes. */
function copyPicture(f) {
  const html = htmlOf.get(f.hash);
  if (!html) { say("Not drawn yet."); return; }
  const blob = picture(f, html, board).then(png => {
    if (!png) throw new Error("no picture");
    const b = atob(png.slice(png.indexOf(",") + 1)), u = new Uint8Array(b.length);
    for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
    return new Blob([u], { type: "image/png" });
  });
  say("Making the picture…");
  try {
    navigator.clipboard.write([new ClipboardItem({ "image/png": blob })])
      .then(() => say("Copied the picture."), () => say("Could not copy a picture of this section here."));
  } catch { blob.catch(() => {}); say("Could not copy a picture of this section here."); }
}

/** A picture of a section of any board of a desk, open or not: what an
 *  agent's `frame_look` is answered with (ui/desk's ways part). "" when the
 *  board has no such section, it runs a script, or no picture came. */
export async function shoot({ api, desk, board: name, frame }) {
  const j = await api(`/api/desks/${desk}/board/${encodeURIComponent(name)}`);
  const f = (j.frames || []).find(x => x.id === frame);
  if (!f || !f.doc || f.island) return "";
  const html = await fetch(frameSrc(f)).then(r => (r.ok ? r.text() : ""), () => "");
  return html ? picture(f, html, j) : "";
}

const ACTS_CSS = `
.bd-bar { gap: var(--sp-3); }
.bd-bar-v { min-width: 0; flex: 0 1 auto; }
.bd-acts, .bd-vers, .bd-change { flex: none; display: inline-flex; gap: var(--sp-1); align-items: center; }
.bd-vers { color: var(--fg-3); font-size: var(--fs-small); font-variant-numeric: tabular-nums; }
.bd-act, .bd-change button { height: 24px; padding: 0 var(--sp-2); border: 0; border-radius: var(--r-pill); background: transparent;
  box-shadow: inset 0 0 0 1px var(--rule); color: var(--fg-2); font: inherit; font-size: var(--fs-small); cursor: pointer; }
.bd-act:hover, .bd-change button:hover { color: var(--fg); box-shadow: inset 0 0 0 1px var(--rule-2); }
.bd-act[data-bd-act="this"], .bd-change button[type="submit"] { background: var(--accent); color: var(--on-accent); box-shadow: none; font-weight: 500; }
.bd-act:disabled { opacity: .4; cursor: default; }
.bd-vers .bd-act { width: 24px; padding: 0; }
.bd-change input { width: min(320px, 40vw); height: 24px; padding: 0 var(--sp-2); border: 0; border-radius: var(--r-sm);
  background: var(--bg); box-shadow: inset 0 0 0 1px var(--rule-2); color: var(--fg); font: inherit; }
.bd-bar-said { color: var(--fg-2); }
.bd-hidbox { left: auto; right: 0; }
`;
