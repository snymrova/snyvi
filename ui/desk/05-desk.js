/* ui/desk/05-desk.js: a part of desk.js, one module. build.rs joins ui/desk/*.js in name
 * order (src/strip.rs `source`); SNYVI_UI_DIR serves the same join. */
// ---------- the desk ----------

function current() {
  return ctx.desks && ctx.desks.desks.find(d => d.id === deskId);
}

/** How many panes the grid has room for: four above 720px, two above
 *  560px, one below. The grid's own width, not the window's: a sidebar folded
 *  to its rail or a rail put away is room, and the window never said so.
 *  The numbers keep what the window's 1100px used to give with both panes
 *  open (a 1280px window's grid is about 780px, four panes), and a 600px
 *  window one. Four panes at phone width are four unreadable panes. */
const room = () => { const w = ctx.docEl.querySelector(".dk-grid")?.clientWidth || innerWidth; return w > 720 ? 4 : w > 560 ? 2 : 1; };
/** Lays the panes out again when the grid's width changes, for whatever reason. */
let gridWatch = null;

/** Why there is no new pane, when there is not: the desk holds four, and
 *  that is the only cap. The width is not one -- panes it has no room for are
 *  tabs. Empty while one can be made. Both places that offer a pane -- the +
 *  in the head and the row in the rail -- ask this, so they never disagree. */
function noNew(d) {
  const j = ctx.desks;
  if (d.kind === "studio") return d.panes.length ? "A studio desk holds one panel" : "";
  return d.panes.length >= j.per_desk ? `A desk holds ${j.per_desk}` : "";
}
/** How many panels a desk holds: four, or a studio desk's one. */
const capOf = d => d.kind === "studio" ? 1 : ctx.desks.per_desk;

function layout() {
  const d = current(), grid = ctx.docEl.querySelector(".dk-grid");
  if (!d || !grid) return;
  const all = d.panes.map(p => views.get(p.id)).filter(Boolean);
  // The focused pane is always shown; the rest in slot order, while there is room.
  const n = full ? 1 : room(), f = all.find(v => v.id === focused);
  const shown = all.length <= n ? all : [f, ...all.filter(v => v !== f)].filter(Boolean).slice(0, n).sort((a, b) => a.pane.slot - b.pane.slot);
  if (full && all.length > 1) grid.dataset.zoom = "1"; else delete grid.dataset.zoom;
  // The window's too: the sidebar and the rail go while the desk is the page.
  if (full && all.length && reading == null) ctx.root.dataset.full = "1"; else delete ctx.root.dataset.full;
  for (const v of all) { const b = v.el.querySelector(".pn-full"); if (b && b.dataset.full !== String(full)) { b.dataset.full = full; b.innerHTML = ctx.glyph(full ? "unfill" : "fill"); b.dataset.tip = full ? "Back to the grid" : "Full view"; b.ariaLabel = b.dataset.tip; } }
  const cols = shown.length > 1 ? 2 : 1, rows = shown.length > 2 ? 2 : 1;
  grid.style.gridTemplateColumns = cols === 2 ? `${d.col}fr ${1 - d.col}fr` : "1fr";
  grid.style.gridTemplateRows = rows === 2 ? `${d.row}fr ${1 - d.row}fr` : "1fr";
  grid.style.setProperty("--col", d.col);
  grid.style.setProperty("--row", d.row);
  grid.dataset.cols = cols; grid.dataset.rows = rows;
  // Slots, not splits: an odd pane out spans the row rather than leave a hole.
  shown.forEach((v, i) => { v.el.style.gridColumn = shown.length % 2 && i === shown.length - 1 && cols === 2 ? "1 / -1" : ""; });
  // Moving an element blurs it, and this runs on every resize of the window:
  // the panes are put back only when the set changes, and the reader's focus
  // with them, or their next key would land on the reading view.
  const keep = [...grid.querySelectorAll(":scope > .dk-div")], want = [...shown.map(v => v.el), ...keep];
  if (want.length !== grid.children.length || want.some((el, i) => grid.children[i] !== el)) {
    // Every pane that is not where it was is drawn whole below: one put back
    // in the page, or one a move put in another place.
    const had = grid.contains(document.activeElement) ? document.activeElement : null, back = shown.filter((v, i) => grid.children[i] !== v.el);
    grid.replaceChildren(...want);
    if (had && had.isConnected) had.focus({ preventScroll: true });
    // A canvas put back in the page -- after a document read over the desk,
    // a pane the grid had no room for, a pane moved -- keeps its pixels, but WebKit's
    // GPU canvas shows none of them until something draws on it: the pane
    // stood empty until a scroll. Drawn whole, it is shown whole.
    for (const v of back) v.behind = true;
  }
  for (const v of shown) catchUp(v);
  pace();
  if (!all.length) grid.innerHTML = d.kind === "studio"
    ? `<p class="dk-none">Claude isn't running here. <button type="button" data-a="new">Start Claude</button></p>`
    : `<p class="dk-none">No panels on this desk. <button type="button" data-a="new">New panel</button></p>`;
  tabs(d, all, shown);
  leftOffSlot(d);
  keysSlot(d);
}

/* Where the work on this desk was left: one quiet line in the head, in a slot
 * that is there whether or not anything was said, so a line arriving, going
 * or being rewritten moves nothing. An agent says it with `leave_off`; the
 * reader rewrites it in place. Emptied, it is cleared, and the slot holds the
 * Undo for BACK_MS, as a removed note's row does. */
let leftField = null, leftGone = null, leftTimer = 0;
function leftOffSlot(d) {
  const head = ctx.docEl.querySelector(".dk-head"), { esc } = ctx;
  if (!head) return;
  let el = head.querySelector(".dk-left");
  if (!el) { el = Object.assign(document.createElement("span"), { className: "dk-left" }); head.querySelector(".dk-keys, .dk-tabs").before(el); }
  if (leftField === d.id && el.querySelector("input")) return;
  const l = d.left_off;
  if (leftGone && leftGone.desk === d.id) {
    el.innerHTML = `<span class="dk-left-b" role="status"><span class="dk-left-k">Left off</span> cleared</span><button type="button" class="dk-undo" data-a="left-back">Undo</button>`;
    return;
  }
  el.innerHTML = l
    ? `<button type="button" class="dk-left-b" data-a="left-edit" data-tip="${esc(l.text)}" data-tip-sub="${esc(l.by || "you")} · ${ctx.relShort(l.at)} · click to rewrite" data-tip-overflow><span class="dk-left-k">Left off</span> ${esc(l.text)}</button>`
    : `<button type="button" class="dk-left-b none" data-a="left-edit" data-tip="Where did you leave off?" data-tip-sub="one line, for the next session on this desk">Left off…</button>`;
}

/* The desk's keys: a slot in the head beside Left off, there whether or not
 * the desk has any, so nothing moves when one arrives. Names only: a value
 * goes from the paste to the daemon and from there to the keychain (or the
 * 0600 file, see src/secrets.rs), and the window never sees it again. The
 * sheet under the slot lists them and takes a new one; a ✕ holds its row for
 * BACK_MS with Undo, as a note's does, and then the value is gone -- the one
 * removal here that is not kept, because a kept secret is still a secret. */
const PROVIDERS = [
  ["OpenRouter", "OPENROUTER_API_KEY"], ["ElevenLabs", "ELEVENLABS_API_KEY"], ["GitHub", "GH_TOKEN"],
  ["AWS", "AWS_ACCESS_KEY_ID"], ["AWS secret", "AWS_SECRET_ACCESS_KEY"], ["OpenAI", "OPENAI_API_KEY"],
  ["Anthropic", "ANTHROPIC_API_KEY"], ["Hugging Face", "HF_TOKEN"], ["Replicate", "REPLICATE_API_TOKEN"], ["Stripe", "STRIPE_SECRET_KEY"],
];
let keysOpen = null, keysGone = null;

function keysSlot(d) {
  const head = ctx.docEl.querySelector(".dk-head"), { esc } = ctx;
  if (!head) return;
  let el = head.querySelector(".dk-keys");
  if (!el) { el = Object.assign(document.createElement("span"), { className: "dk-keys" }); head.querySelector(".dk-tabs").before(el); }
  // The button is redrawn in place; the sheet beside it is left alone, with
  // whatever is typed in it.
  let b = el.querySelector(".dk-keys-b");
  if (!b) { b = Object.assign(document.createElement("button"), { type: "button", className: "dk-keys-b" }); b.dataset.a = "keys"; b.setAttribute("aria-haspopup", "dialog"); el.prepend(b); }
  const ks = d.keys || [], n = ks.length, open = keysOpen === d.id;
  b.classList.toggle("none", !n);
  b.setAttribute("aria-expanded", String(open));
  b.textContent = n ? `${n} key${n === 1 ? "" : "s"}` : "Keys";
  b.dataset.tip = n ? ks.map(k => k.name).join(", ") : "Keys for this desk's panels";
  b.dataset.tipSub = n ? "in the environment of this desk's panels · click to see or add" : "an API key or a token, kept where only you can read it and put in the environment of every panel here";
  if (open) keysRows(d);
}

const provider = name => (PROVIDERS.find(([, n]) => n === name) || [""])[0];

function keysSheet(d) {
  if (keysOpen === d.id) { keysClose(true); return; }
  keysClose();
  const slot = ctx.docEl.querySelector(".dk-keys");
  if (!slot) return;
  keysOpen = d.id;
  const sheet = Object.assign(document.createElement("div"), { className: "dk-keys-sheet" });
  sheet.setAttribute("role", "dialog"); sheet.setAttribute("aria-label", "Keys for this desk's panels");
  sheet.innerHTML = `<div class="dk-keys-h">Keys for this desk's panels</div><div class="dk-keys-rows"></div>
    <form class="dk-keys-add" autocomplete="off">
      <div class="dk-keys-t">Add a key</div>
      <label><span>Name</span><input name="name" list="dk-key-names" required spellcheck="false" placeholder="OPENROUTER_API_KEY" pattern="[A-Z][A-Z0-9_]*" maxlength="64" title="capitals, digits and underscores"></label>
      <datalist id="dk-key-names">${PROVIDERS.map(([p, n]) => `<option value="${n}">${p}</option>`).join("")}</datalist>
      <label><span>Value</span><input name="value" type="password" autocomplete="new-password" required placeholder="paste it here"></label>
      <div class="dk-keys-w"><span>Where</span><label><input type="radio" name="every" value="" checked> this desk</label><label><input type="radio" name="every" value="1"> every desk</label><button type="submit">Keep</button></div>
      <p class="dk-keys-say" role="status">Kept where only you can read it and never shown again. Panels on this desk can use it now, as $(snyvi key NAME).</p>
    </form>`;
  sheet.querySelector("form").addEventListener("submit", e => keyAdd(d, e));
  // What is typed is the sheet's: the page's own keys stay out of it.
  sheet.addEventListener("keydown", e => { if (e.key !== "Escape") e.stopPropagation(); });
  slot.append(sheet);
  keysRows(d);
  keysSlot(d);
  document.addEventListener("pointerdown", keysOutside, true);
  document.addEventListener("keydown", keysKey, true);
  sheet.querySelector("input[name=name]").focus();
}

function keysRows(d) {
  const rows = ctx.docEl.querySelector(".dk-keys-sheet .dk-keys-rows");
  if (!rows) return;
  const { esc } = ctx, ks = d.keys || [];
  const gone = k => keysGone && keysGone.desk === d.id && keysGone.name === k.name && keysGone.every === !k.desk_id;
  rows.innerHTML = ks.length ? ks.map(k => gone(k)
    ? `<div class="dk-key" role="status"><span class="dk-key-n">${esc(k.name)}</span><span class="dk-key-m">Removed · its value is gone in a moment</span><button type="button" class="dk-undo" data-a="key-back">Undo</button></div>`
    : `<div class="dk-key"><span class="dk-key-n">${esc(k.name)}</span><span class="dk-key-m">${k.provider ? esc(k.provider) + " · " : ""}${k.desk_id ? "this desk" : "every desk"} · ${k.used_at ? "a panel started with it " + ctx.relShort(k.used_at) : "no panel has started with it yet"}</span><button type="button" class="icon dk-key-x" data-a="key-x" data-n="${esc(k.name)}" data-every="${k.desk_id ? "" : "1"}" data-tip="Take it off ${k.desk_id ? "this desk" : "every desk"}" aria-label="Remove ${esc(k.name)}">${ctx.glyph("x")}</button></div>`).join("")
    : `<p class="dk-keys-none">None yet. A key here goes into the environment of every panel on this desk, and Claude is told its name, never its value.</p>`;
}

function keysOutside(e) { if (!e.target.closest(".dk-keys")) keysClose(); }
function keysKey(e) { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); keysClose(true); } }
function keysClose(back = false) {
  if (keysOpen == null) return;
  keysOpen = null;
  document.removeEventListener("pointerdown", keysOutside, true);
  document.removeEventListener("keydown", keysKey, true);
  const sheet = ctx.docEl.querySelector(".dk-keys-sheet"); if (sheet) sheet.remove();
  const b = ctx.docEl.querySelector(".dk-keys-b");
  if (b) { b.setAttribute("aria-expanded", "false"); if (back) b.focus(); }
}

async function keyAdd(d, e) {
  e.preventDefault();
  const f = e.target, name = f.name.value.trim(), value = f.value.value, every = f.every.value === "1";
  const say = f.querySelector(".dk-keys-say"), btn = f.querySelector("button[type=submit]");
  if (!name || !value) return;
  btn.disabled = true;
  try {
    const j = await ctx.api(`/api/desks/${d.id}/keys`, { name, value, every, provider: provider(name) });
    f.value.value = ""; f.name.value = "";
    say.textContent = j.kept === "file"
      ? `${name} is kept in a file only you can read. Panels on this desk can use it now, as $(snyvi key ${name}).`
      : `${name} is kept in your keychain. Panels on this desk can use it now, as $(snyvi key ${name}).`;
    f.name.focus();
  } catch (err) { say.textContent = `Could not keep it · ${ctx.sayErr(err).why}`; }
  btn.disabled = false;
}

function keyRemove(d, name, every) {
  // Only the newest offer stands: two rows both saying Undo cannot both mean
  // the last thing that happened.
  if (keysGone) { clearTimeout(keysGone.timer); keyGo(keysGone); }
  keysGone = { desk: d.id, name, every, timer: 0 };
  keysGone.timer = setTimeout(() => { const g = keysGone; keysGone = null; keyGo(g); }, BACK_MS);
  keysRows(d);
}
async function keyGo(g) {
  try { await ctx.api(`/api/desks/${g.desk}/keys/${encodeURIComponent(g.name)}/remove`, { every: g.every }); }
  catch (e) { ctx.toast(`Could not remove ${g.name}`, e); }
  const d = current(); if (d && keysOpen === d.id) keysRows(d);
}
function keyBack(d) { if (!keysGone) return; clearTimeout(keysGone.timer); keysGone = null; keysRows(d); }

/** The line, as a field in its own place. Enter or leaving it keeps what was
 *  typed; Escape leaves it as it was. */
function leftOffEdit(d) {
  const el = ctx.docEl.querySelector(".dk-head .dk-left");
  if (!el) return;
  leftField = d.id;
  const was = d.left_off ? d.left_off.text : "";
  el.innerHTML = `<input class="dk-left-in" maxlength="200" spellcheck="false" aria-label="Where the work on this desk was left" placeholder="If the tests pass, ship it">`;
  const inp = el.querySelector("input");
  inp.value = was;
  let done = false;
  const end = async keep => {
    if (done) return;
    done = true; leftField = null;
    const text = inp.value.trim();
    if (!keep || text === was) { leftOffSlot(current() || d); return; }
    let j;
    try { j = await ctx.api(`/api/desks/${d.id}/leftoff`, { text }); }
    catch (e) { ctx.toast("Could not save where you left off", e); leftOffSlot(current() || d); return; }
    if (!text && j.was) {
      clearTimeout(leftTimer);
      leftGone = { desk: d.id, was: j.was };
      leftTimer = setTimeout(() => { leftGone = null; const c = current(); if (c) leftOffSlot(c); }, BACK_MS);
    }
    await ctx.refresh();
  };
  inp.addEventListener("keydown", e => {
    // The desk gives every other key to the shell in the focused panel.
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); end(true); }
    else if (e.key === "Escape") { e.preventDefault(); end(false); }
  });
  inp.addEventListener("blur", () => end(true));
  inp.focus();
  inp.select();
}

/** Undo a clear: the line back as it was, its time and its author with it. */
async function leftOffBack(d) {
  const g = leftGone;
  if (!g || g.desk !== d.id) return;
  clearTimeout(leftTimer);
  leftGone = null;
  try { await ctx.api(`/api/desks/${d.id}/leftoff`, g.was); }
  catch (e) { leftGone = g; ctx.toast("Could not bring it back", e); }
  await ctx.refresh();
}

function tabs(d, all, shown) {
  const t = ctx.docEl.querySelector(".dk-tabs");
  if (!t) return;
  // A pane out of sight that needs the reader says so on its tab, with the
  // rail's mark: full view never hides a pane that is waiting.
  const need = v => v.status.blocked || v.status.agent === "needs_you";
  // A number is the panel's slot and its key, so a tab says which, and why
  // it is a tab: full view, or a window with no room for it.
  const tip = v => shown.includes(v) ? `data-tip="Panel ${v.pane.slot}" data-key="ctrl+alt+${v.pane.slot}"`
    : `data-tip="${need(v) ? "Waiting on you" : `Panel ${v.pane.slot}`}" data-tip-sub="${full ? "full view shows one" : "not enough room"}" data-key="ctrl+alt+${v.pane.slot}"`;
  t.innerHTML = all.length > shown.length ? all.map(v => `<button type="button" data-focus="${v.id}" class="${shown.includes(v) ? "on" : ""}${!shown.includes(v) && need(v) ? " blk" : ""}" ${tip(v)}>[${v.pane.slot}]${!shown.includes(v) && need(v) ? "!" : ""}</button>`).join("") : "";
  // The + goes quiet when there is no pane to add, and says why under the
  // cursor. At the desk's own cap the count sits beside it -- 4/4 -- which
  // is what ties the greyed + to the panes on the desk.
  const plus = ctx.docEl.querySelector(".dk-head .icon[data-a=\"new\"]"), why = noNew(d), j = ctx.desks;
  if (plus) {
    // Quiet rather than disabled, so the keyboard still reaches it and can
    // hear why: the reason is a hidden line it points to (A4 draws it).
    plus.classList.toggle("dim", !!why);
    why ? plus.setAttribute("aria-disabled", "true") : plus.removeAttribute("aria-disabled");
    plus.dataset.tip = "New panel"; why ? (plus.dataset.tipSub = why) : delete plus.dataset.tipSub;
    let say = plus.nextElementSibling?.id === "dk-plus-why" ? plus.nextElementSibling : null;
    if (!say) { say = Object.assign(document.createElement("span"), { id: "dk-plus-why", className: "vh" }); plus.after(say); plus.setAttribute("aria-describedby", say.id); }
    say.textContent = why || "";
    let n = plus.previousElementSibling?.classList.contains("dk-cap") ? plus.previousElementSibling : null;
    const atCap = d.panes.length >= j.per_desk;
    if (atCap && !n) { n = document.createElement("span"); n.className = "dk-cap"; plus.before(n); }
    if (n) { if (atCap) { n.textContent = `${d.panes.length}/${j.per_desk}`; n.dataset.tip = why; } else n.remove(); }
  }
}

function draw() {
  const d = current();
  const { docEl } = ctx;
  if (!d) {
    docEl.innerHTML = deskId == null ? list() : `<div class="inbox-head"><h1>No such desk</h1><p>It was closed, here or in another window.</p></div>` + list();
    ctx.tocEl.innerHTML = ctx.metaEl.innerHTML = "";
    ctx.rail.classList.add("empty");
    document.title = "Desks · snyvi";
    return;
  }
  document.title = `${d.name} · desk`;
  // A studio desk is its viewer over its one panel, with the line between
  // them to drag; it has no + (one panel is the whole of its grid). Its
  // folders are in the rail, and where its folder is in its ⋯ menu.
  const studio = d.kind === "studio";
  docEl.innerHTML = `<div class="dk${studio ? " dk-studio" : ""}"><header class="dk-head" data-tauri-drag-region="deep"><b class="dk-name"></b><span class="dk-root"></span>` +
    `<span class="dk-tabs"></span>` +
    (studio ? "" : `<button type="button" class="icon" data-a="new" data-tip="New panel" data-key="ctrl+alt+n" aria-label="New panel">${head("plus")}</button>`) +
    `<button type="button" class="icon dk-menu" data-desk-menu="${d.id}" data-tip="What this desk can do" aria-label="Desk actions" aria-haspopup="menu">⋯</button></header>` +
    (studio ? `<div class="st-frame"><div class="st-host" data-part="studio"></div><div class="dk-div st-div" role="separator" aria-orientation="horizontal" tabindex="0" data-tip="Drag to resize"></div><div class="dk-grid" data-part="studio.agent"></div></div>`
      : `<div class="dk-grid"><div class="dk-div dk-v" role="separator" aria-orientation="vertical" tabindex="0" data-tip="Drag to resize"></div><div class="dk-div dk-h" role="separator" aria-orientation="horizontal" tabindex="0" data-tip="Drag to resize"></div></div>`) + `<div class="dk-live vh" aria-live="polite"></div></div>`;
  docEl.querySelector(".dk-name").textContent = d.name;
  docEl.querySelector(".dk-root").textContent = tilde(d.root);
  if (studio) studioFrame(d);
  gridWatch?.disconnect();
  let seen = 0;
  gridWatch = new ResizeObserver(([en]) => { const w = Math.round(en.contentRect.width); if (w !== seen) { seen = w; if (current()) layout(); } });
  gridWatch.observe(docEl.querySelector(".dk-grid"));
  sync(d);
  dividers();
  rail();
}

// ---------- a studio desk ----------

/** The studio's module (studio.js), once a studio desk has been drawn. */
let st = null;

/** A studio desk's frame: the studio drawn in its host, the line between it
 *  and the panel dragged (the desk's `row`, kept as a terminal desk's
 *  divider is), and the rail told when the studio is in. */
function studioFrame(d) {
  const frame = ctx.docEl.querySelector(".st-frame");
  const rows = f => { frame.style.setProperty("--st-a", `${Math.round(f * 1000)}fr`); frame.style.setProperty("--st-b", `${Math.round((1 - f) * 1000)}fr`); };
  rows(d.row);
  const div = frame.querySelector(".st-div");
  const set = f => { const c = current(); if (!c) return; c.row = Math.max(0.2, Math.min(0.9, f)); rows(c.row); };
  const save = () => { const c = current(); if (c) ctx.api(`/api/desks/${c.id}/layout`, { col: c.col, row: c.row }).catch(() => {}); };
  div.addEventListener("pointerdown", e => {
    if (e.button !== 0) return;
    div.setPointerCapture(e.pointerId);
    ctx.root.dataset.resizing = "1";
    const r = frame.getBoundingClientRect();
    const move = ev => set((ev.clientY - r.top) / r.height);
    const up = () => { delete ctx.root.dataset.resizing; div.removeEventListener("pointermove", move); div.removeEventListener("pointerup", up); save(); };
    div.addEventListener("pointermove", move);
    div.addEventListener("pointerup", up);
    e.preventDefault();
  });
  div.addEventListener("dblclick", () => { set(0.62); save(); });
  div.addEventListener("keydown", e => {
    const c = current(), k = { ArrowUp: -0.03, ArrowDown: 0.03 }[e.key];
    if (!c || k == null) return;
    set(c.row + (e.shiftKey ? k * 3 : k)); save();
    e.preventDefault(); e.stopPropagation();
  });
  studioDrop(frame.querySelector(".dk-grid"));
  if (!ctx.studio) return;
  const host = frame.querySelector(".st-host");
  ctx.studio().then(m => {
    st = m;
    if (!host.isConnected || current()?.id !== d.id) return;
    m.mount(host, studioCtx());
  }, e => { host.innerHTML = `<p class="dk-none">Could not load the studio · ${ctx.esc(ctx.sayErr(e).why)} <button type="button" data-a="desk">Retry</button></p>`; });
}

/** What the studio is handed: the page's helpers, and a way back into the
 *  desk's one panel. */
function studioCtx() {
  return {
    desk: () => current(), api: ctx.api, esc: ctx.esc, glyph: ctx.glyph, plural: ctx.plural,
    // The page's toast takes its options as one object; the desk's, in order.
    toast: (t, o = {}) => ctx.toast(t, o.sub, o.go, o.action),
    relShort: ctx.relShort, fmt: ctx.fmt, sayErr: ctx.sayErr, reveal: ctx.reveal, menu: ctx.menu, keyHint: ctx.keyHint,
    home: () => ctx.desks && ctx.desks.home,
    refresh: () => ctx.refresh(),
    // The desk's Keys sheet: the provider keys its Claude starts with.
    keys: () => { const d = current(); if (d) keysSheet(d); },
    // The studio's rows in the rail (`studioTop`) changed: the rail again.
    rail: () => { if (current()?.kind === "studio") rail(); },
    panel: () => { const d = current(); return d && d.panes[0] ? views.get(d.panes[0].id) : null; },
    focusPanel: () => { const d = current(), v = d && d.panes[0] && views.get(d.panes[0].id); if (v) { focused = v.id; v.body.focus(); } },
    // Text into the panel as a paste, for the reader to finish and send:
    // false when no program is running there to take it.
    type: text => { const d = current(), v = d && d.panes[0] && views.get(d.panes[0].id); if (!v || !v.status.running) return false; v.typed = Date.now(); input(v, bracket(v, text)); v.body.focus(); return true; },
  };
}

/** A tile dropped on the studio's panel goes in as its path, a paste: the
 *  same as Tell Claude…. Only a drag from the viewer, which carries the
 *  studio's own type; anything else is the window's. */
function studioDrop(grid) {
  const ours = e => e.dataTransfer && [...e.dataTransfer.types].includes("application/x-snyvi-board");
  grid.addEventListener("dragover", e => { if (ours(e)) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; grid.classList.add("st-drop"); } });
  grid.addEventListener("dragleave", e => { if (!grid.contains(e.relatedTarget)) grid.classList.remove("st-drop"); });
  grid.addEventListener("drop", e => {
    grid.classList.remove("st-drop");
    if (!ours(e)) return;
    e.preventDefault(); e.stopPropagation();
    const t = e.dataTransfer.getData("text/plain");
    if (t && !studioCtx().type(t + " ")) ctx.toast("The panel is not running", "Start it, then drop it again");
  });
}

/** Views for the desk's panes: the ones already here kept, scrollback and
 *  all, new ones made, gone ones dropped. Then the socket is told. */
function sync(d) {
  const ids = new Set(d.panes.map(p => p.id));
  for (const v of [...views.values()]) if (!ids.has(v.id)) dropView(v);
  for (const p of d.panes) {
    const v = views.get(p.id);
    if (v) { v.pane = p; if (p.status) v.status = { ...v.status, ...p.status }; header(v); }
    else views.set(p.id, makeView(p));
  }
  // The daemon's word on full view: this window's own changes are in it
  // already, and another window's, or a close that moved the slots, arrive here.
  const fp = d.full_slot && d.panes.find(p => p.slot === d.full_slot);
  full = !!fp;
  if (fp) focused = fp.id;
  if (!views.has(focused)) focused = d.panes[0] ? d.panes[0].id : null;
  layout();
  watch();
}

function list() {
  const ds = ctx.desks ? ctx.desks.desks : [];
  return `<div class="inbox-head"><h1>Desks</h1><p>A desk is one project: its folder, and up to four terminal panels side by side in it. A new one asks where: a project snyvi knows, another folder, or a shell in your home folder. Or it is the studio: Claude making pictures, video and sound in one folder.</p><p><button type="button" class="dk-make" data-a="make">+ New desk</button></p></div>` +
    (ds.length ? `<ul class="inbox">${ds.map(d => `<li><a href="/desk/${d.id}" data-desk="${d.id}"><span class="title">${ctx.esc(d.name)}</span><span class="time">${ctx.plural(d.panes.length, "panel")}</span><span class="sub">${ctx.esc(tilde(d.root))}</span></a></li>`).join("")}</ul>` : "");
}

// ---------- links ----------

/** A URL in what a panel shows, at a character: the http or https link that
 *  covers `i` in `text`, with the punctuation a sentence puts after a link
 *  trimmed off -- and a closing bracket kept when the link opened one, as a
 *  Wikipedia link does. Nothing else is a link: what a program prints is not
 *  trusted, and `file:`, `javascript:` and every other scheme stay text. */
function urlAt(text, i) {
  const re = /https?:\/\/[^\s<>"'`]+/g;
  for (let m; (m = re.exec(text));) {
    let u = m[0];
    for (;;) {
      const last = u[u.length - 1];
      if (/[.,;:!?'"]/.test(last)) u = u.slice(0, -1);
      else if (/[)\]}]/.test(last)) {
        const open = { ")": "(", "]": "[", "}": "{" }[last];
        if (u.split(open).length < u.split(last).length) u = u.slice(0, -1); else break;
      } else break;
    }
    if (i >= m.index && i < m.index + u.length) {
      try { const p = new URL(u); if (p.protocol === "http:" || p.protocol === "https:") return { url: u, from: m.index, to: m.index + u.length }; } catch {}
      return null;
    }
    if (m.index > i) return null;
  }
  return null;
}

/** The link under the pointer in a pane, with the rectangles it covers on
 *  screen. On the live grid it is read from the cells, which are never
 *  behind; a row that runs to the last column is read on into the next, so
 *  a link the terminal wrapped is one link. In the scrollback it is the
 *  line's text, joined over the lines the daemon marked as wrapped. */
function linkAt(v, e) {
  const r = v.scr.getBoundingClientRect();
  if (v.rows && e.clientY >= r.top && e.clientY < r.top + v.rows * LINE_PX) {
    const y = Math.floor((e.clientY - r.top) / LINE_PX), x = Math.floor((e.clientX - r.left) / cellW);
    if (x < 0 || x >= v.cols) return null;
    const full = row => row && row[v.cols - 1] && row[v.cols - 1][0] !== " ";
    let y0 = y, y1 = y;
    while (y0 > 0 && y - y0 < 4 && full(v.cells[y0 - 1])) y0--;
    while (y1 < v.rows - 1 && y1 - y < 4 && full(v.cells[y1])) y1++;
    // One string for the rows, and where each character's cell is.
    let text = "", at = -1;
    const cellOf = [];
    for (let yy = y0; yy <= y1; yy++) {
      v.cells[yy].forEach((c, xx) => {
        if (yy === y && xx === x) at = c ? text.length : text.length - 1;
        if (!c) return;
        cellOf.push([xx, yy, c[4] || 1]);
        text += c[0];
      });
    }
    const u = urlAt(text, at) || pathIn(text, at);
    if (!u) return null;
    const rects = [];
    for (let k = u.from; k < u.to; k++) {
      const [xx, yy, w] = cellOf[k], last = rects[rects.length - 1];
      if (last && last.y === yy) last.w = (xx + w) * cellW - last.x;
      else rects.push({ x: xx * cellW, y: yy, w: w * cellW });
    }
    return { url: u.url, path: u.path, rects: rects.map(q => ({ left: r.left + q.x, top: r.top + q.y * LINE_PX, width: q.w, height: LINE_PX })) };
  }
  const line = e.target.closest && e.target.closest(".pn-pg > div");
  const hit = line && document.caretRangeFromPoint && document.caretRangeFromPoint(e.clientX, e.clientY);
  if (!hit || !line.contains(hit.startContainer)) return null;
  const lines = [line];
  if (v.sb.contains(line)) {
    for (let p = rowBefore(line); p && p.dataset.w && lines.length < 5; p = rowBefore(p)) lines.unshift(p);
    for (let n = line; n.dataset.w && rowAfter(n) && lines.length < 5; n = rowAfter(n)) lines.push(rowAfter(n));
  }
  // The character under the pointer, counted from the first of the lines.
  let at = 0;
  for (const l of lines) {
    if (l !== line) { at += l.textContent.length; continue; }
    const w = document.createTreeWalker(l, NodeFilter.SHOW_TEXT);
    for (let n; (n = w.nextNode());) { if (n === hit.startContainer) { at += hit.startOffset; break; } at += n.length; }
    break;
  }
  const all = lines.map(l => l.textContent).join("");
  const u = urlAt(all, at) || pathIn(all, at);
  if (!u) return null;
  // Its rectangles, from a range over the same characters.
  const rects = [];
  let k = 0;
  for (const l of lines) {
    const w = document.createTreeWalker(l, NodeFilter.SHOW_TEXT);
    for (let n; (n = w.nextNode());) {
      const a = Math.max(u.from - k, 0), b = Math.min(u.to - k, n.length);
      if (a < b) { const rg = document.createRange(); rg.setStart(n, a); rg.setEnd(n, b); rects.push(...rg.getClientRects()); }
      k += n.length;
    }
  }
  return { url: u.url, path: u.path, rects };
}

/* A path in a panel is ui/paths.js's to find and to open (see `pathsUse` in
 * app.js), shared with the reader: fetched the first time Ctrl is held over a
 * panel, and until then only a URL is a link. */
let P = null, pLoading = false;
const pathIn = (text, at) => (P && P.pathAt(text, at)) || null;
const fromPane = v => ({ desk: current().id, pane: v.id });
/** Whether the daemon has said this path is there. Asked once per word while
 *  Ctrl is held; the answer, when it comes, redraws the underline if the
 *  pointer is still where it was. */
function found(v, path, e) {
  const j = P.known(fromPane(v), path);
  if (j && typeof j.then !== "function") return j;
  if (e && j !== null) P.check(fromPane(v), path).then(() => { if (v.at === e) hover(v, e); });
  return null;
}

/** The underline under a link while Ctrl is held: divs laid over the pane,
 *  never drawn into the canvas, so the paint budget does not see them. */
function hover(v, e) {
  if (e && !P && !pLoading && ctx.paths) {
    pLoading = true;
    ctx.paths().then(m => { P = m; if (v.at && v.at.ctrlKey) hover(v, v.at); }, () => { pLoading = false; });
  }
  let l = e && linkAt(v, e);
  if (l && l.path) { const j = found(v, l.path, e); l = j && { ...l, url: j.path }; }
  v.body.classList.toggle("pn-on-link", !!l);
  if (!l) { v.ul?.remove(); v.ul = null; return; }
  if (!v.ul) { v.ul = document.createElement("div"); v.ul.className = "pn-ul"; v.el.append(v.ul); }
  const o = v.el.getBoundingClientRect();
  v.ul.innerHTML = [...l.rects].map(q => `<i style="left:${q.left - o.left}px;top:${q.top - o.top + q.height - 2}px;width:${q.width}px"></i>`).join("");
  v.ul.title = l.url;
}

/** Out to the desktop's browser. In the window, a new window is handed to
 *  the desktop (`on_new_window`), as a link in a document is. */
function openLink(url) {
  window.open(url, "_blank", "noopener");
}

// ---------- moving a pane ----------

/** Move a pane to another position; the pane there takes its old one. The
 *  number goes with the position -- pane 2 is always the one ⌃⌥2 reaches --
 *  and the daemon moves what each pane sent with it, so "From desk [2]"
 *  still leads to the pane that sent it. Every window redraws from the
 *  daemon's word, this one too. */
async function moveTo(v, slot) {
  const d = current();
  if (!d || slot === v.pane.slot) return;
  try { await ctx.api(`/api/desks/${d.id}/move`, { from: v.pane.slot, to: slot }); }
  catch (e) { ctx.toast("Could not move the panel", e); }
}

/** A pane's head dragged onto another pane, or onto its tab, trades their
 *  places. Pointer events, as the dividers are: the window's own drop
 *  handler takes HTML drag and drop. A press that does not travel is a
 *  click, and focuses the pane as before. */
function drag(v, e) {
  if (e.button !== 0 || e.target.closest("button")) return;
  const x0 = e.clientX, y0 = e.clientY;
  let on = false, over = null;
  const target = ev => {
    const at = document.elementFromPoint(ev.clientX, ev.clientY);
    const t = at && (at.closest(".dk-grid > .pn") || at.closest(".dk-tabs [data-focus]"));
    const w = t && views.get(t.dataset.id || t.dataset.focus);
    return w && w !== v ? { w, el: t } : null;
  };
  const move = ev => {
    if (!on && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5) return;
    if (!on) { on = true; v.el.classList.add("pn-drag"); ctx.root.dataset.resizing = "1"; }
    const t = target(ev);
    if (over && (!t || t.el !== over)) over.classList.remove("pn-drop");
    over = t ? t.el : null;
    if (over) over.classList.add("pn-drop");
  };
  const up = ev => {
    removeEventListener("pointermove", move);
    removeEventListener("pointerup", up);
    removeEventListener("pointercancel", up);
    if (over) over.classList.remove("pn-drop");
    if (!on) return;
    v.el.classList.remove("pn-drag");
    delete ctx.root.dataset.resizing;
    v.dragged = true;
    const t = ev.type === "pointerup" && target(ev);
    if (t) moveTo(v, t.w.pane.slot);
  };
  // Followed on the window, not captured by the head: a captured pointer
  // makes the head the target of the click that follows a press, and the ⤢
  // in it would never be clicked.
  addEventListener("pointermove", move);
  addEventListener("pointerup", up);
  addEventListener("pointercancel", up);
}

/** ⌃⌥⇧ and an arrow: the focused pane trades places with the one beside it
 *  that way. Positions are 1 2 over 3 4; there is nothing to trade with past
 *  the edge, or where no pane is. */
const NEXT = { ArrowLeft: [0, 1, 0, 3], ArrowRight: [2, 0, 4, 0], ArrowUp: [0, 0, 1, 2], ArrowDown: [3, 4, 0, 0] };

// ---------- the dividers ----------

function dividers() {
  const grid = ctx.docEl.querySelector(".dk-grid");
  for (const div of grid.querySelectorAll(".dk-div")) {
    const vert = div.classList.contains("dk-v");
    const set = f => {
      const d = current();
      if (!d) return;
      f = Math.max(0.15, Math.min(0.85, f));
      if (vert) d.col = f; else d.row = f;
      layout();
    };
    const save = () => { const d = current(); if (d) ctx.api(`/api/desks/${d.id}/layout`, { col: d.col, row: d.row }).catch(() => {}); };
    div.addEventListener("pointerdown", e => {
      if (e.button !== 0) return;
      div.setPointerCapture(e.pointerId);
      ctx.root.dataset.resizing = "1";
      const r = grid.getBoundingClientRect();
      const move = ev => set(vert ? (ev.clientX - r.left) / r.width : (ev.clientY - r.top) / r.height);
      const up = () => { delete ctx.root.dataset.resizing; div.removeEventListener("pointermove", move); div.removeEventListener("pointerup", up); save(); };
      div.addEventListener("pointermove", move);
      div.addEventListener("pointerup", up);
      e.preventDefault();
    });
    div.addEventListener("dblclick", () => { set(0.5); save(); });
    div.addEventListener("keydown", e => {
      const d = current(), step = e.shiftKey ? 0.1 : 0.03, at = vert ? d.col : d.row;
      const k = vert ? { ArrowLeft: -step, ArrowRight: step } : { ArrowUp: -step, ArrowDown: step };
      if (k[e.key] == null) return;
      set(at + k[e.key]); save();
      e.preventDefault(); e.stopPropagation();
    });
  }
}
