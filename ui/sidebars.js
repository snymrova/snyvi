/* /sidebars: arranging the two sidebars, and the widgets in them.
 *
 * Fetched when the page opens (app.js `showSidebars`): arranging happens
 * once in a while, so first paint never pays for it. Two lists, the left's
 * and the right's, in the order the sidebars draw them; a row is dragged,
 * or moved with Alt+↑ ↓, and switched on or off. Your turn is fixed: first
 * on the right, never off. Every change is saved as it is made, and the
 * real sidebar moves with it (the `layout` event). Under them the widgets:
 * each widget file with what it runs, whether it is allowed, its switch,
 * its settings and Rerun my edits; then what agents and scripts pushed.
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
.sb-row.fixed .sb-grip { cursor: default; }
.sb-nm { flex: none; }
.sb-what { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs-small); color: var(--fg-3); font-weight: 400; }
.sb-sw { flex: none; position: relative; width: 26px; height: 16px; border-radius: var(--r-pill); background: var(--rule-2); transition: background var(--t); }
.sb-sw::after { content: ""; position: absolute; top: 2px; left: 2px; width: 12px; height: 12px; border-radius: 50%; background: var(--bg-raise); box-shadow: var(--shadow); transition: transform var(--t); }
.sb-sw[aria-checked="true"] { background: var(--accent); }
.sb-sw[aria-checked="true"]::after { transform: translateX(10px); }
.sb-fixed { flex: none; font-size: var(--fs-micro); color: var(--fg-3); }
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
.sb-set { display: grid; grid-template-columns: max-content 1fr; gap: 6px 12px; align-items: center; margin-top: 6px; font-size: var(--fs-small); color: var(--fg-2); }
.sb-set input:not([type="checkbox"]), .sb-set select { min-width: 0; font: inherit; padding: 2px 6px; border: 1px solid var(--rule-2); border-radius: var(--r-sm); background: var(--bg); color: var(--fg); }
.sb-folder { font-family: var(--mono); font-size: var(--fs-micro); color: var(--fg-3); overflow-wrap: anywhere; }
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
  turn: ["Your turn", "what only you can do"],
  panels: ["Panels", "this desk's panels"],
  rest: ["Resting", "threads no panel is moving"],
  points: ["Points", "passages kept for a panel"],
  docs: ["Documents", "what this desk's panels sent"],
  notes: ["Notes", "this desk's list"],
};
const DEFAULT = { left: ["inbox", "desks", "folders", "widgets"], right: ["turn", "panels", "rest", "points", "docs", "notes", "widgets"], hidden: [] };

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
    const [name, what] = SECS[id] || [id, ""], fixed = id === "turn", on = !l.hidden.includes(hideId(side, id));
    return `<li class="sb-row${fixed ? " fixed" : ""}${on ? "" : " off"}" data-sb="${side}:${id}" tabindex="0"${fixed ? "" : ` draggable="true"`} aria-label="${esc(name)}${fixed ? ", fixed" : ""}">` +
      `<span class="sb-grip" aria-hidden="true">${fixed ? "⊘" : "⠿"}</span><span class="sb-nm">${esc(name)}</span><span class="sb-what">${esc(what)}</span>` +
      (fixed ? `<span class="sb-fixed">fixed</span>` : `<button type="button" class="sb-sw" role="switch" aria-checked="${on}" data-sw="${side}:${id}" aria-label="${on ? "Shown" : "Hidden"}: ${esc(name)}"></button>`) + `</li>`;
  };
  const box = (side, title, ids) => `<section class="sb-box">${c.secHead(`sb-${side}`, title, { fixed: true })}<ul class="sb-list" data-side="${side}">${ids.map(id => row(side, id)).join("")}</ul></section>`;
  c.docEl.innerHTML = `<div class="sb">` +
    `<div class="sb-top"><h1 tabindex="-1">Sidebars</h1><button type="button" class="sb-btn" data-reset data-tip="Reset to default" data-tip-sub="Today's order, everything shown. Widgets keep their settings">Reset to default</button></div>` +
    `<p class="sb-say">Drag a row, or move it with Alt ↑ ↓. Changes are saved as you make them. The left is the same on every page; the right is the desk you are on.</p>` +
    `<div class="sb-cols">${box("left", "Left · everywhere", l.left)}${box("right", "Right · on a desk", l.right)}</div>` +
    `<div class="sb-cols" style="margin-top:24px">${filesBox()}${pushedBox()}</div></div>`;
  const back = at && c.docEl.querySelector(`[data-sb="${CSS.escape(at)}"]`);
  if (back) back.focus({ preventScroll: true });
}

/** The widget files: each with what it runs, whether it may, and its
 *  switch, settings and Rerun my edits. */
function filesBox() {
  const { esc } = c;
  const files = data.files || [];
  const one = f => {
    if (!f.command) return `<div class="sb-w"><div class="sb-w-head"><b>${esc(f.name)}</b><span class="sb-w-meta"></span></div><p class="sb-w-err">${esc(f.error || "")}</p><p class="sb-folder">${esc(f.folder)}</p></div>`;
    const state = f.allowed ? ["Allowed", "ok"] : f.changed ? ["Changed · needs Allow", "warn"] : ["Needs Allow", "warn"];
    const fields = Object.entries(f.fields || {});
    return `<div class="sb-w" data-w="${esc(f.name)}"><div class="sb-w-head"><b>${esc(f.title || f.name)}</b>` +
      `<span class="sb-w-meta">${f.scope === "global" ? "global" : "desk"} · <code>${esc(f.command)}</code> · every ${f.every} s</span>` +
      `<span class="sb-w-state ${state[1]}">${state[0]}</span>` +
      `<button type="button" class="sb-sw" role="switch" aria-checked="${!f.hidden}" data-wsw="${esc(f.name)}" aria-label="${f.hidden ? "Off" : "On"}: ${esc(f.title || f.name)}"></button></div>` +
      (f.error ? `<p class="sb-w-err">${esc(f.error)}</p>` : "") +
      `<div class="sb-w-acts">` + (f.allowed ? "" : `<button type="button" class="sb-btn primary" data-allow="${esc(f.name)}" data-tip="Allow it to run" data-tip-sub="As its folder is now. Only the snyvi window can allow">Allow</button>`) +
      `<label data-tip="Rerun my edits" data-tip-sub="A change to its folder runs without asking again. For a widget you are writing yourself"><input type="checkbox" data-rerun="${esc(f.name)}"${f.rerun_edits ? " checked" : ""}>Rerun my edits</label></div>` +
      (fields.length ? `<div class="sb-set">` + fields.map(([k, d]) => {
        const v = f.settings[k], id = `sb-${f.name}-${k}`, lab = `<label for="${id}">${esc(d.label || k)}</label>`, at = `id="${id}" data-set="${esc(f.name)}" data-k="${esc(k)}"`;
        if (d.type === "boolean" || d.type === "bool") return lab + `<span><input type="checkbox" ${at}${v ? " checked" : ""}></span>`;
        if (d.type === "choice" && d.choices?.length) return lab + `<select ${at}>${d.choices.map(o => `<option${o === v ? " selected" : ""}>${esc(o)}</option>`).join("")}</select>`;
        return lab + `<input ${at} type="${d.type === "number" ? "number" : "text"}" value="${esc(v ?? "")}" spellcheck="false">`;
      }).join("") + `</div>` : "") +
      `<p class="sb-folder">${esc(f.folder)}</p></div>`;
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
      `<button type="button" class="sb-sw" role="switch" aria-checked="${!p.hidden}" data-wsw="${esc(p.name)}" aria-label="${p.hidden ? "Off" : "On"}: ${esc(p.name)}"></button></li>`).join("") + `</ul>`
      : `<p class="sb-empty">None. An agent's <code>set_widget</code>, or <code>snyvi widget set</code> from a script.</p>`) + `</section>`;
}

/** Save the layout, and draw what the daemon kept. */
async function save(l) {
  data.layout = l; draw();
  try {
    const r = await fetch("/api/layout", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(l) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    data.layout = await r.json(); c.setLayout(data.layout); draw();
  } catch (e) { c.toast("Could not save the sidebars", { sub: e }); }
}

/** Move `id` on `side` to just before `before` (or the end), never above Your turn. */
function move(side, id, before) {
  const l = structuredClone(data.layout || DEFAULT), list = l[side].filter(x => x !== id);
  let at = before ? list.indexOf(before) : list.length;
  if (at < 0) at = list.length;
  if (side === "right") at = Math.max(at, 1);
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
    return prefs(wsw.dataset.wsw, { hidden: on });
  }
  const al = e.target.closest("[data-allow]");
  if (al) {
    al.disabled = true;
    try { await c.deskApi(`/api/widgets/${al.dataset.allow}/allow`, {}); await again(); }
    catch { al.disabled = false; c.toast("Allow works in the snyvi window", { sub: "A tab cannot let a command run" }); }
  }
}

/** A setting, Rerun my edits: saved as it changes. */
async function changed(e) {
  if (c.view() !== "sidebars") return;
  const t = e.target;
  if (t.dataset.rerun) {
    try { await c.deskApi(`/api/widgets/${t.dataset.rerun}/allow`, { allow: false, rerun_edits: t.checked }); }
    catch { t.checked = !t.checked; c.toast("Rerun my edits is set in the snyvi window"); }
    return;
  }
  if (t.dataset.set) {
    const f = (data.files || []).find(x => x.name === t.dataset.set);
    if (!f) return;
    const v = t.type === "checkbox" ? t.checked : t.type === "number" ? Number(t.value) : t.value;
    f.settings = { ...f.settings, [t.dataset.k]: v };
    prefs(f.name, { settings: f.settings }, false);
  }
}

async function prefs(name, body, redraw = true) {
  try {
    const r = await fetch(`/api/widgets/${name}/prefs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    if (redraw) await again();
  } catch (e) { c.toast("Could not save that", { sub: e }); }
}

/** Read everything again: after an Allow, a switch. */
async function again() {
  try { data = await (await fetch("/api/widgets")).json(); } catch { return; }
  if (c.view() === "sidebars") draw();
}

/** Alt+↑ ↓ moves the row with the focus; a row is not a field, so the
 *  letter keys and the rest pass. */
function keys(e) {
  if (c.view() !== "sidebars") return;
  const row = e.target.closest?.(".sb-row[data-sb]");
  if (!row || !e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
  e.preventDefault(); e.stopPropagation();
  const [side, id] = row.dataset.sb.split(":");
  if (id === "turn") return;
  const list = (data.layout || DEFAULT)[side], i = list.indexOf(id), j = i + (e.key === "ArrowUp" ? -1 : 1);
  if (j < (side === "right" ? 1 : 0) || j >= list.length) return;
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
