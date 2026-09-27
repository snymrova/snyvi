/* The aside card at the foot of the sidebar: what an agent said beside the
 * work, the trail of the ones before it, and the Undo a closed one leaves.
 *
 * A chunk since 1.7.1. The card is nothing at all until an agent says
 * something, and many readers go days without an aside, so first paint no
 * longer carries its drawing, its listeners or its look. The page keeps the
 * list (`state.notes`, from the boot payload and the stream) and the one mark
 * that has to be right with this unloaded: `data-note` on the root, which
 * makes the logo blink and, folded, the rail's aside dot glow. It fetches
 * this the first time the list has an aside in it, and from then on every
 * redraw is `render()` here.
 */

const CSS = `
/* The note. Nothing until an agent says something; a warm glow until a
   reader rests on it; then a single quiet line. The trail of the ones before
   opens upward on hover, over the tree rather than pushing it. */
#note { position: relative; margin: 0 8px;
  /* A side note's surface: a breath of the accent in the sidebar's colour,
     and a hairline with a little warmth in it. Quiet on purpose. */
  --note-bg: color-mix(in srgb, var(--accent) 6%, var(--bg-side));
  --note-rule: color-mix(in srgb, var(--accent) 16%, var(--rule)); }
.note-now { position: relative; display: block; padding: 9px 12px; border-radius: 10px; cursor: default; outline: none;
  background: transparent; border: 1px solid transparent; transition: background .6s ease, border-color .6s ease, box-shadow .6s ease, padding .3s ease; }
.note-now { overflow: hidden; isolation: isolate; }
.note-now > p, .note-now > .note-by { position: relative; z-index: 1; }
.note-now:is([data-about], [data-href]) { cursor: pointer; }
/* snyvi peeking from behind the note on hover, and for a moment when a new one arrives: large, tilted, faint, with a
   feeling. It rises from the corner rather than fading in on the spot. */
.note-bg { position: absolute; right: -12px; bottom: -22px; width: 72px; height: 72px; z-index: 0; pointer-events: none;
  opacity: 0; transform: translate(12px, 26px) rotate(0deg); transition: opacity .25s ease, transform .45s cubic-bezier(.3,1.5,.5,1); }
#note:hover .note-bg, #note:focus-within .note-bg, #note.peek .note-bg { opacity: var(--mascot-peek); transform: rotate(-14deg); transition-delay: .12s; }
.note-bg .nb-body { fill: var(--mascot); }
.note-bg .nb-nub { fill: var(--mascot-nub); }
.note-bg .nb-cheek, .note-bg .nb-love { fill: var(--heart); }
.note-bg .nb-ink { fill: var(--mascot-ink); }
.note-bg .nb-shine { fill: #fff; }
.note-bg .nb-line { fill: none; stroke: var(--mascot-ink); stroke-width: 2; stroke-linecap: round; }
/* Opened -- hovered or focused -- a read note wears the same warm card as
   the ones in the trail above it, so the stack reads as one voice. */
#note:hover .note-now, #note:focus-within .note-now { background: var(--note-bg); border-color: var(--note-rule); }
/* The surface is quiet, so the words are not. */
#note:hover .note-now p, #note:focus-within .note-now p { color: var(--fg); }
/* snyvi peeks from the byline's corner, so the byline ends before it does. */
#note:hover .note-by-now, #note:focus-within .note-by-now, #note.peek .note-by-now { padding-right: 40px; }
.note-now:focus-visible { box-shadow: 0 0 0 2px var(--accent); }
/* Interface text, not reading text: the UI's sans at 13px for the note and
   11px for its byline, the sizes a Mac sidebar uses for a label and its
   caption. The reading font is for documents; at 13px in a sidebar a serif
   goes soft. */
.note-now p, .note-trail .note-t { display: block; margin: 0; font-family: var(--sans); font-size: 13px; font-weight: 400; line-height: 1.38; letter-spacing: -.003em;
  color: var(--fg-2); text-wrap: pretty; }
.note-by { display: block; margin-top: 4px; font-family: var(--sans); font-size: 11px; line-height: 1.3; color: var(--fg-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.note-by-now { display: flex; gap: 6px; }
.note-who { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.note-snyvi { font-weight: 600; color: var(--accent); }
.note-more { flex: none; margin-left: auto; padding: 0 5px; border-radius: 6px; background: var(--rule); color: var(--fg-3); }
/* On hover the trail it counts is open above, and snyvi is peeking from that corner. */
#note:hover .note-more, #note:focus-within .note-more, #note.peek .note-more { visibility: hidden; }
#note[data-lit="1"] .note-now { background: var(--accent-bg); border-color: color-mix(in srgb, var(--accent) 30%, transparent);
  animation: note-glow 3.2s ease-in-out infinite; }
#note[data-lit="1"] .note-now p { color: var(--fg); }
#note[data-seen="1"]:not(:hover):not(:focus-within) .note-now p { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--fg-3); }
#note[data-seen="1"]:not(:hover):not(:focus-within) .note-by { display: none; }
#note[data-seen="1"]:not(:hover):not(:focus-within) .note-now { padding-top: 5px; padding-bottom: 5px; }

@keyframes note-glow {
  0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 0%, transparent); }
  50% { box-shadow: 0 0 14px 0 color-mix(in srgb, var(--accent) 16%, transparent); }
}
/* The ones before, each its own card in the same quiet surface as the note
   below them, opaque over the tree they float above. */
.note-trail { position: absolute; left: 0; right: 0; bottom: 100%; margin: 0 0 6px; padding: 0; list-style: none; z-index: 5;
  display: flex; flex-direction: column; gap: 6px;
  opacity: 0; visibility: hidden; transform: translateY(4px); transition: opacity .18s ease, transform .18s ease, visibility 0s linear .18s; }
#note:hover .note-trail, #note:focus-within .note-trail { opacity: 1; visibility: visible; transform: none; transition-delay: .25s, .25s, 0s; }
.note-trail li { padding: 9px 12px; border-radius: 10px; background: var(--note-bg); border: 1px solid var(--note-rule); box-shadow: 0 4px 14px rgba(0,0,0,.12); }
/* An older aside that leads somewhere is a button, so a keyboard opens it too. */
.note-go { display: block; width: 100%; padding: 0; border: 0; background: none; font: inherit; color: inherit; text-align: left; cursor: pointer; }
.note-go:focus-visible { outline: 2px solid var(--accent); outline-offset: 5px; border-radius: 4px; }
.note-trail li:has(> .note-go:hover) { border-color: color-mix(in srgb, var(--accent) 35%, var(--rule)); }
.note-trail .note-t { color: var(--fg); }
.note-trail .note-by { margin-top: 4px; }
/* The ✕ that closes the aside: in the card's corner, there only while the
   card is opened -- hovered or focused -- like the other rows' tools. The
   words keep clear of it. */
.note-now > p { padding-right: 14px; }
.note-x { position: absolute; top: 5px; right: 5px; z-index: 2; width: 18px; height: 18px; display: grid; place-items: center; padding: 0;
  font: inherit; font-size: 10px; line-height: 1; color: var(--fg-3); background: none; border-radius: 4px; cursor: pointer; opacity: 0; pointer-events: none; }
#note:is(:hover, :focus-within) .note-x { opacity: 1; pointer-events: auto; }
.note-x:hover { background: var(--rule-2); color: var(--fg); }
/* A closed aside, standing where the card was with its Undo, on the same
   drain as a removed document's row. */
.note-ghost { padding: 5px 12px; font-size: 12px; }
.note-ghost::after { left: 12px; right: 12px; }
.note-ghost > .title { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
/* Close all: the trail's own quiet last line, not a card. */
.note-trail li.note-all { padding: 0; background: none; border: 0; box-shadow: none; text-align: right; }
.note-all button { font: inherit; font-family: var(--sans); font-size: 11px; color: var(--fg-3); padding: 2px 6px; border-radius: 4px; background: var(--bg-side); }
.note-all button:hover { color: var(--fg); background: var(--rule-2); }
`;

/** Wire the card and draw it. What comes in is the page's; `render` is what
 *  the page calls on every change to `state.notes`. */
export function init({ root, $, state, liveNotes, esc, relShort, showDoc, showStart, toast, closeSay, undoClock, holdUndo, dropUndo }) {
  const sheet = document.createElement("style");
  sheet.id = "note-drawn";
  sheet.textContent = CSS;
  document.head.append(sheet);
  /** It sits above the theme bar and is nothing at all until an agent says
   *  something. A new note glows until a reader rests on it; after that it is
   *  one quiet line. The ones before it wait in a trail a hover away. Seen is
   *  the daemon's, so a glance in one window puts the glow out in all. */
  const noteEl = $("#note");
  let noteLook = 0, notePeek = 0, noteShown = (state.notes.find(n => !n.dismissed) || {}).id || 0;
  /** An aside a reader just closed: the card stands where it was as one line
   *  holding the Undo, on the same drain as a removed document's row, and
   *  only when that ends does the next aside take the card. */
  let noteGone = null;
  /** There is one snyvi on screen, the logo, and the note is its voice: a
   *  waiting note perks it up, a new one makes it hop, and a reader resting on
   *  the note gets a smile and a heart. The card itself carries no face. */
  const markEl = $(".brand-mark");
  /** Behind the note, when a reader comes over: snyvi large and tilted,
   *  peeking up from the corner with a feeling. Each note keeps its own --
   *  glad, a wink, heart eyes -- chosen by its id, so a redraw never
   *  changes its mind. */
  const HEART = (x, y) => `<path class="nb-love" transform="translate(${x} ${y}) scale(.8)" d="M0 3.2c-3.4-2-4.3-4.4-2.6-5.6 1-.7 2.1-.1 2.6.8.5-.9 1.6-1.5 2.6-.8 1.7 1.2.8 3.6-2.6 5.6z"/>`;
  const FEELINGS = [
    `<path class="nb-line" d="M8.6 17.8q2.4-3 4.8 0M18.6 17.8q2.4-3 4.8 0"/><path class="nb-ink" d="M12.6 21.6q3.4 4.6 6.8 0z"/>`,
    `<ellipse class="nb-ink" cx="11" cy="16.5" rx="2.6" ry="3.3"/><circle class="nb-shine" cx="11.9" cy="15.2" r="1"/><path class="nb-line" d="M18.6 17.6q2.4-2.8 4.8 0M13.5 22.6q3 2.8 6 0"/>`,
    HEART(11, 16.5) + HEART(21, 16.5) + `<path class="nb-line" d="M13.5 22.6q2.5 2.4 5 0"/>`,
  ];
  const noteBg = id => `<svg class="note-bg" viewBox="0 0 32 32" aria-hidden="true">` +
    `<rect class="nb-nub" x="14" y="0.5" width="4" height="5" rx="2"/><rect class="nb-body" x="1" y="4" width="30" height="27" rx="9"/>` +
    `<ellipse class="nb-cheek" cx="7.4" cy="21.8" rx="2.4" ry="1.5"/><ellipse class="nb-cheek" cx="24.6" cy="21.8" rx="2.4" ry="1.5"/>` +
    FEELINGS[(typeof id === "number" ? id : String(id).length) % FEELINGS.length] + `</svg>`;
  /** The byline says whose work it came through: "via claude-code on api". */
  function noteBy(n) {
    return [n.sender && `via ${esc(n.sender)}`, n.project && `on ${esc(n.project)}`].filter(Boolean).join(" ");
  }
  function renderNote() {
    const [n, ...trail] = noteGone ? [] : liveNotes();
    // Removed rather than emptied: `html[data-note]` matches an empty value
    // too, so writing "" left the mark blinking on every page from boot, note
    // or no note -- a perpetual animation for a state the page was not in.
    // It blinks while a note waits and stops when the reader rests on it.
    if (n && !n.seen) root.dataset.note = n.lit ? "lit" : "new";
    else delete root.dataset.note;
    if (noteGone) {
      // The daemon's word on the close arrives while the ghost stands; the
      // ghost it would redraw is this one, and redrawing it drops the
      // keyboard off its Undo.
      if (noteEl.querySelector(".note-ghost")?.dataset.ids === noteGone.ids.join(",")) return;
      const g = noteGone;
      noteEl.hidden = false; noteEl.dataset.lit = ""; noteEl.dataset.seen = "";
      noteEl.innerHTML = `<div class="t-ghost note-ghost" role="status" data-ids="${g.ids.join(",")}" style="--undo-left:${g.clock.left()}"><span class="title">${g.ids.length > 1 ? "Asides closed" : "Aside closed"}</span><button type="button" class="t-undo" data-note-undo>Undo</button></div>`;
      return;
    }
    if (!n) { noteEl.hidden = true; noteEl.innerHTML = ""; return; }
    noteEl.hidden = false;
    noteEl.dataset.lit = n.lit && !n.seen ? "1" : "";
    noteEl.dataset.seen = n.seen ? "1" : "";
    // A note newer than the one on screen makes snyvi hop; a reload or a redraw does not.
    const arrived = n.id !== noteShown && !n.seen;
    if (arrived && markEl) {
      markEl.classList.remove("hop"); void markEl.offsetWidth; markEl.classList.add("hop");
      // Whatever snyvi was saying to a reader on the face, the line that just
      // arrived outranks it: the agent takes the floor, and the hop is the
      // mark's answer rather than the nod. Asked only of a bubble that is
      // open, which is also the only time `closeSay` is in scope: the first
      // render runs before the block below it is reached.
      if ("say" in root.dataset) closeSay();
    }
    noteShown = n.id;
    const by = noteBy(n);
    noteEl.innerHTML =
      (trail.length ? `<ol class="note-trail">${trail.map(t => { const go = t.about ? ` data-about="${esc(t.about)}"` : t.href ? ` data-href="${esc(t.href)}"` : ""; return `<li>${go ? `<button type="button" class="note-go"${go}>` : ""}<span class="note-t">${esc(t.text)}</span><span class="note-by"><b class="note-snyvi">snyvi</b> · ${relShort(t.at)}${by === noteBy(t) ? "" : " · " + noteBy(t)}</span>${go ? "</button>" : ""}</li>`; }).join("")}` +
        `<li class="note-all"><button type="button" data-note-all title="Close every aside · Undo for 4 s">Close all</button></li></ol>` : "") +
      `<div class="note-now" tabindex="0" role="note"${n.about ? ` data-about="${esc(n.about)}" title="Open what this is about"` : n.href ? ` data-href="${esc(n.href)}" title="Read more"` : ""}>` +
      noteBg(n.id) + `<button type="button" class="note-x" data-note-x title="Close · Undo for 4 s  Esc" aria-label="Close this aside">✕</button><p>${esc(n.text)}</p><span class="note-by note-by-now"><span class="note-who" title="${by}"><b class="note-snyvi">snyvi</b> · ${relShort(n.at)}${by ? " · " + by : ""}</span>${trail.length ? `<span class="note-more">+${trail.length}</span>` : ""}</span></div>`;
    // A new note brings snyvi up from behind it for a moment, as a hover does.
    // A window in the background would play that to nobody, so it waits.
    if (arrived) { if (document.hidden) peekOwed = true; else peekNote(); }
  }
  let peekOwed = false;
  function peekNote() {
    peekOwed = false;
    clearTimeout(notePeek);
    void noteEl.offsetWidth;   // the new card's resting state first, so the rise transitions
    noteEl.classList.add("peek");
    notePeek = setTimeout(() => noteEl.classList.remove("peek"), 4200);
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden && peekOwed) peekNote(); });
  function seeNotes() {
    if (!liveNotes().some(n => !n.seen)) return;
    state.notes = state.notes.map(n => ({ ...n, seen: true }));
    // Only the card's marks change, not what is in it: a rebuild here, on
    // the focus a press on its ✕ brings, swapped the button out between the
    // press and the release, and the click never happened.
    if (!noteGone) { noteEl.dataset.lit = ""; noteEl.dataset.seen = "1"; delete root.dataset.note; }
    fetch("/api/notes/seen", { method: "POST" }).catch(() => {});
  }
  // Resting on it is reading it; passing over on the way to the theme button is not.
  // The logo looks down at whoever comes over to the note.
  const noteNear = on => { if (on) root.dataset.noteNear = "1"; else delete root.dataset.noteNear; };
  noteEl.addEventListener("mouseenter", () => { noteNear(true); clearTimeout(noteLook); noteLook = setTimeout(seeNotes, 700); });
  noteEl.addEventListener("mouseleave", () => { noteNear(false); clearTimeout(noteLook); });
  noteEl.addEventListener("focusin", () => { noteNear(true); seeNotes(); });
  noteEl.addEventListener("focusout", () => noteNear(false));
  markEl?.addEventListener("animationend", e => { if (e.animationName === "bm-hop") markEl.classList.remove("hop"); });
  noteEl.addEventListener("click", e => {
    if (e.target.closest("[data-note-undo]")) { if (noteGone) noteGone.undo(); return; }
    // `detail` is 0 for a click a key made, and only a keyboard is handed on to Undo.
    if (e.target.closest("[data-note-x]")) { closeNotes(liveNotes().slice(0, 1).map(n => n.id), !e.detail); return; }
    if (e.target.closest("[data-note-all]")) { closeNotes(liveNotes().map(n => n.id), !e.detail); return; }
    seeNotes();
    const a = e.target.closest("[data-about]"), h = e.target.closest("[data-href]");
    if (a) showDoc(a.dataset.about, true);
    else if (h) showStart(true, h.dataset.href.slice(h.dataset.href.indexOf("#")));
  });
  noteEl.addEventListener("keydown", e => {
    // Esc closes the aside the hand is on, and goes no further: not back a
    // page, which is what it does with nothing over the page.
    if (e.key === "Escape") {
      e.preventDefault(); e.stopPropagation();
      if (e.target.closest(".note-now")) closeNotes(liveNotes().slice(0, 1).map(n => n.id), true);
      return;
    }
    if (e.target.closest("button")) return;
    const a = e.target.closest(".note-now[data-about], .note-now[data-href]");
    if (a && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); a.dataset.about ? showDoc(a.dataset.about, true) : showStart(true, a.dataset.href.slice(a.dataset.href.indexOf("#"))); }
  });
  /** Close asides: off the card at once, in every page once the daemon has
   *  it, and the card holds the way back for GHOST_MS. Nothing is deleted. */
  function closeNotes(ids, byKey = false) {
    if (!ids.length) return;
    if (noteGone) noteSettle(noteGone);
    const g = { ids, clock: undoClock("#note .note-ghost", () => noteSettle(g)) };
    g.undo = () => undoNotes(g);
    state.notes = state.notes.map(n => ids.includes(n.id) ? { ...n, dismissed: true, seen: true } : n);
    noteGone = g; holdUndo(g.undo);
    renderNote();
    // A keyboard that closed it lands on the Undo, not on the page's start.
    // A pointer does not: a focus resting there would hold the clock.
    if (byKey) noteEl.querySelector("[data-note-undo]")?.focus({ preventScroll: true });
    notesSay("dismiss", ids).catch(e => { if (noteGone === g) undoNotes(g, false); toast("Could not close the aside", String(e)); });
  }
  function noteSettle(g) {
    if (noteGone !== g) return;
    g.clock.stop();
    dropUndo(g.undo);
    noteGone = null;
    renderNote();
  }
  async function undoNotes(g, tell = true) {
    if (noteGone !== g || g.asking) return;
    if (tell) {
      // The daemon first: an aside put back on the card while the daemon
      // still holds it closed would be gone again at the next page. The
      // clock holds while it is asked, and after a no, which the card says
      // where the Undo was, with the Undo as its Retry.
      const gh = noteEl.querySelector(".note-ghost");
      g.clock.hold = g.asking = true;
      const ok = await notesSay("restore", g.ids).then(() => true, () => false);
      g.asking = false;
      if (noteGone !== g) return;
      if (!ok) {
        if (gh) { gh.querySelector(".title").textContent = "Could not bring it back"; gh.querySelector("[data-note-undo]").textContent = "Retry"; }
        return;
      }
    }
    g.clock.stop();
    dropUndo(g.undo);
    noteGone = null;
    state.notes = state.notes.map(n => g.ids.includes(n.id) ? { ...n, dismissed: false } : n);
    renderNote();
  }
  async function notesSay(what, ids) {
    // snyvi's own lines live in this page; only an agent's reach the daemon.
    ids = ids.filter(id => !String(id).startsWith("snyvi:"));
    if (!ids.length) return;
    const r = await fetch(`/api/notes/${what}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids }) });
    if (!r.ok) throw new Error(`${r.status}`);
  }
  // "3 min ago" stays true without anything arriving.
  setInterval(() => { if (liveNotes().length && !noteGone && !noteEl.matches(":hover")) renderNote(); }, 60000);
  return { render: renderNote };
}
