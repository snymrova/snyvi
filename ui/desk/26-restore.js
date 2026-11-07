/* ui/desk/26-restore.js: a part of desk.js, one module. build.rs joins ui/desk/*.js in name
 * order (src/strip.rs `source`); SNYVI_UI_DIR serves the same join. */
// ---------- bringing a desk's conversations back (1.58, plan 4b492bec68) ----------

/* A crash or a stop leaves each panel Claude was open in on offer: its shell
 * comes back, and the strip over it offers the conversation (#108). With two
 * or more on this desk, the strip offers them all too, "↻ All 3 here", which
 * asks the daemon to bring this desk's back two at a time (`restore_run`):
 * the same queue as Home's Restore all, this desk alone. In the strip, over
 * the panel, so its coming and going moves nothing -- a button in the head
 * would push the tabs along.
 *
 * How many are left on each desk comes with the desks (`offers`) and, as
 * they come back, with the `restore` event (`restoreSaid`). */

/** desk id → how many are on offer there, as the last `restore` event said;
 *  null until one has, when the desks' own `offers` holds. */
let offersBy = null;
/** This desk's are being brought back: the strips say so, and wait. */
let restoring = false;

/** How many are on offer on the desk shown. */
function offersHere() {
  if (offersBy) return offersBy[String(deskId)] || 0;
  const d = ctx.desks && ctx.desks.desks.find(x => x.id === deskId);
  return (d && d.offers) || 0;
}

/** The strip's second button, drawn each time the strip is (`header`). */
function restoreStrip(v, off) {
  const b = off.querySelector('[data-offer="all"]');
  if (!b) return;
  const n = offersHere();
  b.hidden = n < 2;
  if (b.hidden) return;
  b.disabled = restoring;
  b.textContent = restoring ? "Bringing them back…" : `↻ All ${n} here`;
  b.dataset.tip = "Resume every conversation on this desk";
  b.dataset.tipSub = "two at a time, as the panels come back";
}

/** The click: this desk's, first. The strips go one by one as each agent is in. */
async function restoreDesk(b) {
  restoring = true;
  for (const v of views.values()) { const off = v.el.querySelector(".pn-offer"); if (off && !off.hidden) restoreStrip(v, off); }
  try { await ctx.api("/api/restore", { desk: deskId, from: deskId }); }
  catch (e) {
    restoring = false;
    b.disabled = false;
    ctx.toast("Could not bring them back", e);
  }
}

/** The `restore` event (app.js): the counts by desk, and the strips again. */
export function restoreSaid(j) {
  if (!j || !j.desks) return;
  offersBy = j.desks;
  if (!j.queued) restoring = false;
  for (const v of views.values()) { const off = v.el.querySelector(".pn-offer"); if (off && !off.hidden) restoreStrip(v, off); }
}
