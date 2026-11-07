/* Approve on a plan (1.47, src/waiting.rs). The head of a document that is
 * some open desk notes' plan carries the gate (1.56): a block drawn by the
 * daemon with the page (assets.rs `approve_block`) that names the notes it
 * plans and the panel that hears the Approve, so first paint pays nothing
 * for it but the line that fetches this on the first press.
 *
 * Approve marks those notes approved, and the panel that planned them reads
 * it with its next prompt (brief.rs `changes`), or from Start on the line. The
 * button then says Approved ✓ and the line under it says so, and pressed
 * again takes it back. The page's copy of the document is dropped, so
 * coming back to it draws the head as it now is. */

const SAY = {
  0: ["Approve", "The go-ahead for this plan: its panel hears it at its next prompt", "Approve, and its panel hears it at its next prompt."],
  // A panel idle at its prompt has no next prompt of its own (#223): the
  // note's line on the desk then reads "approved · start", which tells it.
  1: ["Approved ✓", "Approved by you: its panel goes ahead. Click to take it back", "Approved by you just now · if its panel waits at its prompt, Start on the note's line tells it · press again to take it back"],
};

export async function press(b, api, cache) {
  if (b.getAttribute("aria-busy")) return;
  const ok = b.dataset.ok === "1";
  const said = b.closest(".doc-gate")?.querySelector(".doc-gate-s");
  b.setAttribute("aria-busy", "true");
  try {
    await api(`/api/desks/${b.dataset.desk}/plans/${encodeURIComponent(b.dataset.doc)}/approve`, { undo: ok });
    const now = ok ? 0 : 1;
    b.dataset.ok = String(now);
    [b.textContent, b.dataset.tip] = SAY[now];
    if (said) said.textContent = SAY[now][2];
    cache?.delete(b.dataset.doc);
  } catch (e) {
    // Said in the button's own place for a moment, then back as it was.
    b.textContent = e.status === 404 ? "No open notes are planned by this any more" : "Could not approve: snyvi did not answer";
    setTimeout(() => { b.textContent = SAY[ok ? 1 : 0][0]; }, 4000);
  } finally {
    b.removeAttribute("aria-busy");
  }
}
