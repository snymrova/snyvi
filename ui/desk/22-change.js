/* ui/desk/22-change.js: a part of desk.js, one module. build.rs joins ui/desk/*.js in name
 * order (src/strip.rs `source`); SNYVI_UI_DIR serves the same join. */
// ---------- the change (1.56, audit B1) ----------
/*
 * The change a panel is making is the unit of a builder's work, and on the
 * desk it was one word on the panel's row -- "building", a chip
 * (09-thread.js `threadChip`) -- with its name, its notes and its PR in the
 * chip's tip, and its stage in the chip's menu. Home gave the same thread a
 * line. The builder read the desk as four terminals plus a list.
 *
 * So the change gets a row of its own, at the head of Notes, above the
 * lines it carries: its name, its stage as a control, the panel at it, its
 * PR and checks, its notes. The chip on the panel's row stays as the
 * pointer from the panel to it. Nothing new is fetched: the rows are the
 * desk's filed threads (09-thread.js `filed`), the ones a panel is moving
 * and the ones that shipped lately, as the chip has them. The stage opens
 * the same menu the chip has, under the row, over the rows below, so
 * nothing moves. For a book the words would be "chapter" and "accept";
 * the row is where they go.
 */

/** The stages the reader may move a change to by hand (src/thread.rs
 *  `STAGES`, minus shipped, which is Done, and the one it is in). */
const CH_STAGES = ["idea", "planned", "building", "review", "waiting", "parked"];

/** Which change's menu is open, by thread id. */
let chMenu = 0;

/** The rows at the head of Notes: one per change this desk is moving. */
function changeRows(d, esc) {
  if (filedAt !== d.id) return "";
  const now = Date.now() / 1000;
  const ts = filed.threads.filter(t => !restOf(d, t) && (t.stage !== "shipped" || shippedFresh(t, now)));
  if (!ts.length) return "";
  return `<ul class="dk-list dk-changes" aria-label="Changes on this desk">${ts.map(t => changeRow(d, t, esc)).join("")}</ul>`;
}

function changeRow(d, t, esc) {
  const slot = slotOf(d, t.pane), v = views.get(t.pane);
  const at = slot ? (v?.pane?.name || `panel ${slot}`) : "";
  const shipped = t.stage === "shipped", told = shipped && !!t.told_at;
  const stage = told ? "told" : shipped ? "shipped" : t.stage;
  const tone = /fail|error/i.test(t.ci || "") ? " fail" : /pass|success/i.test(t.ci || "") ? " pass" : "";
  const pr = t.pr ? `<span class="dk-stage dk-ch-pr${tone}" data-tip="PR ${esc(t.pr)}" data-tip-sub="${esc(t.merged ? `merged ${t.merged.slice(0, 7)}` : t.ci ? `checks ${t.ci}` : "no checks yet")}">PR ${esc(t.pr)}${t.ci ? ` ${esc(t.ci)}` : ""}</span>` : "";
  const notes = t.notes.length ? `<span class="dk-stage dk-ch-notes" data-tip="Its notes" data-tip-sub="the lines under this row it answers">${t.notes.map(n => `#${n}`).join(" ")}</span>` : "";
  return `<li class="dk-note dk-change${shipped ? " shipped" : ""}" data-t="${t.id}">` +
    `<span class="dk-lead"><span class="dk-ch-ico" aria-hidden="true">${ico("branch")}</span></span>` +
    `<span class="nm" data-tip="${esc(t.name)}" data-tip-sub="${esc(threadSub(t))}" data-tip-overflow><span class="nm-t" data-tip-cut>${esc(t.name)}</span></span>` +
    `<span class="dk-meta"><span class="dk-marks">` +
    `<button type="button" class="dk-stage dk-ch-stage${shipped ? " ok" : ""}" data-a="ch-menu" data-t="${t.id}" aria-haspopup="menu" aria-expanded="${chMenu === t.id}" data-tip="Its stage" data-tip-sub="click to move it, rename it, or say where it was told" aria-label="Stage of ${esc(t.name)}: ${esc(stage)}">${esc(stage)} ▾</button>` +
    (at ? `<span class="dk-stage dk-ch-at" data-tip="The panel at it" data-tip-sub="panel ${slot}">${esc(at)}</span>` : "") + pr + notes +
    `</span></span>` + changePop(t, esc) + errLine(`t${t.id}`, esc) + `</li>`;
}

/** The stage's menu under the row: the other stages, Done, Told at…,
 *  Rename…, Remove -- the chip's menu (09-thread.js `threadMenu`), laid
 *  out as the date's is. */
function changePop(t, esc) {
  if (chMenu !== t.id) return "";
  const item = (a, label, extra = "") => `<button type="button" role="menuitem" data-a="${a}" data-t="${t.id}"${extra}>${label}</button>`;
  const shipped = t.stage === "shipped";
  return `<span class="dk-due-pop dk-ch-pop" role="menu" aria-label="Move ${esc(t.name)}">` +
    (shipped ? "" : CH_STAGES.filter(s => s !== t.stage).map(s => item("th-move", `→ ${s}`, ` data-stage="${s}"`)).join("") + item("th-move", "→ shipped (Done)", ` data-stage="shipped"`)) +
    (shipped ? item("ch-told", t.told_at ? "Told at… (change)" : "Told at…") : "") +
    item("ch-rename", "Rename…") +
    item("th-x", "Remove", ` class="danger"`) + `</span>`;
}

/** The row's presses; true when one of them was this part's. Any other
 *  press closes an open menu. The moves are the chip's (`filedAct`). */
function changeAct(a, b, d) {
  if (a !== "ch-menu" && a !== "ch-rename" && a !== "ch-told") { if (chMenu && !a.startsWith("th-")) { chMenu = 0; } return false; }
  const t = filed.threads.find(x => x.id === +b.dataset.t);
  if (!t || !d) return true;
  if (a === "ch-menu") {
    chMenu = chMenu === t.id ? 0 : t.id;
    rail();
    if (chMenu) ctx.tocEl.querySelector(".dk-ch-pop button")?.focus();
    return true;
  }
  chMenu = 0;
  thField = { kind: a === "ch-rename" ? "rename" : "told", id: t.id };
  thDraft = a === "ch-rename" ? t.name : t.told_url || "";
  rail();
  return true;
}

const CHANGE_CSS = `
/* The change's row at the head of Notes: a note row's shape, the branch
   where the circle is, and its facts on the line under the name. */
.dk-changes { margin-bottom: 4px; }
.dk-change .dk-ch-ico { display: grid; place-items: center; width: 14px; height: 14px; color: var(--fg-3); }
.dk-change .dk-ch-ico svg { width: 12px; height: 12px; }
.dk-change > .nm { font-weight: 600; }
.dk-change.shipped > .nm { font-weight: 500; color: var(--fg-2); }
.dk-meta .dk-marks > .dk-ch-stage { padding: 0 4px; margin-left: -4px; border-radius: var(--r-xs); color: var(--accent); font-weight: 600; }
.dk-meta .dk-marks > .dk-ch-stage.ok { color: var(--ok); }
.dk-meta .dk-marks > .dk-ch-stage:hover { background: var(--rule); color: var(--accent); }
.dk-meta .dk-marks > .dk-ch-pr.pass { color: var(--ok); }
.dk-meta .dk-marks > .dk-ch-pr.fail { color: var(--warn); }
.dk-meta .dk-marks > .dk-ch-at { color: var(--fg-2); }
.dk-ch-pop > .danger { color: var(--danger); }
`;
