/* The studio desk: one folder drawn as a viewer, its folders in the desk's
 * rail, and the one Claude panel docked under it that fills it.
 *
 * Not on the wire until the studio desk is opened, or New desk asks for
 * one: ui/studio/*.js are joined into studio.js in name order (src/strip.rs
 * `source`), one module, as desk.js is. desk.js draws the frame -- the
 * head, the docked panel, the rail -- and hands this the space above
 * (`mount`) and the rail's studio rows (`railRows`); the menu hands it New
 * desk's dialog (`newDesk`). Everything it needs from the page comes in
 * those calls' arguments.
 *
 * What the folder holds is files the agent wrote, read by the daemon
 * (src/studio/folder.rs) and drawn here. The one thing written into it is
 * the reader's ★, which the daemon puts in that folder's folder.json.
 */

// ---------- New studio desk ----------

/** The dialog, while it is open. */
let made = null;

/** New studio desk: which folder it works in -- `~/Studio` offered, any
 *  other picked with the desktop's own dialog (snyvi never looks through
 *  the home folder for one). There is one studio desk: asked for again, the
 *  one there is opens, and a closed one comes back, as it was left. With no
 *  Claude Code here there is nothing for the desk to do, and the dialog
 *  says so before anything is made. */
export async function newDesk(c, { hold }) {
  const ds = c.state.desks || {};
  const there = (ds.desks || []).find(d => d.kind === "studio");
  if (there) { c.show(there.id, true); return; }
  if (made) { made.querySelector?.(".go")?.focus(); return; }
  if (ds.studio_closed) {
    made = true;
    try {
      const j = await c.api("/api/desks", { kind: "studio" });
      await c.load();
      c.show(j.desk.id, true);
      if (j.reopened) c.toast("Your studio desk is back", { sub: "Its notes, its folder, and Claude's conversation to resume" });
    } catch (e) { c.toast("Could not bring the studio desk back", { sub: e }); }
    finally { made = null; }
    return;
  }
  made = true;
  const claude = await hold().catch(() => false);
  made = null;
  if (!claude) return needClaude(c);
  style();
  let folder = (c.state.desks && c.state.desks.studio_offer) || "";
  const over = Object.assign(document.createElement("div"), { className: "st-over" });
  over.innerHTML = `<form class="st-dlg" role="dialog" aria-modal="true" aria-labelledby="st-new-t" autocomplete="off">
    <h2 class="st-dlg-t" id="st-new-t">Studio desk</h2>
    <p class="st-dlg-sub">Pictures, video and sound in one folder, with Claude under them making them. Claude arranges them into folders, and you see those in the rail.</p>
    <div class="st-f"><span>Folder</span><span class="st-path" data-folder></span><button type="button" class="st-b" data-a="pick">Change…</button></div>
    <p class="st-dlg-err" role="alert" hidden></p>
    <div class="st-dlg-act"><button type="button" class="st-b" data-a="cancel">Cancel</button><button type="submit" class="st-b go">Make desk</button></div>
  </form>`;
  document.body.append(over);
  made = over;
  const f = over.querySelector("form"), say = f.querySelector(".st-dlg-err");
  const paint = () => {
    const b = f.querySelector("[data-folder]");
    b.textContent = folder ? tildeIn(folder, c) : "Nowhere yet";
    b.classList.toggle("none", !folder);
    f.querySelector("[data-a=pick]").textContent = folder ? "Change…" : "Choose…";
  };
  const shut = () => { over.remove(); made = null; document.removeEventListener("keydown", esc_, true); };
  const esc_ = e => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); shut(); } };
  document.addEventListener("keydown", esc_, true);
  over.addEventListener("pointerdown", e => { if (e.target === over) shut(); });
  f.addEventListener("click", async e => {
    const a = e.target.closest("[data-a]")?.dataset.a;
    if (a === "cancel") shut();
    if (a !== "pick") return;
    const p = await pickFolder(c).catch(err => { say.hidden = false; say.textContent = `Could not open the folder dialog · ${c.sayErr(err).why}`; return null; });
    if (p) { folder = p; say.hidden = true; paint(); }
  });
  f.addEventListener("submit", async e => {
    e.preventDefault();
    if (!folder) { say.hidden = false; say.textContent = "Choose the studio's folder first."; f.querySelector("[data-a=pick]").focus(); return; }
    const go = f.querySelector("button[type=submit]");
    go.disabled = true;
    try {
      const j = await c.api("/api/desks", { kind: "studio", folder });
      shut();
      if (!j.existing) await firstPanel(c, j.desk.id);
      await c.load();
      c.show(j.desk.id, true);
      if (j.reopened) c.toast("Your studio desk is back", { sub: "Its notes, its folder, and Claude's conversation to resume" });
    } catch (err) {
      go.disabled = false; say.hidden = false;
      say.textContent = `Could not make the desk · ${c.sayErr(err).why}`;
    }
  });
  paint();
  f.querySelector("button[type=submit]").focus();
}

/** The desktop's folder dialog: its path, or null when it was closed
 *  without one (204, which reads as nothing). */
async function pickFolder(c) {
  const j = await c.api("/api/studio/pick", {});
  return j.path || null;
}

/** The desk's one panel: Claude, waiting in the Start field for the
 *  reader's Enter, as a project desk's first panel is. The desk is made
 *  either way, and its rail's Claude row starts one. */
async function firstPanel(c, id) {
  try {
    const p = await c.api(`/api/desks/${id}/panes`, { cmd: "claude" });
    c.hold(p.pane.id);
  } catch (e) { c.toast("Could not open Claude's panel", { sub: e }); }
}

/** No Claude Code here: the studio is Claude making things, so no desk is
 *  made, and the dialog says where Claude Code is set up instead. */
function needClaude(c) {
  style();
  const over = Object.assign(document.createElement("div"), { className: "st-over" });
  over.innerHTML = `<div class="st-dlg" role="dialog" aria-modal="true" aria-labelledby="st-new-t">
    <h2 class="st-dlg-t" id="st-new-t">Studio desk</h2>
    <p class="st-dlg-sub">The studio is Claude Code making pictures, video and sound, and snyvi can't find Claude Code on this computer. Agents says how to set it up; then ask for the studio again.</p>
    <div class="st-dlg-act"><button type="button" class="st-b" data-a="cancel">Close</button><button type="button" class="st-b go" data-a="agents">Agents…</button></div>
  </div>`;
  document.body.append(over);
  made = over;
  const shut = () => { over.remove(); made = null; document.removeEventListener("keydown", esc_, true); };
  const esc_ = e => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); shut(); } };
  document.addEventListener("keydown", esc_, true);
  over.addEventListener("pointerdown", e => { if (e.target === over) shut(); });
  over.addEventListener("click", e => {
    const a = e.target.closest("[data-a]")?.dataset.a;
    if (a === "cancel") shut();
    if (a === "agents") { shut(); c.agents(); }
  });
  over.querySelector(".go").focus();
}

/** A path with the home folder as ~, before the studio desk is drawn. */
function tildeIn(p, c) {
  const h = c.state.desks && c.state.desks.home;
  return h && (p === h || p.startsWith(h + "/")) ? "~" + p.slice(h.length) : p;
}
