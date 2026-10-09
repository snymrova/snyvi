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
/** The key just kept, { desk, name }: its row, when the desk's next read
 *  brings it, lights once, so Keep is seen to have done something. */
let keyNew = null;

function keysSlot(d) {
  const hd = ctx.docEl.querySelector(".dk-head");
  if (!hd) return;
  let el = hd.querySelector(".dk-keys");
  if (!el) { el = Object.assign(document.createElement("span"), { className: "dk-keys" }); hd.querySelector(".dk-tabs").before(el); }
  // The button is redrawn in place; the sheet beside it is left alone, with
  // whatever is typed in it.
  let b = el.querySelector(".dk-keys-b");
  if (!b) { b = Object.assign(document.createElement("button"), { type: "button", className: "dk-keys-b" }); b.dataset.a = "keys"; b.setAttribute("aria-haspopup", "dialog"); el.prepend(b); }
  const ks = d.keys || [], n = ks.length, open = keysOpen === d.id;
  b.classList.toggle("none", !n);
  b.setAttribute("aria-expanded", String(open));
  // A key, always there, and how many beside it: a word that showed only
  // under the cursor was a control nobody knew was there.
  const html = head("key") + (n ? `<span class="n">${n}</span>` : "");
  if (b.$html !== html) { b.innerHTML = html; b.$html = html; }
  b.setAttribute("aria-label", n ? `${n} key${n === 1 ? "" : "s"}` : "Keys");
  const acc = d.account ? (ctx.desks.accounts || []).find(a => a.id === d.account) : null;
  b.dataset.tip = (acc ? `Claude as ${acc.label}${n ? " · " : ""}` : "") + (n ? ks.map(k => k.name).join(", ") : acc ? "" : "Keys for this desk's panels");
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
  sheet.innerHTML = `<div class="dk-keys-h">Claude account this desk's panels start as</div><div class="dk-acc-rows" role="radiogroup" aria-label="Claude account"></div>
    <details class="dk-acc-more"><summary>Add a Claude account</summary><form class="dk-keys-add dk-acc-add" autocomplete="off">
      <label><span>Name</span><input name="label" maxlength="40" spellcheck="false" placeholder="Work"><button type="button" data-a="acc-in">Sign in…</button></label>
      <div class="dk-acc-live" role="status" hidden></div>
      <label><span>Token</span><input name="token" type="password" autocomplete="new-password" required spellcheck="false" placeholder="or paste one from claude setup-token"><button type="submit">Add</button></label>
      <p class="dk-keys-say" role="status">Sign in opens Claude's sign-in in your browser: approve as the other account and it is added here. It lasts a year, and your settings, hooks and history stay shared.</p>
    </form></details>
    <div class="dk-keys-h">Keys for this desk's panels</div><div class="dk-keys-rows"></div>
    <form class="dk-keys-add" autocomplete="off">
      <div class="dk-keys-t">Add a key</div>
      <label><span>Name</span><input name="name" list="dk-key-names" required spellcheck="false" placeholder="OPENROUTER_API_KEY" pattern="[A-Z][A-Z0-9_]*" maxlength="64" title="capitals, digits and underscores"></label>
      <datalist id="dk-key-names">${PROVIDERS.map(([p, n]) => `<option value="${n}">${p}</option>`).join("")}</datalist>
      <label><span>Value</span><input name="value" type="password" autocomplete="new-password" required placeholder="paste it here"></label>
      <div class="dk-keys-w"><span>Where</span><label><input type="radio" name="every" value="" checked> this desk</label><label><input type="radio" name="every" value="1"> every desk</label><button type="submit">Keep</button></div>
      <p class="dk-keys-say" role="status">Kept where only you can read it and never shown again. Panels on this desk can use it now, as $(snyvi key NAME).</p>
    </form>`;
  sheet.querySelector(".dk-keys-add:not(.dk-acc-add)").addEventListener("submit", e => keyAdd(d, e));
  sheet.querySelector(".dk-acc-add").addEventListener("submit", e => accAdd(d, e));
  sheet.querySelector(".dk-acc-live").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); accSignCode(); } });
  sheet.querySelector(".dk-acc-rows").addEventListener("change", e => { if (e.target.name === "acc") accPick(d, +e.target.value); });
  // What is typed is the sheet's: the page's own keys stay out of it.
  sheet.addEventListener("keydown", e => { if (e.key !== "Escape") e.stopPropagation(); });
  slot.append(sheet);
  keysRows(d);
  keysSlot(d);
  ctx.api("/api/accounts/signin").then(j => { signing = j.signin; signDraw(); signPoll(); }, () => {});
  document.addEventListener("pointerdown", keysOutside, true);
  document.addEventListener("keydown", keysKey, true);
  sheet.querySelector("input[name=name]").focus();
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
    : `<div class="dk-key${lit(k)}"><span class="dk-key-n">${esc(k.name)}</span><span class="dk-key-m">${k.provider ? esc(k.provider) + " · " : ""}${k.desk_id ? "this desk" : "every desk"} · ${k.used_at ? "a panel started with it " + ctx.relShort(k.used_at) : "no panel has started with it yet"}</span><button type="button" class="icon dk-key-x" data-a="key-x" data-n="${esc(k.name)}" data-every="${k.desk_id ? "" : "1"}" data-tip="Take it off ${k.desk_id ? "this desk" : "every desk"}" aria-label="Remove ${esc(k.name)}">${ctx.glyph("x")}</button></div>`).join("")
    : `<p class="dk-keys-none">None yet. A key here goes into the environment of every panel on this desk, and Claude is told its name, never its value.</p>`;
  if (rows.$html !== html) { rows.innerHTML = html; rows.$html = html; }
}

function keysOutside(e) { if (!e.target.closest(".dk-keys")) keysClose(); }
function keysKey(e) { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); keysClose(true); } }
function keysClose(back = false) {
  if (keysOpen == null) return;
  keysOpen = null; accRenew = null;
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

/* ---------- Claude accounts (`crate::accounts`) ----------
 * In the keys sheet, since a token is kept as a key is: which account the
 * desk's panels start as, a token added or renewed, an account taken away.
 * An account is every desk's; which one a desk starts as is the desk's. */
const YEAR = 365 * 86400, RENEW_SOON = 30 * 86400;
let accGone = null, accRenew = null;
const accDate = t => new Date(t * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

function accRows(d) {
  const rows = ctx.docEl.querySelector(".dk-keys-sheet .dk-acc-rows");
  if (!rows) return;
  const { esc } = ctx, now = Date.now() / 1000;
  const all = accounts();
  const row = a => {
    if (accGone && accGone.id === a.id) return `<div class="dk-key" role="status"><span class="dk-key-n">${esc(a.label)}</span><span class="dk-key-m">Removed · its token is gone in a moment</span><button type="button" class="dk-undo" data-a="acc-back">Undo</button></div>`;
    const end = (a.created_at || 0) + YEAR, soon = a.id && end - now < RENEW_SOON;
    const meta = !a.id ? "the account <code>/login</code> signed in"
      : `${soon ? `<b>renew by ${accDate(end)}</b>` : `good until ${accDate(end)}`} · ${a.used_at ? "a panel started as it " + ctx.relShort(a.used_at) : "no panel has started as it yet"}`;
    return `<div class="dk-key dk-acc"><label><input type="radio" name="acc" value="${a.id}"${a.id === (d.account || 0) ? " checked" : ""}><span class="dk-key-n">${esc(a.label)}</span></label><span class="dk-key-m">${meta}</span>` +
      (a.id ? `<button type="button" class="dk-acc-renew" data-a="acc-renew" data-n="${a.id}">Renew</button><button type="button" class="icon dk-key-x" data-a="acc-x" data-n="${a.id}" data-tip="Remove ${esc(a.label)}" data-tip-sub="from every desk · its panels go back to your login" aria-label="Remove ${esc(a.label)}">${ctx.glyph("x")}</button>` : "") + `</div>`;
  };
  // Claude Code ranks these over an account's token (`accounts::OUTRANKS`).
  const over = d.account ? (d.keys || []).find(k => k.name === "ANTHROPIC_API_KEY" || k.name === "ANTHROPIC_AUTH_TOKEN") : null;
  const html = all.map(row).join("") + (over ? `<p class="dk-keys-say"><b>${esc(over.name)}</b> is a key here, and Claude Code uses it over the account picked.</p>` : "");
  if (rows.$html !== html) { rows.innerHTML = html; rows.$html = html; }
  const more = ctx.docEl.querySelector(".dk-acc-more"), f = more && more.querySelector("form");
  const r = accRenew && all.find(a => a.id === accRenew);
  if (f) { f.label.hidden = f.label.previousElementSibling.hidden = !!r; more.firstElementChild.textContent = r ? `Renew ${r.label}` : "Add a Claude account"; f.querySelector("button[type=submit]").textContent = r ? "Renew" : "Add"; }
  signDraw();
}

/* Sign in: snyvi runs `claude setup-token` out of sight and keeps the token
 * it prints (`accounts::signin`); the sheet asks how it is going each second
 * while one is open, and is told the sign-in page's address and the ending,
 * never the token. */
let signing = null, signTimer = 0;
async function accSignIn(d) {
  const f = ctx.docEl.querySelector(".dk-acc-add");
  if (!f) return;
  const renew = accRenew;
  try { signing = (await ctx.api("/api/accounts/signin", renew ? { renew } : { label: f.label.value.trim() })).signin; }
  catch (e) { signing = { phase: "failed", error: ctx.sayErr(e).why }; }
  signDraw(); signPoll();
}
function signPoll() {
  clearTimeout(signTimer);
  if (!signing || !/^(starting|waiting)$/.test(signing.phase)) return;
  signTimer = setTimeout(async () => {
    try { signing = (await ctx.api("/api/accounts/signin")).signin; } catch {}
    if (signing && signing.phase === "done") {
      const f = ctx.docEl.querySelector(".dk-acc-add");
      if (f) { f.label.value = ""; f.querySelector(".dk-keys-say").textContent = `${signing.label} is signed in. ${signing.renew ? "Panels start with the new token from their next start." : "Pick it above, or right-click a panel to run it as this account."}`; }
      accRenew = null;
      await ctx.refresh();
    }
    signDraw(); signPoll();
  }, 1000);
}
function signDraw() {
  const live = ctx.docEl.querySelector(".dk-keys-sheet .dk-acc-live");
  if (!live) return;
  const s = signing, { esc } = ctx;
  const html = !s || s.phase === "done" || s.phase === "cancelled" ? ""
    : s.phase === "failed" ? `<span>Could not sign in · ${esc(s.error || "it ended")}. Paste a token instead, or try again.</span>`
    : s.phase === "starting" ? `<span>Opening Claude's sign-in…</span><button type="button" data-a="acc-in-x">Cancel</button>`
    : `<span>Approve in your browser as the account to add. <button type="button" class="dk-acc-link" data-a="acc-in-open">Open the sign-in page</button> if it did not open.</span>
      <label><span>Code</span><input name="code" spellcheck="false" autocomplete="off" placeholder="only if the page shows one"><button type="button" data-a="acc-in-code">Send</button><button type="button" data-a="acc-in-x">Cancel</button></label>`;
  if (live.$html === html) return;
  live.innerHTML = html; live.$html = html; live.hidden = !html;
  const btn = ctx.docEl.querySelector(".dk-acc-add [data-a=acc-in]");
  if (btn) btn.disabled = !!s && /^(starting|waiting)$/.test(s.phase);
}
async function accSignCode() {
  const inp = ctx.docEl.querySelector(".dk-acc-live input[name=code]");
  if (!inp || !inp.value.trim()) return;
  try { await ctx.api("/api/accounts/signin/code", { code: inp.value.trim() }); inp.value = ""; inp.placeholder = "sent · waiting for Claude"; }
  catch (e) { ctx.toast("Could not send the code", e); }
}
async function accSignCancel() {
  try { await ctx.api("/api/accounts/signin/cancel", {}); } catch {}
  signing = null; clearTimeout(signTimer); signDraw();
}

async function accAdd(d, e) {
  e.preventDefault();
  const f = e.target, token = f.token.value.trim(), label = f.label.value.trim();
  const say = f.querySelector(".dk-keys-say"), btn = f.querySelector("button[type=submit]");
  if (!token) return;
  btn.disabled = true;
  try {
    const renew = accRenew;
    const j = renew ? await ctx.api(`/api/accounts/${renew}/renew`, { token }) : await ctx.api("/api/accounts", { label, token });
    f.token.value = ""; f.label.value = ""; accRenew = null;
    const name = renew ? (ctx.desks.accounts || []).find(a => a.id === renew)?.label : j.account.label;
    say.textContent = `${name} is kept in ${j.kept === "file" ? "a file only you can read" : "your keychain"}. ${renew ? "Panels start with the new token from their next start." : "Pick it above, or right-click a panel to run it as this account."}`;
    await ctx.refresh();
  } catch (err) { say.textContent = `Could not keep it · ${ctx.sayErr(err).why}`; }
  btn.disabled = false;
}

/** The desk's account. Panels that follow it and are running keep what they
 *  started as, and are offered the switch: it restarts each into its
 *  conversation, so it is asked, never done. */
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
    { label: "Switch them", run: () => { for (const v of vs) switchPanel(v, null, name).catch(e => ctx.toast(`Could not switch panel ${v.pane.slot}`, e)); } });
}

function accRemove(d, id) {
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
function accRenewing(d, id) {
  accRenew = id;
  keysRows(d);
  const more = ctx.docEl.querySelector(".dk-acc-more");
  if (more) { more.open = true; more.querySelector("input[name=token]").focus(); }
}

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
