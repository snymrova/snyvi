/* ui/desk/35-verbs.js: a part of desk.js, one module. build.rs joins ui/desk/*.js in name
 * order (src/strip.rs `source`); SNYVI_UI_DIR serves the same join. */
// ---------- the palette's verbs for a desk (1.69) ----------

/* ⌘K, `>` and a verb with its words (ui/palette.js, plan 520aa866b0 Round
 * D): a note, a routine, a goal, said from the keyboard without a visit to
 * the rail; which, at rest, is not there to visit. Each does what the
 * rail's own field does, by the rail's own code: nothing here is a second
 * way to save a thing. The palette only offers them on a desk, in a window
 * that holds the capability. */

/** The right side where the reader can see it: over the panels at rest,
 *  unfolded if it was folded by hand. For a verb that opens a field. */
function verbRail() {
  if (resting()) restOver("key");
  else if (restRoot.dataset.rail === "0" && restWide()) restSide("rail", false);
}

/** `> note <words>`: the note is added, as Enter in the notes' field adds
 *  it. A line being written in that field is left as it was. */
export function noteSay(text) {
  const d = current();
  text = (text || "").trim();
  if (!d || !text) return;
  const was = [noteField, noteDraft, noteCaret, pending];
  noteField = { kind: "new" }; noteDraft = text; noteCaret = text.length; pending = []; noteErr = "";
  // What is typed is read before the first wait, so the field's own line
  // can go back at once; a line too long stays in the field, which says so.
  const saved = saveNote(false);
  if (noteErr) { ctx.fold("notes", false); verbRail(); rail(); return; }
  [noteField, noteDraft, noteCaret, pending] = was;
  rail();
  saved.then(() => { if (restRoot.dataset.rail === "0" && restRoot.dataset.rest !== "over") ctx.toast("Note added", text); }, () => {});
}

/** `> routine <words>`: the routines' field, open with the words in it.
 *  What it becomes is still the reader's to send from there. */
export function routineSay(text) {
  const d = current();
  if (!d) return;
  text = (text || "").trim();
  ctx.fold("routines", false);
  verbRail();
  rtField = { text, caret: text.length, err: "", pick: 0, away: false };
  if (rtCmds.at !== d.id) rtCmdsGet(d.id);
  rail();
  const inp = ctx.tocEl.querySelector(".rt-new .rt-in");
  if (!inp) return;
  inp.scrollIntoView({ block: "nearest" });
  inp.focus({ preventScroll: true });
  inp.setSelectionRange(text.length, text.length);
  rtCompDraw();
}

/** `> goal <words>`: the desk's goal is set; with no words, its field. */
export function goalSay(text) {
  const d = current();
  if (!d) return;
  text = (text || "").trim();
  if (!text) { verbRail(); lineGoal(d); return; }
  lineSet(d, { goal: text }).then(() => { if (lineOf(d).goal === text && restRoot.dataset.rail === "0" && restRoot.dataset.rest !== "over") ctx.toast("Goal set", text); });
}
