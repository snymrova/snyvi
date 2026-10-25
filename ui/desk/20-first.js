/* ui/desk/20-first.js: a part of desk.js, one module. build.rs joins ui/desk/*.js in name
 * order (src/strip.rs `source`); SNYVI_UI_DIR serves the same join. */
// ---------- a first desk's three steps (#191) ----------
/*
 * A maker's first desk rings its three moments in turn -- Connect, Ask
 * Claude, read Claude's page and answer -- with a card that says which of
 * three it is and Skip. Only the first desk: by a second one the loop is
 * known, and a ring there would be noise. What it rings and when it is done
 * are ui/guide.js's, a chunk of its own, fetched with the first desk opened;
 * it asks the daemon whether the steps are done or skipped (`/api/guide`)
 * before it draws anything.
 */
let guideMod = null;

function firstSteps() {
  firstStop();
  const ds = ctx.desks && ctx.desks.desks;
  const first = ds && ds.length === 1 && deskId != null;
  // The dots on new controls start here too (#191): an update's controls
  // are a desk's, mostly, and first paint pays nothing for them. `dots`
  // asks once and is quiet with no fresh What's new page.
  if (guideMod && !first) return;
  let v = "";
  try { v = JSON.parse(document.getElementById("boot").textContent || "{}").v || ""; } catch { /* unversioned */ }
  import(`/assets/guide.js${v ? `?v=${v}` : ""}`).then(m => {
    guideMod = m;
    m.dots();
    if (first && deskId != null) m.steps({ api: ctx.api, say: (t, sub) => ctx.toast(t, sub) });
  }).catch(() => {});
}

function firstStop() { if (guideMod) guideMod.stop(); }
