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
  return d.panes.length >= j.per_desk ? `A desk holds ${j.per_desk}` : "";
}

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
    const had = grid.contains(document.activeElement) ? document.activeElement : null;
    grid.replaceChildren(...want);
    if (had && had.isConnected) had.focus({ preventScroll: true });
    // A canvas put back in the page -- after a document read over the desk,
    // a pane the grid had no room for, a pane moved -- keeps its pixels, but WebKit's
    // GPU canvas shows none of them until something draws on it: the pane
    // stood empty until a scroll. Drawn whole, it is shown whole. Every one,
    // not only those that moved: replaceChildren takes each pane out and
    // puts it back, and a close left the panes that kept their place blank
    // or showing a frame from long before (#155).
    for (const v of shown) v.behind = true;
  }
  for (const v of shown) catchUp(v);
  pace();
  if (!all.length) grid.innerHTML = `<p class="dk-none">No panels on this desk. <button type="button" data-a="new">New panel</button></p>`;
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
  if (!el) { el = Object.assign(document.createElement("span"), { className: "dk-left" }); head.querySelector(".dk-root").after(el); }
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

/* The desk's keys: a slot at the head's right, against + -- where it once
 * floated mid-head, Left off and the tabs splitting the space around it
 * (audit 2dbcf2e538) -- there whether or not the desk has any, so nothing
 * moves when one arrives. Names only: a value
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
/** The key just kept, { desk, name }: its row, when the desk's next read
 *  brings it, lights once, so Keep is seen to have done something. */
let keyNew = null;

function keysSlot(d) {
  const hd = ctx.docEl.querySelector(".dk-head");
  if (!hd) return;
  let el = hd.querySelector(".dk-keys");
  if (!el) { el = Object.assign(document.createElement("span"), { className: "dk-keys" }); hd.querySelector('[data-a="new"]').before(el); }
  // The button is redrawn in place; the sheet beside it is left alone, with
  // whatever is typed in it.
  let b = el.querySelector(".dk-keys-b");
  if (!b) { b = Object.assign(document.createElement("button"), { type: "button", className: "dk-keys-b" }); b.dataset.a = "keys"; b.setAttribute("aria-haspopup", "dialog"); el.prepend(b); }
  const ks = d.keys || [], n = ks.length, open = keysOpen === d.id;
  const acc = d.account ? (ctx.desks.accounts || []).find(a => a.id === d.account) : null;
  b.classList.toggle("none", !n && !acc);
  b.setAttribute("aria-expanded", String(open));
  // A key, always there, and how many beside it: a word that showed only
  // under the cursor was a control nobody knew was there. The account the
  // desk's Claude runs as leads it when it is not your login -- which one a
  // desk is on was a tip's alone, and the thing most asked (note #113, audit
  // 67d008cb6f). It changes when the reader picks, never on its own.
  // Said "as Trapti", quiet, so the desk's name stays the one bold word in
  // the head: in bold the account read as the desk's own title.
  const html = (acc ? `<span class="acc">as ${ctx.esc(acc.label)}</span>` : "") + head("key") + (n ? `<span class="n">${n}</span>` : "");
  if (b.$html !== html) { b.innerHTML = html; b.$html = html; }
  b.setAttribute("aria-label", [acc ? `Claude as ${acc.label}` : "", n ? `${n} key${n === 1 ? "" : "s"}` : "Keys"].filter(Boolean).join(", "));
  b.dataset.tip = (acc ? `Claude as ${acc.label}${n ? " · " : ""}` : "") + (n ? ks.map(k => k.name).join(", ") : acc ? "" : "What this desk's panels start with");
  b.dataset.tipSub = "the Claude account and the keys in this desk's panels · click to see or change";
  if (open) keysRows(d);
}

const provider = name => (PROVIDERS.find(([, n]) => n === name) || [""])[0];
/** When a panel last started with it, said as a sentence says it. */
const usedSay = t => t ? `used ${ctx.rel(t)}` : "not used yet";

/* The sheet is two short lists, what this desk's panels start with: the
 * Claude account and the keys. The accounts end in "+ Claude account", one
 * click to a browser's approval and no form (plan 7ead8a629d); the keys in
 * an "Add a key" row that unfolds its form in place. It opens on the
 * account picked, not in a form, since most opens are to look or switch.
 * Managing an account -- rename, renew, remove from every desk -- is behind
 * its row's ⋯, because it reaches past this desk (audit 67d008cb6f). */
function keysSheet(d) {
  if (keysOpen === d.id) { keysClose(true); return; }
  keysClose();
  const slot = ctx.docEl.querySelector(".dk-keys");
  if (!slot) return;
  keysOpen = d.id;
  const plus = ctx.glyph("plus");
  const sheet = Object.assign(document.createElement("div"), { className: "dk-keys-sheet" });
  sheet.setAttribute("role", "dialog"); sheet.setAttribute("aria-label", "What this desk's panels start with");
  sheet.innerHTML = `<div class="dk-ks-t">This desk's panels start with</div>
    <div class="dk-keys-h">Claude as</div><div class="dk-acc-rows" role="radiogroup" aria-label="Claude as"></div>
    <div class="dk-acc-add"><button type="button" class="dk-acc-new" data-a="acc-in" data-tip="Add a Claude account" data-tip-sub="approve in your browser · your settings and history stay shared">${plus}<span>Claude account</span></button>
      <div class="sg-row dk-acc-live" role="status" hidden></div>
      <form class="dk-keys-add dk-acc-paste" autocomplete="off" hidden><label><span>Token</span><input name="token" type="password" autocomplete="new-password" required spellcheck="false" placeholder="paste one from claude setup-token"><button type="submit">Add</button></label></form>
      <p class="dk-keys-say dk-acc-said" role="status"></p></div>
    <div class="dk-keys-h">Keys</div><div class="dk-keys-rows"></div>
    <details class="dk-add dk-key-more"><summary>${plus}<span>Add a key</span></summary><form class="dk-keys-add dk-key-add" autocomplete="off">
      <label><span>Name</span><input name="name" list="dk-key-names" required spellcheck="false" placeholder="e.g. OPENROUTER_API_KEY" pattern="[A-Z][A-Z0-9_]*" maxlength="64" title="capitals, digits and underscores"></label>
      <datalist id="dk-key-names">${PROVIDERS.map(([p, n]) => `<option value="${n}">${p}</option>`).join("")}</datalist>
      <label><span>Value</span><input name="value" type="password" autocomplete="new-password" required placeholder="paste it here"></label>
      <div class="dk-keys-w"><span>For</span><label><input type="radio" name="every" value="" checked> this desk</label><label><input type="radio" name="every" value="1"> every desk</label><button type="submit">Add</button></div>
      <p class="dk-keys-say" role="status">Only you can read it, and it is never shown again. Use it as $(snyvi key NAME).</p>
    </form></details>`;
  sheet.querySelector(".dk-key-add").addEventListener("submit", e => keyAdd(d, e));
  sheet.querySelector(".dk-acc-paste").addEventListener("submit", e => accAdd(d, e));
  sheet.querySelector(".dk-acc-rows").addEventListener("change", e => { if (e.target.name === "acc") accPick(d, +e.target.value); });
  sheet.querySelector(".dk-acc-rows").addEventListener("keydown", e => { if (e.target.matches(".dk-acc-name") && e.key === "Enter") { e.preventDefault(); accNamed(d, e.target); } });
  // An "Add …" row, opened, puts the hand in its first field; the other one
  // folds, so one form is open at a time.
  for (const x of sheet.querySelectorAll(".dk-add")) x.addEventListener("toggle", () => {
    if (!x.open) return;
    for (const y of sheet.querySelectorAll(".dk-add")) if (y !== x) y.open = false;
    [...x.querySelectorAll("input:not([type=radio])")].find(i => !i.hidden)?.focus();
  });
  // What is typed is the sheet's: the page's own keys stay out of it.
  sheet.addEventListener("keydown", e => { if (e.key !== "Escape") e.stopPropagation(); });
  slot.append(sheet);
  keysRows(d);
  keysSlot(d);
  signRow(sheet.querySelector(".dk-acc-live"), { label: "Paste a token instead", run: () => accPaste(true) });
  signFollow();
  document.addEventListener("pointerdown", keysOutside, true);
  document.addEventListener("keydown", keysKey, true);
  (sheet.querySelector(".dk-acc-rows input:checked") || sheet.querySelector(".dk-acc-rows input") || sheet.querySelector("summary")).focus();
}

function keysRows(d) {
  accRows(d);
  const rows = ctx.docEl.querySelector(".dk-keys-sheet .dk-keys-rows");
  if (!rows) return;
  const { esc } = ctx, ks = d.keys || [];
  const gone = k => keysGone && keysGone.desk === d.id && keysGone.name === k.name && keysGone.every === !k.desk_id;
  const lit = k => keyNew && keyNew.desk === d.id && keyNew.name === k.name ? " new" : "";
  // Drawn only when it changed: a row that lit up would light again at every
  // redraw of the desk.
  const html = ks.length ? ks.map(k => gone(k)
    ? `<div class="dk-key" role="status"><span class="dk-key-n">${esc(k.name)}</span><span class="dk-key-m">Removed · its value is gone in a moment</span><button type="button" class="dk-undo" data-a="key-back">Undo</button></div>`
    : `<div class="dk-key${lit(k)}"><span class="dk-key-n">${esc(k.name)}</span><span class="dk-key-m">${k.provider ? esc(k.provider) + " · " : ""}${k.desk_id ? "this desk" : "every desk"} · ${usedSay(k.used_at)}</span><button type="button" class="icon dk-key-x" data-a="key-x" data-n="${esc(k.name)}" data-every="${k.desk_id ? "" : "1"}" data-tip="Take it off ${k.desk_id ? "this desk" : "every desk"}" aria-label="Remove ${esc(k.name)}">${ctx.glyph("x")}</button></div>`).join("")
    : `<p class="dk-keys-none">None yet. A key goes into the environment of every panel here, and Claude is told its name, never its value.</p>`;
  if (rows.$html !== html) { rows.innerHTML = html; rows.$html = html; }
}

function keysOutside(e) { if (!e.target.closest(".dk-keys")) keysClose(); }
function keysKey(e) {
  if (e.key !== "Escape") return;
  e.preventDefault(); e.stopPropagation();
  // Esc in a name being changed leaves the name as it was, and the sheet open.
  if (accNaming != null && document.activeElement?.matches(".dk-acc-name")) { accNaming = null; const d = current(); if (d) keysRows(d); return; }
  keysClose(true);
}
function keysClose(back = false) {
  if (keysOpen == null) return;
  keysOpen = null; accRenew = null; accMore = null; accNaming = null;
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
    keyNew = { desk: d.id, name };
    setTimeout(() => { if (keyNew && keyNew.name === name) keyNew = null; }, 1600);
    const b = ctx.docEl.querySelector(".dk-keys-b");
    if (b) { b.classList.remove("kept"); void b.offsetWidth; b.classList.add("kept"); b.addEventListener("animationend", () => b.classList.remove("kept"), { once: true }); }
    say.textContent = `${name} is kept in ${j.kept === "file" ? "a file only you can read" : "your keychain"}. Panels here can use it now, as $(snyvi key ${name}).`;
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

/* ---------- Claude accounts (`crate::accounts`) ----------
 * In the keys sheet, since a token is kept as a key is: which account the
 * desk's panels start as, a token added or renewed, an account renamed or
 * taken away. An account is every desk's; which one a desk starts as is the
 * desk's. */
const YEAR = 365 * 86400, RENEW_SOON = 30 * 86400;
/** The account whose ⋯ is open, and the one whose name is being changed. */
let accGone = null, accRenew = null, accMore = null, accNaming = null;
const accDate = t => new Date(t * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short" });

function accRows(d) {
  const rows = ctx.docEl.querySelector(".dk-keys-sheet .dk-acc-rows");
  if (!rows) return;
  const { esc } = ctx, now = Date.now() / 1000;
  const all = accounts();
  const row = a => {
    // Running panels keep the token they started with: said, so a head
    // that reads "a removed account" later is no surprise.
    if (accGone && accGone.id === a.id) return `<div class="dk-key" role="status"><span class="dk-key-n">${esc(a.label)}</span><span class="dk-key-m">Removed from every desk · ${a.running ? `${a.running === 1 ? "1 panel still runs" : `${a.running} panels still run`} as it until restarted` : "its token is gone in a moment"}</span><button type="button" class="dk-undo" data-a="acc-back">Undo</button></div>`;
    const on = a.id === (d.account || 0), radio = `<input type="radio" name="acc" value="${a.id}"${on ? " checked" : ""}>`;
    if (accNaming === a.id) return `<div class="dk-key dk-acc">${radio}<input class="dk-acc-name" value="${esc(a.label)}" maxlength="40" spellcheck="false" aria-label="New name for ${esc(a.label)}"><span class="dk-key-m">Enter keeps it · Esc leaves it</span></div>`;
    const end = (a.created_at || 0) + YEAR, soon = a.id && end - now < RENEW_SOON;
    const broke = (ctx.desks.broken || {})[a.id];
    // One fact: a sign-in that stopped working, or the token's end when it
    // is near -- and then it is the row's button -- otherwise when a panel
    // last started as it.
    const meta = broke && !a.id ? `<span class="dk-key-m"><b>Sign-in stopped</b> · run <code>/login</code> in a panel</span>`
      : broke ? `<button type="button" class="dk-acc-due" data-a="acc-renew" data-n="${a.id}" data-tip="Renew ${esc(a.label)}" data-tip-sub="its sign-in no longer works; approve it again in your browser">Sign-in stopped · Renew</button>`
      : !a.id ? `<span class="dk-key-m">Claude's own <code>/login</code></span>`
      : soon ? `<button type="button" class="dk-acc-due" data-a="acc-renew" data-n="${a.id}" data-tip="Renew ${esc(a.label)}" data-tip-sub="its token ends ${accDate(end)}; approve it again in your browser">Renew by ${accDate(end)}</button>`
      : `<span class="dk-key-m">${usedSay(a.used_at)}</span>`;
    const more = accMore === a.id;
    // Its ⋯ puts what reaches past this desk in the row's own place: the
    // fact steps aside, the row keeps its height.
    const acts = `<span class="dk-acc-acts"><button type="button" data-a="acc-name" data-n="${a.id}">Rename</button><button type="button" data-a="acc-renew" data-n="${a.id}">Renew</button><button type="button" class="danger" data-a="acc-x" data-n="${a.id}" data-tip="Remove ${esc(a.label)}" data-tip-sub="from every desk · their panels go back to your login">Remove from every desk</button></span>`;
    return `<div class="dk-key dk-acc${on ? " on" : ""}"><label>${radio}<span class="dk-key-n">${a.id ? esc(a.label) : "Your login"}</span></label>${more ? acts : meta}` +
      (a.id ? `<button type="button" class="icon dk-acc-dots" data-a="acc-more" data-n="${a.id}" aria-expanded="${more}" data-tip="${more ? "Done" : "Rename, renew or remove"}" aria-label="${more ? "Close" : "More for"} ${esc(a.label)}">${ctx.glyph(more ? "x" : "more")}</button>` : "") + `</div>`;
  };
  // Claude Code ranks these over an account's token (`accounts::OUTRANKS`).
  const over = d.account ? (d.keys || []).find(k => k.name === "ANTHROPIC_API_KEY" || k.name === "ANTHROPIC_AUTH_TOKEN") : null;
  const html = all.map(row).join("") + (over ? `<p class="dk-keys-say"><b>${esc(over.name)}</b> is a key here, and Claude Code uses it over the account picked.</p>` : "");
  if (rows.$html !== html) {
    rows.innerHTML = html; rows.$html = html;
    const nm = rows.querySelector(".dk-acc-name"); if (nm) { nm.focus(); nm.select(); }
  }
}
/** A name changed in its row: Enter keeps it. */
async function accNamed(d, input) {
  const id = accNaming, label = input.value.trim();
  if (id == null || !label) return;
  try { await ctx.api(`/api/accounts/${id}/rename`, { label }); accNaming = null; accMore = null; await ctx.refresh(); }
  catch (e) { ctx.toast("Could not rename the account", e); return; }
  keysRows(d);
  ctx.docEl.querySelector(`.dk-acc-rows input[value="${id}"]`)?.focus();
}

/* "+ Claude account", a Renew: one click to the browser's approval
 * (`signIn`, 12-signin.js), its progress in the sheet's own row, and what
 * came of it said under it. A sign-in that cannot work offers the paste. */
async function accSignIn(d, renew = null) {
  accRenew = renew; accMore = null; accPaste(false); accSaid("");
  if (renew) keysRows(d);
  try {
    const id = await signIn(renew ? { renew } : {});
    const a = (ctx.desks.accounts || []).find(x => x.id === id);
    const name = a ? a.label : "The account";
    accSaid(renew ? `${name} is renewed. Panels start with the new token from their next start.` : `${name} is added · pick it above. Rename it from its ⋯.`);
    accRenew = null;
  } catch {}
  const now = current(); if (now && keysOpen === now.id) keysRows(now);
}
/** The line under the account rows: what the last add or renew came to. */
function accSaid(text) { const p = ctx.docEl.querySelector(".dk-acc-said"); if (p) p.textContent = text; }
/** The paste field, for a sign-in that could not work. */
function accPaste(show) {
  const f = ctx.docEl.querySelector(".dk-acc-paste");
  if (!f) return;
  f.hidden = !show;
  if (show) { f.token.placeholder = accRenew ? `a new token for ${labelOf(accRenew)}` : "paste one from claude setup-token"; f.token.focus(); }
}

async function accAdd(d, e) {
  e.preventDefault();
  const f = e.target, token = f.token.value.trim();
  const btn = f.querySelector("button[type=submit]");
  if (!token) return;
  btn.disabled = true;
  try {
    const renew = accRenew;
    const j = renew ? await ctx.api(`/api/accounts/${renew}/renew`, { token }) : await ctx.api("/api/accounts", { token });
    f.token.value = ""; accRenew = null; accPaste(false);
    const name = renew ? labelOf(renew) : j.account.label;
    accSaid(`${name} is kept in ${j.kept === "file" ? "a file only you can read" : "your keychain"}. ${renew ? "Panels start with the new token from their next start." : "Pick it above."}`);
    await ctx.refresh();
  } catch (err) { accSaid(`Could not keep it · ${ctx.sayErr(err).why}`); }
  btn.disabled = false;
}

/** The desk's account. Panels that follow it and are running keep what they
 *  started as, and are offered the switch: it restarts each into its
 *  conversation, so it is asked, never done. */
/** The keys sheet's buttons, its keys' and its accounts': whether `a` was
 *  one of them (`act` asks). */
function keysAct(a, b, d) {
  if (a === "keys") keysSheet(d);
  else if (a === "key-x") keyRemove(d, b.dataset.n, !!b.dataset.every);
  else if (a === "key-back") keyBack(d);
  else if (a === "acc-x") accRemove(d, +b.dataset.n);
  else if (a === "acc-back") accBack(d);
  else if (a === "acc-renew") accSignIn(d, +b.dataset.n);
  else if (a === "acc-more") { accMore = accMore === +b.dataset.n ? null : +b.dataset.n; keysRows(d); ctx.docEl.querySelector(`.dk-acc-dots[data-n="${b.dataset.n}"]`)?.focus(); }
  else if (a === "acc-name") { accNaming = +b.dataset.n; accMore = null; keysRows(d); }
  else if (a === "acc-in") accSignIn(d);
  else return false;
  return true;
}

async function accPick(d, account) {
  let j;
  try { j = await ctx.api(`/api/desks/${d.id}/account`, { account }); }
  catch (e) {
    ctx.toast("Could not change the account", e);
    const rows = ctx.docEl.querySelector(".dk-acc-rows"); if (rows) rows.$html = "";
    return keysRows(d);
  }
  d.account = account;
  await ctx.refresh();
  const vs = (j.running || []).map(id => views.get(id)).filter(v => v && continuable(v));
  if (!vs.length) return;
  const name = account ? (ctx.desks.accounts || []).find(a => a.id === account)?.label : "your login";
  ctx.toast(`New panels here start as ${name}`, `${vs.length} running panel${vs.length === 1 ? " keeps" : "s keep"} what ${vs.length === 1 ? "it" : "they"} started as`, null,
    { label: "Switch them", run: () => { for (const v of vs) switchSoon(v, null, name).catch(e => ctx.toast(`Could not switch panel ${v.pane.slot}`, e)); } });
}

function accRemove(d, id) {
  accMore = null;
  if (accGone) { clearTimeout(accGone.timer); accGo(accGone); }
  accGone = { id, timer: 0 };
  accGone.timer = setTimeout(() => { const g = accGone; accGone = null; accGo(g); }, BACK_MS);
  keysRows(d);
}
async function accGo(g) {
  try { await ctx.api(`/api/accounts/${g.id}/delete`, {}); await ctx.refresh(); }
  catch (e) { ctx.toast("Could not remove the account", e); }
  const d = current(); if (d && keysOpen === d.id) keysRows(d);
}
function accBack(d) { if (!accGone) return; clearTimeout(accGone.timer); accGone = null; keysRows(d); }

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
    : `data-tip="${need(v) ? "Needs you" : `Panel ${v.pane.slot}`}" data-tip-sub="${full ? "full view shows one" : "not enough room"}" data-key="ctrl+alt+${v.pane.slot}"`;
  t.innerHTML = all.length > shown.length ? all.map(v => `<button type="button" data-focus="${v.id}" class="${shown.includes(v) ? "on" : ""}${!shown.includes(v) && need(v) ? " blk" : ""}" ${tip(v)}>[${v.pane.slot}]${!shown.includes(v) && need(v) ? "!" : ""}</button>`).join("") : "";
  // The + goes quiet when there is no pane to add, and says why under the
  // cursor: "A desk holds 4". The rail's Panels head says the count, 4 of 4,
  // so the head does not say it again (the audit of 1.46.2 found it twice).
  const plus = ctx.docEl.querySelector(".dk-head .icon[data-a=\"new\"]"), why = noNew(d);
  if (plus) {
    // Quiet rather than disabled, so the keyboard still reaches it and can
    // hear why: the reason is a hidden line it points to (A4 draws it).
    plus.classList.toggle("dim", !!why);
    why ? plus.setAttribute("aria-disabled", "true") : plus.removeAttribute("aria-disabled");
    plus.dataset.tip = "New panel"; why ? (plus.dataset.tipSub = why) : delete plus.dataset.tipSub;
    let say = plus.nextElementSibling?.id === "dk-plus-why" ? plus.nextElementSibling : null;
    if (!say) { say = Object.assign(document.createElement("span"), { id: "dk-plus-why", className: "vh" }); plus.after(say); plus.setAttribute("aria-describedby", say.id); }
    say.textContent = why || "";
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
  docEl.innerHTML = `<div class="dk"><header class="dk-head" data-tauri-drag-region="deep">${document.querySelector("#chrome .nv")?.outerHTML || ""}<b class="dk-name"></b><span class="dk-root"></span><span class="dk-tabs"></span>` +
    `<button type="button" class="icon" data-a="new" data-tip="New panel" data-key="ctrl+alt+n" aria-label="New panel">${head("plus")}</button>` +
    `<button type="button" class="icon dk-menu" data-desk-menu="${d.id}" data-tip="What this desk can do" aria-label="Desk actions" aria-haspopup="menu">⋯</button></header>` +
    `<div class="dk-grid"><div class="dk-div dk-v" role="separator" aria-orientation="vertical" tabindex="0" data-tip="Drag to resize"></div><div class="dk-div dk-h" role="separator" aria-orientation="horizontal" tabindex="0" data-tip="Drag to resize"></div></div><div class="dk-live vh" aria-live="polite"></div></div>`;
  docEl.querySelector(".dk-name").textContent = d.name;
  docEl.querySelector(".dk-root").textContent = tilde(d.root);
  gridWatch?.disconnect();
  let seen = 0;
  gridWatch = new ResizeObserver(([en]) => { const w = Math.round(en.contentRect.width); if (w !== seen) { seen = w; if (current()) layout(); } });
  gridWatch.observe(docEl.querySelector(".dk-grid"));
  sync(d);
  dividers();
  rail();
  ctx.nav?.();
}

/** Views for the desk's panes: the ones already here kept, scrollback and
 *  all, new ones made, gone ones dropped. Then the socket is told. */
function sync(d) {
  const ids = new Set(d.panes.map(p => p.id));
  for (const v of [...views.values()]) if (!ids.has(v.id)) dropView(v);
  for (const p of d.panes) {
    const v = views.get(p.id);
    if (v) { if (!p.held) unready(v); v.pane = p; if (p.status) v.status = { ...v.status, ...p.status }; header(v); }
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
  return `<div class="inbox-head"><h1>Desks</h1><p>A desk is one project: its folder, and up to four terminal panels side by side in it. A new one asks where: a project snyvi knows, another folder, or a shell in your home folder.</p><p><button type="button" class="dk-make" data-a="make">+ New desk</button></p></div>` +
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
  if (e.button !== 0 || e.target.closest("button, a")) return;
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
