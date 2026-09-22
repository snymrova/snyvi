/* What this is, and the one thing that cannot be undone.
 *
 * A chunk, like the desk view, the diagram driver and the game -- fetched the
 * first time the reader opens either panel and never before. Neither is on the
 * way to reading a document: one says which build is answering, the other
 * empties the library, and a first paint that has never been asked for either
 * pays for neither.
 *
 * Both already went to the daemon when they opened -- `/api/about` for the
 * facts, `/api/reset` for the census -- so the fetch that brings this module
 * is the one the panel was going to make anyway, on the same localhost.
 *
 * The page owns the markup and the dialog helpers; this owns what goes in
 * them. Everything it needs arrives in `d`, so nothing here reaches into the
 * page's scope and the seam is one object.
 */

let wired = false;

/** Open a panel, wiring both the first time. `which` is "about" or "reset".
 *  The listeners go on once: a panel opened twice is the same dialog. */
export function open(which, d) {
  if (!wired) { wire(d); wired = true; }
  return which === "about" ? openAbout(d) : openReset(d);
}

function wire(d) {
  const { $, closeDialog, aboutDlg, resetDlg } = d;
  $("#about-close").addEventListener("click", () => closeDialog(aboutDlg));
  aboutDlg.addEventListener("click", e => { if (e.target === aboutDlg) closeDialog(aboutDlg); });
  $("#reset-close").addEventListener("click", () => closeDialog(resetDlg));
  $("#reset-cancel").addEventListener("click", () => closeDialog(resetDlg));
  resetDlg.addEventListener("click", e => { if (e.target === resetDlg) closeDialog(resetDlg); });
  $("#reset-n").addEventListener("input", () => resetArm(d));
  $("#reset-pinned").addEventListener("change", () => resetArm(d));
  resetDlg.firstElementChild.addEventListener("submit", e => submitReset(e, d));
}

// ---------- about: what this is, from the daemon ----------
/* Every number here is read from the daemon when the panel opens, not
 * baked into this bundle, so the version it names is the one answering
 * and the one `snyvi --version` prints. */
async function openAbout(d) {
  const { $, openDialog, closeDialog, help, aboutDlg } = d;
  const aboutFacts = $("#about-facts");
  closeDialog(help);
  aboutFacts.replaceChildren();
  openDialog(aboutDlg, aboutDlg.firstElementChild);
  let a;
  try { a = await (await fetch("/api/about")).json(); } catch { $("#about-say").textContent = "The daemon did not answer."; return; }
  $("#about-say").textContent = `${a.description}.`;
  const fact = (k, v, cls) => {
    if (v == null || v === "") return;
    const dt = document.createElement("dt"); dt.textContent = k;
    const dd = document.createElement("dd"); if (cls) dd.className = cls;
    if (v instanceof Node) dd.append(v); else dd.textContent = v;
    aboutFacts.append(dt, dd);
  };
  const ver = document.createDocumentFragment();
  ver.append(a.version);
  const build = [a.commit, a.target].filter(Boolean).join(", ");
  if (build) { const m = document.createElement("span"); m.className = "muted"; m.textContent = ` (${build})`; ver.append(m); }
  fact("Version", ver);
  fact("Binary", a.binary, "path");
  fact("Documents", a.data_dir, "path");
  fact("Settings", a.config_dir, "path");
  fact("Agents", a.agents, "pre");
  fact("License", a.license);
  if (a.repository) {
    const link = document.createElement("a"); link.href = a.repository; link.target = "_blank"; link.rel = "noopener";
    link.textContent = a.repository.replace(/^https?:\/\//, "");
    fact("Source", link);
  }
}

// ---------- reset: the one thing that cannot be undone ----------
/* A delete has Undo; this has a number. The dialog says what goes and what
 * stays, and the button stays dead until the number of documents is typed
 * back -- the number, not "yes", because the number means the sentence was
 * read. The daemon is sent that number and refuses if it is no longer
 * true, so a document that arrived while the dialog was open is not reset
 * unseen. Every open tab hears the event and comes back to the empty
 * library with its preferences dropped; the agents stay registered. */
let resetCensus = null;

function resetArm(d) {
  const { $ } = d;
  const pin = $("#reset-pinned");
  $("#reset-go").disabled = !resetCensus || $("#reset-n").value.trim() !== String(resetCensus.documents) || (resetCensus.pinned > 0 && !pin.checked);
}

/** The documents and the desks both, because the daemon checks both. */
const resetSentence = (c, plural) => `This removes ${plural(c.documents, "document")} in ${plural(c.projects, "project")}, ${c.desks ? plural(c.desks, "desk") + " and their panes, " : ""}the index, the token and this page's preferences. Agents stay connected: the next document they send lands in an empty library. Nothing can be undone.`;

async function openReset(d) {
  const { $, openDialog, closeDialog, help, resetDlg, plural } = d;
  const resetSay = $("#reset-say"), resetN = $("#reset-n"), resetErr = $("#reset-err");
  const resetPinRow = $("#reset-pinned-row"), resetPin = $("#reset-pinned");
  closeDialog(help);
  resetCensus = null; resetN.value = ""; resetErr.hidden = true; resetPin.checked = false; resetPinRow.hidden = true;
  resetSay.textContent = "Reading what there is…";
  resetArm(d);
  openDialog(resetDlg, resetN);
  try { resetCensus = await (await fetch("/api/reset")).json(); } catch { resetSay.textContent = "The daemon did not answer."; return; }
  resetSay.textContent = resetSentence(resetCensus, plural);
  if (resetCensus.pinned > 0) {
    $("#reset-pinned-say").textContent = `Also the ${plural(resetCensus.pinned, "pinned document")} — a pin means keep`;
    resetPinRow.hidden = false;
  }
  resetArm(d);
}

/** Drop the preferences and start over. The drop is done again by boot.js
 *  on the page that lands, because this page is still running until the
 *  navigation commits, and a task it already queued -- the toggle event a
 *  rendered `<details open>` fires, which writes `snyvi.open` -- can run
 *  after the drop here. Seen once in CI: one key back in storage. */
function afterReset() {
  try { sessionStorage.setItem("snyvi.reset", "1"); } catch {}
  try { Object.keys(localStorage).filter(k => k.startsWith("snyvi.")).forEach(k => localStorage.removeItem(k)); } catch {}
  location.replace("/");
}

async function submitReset(e, d) {
  const { $, plural } = d;
  const resetGo = $("#reset-go"), resetErr = $("#reset-err"), resetPin = $("#reset-pinned");
  e.preventDefault();
  if (resetGo.disabled) return;
  resetGo.disabled = true; resetGo.textContent = "Resetting…";
  let r;
  try {
    r = await fetch("/api/reset", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ documents: resetCensus.documents, desks: resetCensus.desks || 0, pinned: resetPin.checked }) });
  } catch { resetGo.textContent = "Reset"; resetErr.textContent = "The daemon did not answer."; resetErr.hidden = false; return; }
  if (r.ok) { afterReset(); return; }
  resetGo.textContent = "Reset";
  let j = {}; try { j = await r.json(); } catch {}
  resetErr.textContent = j.error || `The daemon refused (${r.status}).`;
  resetErr.hidden = false;
  // The number has moved: say the new sentence and ask for the new number.
  if (j.census) { resetCensus = j.census; $("#reset-n").value = ""; $("#reset-say").textContent = resetSentence(j.census, plural); }
  resetArm(d);
}
