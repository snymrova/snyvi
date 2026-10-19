/* /sidebars: arranging the two sidebars, and the widgets in them.
 *
 * Fetched when the page opens (app.js `showSidebars`): arranging happens
 * once in a while, so first paint never pays for it. Two lists, the left's
 * and the right's, in the order the sidebars draw them; a row is dragged,
 * or moved with Alt+↑ ↓, and switched on or off. Your turn is not a
 * section any more: it waits in a desk's corner (ui/desk/10-onyou.js). Every change is saved as it is made, and the
 * real sidebar moves with it (the `layout` event). Under them the widgets:
 * each widget file with what it runs, whether it is allowed, its switch,
 * its settings and Rerun my edits, the desks it is on and how long it lasts
 * (#111); then what agents and scripts pushed.
 * Nothing on the lists is ever removed: off is a switch, and on again is the
 * same switch (snyvi never deletes). Drawn with the sidebars' own Section
 * and Rows (docs/DESIGN.md §8.4), so the page follows the system it sets. */

const STYLE = `
/* 40 px on top: the waiting bar lays over a page's first 40 px, and here the
   first row is Reset, which a click on the bar would miss. Always there, so
   the bar coming and going moves nothing. */
.sb { max-width: 880px; margin: 0 auto; padding: 40px 48px 64px; }
.sb-top { display: flex; align-items: center; gap: 12px; margin: 8px 0 20px; }
.sb-top h1 { flex: 1; margin: 0; font-size: var(--fs-h2, 20px); }
.sb-top p { margin: 0; }
.sb-say { color: var(--fg-3); font-size: var(--fs-small); }
.sb-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
@media (max-width: 760px) { .sb { padding: 8px 16px 48px; } .sb-cols { grid-template-columns: 1fr; } }
.sb-box { border: 1px solid var(--rule); border-radius: var(--r-md); background: var(--bg-side); padding: 0 8px 8px; }
.sb-box > .sec-head:first-child { margin-top: var(--sp-2); }
.sb-list { list-style: none; margin: 0; padding: 0; }
.sb-row { display: flex; align-items: center; gap: 8px; height: var(--row-h); padding: 0 8px; border-radius: var(--r-sm); font-size: var(--fs-ui); font-weight: var(--fw-row); color: var(--fg); }
.sb-row:hover, .sb-row:focus-visible { background: var(--rule); }
.sb-row.drag { opacity: .4; }
.sb-row.over { box-shadow: inset 0 2px 0 var(--accent); }
.sb-row.off .sb-nm { color: var(--fg-3); }
.sb-grip { flex: none; width: 12px; color: var(--fg-3); cursor: grab; text-align: center; letter-spacing: -1px; }
.sb-nm { flex: none; }
.sb-what { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs-small); color: var(--fg-3); font-weight: 400; }
.sb-sw { flex: none; position: relative; width: 26px; height: 16px; border-radius: var(--r-pill); background: var(--rule-2); transition: background var(--t); }
.sb-sw::after { content: ""; position: absolute; top: 2px; left: 2px; width: 12px; height: 12px; border-radius: 50%; background: var(--bg-raise); box-shadow: var(--shadow); transition: transform var(--t); }
.sb-sw[aria-checked="true"] { background: var(--accent); }
.sb-sw[aria-checked="true"]::after { transform: translateX(10px); }
.sb-w { padding: 6px 8px 8px; border-top: 1px solid var(--rule); }
.sb-w:first-of-type { border-top: 0; }
.sb-w-head { display: flex; align-items: center; gap: 8px; min-height: var(--row-h); font-size: var(--fs-ui); }
.sb-w-head b { font-weight: 600; }
.sb-w-meta { flex: 1; min-width: 0; font-size: var(--fs-small); color: var(--fg-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sb-w-meta code { font-family: var(--mono); font-size: var(--fs-micro); }
.sb-w-state { flex: none; font-size: var(--fs-micro); font-weight: 600; color: var(--fg-3); }
.sb-w-state.warn { color: var(--warn); }
.sb-w-state.ok { color: var(--ok); }
.sb-w-err { margin: 2px 0 0; font-size: var(--fs-small); color: var(--warn); }
.sb-w-acts { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin-top: 4px; font-size: var(--fs-small); color: var(--fg-2); }
.sb-w-acts label { display: inline-flex; align-items: center; gap: 6px; }
.sb-btn { padding: 2px 10px; border: 1px solid var(--rule-2); border-radius: var(--r-sm); font-size: var(--fs-small); color: var(--fg); }
.sb-btn:hover:not(:disabled) { border-color: var(--accent); }
.sb-btn.primary { border-color: var(--accent); color: var(--accent); font-weight: 600; }
.sb-btn.sb-rm { color: var(--danger); }
.sb-btn.sb-rm:hover:not(:disabled) { border-color: var(--danger); }
.sb-set { display: grid; grid-template-columns: max-content 1fr; gap: 6px 12px; align-items: center; margin-top: 6px; font-size: var(--fs-small); color: var(--fg-2); }
.sb-set input:not([type="checkbox"]), .sb-set select { min-width: 0; font: inherit; padding: 2px 6px; border: 1px solid var(--rule-2); border-radius: var(--r-sm); background: var(--bg); color: var(--fg); }
.sb-folder { font-family: var(--mono); font-size: var(--fs-micro); color: var(--fg-3); overflow-wrap: anywhere; }
.sb-open { margin-left: 6px; font-family: inherit; font-size: var(--fs-micro); color: var(--accent); }
.sb-open:hover { text-decoration: underline; }
.sb-sub { margin: 12px 0 4px; font-size: var(--fs-micro); font-weight: 600; color: var(--fg-2); }
.sb-empty { margin: 4px 8px 8px; font-size: var(--fs-small); color: var(--fg-3); }
.sb-empty code { font-family: var(--mono); font-size: var(--fs-micro); }
.sb-note { margin: 8px 8px 0; font-size: var(--fs-small); color: var(--fg-3); }
`;

/** What each section is, in a few words: the page names them as the
 *  sidebars do, and says what each holds. */
const SECS = {
  inbox: ["Inbox", "projects, and what waits"],
  desks: ["Desks", "your desks"],
  folders: ["Folders", "folders opened to read"],
  widgets: ["Widgets", "global widgets"],
  panels: ["Panels", "this desk's panels"],
  points: ["Points", "passages kept for a panel"],
  docs: ["Documents", "what this desk's panels sent"],
  notes: ["Notes", "this desk's list"],
};
const DEFAULT = { left: ["inbox", "desks", "folders", "widgets"], right: ["panels", "points", "docs", "notes", "widgets"], hidden: [] };

let c = null, data = null, styled = false;

/** The id a hidden slot is named by: `widgets` is on both sides. */
const hideId = (side, id) => id === "widgets" ? `${side}:widgets` : id;

export async function show(ctx) {
  c = ctx;
  if (!styled) { const s = document.createElement("style"); s.textContent = STYLE; document.head.append(s); styled = true; }
  try { data = await (await fetch("/api/widgets")).json(); }
  catch { c.docEl.innerHTML = `<div class="sb"><p class="sb-say">Could not read the sidebars.</p></div>`; return; }
  if (c.view() !== "sidebars") return;
  draw();
  c.docEl.onclick = click;
  c.docEl.onkeydown = keys;
  c.docEl.ondragstart = dragStart;
  c.docEl.ondragover = dragOver;
  c.docEl.ondrop = drop;
  c.docEl.ondragend = dragEnd;
  c.docEl.onchange = changed;
}

/** The page again, from `data`, keeping the focus on the row it was on. */
function draw() {
  const { esc } = c, l = data.layout || DEFAULT;
  const at = document.activeElement?.closest?.("[data-sb]")?.dataset.sb;
  const row = (side, id) => {
    const [name, what] = SECS[id], on = !l.hidden.includes(hideId(side, id));
    return `<li class="sb-row${on ? "" : " off"}" data-sb="${side}:${id}" tabindex="0" draggable="true" aria-label="${esc(name)}">` +
      `<span class="sb-grip" aria-hidden="true">⠿</span><span class="sb-nm">${esc(name)}</span><span class="sb-what">${esc(what)}</span>` +
      `<button type="button" class="sb-sw" role="switch" aria-checked="${on}" data-sw="${side}:${id}" aria-label="${on ? "Shown" : "Hidden"}: ${esc(name)}"></button></li>`;
  };
  const box = (side, title, ids) => `<section class="sb-box">${c.secHead(`sb-${side}`, title, { fixed: true })}<ul class="sb-list" data-side="${side}">${ids.filter(id => SECS[id]).map(id => row(side, id)).join("")}</ul></section>`;
  c.docEl.innerHTML = `<div class="sb">` +
    `<div class="sb-top"><h1 tabindex="-1">Sidebars</h1><button type="button" class="sb-btn" data-reset data-tip="Reset to default" data-tip-sub="Today's order, everything shown. Widgets keep their settings">Reset to default</button></div>` +
    `<p class="sb-say">Drag a row, or move it with Alt ↑ ↓. Changes are saved as you make them. The left is the same on every page; the right is the desk you are on.</p>` +
    `<div class="sb-cols">${box("left", "Left · everywhere", l.left)}${box("right", "Right · on a desk", l.right)}</div>` +
    `<div class="sb-cols" style="margin-top:24px">${filesBox()}${pushedBox()}</div></div>`;
  const back = at && c.docEl.querySelector(`[data-sb="${CSS.escape(at)}"]`);
  if (back) back.focus({ preventScroll: true });
}

/** Remove, on an agent's widget alone: a desk's own widget file, or a box
 *  a panel pushed. Its folder is kept in widgets/.removed/, and the row
 *  says Undo where it was (`removeRow`). */
const rmBtn = (name, desk, owner) => `<button type="button" class="sb-btn sb-rm" data-wrm="${c.esc(name)}" data-wd="${desk}" data-wown="${owner}" data-tip="Remove" data-tip-sub="An agent's widget: kept in widgets/.removed/, with Undo here for a moment">Remove</button>`;

/** The widget files: each with what it runs, whether it may, and its
 *  switch, settings and Rerun my edits. */
function filesBox() {
  const { esc } = c;
  const files = data.files || [];
  const one = f => {
    if (!f.command) return `<div class="sb-w" data-own="${f.owner || 0}"><div class="sb-w-head"><b>${esc(f.name)}</b><span class="sb-w-meta"></span></div><p class="sb-w-err">${esc(f.error || "")}</p>` +
      (f.owner ? `<div class="sb-w-acts">${rmBtn(f.name, f.owner, f.owner)}</div>` : "") + `<p class="sb-folder">${esc(f.folder)} <button type="button" class="sb-open" data-wopen="${esc(f.name)}" data-tip="Open its folder">Open</button></p></div>`;
    const now = Date.now() / 1000, ended = !!f.ended;
    const state = ended ? [`Ended ${f.until ? new Date(f.until * 1000).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" }) : "with its panel"}`, ""]
      : f.allowed ? ["Allowed", "ok"] : f.changed ? ["Changed · needs Allow", "warn"] : ["Needs Allow", "warn"];
    const ds = data.desks || [], every = !(f.desks || []).length, mine = f.owner ? esc(f.owner_desk || `desk ${f.owner}`) : "";
    // A desk's own (1.32) is on its desk alone: no desks to tick, and
    // Share is the way to more of them.
    const where = f.scope === "global" ? "" : f.owner ? `<div class="sb-w-acts sb-desks"><span>On ${mine} alone</span>` +
      `<button type="button" class="sb-btn" data-wshare="${esc(f.name)}" data-tip="Share with other desks" data-tip-sub="It stays on ${mine}; tick more desks here after">Share with other desks</button></div>`
      : `<div class="sb-w-acts sb-desks" role="group" aria-label="Desks it is on"><span>On</span>` +
      `<label><input type="checkbox" data-wdesks="${esc(f.name)}" data-d="all"${every ? " checked" : ""}>every desk</label>` +
      ds.map(d => `<label><input type="checkbox" data-wdesks="${esc(f.name)}" data-d="${d.id}"${!every && f.desks.includes(d.id) ? " checked" : ""}${every ? " disabled" : ""}>${esc(d.name)}</label>`).join("") + `</div>`;
    const pick = f.until_pane ? "panel" : f.until > now ? (f.until - now > 86400 ? "week" : "today") : "";
    const lasts = `<div class="sb-w-acts" role="group" aria-label="How long"><span>Lasts</span>` +
      [["", "Until I turn it off"], ["today", "For today"], ["week", "For a week"]].map(([k, l]) =>
        `<button type="button" class="sb-btn${pick === k ? " primary" : ""}" data-wlast="${esc(f.name)}" data-v="${k}" aria-pressed="${pick === k}">${l}</button>`).join("") +
      (pick === "panel" ? `<span>while its panel is open</span>` : f.until > now ? `<span>until ${esc(new Date(f.until * 1000).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" }))}</span>` : "") + `</div>`;
    const fields = Object.entries(f.fields || {});
    return `<div class="sb-w" data-w="${esc(f.name)}" data-own="${f.owner || 0}"><div class="sb-w-head"><b>${esc(f.title || f.name)}</b>` +
      `<span class="sb-w-meta">${f.scope === "global" ? "global" : f.owner ? `${mine}'s own` : "shared"} · <code>${esc(f.command)}</code> · every ${f.every} s</span>` +
      `<span class="sb-w-state ${state[1]}">${state[0]}</span>` +
      `<button type="button" class="sb-sw" role="switch" aria-checked="${!f.hidden}" data-wsw="${esc(f.name)}" aria-label="${f.hidden ? "Off" : "On"}: ${esc(f.title || f.name)}"></button></div>` +
      (f.error ? `<p class="sb-w-err">${esc(f.error)}</p>` : "") +
      // The desk keys it names (1.46): Allow covers them, and the reader
      // sees which before they do.
      (f.keys?.length ? `<p class="sb-w-err" style="color:var(--fg-2)" data-tip="Keys it is given" data-tip-sub="Each from ${mine || "its desk"}'s Keys list, in the run's environment; nothing else of the desk's">Uses ${f.keys.length === 1 ? "the key" : "the keys"} ${f.keys.map(k => `<code>${esc(k)}</code>`).join(", ")}</p>` : "") +
      `<div class="sb-w-acts">` + (f.allowed ? "" : `<button type="button" class="sb-btn primary" data-allow="${esc(f.name)}" data-tip="Allow it to run" data-tip-sub="As its folder is now${f.keys?.length ? ", and the keys it names" : ""}. Only the snyvi window can allow">Allow</button>`) +
      `<label data-tip="Rerun my edits" data-tip-sub="A change to its folder runs without asking again. For a widget you are writing yourself"><input type="checkbox" data-rerun="${esc(f.name)}"${f.rerun_edits ? " checked" : ""}>Rerun my edits</label>` +
      (ended ? `<button type="button" class="sb-btn primary" data-won="${esc(f.name)}">Turn on again</button>` : "") + (f.owner ? rmBtn(f.name, f.owner, f.owner) : "") + `</div>` + where + lasts +
      (fields.length ? `<div class="sb-set">` + fields.map(([k, d]) => {
        const v = f.settings[k], id = `sb-${f.owner || 0}-${f.name}-${k}`, lab = `<label for="${id}">${esc(d.label || k)}</label>`, at = `id="${id}" data-set="${esc(f.name)}" data-k="${esc(k)}"`;
        if (d.type === "boolean" || d.type === "bool") return lab + `<span><input type="checkbox" ${at}${v ? " checked" : ""}></span>`;
        if (d.type === "choice" && d.choices?.length) return lab + `<select ${at}>${d.choices.map(o => `<option${o === v ? " selected" : ""}>${esc(o)}</option>`).join("")}</select>`;
        return lab + `<input ${at} type="${d.type === "number" ? "number" : "text"}" value="${esc(v ?? "")}" spellcheck="false">`;
      }).join("") + `</div>` : "") +
      `<p class="sb-folder">${esc(f.folder)} <button type="button" class="sb-open" data-wopen="${esc(f.name)}" data-tip="Open its folder" data-tip-sub="Read what Allow takes: every file in it">Open</button></p></div>`;
  };
  return `<section class="sb-box">${c.secHead("sb-files", "Widget files", { fixed: true, count: files.length || "" })}` +
    (files.length ? files.map(one).join("") : `<p class="sb-empty">None yet. <code>snyvi widget new git</code> writes a starter; an agent can propose one.</p>`) +
    `<p class="sb-note">Allow is consent, not a sandbox: a widget runs as you, with your PATH.</p></section>`;
}

/** What agents and scripts pushed: each switch is the reader's, and a
 *  widget switched off stays off when its writer updates it. */
function pushedBox() {
  const { esc } = c;
  const ps = data.pushed || [];
  return `<section class="sb-box">${c.secHead("sb-pushed", "Pushed", { fixed: true, count: ps.length || "" })}` +
    (ps.length ? `<ul class="sb-list">` + ps.map(p => `<li class="sb-row${p.hidden ? " off" : ""}"><span class="sb-nm">${esc(p.name)}</span>` +
      `<span class="sb-what">${p.desk_id ? esc(p.desk || `desk ${p.desk_id}`) : "global"} · ${esc(p.writer)}</span>` +
      (p.agent && p.desk_id ? rmBtn(p.name, p.desk_id, 0) : "") +
      `<button type="button" class="sb-sw" role="switch" aria-checked="${!p.hidden}" data-wsw="${esc(p.name)}" data-wown="${p.desk_id}" aria-label="${p.hidden ? "Off" : "On"}: ${esc(p.name)}"></button></li>`).join("") + `</ul>`
      : `<p class="sb-empty">None. An agent's <code>set_widget</code>, or <code>snyvi widget set</code> from a script.</p>`) + saidNo() + `</section>`;
}

/** The boxes the reader said Not now to, or removed: a no is theirs to
 *  take back. Ask again lets the next push ask with a card. */
function saidNo() {
  const { esc } = c, ns = data.said_no || [];
  if (!ns.length) return "";
  return `<h4 class="sb-sub">You said no</h4><ul class="sb-list">` + ns.map(n => `<li class="sb-row"><span class="sb-nm">${esc(n.name)}</span>` +
    `<span class="sb-what">${esc(n.desk)} · ${n.answer === "removed" ? "removed" : "not now"} · ${esc(n.writer)}</span>` +
    `<button type="button" class="sb-open" data-wagain="${esc(n.name)}" data-wd="${n.desk_id}" data-tip="Ask again" data-tip-sub="Its next push brings a card to Allow, from any panel">Ask again</button></li>`).join("") + `</ul>`;
}

/** Save the layout, and draw what the daemon kept. */
async function save(l) {
  const was = data.layout;
  data.layout = l; draw();
  try {
    const r = await fetch("/api/layout", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(l) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    data.layout = await r.json(); c.setLayout(data.layout); draw();
  } catch (e) {
    // Not kept: the page shows what the sidebars have, not what it hoped.
    data.layout = was; draw();
    c.toast("Could not save the sidebars", { sub: e });
  }
}

/** Move `id` on `side` to just before `before`, or to the end. */
function move(side, id, before) {
  const l = structuredClone(data.layout || DEFAULT), list = l[side].filter(x => x !== id);
  let at = before ? list.indexOf(before) : list.length;
  if (at < 0) at = list.length;
  list.splice(at, 0, id);
  l[side] = list;
  save(l);
}

async function click(e) {
  if (c.view() !== "sidebars") return;
  const sw = e.target.closest("[data-sw]");
  if (sw) {
    const [side, id] = sw.dataset.sw.split(":"), h = hideId(side, id), l = structuredClone(data.layout || DEFAULT);
    l.hidden = l.hidden.includes(h) ? l.hidden.filter(x => x !== h) : [...l.hidden, h];
    return save(l);
  }
  if (e.target.closest("[data-reset]")) return save(structuredClone(DEFAULT));
  const wsw = e.target.closest("[data-wsw]");
  if (wsw) {
    const on = wsw.getAttribute("aria-checked") === "true";
    return prefs(wsw.dataset.wsw, { hidden: on }, true, wsw.dataset.wown != null ? +wsw.dataset.wown : own(wsw));
  }
  const sh = e.target.closest("[data-wshare]");
  if (sh) return prefs(sh.dataset.wshare, { share: true }, true, own(sh));
  const wl = e.target.closest("[data-wlast]");
  if (wl) {
    const k = wl.dataset.v, t = new Date();
    t.setHours(24, 0, 0, 0);
    const until = k === "today" ? Math.floor(t / 1000) : k === "week" ? Math.floor(Date.now() / 1000) + 7 * 86400 : 0;
    return prefs(wl.dataset.wlast, { until, until_pane: "" }, true, own(wl));
  }
  const wo = e.target.closest("[data-won]");
  if (wo) return prefs(wo.dataset.won, { hidden: false, until: 0, until_pane: "" }, true, own(wo));
  const rm = e.target.closest("[data-wrm]");
  if (rm) return removeRow(rm);
  const un = e.target.closest("[data-wun]");
  if (un) return undoRow(un);
  const ag = e.target.closest("[data-wagain]");
  if (ag) {
    ag.disabled = true;
    try { await c.deskApi(`/api/widgets/${ag.dataset.wagain}/prefs`, { ask_again: +ag.dataset.wd }); ag.textContent = "Asks on its next push"; }
    catch (e) { ag.disabled = false; allowRefused(e); }
    return;
  }
  const op = e.target.closest("[data-wopen]");
  if (op) return openWidget(op.dataset.wopen, own(op));
  const al = e.target.closest("[data-allow]");
  if (al) {
    al.disabled = true;
    try { await c.deskApi(`/api/widgets/${al.dataset.allow}/allow`, { owner: own(al) }); await again(); }
    catch (e) { al.disabled = false; allowRefused(e); }
  }
}

/** Why Allow, or turning a widget on or wider, did not happen: a tab's
 *  missing capability (403), or the daemon's own reason, said as it is. */
function allowRefused(e) {
  if (e?.status === 403) c.toast("That works in the snyvi window", { sub: "A tab cannot let a command run" });
  else c.toast("Not allowed", { sub: e?.message || e });
}

/** A widget file's folder, in the file manager: what Allow takes, read
 *  before it is allowed. By name and desk; the daemon finds the folder. */
async function openWidget(widget, owner) {
  try {
    const r = await fetch("/api/reveal", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ widget, owner }) });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
  } catch (e) { c.toast("Could not open the folder", { sub: e?.message || e }); }
}

/** A setting, Rerun my edits: saved as it changes. */
async function changed(e) {
  if (c.view() !== "sidebars") return;
  const t = e.target;
  if (t.dataset.rerun) {
    try { await c.deskApi(`/api/widgets/${t.dataset.rerun}/allow`, { allow: false, rerun_edits: t.checked, owner: own(t) }); }
    catch { t.checked = !t.checked; c.toast("Rerun my edits is set in the snyvi window"); }
    return;
  }
  if (t.dataset.wdesks) {
    const name = t.dataset.wdesks;
    if (t.dataset.d === "all") return prefs(name, { desks: t.checked ? [] : (data.desks || []).map(d => d.id) });
    const ids = [...c.docEl.querySelectorAll(`input[data-wdesks="${CSS.escape(name)}"]:not([data-d="all"]):checked`)].map(x => +x.dataset.d);
    // Off every desk is off: the switch says so, and the ticks stay. A desk
    // ticked is a yes to it there: on again, if it was off.
    return prefs(name, ids.length ? { desks: ids, ...(t.checked ? { hidden: false } : {}) } : { hidden: true });
  }
  if (t.dataset.set) {
    const f = (data.files || []).find(x => x.name === t.dataset.set && (x.owner || 0) === own(t));
    if (!f) return;
    const v = t.type === "checkbox" ? t.checked : t.type === "number" ? Number(t.value) : t.value;
    f.settings = { ...f.settings, [t.dataset.k]: v };
    prefs(f.name, { settings: f.settings }, false, own(t));
  }
}

/** An agent's widget removed from its row: the row keeps its height and
 *  says Undo for a moment, then the page is read again and it closes up --
 *  the reader's click, so the page may move then. */
let rmTimer = 0;
const RM_MS = 4000;
async function removeRow(b) {
  const row = b.closest(".sb-w, .sb-row"), name = b.dataset.wrm, desk = +b.dataset.wd, owner = +b.dataset.wown;
  b.disabled = true;
  let j;
  try { j = await c.deskApi(`/api/widgets/${name}/remove`, { desk, owner }); }
  catch (e) { b.disabled = false; c.toast(`Could not remove ${name}`, { sub: e }); return; }
  row.style.minHeight = `${row.offsetHeight}px`;
  row.innerHTML = `<span class="sb-nm">Removed ${c.esc(name)}</span><button type="button" class="sb-btn" data-wun="${c.esc(name)}" data-wd="${desk}" data-wown="${owner}" data-wfrom="${c.esc(j.from || "")}">Undo</button>`;
  row.querySelector("[data-wun]").focus({ preventScroll: true });
  clearTimeout(rmTimer); rmTimer = setTimeout(again, RM_MS);
}
async function undoRow(b) {
  b.disabled = true;
  try { await c.deskApi(`/api/widgets/${b.dataset.wun}/restore`, { desk: +b.dataset.wd, owner: +b.dataset.wown, from: b.dataset.wfrom }); clearTimeout(rmTimer); await again(); }
  catch (e) { b.disabled = false; c.toast(`Could not bring ${b.dataset.wun} back`, { sub: e }); }
}

/** The desk a widget file on this page belongs to (0: shared or global):
 *  two desks may each own one of a name, so the name alone is not enough. */
const own = el => +(el.closest(".sb-w")?.dataset.own || 0);

async function prefs(name, body, redraw = true, owner = 0) {
  try {
    await c.deskApi(`/api/widgets/${name}/prefs`, { owner, ...body });
    if (redraw) await again();
  } catch (e) {
    if (e?.status === 403) allowRefused(e);
    else c.toast("Could not save that", { sub: e?.message || e });
  }
}

/** Read everything again: after an Allow, a switch, a Remove -- keeping
 *  the focus on the control it was on, by what it names, so a keyboard
 *  reader does not start over from the top. */
async function again() {
  const at = document.activeElement, box = at?.closest?.(".sb-w")?.dataset.own;
  const mark = at && [...at.attributes].find(a => a.name.startsWith("data-w") || a.name === "data-allow" || a.name === "data-rerun");
  try { data = await (await fetch("/api/widgets")).json(); } catch { return; }
  if (c.view() !== "sidebars") return;
  draw();
  if (!mark) return;
  const back = [...c.docEl.querySelectorAll(`[${mark.name}="${CSS.escape(mark.value)}"]`)].find(el => box == null || el.closest(".sb-w")?.dataset.own === box);
  back?.focus({ preventScroll: true });
}

/** Alt+↑ ↓ moves the row with the focus; a row is not a field, so the
 *  letter keys and the rest pass. */
function keys(e) {
  if (c.view() !== "sidebars") return;
  const row = e.target.closest?.(".sb-row[data-sb]");
  if (!row || !e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
  e.preventDefault(); e.stopPropagation();
  const [side, id] = row.dataset.sb.split(":");
  const list = (data.layout || DEFAULT)[side], i = list.indexOf(id), j = i + (e.key === "ArrowUp" ? -1 : 1);
  if (j < 0 || j >= list.length) return;
  move(side, id, e.key === "ArrowUp" ? list[j] : list[j + 1]);
}

let dragging = null;
function dragStart(e) {
  if (c.view() !== "sidebars") return;
  const row = e.target.closest?.(".sb-row[draggable]");
  if (!row) return;
  dragging = row.dataset.sb;
  row.classList.add("drag");
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/plain", dragging);
}
function dragOver(e) {
  const row = e.target.closest?.(".sb-row[data-sb]");
  if (!dragging || !row || row.dataset.sb.split(":")[0] !== dragging.split(":")[0]) return;
  e.preventDefault();
  for (const o of c.docEl.querySelectorAll(".sb-row.over")) if (o !== row) o.classList.remove("over");
  row.classList.add("over");
}
function drop(e) {
  const row = e.target.closest?.(".sb-row[data-sb]");
  if (!dragging || !row) return;
  e.preventDefault();
  const [side, id] = dragging.split(":"), [s2, before] = row.dataset.sb.split(":");
  dragEnd();
  if (side === s2 && before !== id) move(side, id, before);
}
function dragEnd() {
  dragging = null;
  for (const o of c.docEl.querySelectorAll(".sb-row.drag, .sb-row.over")) o.classList.remove("drag", "over");
}
