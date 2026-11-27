/* ui/desk/11-elsewhere.js: a part of desk.js, one module. build.rs joins ui/desk/*.js in name
 * order (src/strip.rs `source`); SNYVI_UI_DIR serves the same join. */
// ---------- elsewhere: a document from another desk ----------
/*
 * A reader at work on one desk heard nothing when a panel on another desk
 * sent them something (#122), so it rises in this desk's corner as a small
 * card -- who sent it, its title, Open and Later. It used to go at the first
 * click elsewhere, with nothing left on the desk to find it by: the reader
 * who missed it had lost it (plan b0bca0a11f). So the card is the corner's
 * (ui/corner.js `rise`), and it settles into the pill: the document is in
 * the tray under Lately, kept, with the pill's dot lit until it is seen.
 * This desk's own documents are the rail's, at the top of Documents, and do
 * not rise -- but for its first: a reader new to snyvi, working in the
 * panel, never looked at the rail's edge, so the first page a desk is sent
 * rises too, once, and says where pages live. The panel that sent it says
 * so in its head as well (rail.js `pageChips`), for every page, until it is
 * read.
 */

/** A document arrived (app.js `docEvent`) while this desk is on screen. One
 *  from this desk's own panels is the rail's to show; anything else -- a
 *  panel on another desk, a hook, the CLI -- rises. */
export function elsewhere(doc) {
  const d = current(), k = ctx.corner?.(), { esc } = ctx;
  if (!d || !doc || !k) return;
  const open = () => ctx.read(doc.id);
  if (doc.desk && doc.desk.id === d.id) {
    // The desk's first: nothing listed and nothing removed before it. The
    // list is fetched after this (app.js `deskDocs`), so it is still the
    // list from before the page came.
    if (docsAt !== d.id || docList.length || docOff.length) return;
    const who = doc.desk.slot ? `Panel ${doc.desk.slot}` : "This desk";
    k.rise({ kind: "first", key: `d${doc.id}`, from: `${who} sent this desk's first page`, title: doc.title, label: "Read it", go: open, where: "Every page stays in the <b>Inbox</b>, under this desk's name." });
  } else k.rise({ kind: "doc", key: `d${doc.id}`, from: `${ewFrom(doc, esc)} sent a document`, title: doc.title, go: open });
}

/** Who sent it, as the reader knows them: the desk and its panel, or the
 *  project it went to when no panel sent it. */
function ewFrom(doc, esc) {
  return doc.desk ? `${esc(doc.desk.name)} · panel ${doc.desk.slot}` : esc(doc.project);
}

/** The page's foot while the panel that sent it waits on the reader: who,
 *  and the way back to it, where the page's last line (often a question)
 *  was just read. Drawn with the page and on each panel's change (app.js
 *  `turnLine`); once drawn its box stays, hidden, so the page's height
 *  never changes. */
let turnAt = null;
export function turnLine(state, docEl) {
  turnAt = [state, docEl];
  const from = state.view === "doc" && state.doc && state.doc.desk;
  const d = from && from.slot && state.desks && state.desks.desks.find(x => x.id === from.id);
  const p = d && d.panes.find(x => x.slot === from.slot), s = p && p.status;
  let el = docEl.querySelector(".doc-turn");
  // The question asked under this page (1.70, plan part 5): its card, with
  // its choices, where the page's last line was just read. A press is the
  // card's own (`tn-pick`), so the answer goes where it would from On you.
  // Only over the page's own desk, whose turns this part has read.
  const ask = d && T && ctx && deskId === d.id && filedAt === d.id
    && filed.turns.filter(w => `${w.link}` === `${state.doc.id}` && w.via !== "dialog" && (w.options || []).length).sort((a, b) => b.id - a.id)[0];
  if (ask) {
    if (!el) { el = document.createElement("aside"); docEl.append(el); }
    el.className = "doc-turn doc-ask";
    const who = /^claude\b/.test(((s && s.cmd) || (p && p.cmd) || "").trim()) ? "Claude" : "The agent";
    el.innerHTML = (ask.answered_at ? "" : `<p class="doc-ask-h">${who}${p ? `, in panel ${p.slot},` : ""} is waiting for this</p>`) +
      turnCard(d, filed, ask, ctx.esc) +
      (p ? `<p class="doc-ask-f"><a href="/desk/${d.id}" data-desk="${d.id}" data-slot="${p.slot}">${ask.answered_at ? `Back to panel ${p.slot}` : "Something else"}</a>${ask.answered_at ? "" : " takes you to the panel, to say it in your own words."}</p>` : "");
    el.style.visibility = "";
    return;
  }
  if (!(s && s.running && (s.blocked || s.agent === "done" || s.agent === "needs_you"))) { if (el) el.style.visibility = "hidden"; return; }
  if (!el) { el = document.createElement("aside"); docEl.append(el); }
  el.className = "doc-turn";
  const who = /^claude\b/.test((s.cmd || p.cmd || "").trim()) ? "Claude is" : `Panel ${p.slot} is`;
  el.innerHTML = `<span>${who} waiting for you.</span><a href="/desk/${d.id}" data-desk="${d.id}" data-slot="${p.slot}" class="btn">Back to panel ${p.slot}</a>` +
    (state.deskBehind === d.id ? `<kbd>ctrl \u0060</kbd>` : "");
  el.style.visibility = "";
}
/** The page's foot again, when this desk's turns or panels moved under it. */
function turnAgain() { if (turnAt && turnAt[0].view === "doc" && turnAt[1].isConnected) turnLine(turnAt[0], turnAt[1]); }

const ELSEWHERE_CSS = `
.doc-turn { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin: 40px 0 0; padding: 12px 14px; border: 1px solid var(--rule-2); border-radius: var(--r-md); background: var(--bg-raise); font-size: var(--fs-ui); }
.doc-turn span { flex: 1; min-width: 0; color: var(--fg); font-weight: 500; }
.doc-turn.doc-ask { display: block; }
.doc-ask-h { margin: 0 0 8px; color: var(--fg-3); font-size: var(--fs-small); }
.doc-ask-f { margin: 8px 0 0; color: var(--fg-3); font-size: var(--fs-small); }
`;
