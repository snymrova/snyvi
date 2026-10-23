/* A friend's snyvi: the sheets.
 *
 * Pairing (a code to say, or a friend's code to type, then four emoji both
 * sides compare), Send to… (a document to one of the friends), a line for a
 * friend's notes, an agent's offer (Send, or Not now), and a friend's
 * document kept on a desk and saved into its folder. Each is one box
 * over the page, built here and gone when it closes, so a reader who never
 * pairs never fetches a byte of this. Home (Friends, Arrived, the foot's
 * Pair with a friend…) and the document menu are where these are opened
 * from (ui/home.js, ui/menu.js);
 * the daemon's side is src/server/api_peer.rs.
 *
 * Nothing here holds state but the open box. Everything else comes from
 * `ctx`, made by app.js: esc, rel, toast.
 */

const CSS = `
#peer { position: fixed; inset: 0; background: var(--scrim); z-index: var(--z-dialog); display: grid; place-items: start center; padding-top: 12vh; }
#peer[hidden] { display: none; }
#peer .pr-box { width: min(440px, calc(100vw - 32px)); background: var(--bg-raise); border: 1px solid var(--rule); border-radius: var(--r-md); box-shadow: var(--shadow-3); padding: 20px 22px 18px; color: var(--fg); }
#peer h2 { font-size: var(--fs-h3); font-weight: 600; margin: 0 0 6px; display: flex; align-items: baseline; gap: 10px; }
#peer h2 button.pr-x { margin-left: auto; color: var(--fg-3); font-size: var(--fs-ui); }
#peer h2 button.pr-x:hover { color: var(--fg); }
#peer p { margin: 0 0 10px; color: var(--fg-2); font-size: var(--fs-ui); line-height: 1.45; }
#peer .pr-quiet { color: var(--fg-3); }
#peer .pr-code { font-family: var(--mono); font-size: clamp(var(--fs-read), 5.4vw, var(--fs-h2)); letter-spacing: 0.02em; text-align: center; padding: 14px 10px; margin: 8px 0 6px; border: 1px dashed var(--rule-2); border-radius: var(--r-md); user-select: all; overflow-wrap: anywhere; }
#peer .pr-url { font-family: var(--mono); font-size: var(--fs-small); color: var(--fg-3); overflow-wrap: anywhere; }
#peer .pr-emoji { font-size: 34px; text-align: center; padding: 10px 0 6px; letter-spacing: 0.25em; }
#peer .pr-row { display: flex; gap: 8px; align-items: center; margin: 8px 0 0; }
#peer input, #peer textarea { flex: 1; min-width: 0; font: inherit; padding: 7px 10px; border: 1px solid var(--rule-2); border-radius: var(--r-sm); background: var(--bg); color: var(--fg); }
#peer textarea { resize: none; line-height: 1.4; max-height: calc(3 * 1.4em + 16px); overflow-y: auto; }
#peer .pr-row:has(textarea) { align-items: flex-end; }
#peer input:focus, #peer textarea:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
#peer .pr-n { color: var(--fg-3); font-size: var(--fs-small); text-align: right; min-height: 1.2em; }
#peer button { font: inherit; padding: 7px 12px; border-radius: var(--r-sm); border: 1px solid var(--rule-2); background: var(--bg); color: var(--fg); cursor: pointer; }
#peer button:hover, #peer button:focus-visible { border-color: var(--fg-3); }
#peer button.pr-go { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
#peer button.pr-go[disabled] { opacity: .6; cursor: default; }
/* A row's send, spent: said in the quiet style, not a faded accent. */
#peer button.pr-spent, #peer button.pr-spent[disabled] { background: none; border-color: transparent; color: var(--fg-2); opacity: 1; cursor: default; }
#peer button.pr-link { border: 0; background: none; padding: 2px 4px; color: var(--accent); }
#peer ul { list-style: none; margin: 6px 0 0; padding: 0; }
#peer li { display: flex; align-items: baseline; gap: 10px; padding: 6px 0; border-top: 1px solid var(--rule); }
#peer li:first-child { border-top: 0; }
#peer li .pr-nm { font-weight: 500; }
#peer li .pr-t { color: var(--fg-3); font-size: var(--fs-small); margin-left: auto; }
#peer .pr-said { min-height: 1.4em; color: var(--fg-2); font-size: var(--fs-ui); margin-top: 10px; }
#peer .pr-said.err { color: var(--danger); }
#peer .pr-foot { display: flex; gap: 8px; justify-content: flex-end; margin-top: 14px; }
#peer .pr-title { font-style: italic; }
`;

let box = null, opener = null, poll = 0, styled = false;
/** The code this snyvi is waiting on, while the pairing sheet shows it:
 *  whatever takes the sheet away withdraws it on the daemon. */
let waiting = "";
function withdraw() {
  if (!waiting) return;
  fetch(`/api/peers/pair/${encodeURIComponent(waiting)}`, { method: "DELETE", keepalive: true }).catch(() => {});
  waiting = "";
}
/** The open box's own listeners: dropped when another box takes its place,
 *  so a sheet opened twice does not answer one click twice. */
let wired = null;
const on = (type, fn) => box.addEventListener(type, fn, { signal: wired.signal });

function ensure() {
  if (!styled) { styled = true; document.head.append(Object.assign(document.createElement("style"), { textContent: CSS })); }
  if (!box) {
    box = document.createElement("div");
    box.id = "peer"; box.hidden = true; box.setAttribute("role", "dialog"); box.setAttribute("aria-modal", "true");
    document.body.append(box);
    box.addEventListener("click", e => { if (e.target === box) close(); if (e.target.closest("[data-pr=close]")) close(); });
    box.addEventListener("keydown", e => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); } });
  }
  return box;
}

/** The box, with `html` in it; the hand goes to the first field or button. */
function open(title, html) {
  const el = ensure();
  if (el.hidden) opener = document.activeElement;
  clearInterval(poll); poll = 0; withdraw();
  wired?.abort(); wired = new AbortController();
  el.innerHTML = `<div class="pr-box"><h2>${title}<button type="button" class="pr-x pr-link" data-pr="close" aria-label="Close">✕</button></h2>${html}</div>`;
  el.hidden = false;
  const first = el.querySelector("input, button.pr-go, button:not(.pr-x)");
  (first || el.querySelector("button")).focus({ preventScroll: true });
  return el;
}

export function close() {
  if (!box || box.hidden) return false;
  clearInterval(poll); poll = 0; withdraw();
  box.hidden = true;
  if (opener && opener.isConnected && opener !== document.body) opener.focus({ preventScroll: true });
  opener = null;
  return true;
}

/** A line in the sheet. An error the daemon wrote in lower case, as its
 *  messages are, reads as a sentence. */
const say = (s, err = false) => {
  const el = box?.querySelector(".pr-said");
  if (!el) return;
  if (err && s) s = s[0].toUpperCase() + s.slice(1) + (/[.!?…]$/.test(s) ? "" : ".");
  el.textContent = s || ""; el.classList.toggle("err", !!err);
};
/** Copy, said on the button for a moment. */
async function copy(text, b) {
  try { await navigator.clipboard.writeText(text); } catch { say("Could not copy it; select the code and copy it by hand", true); return; }
  b.textContent = "Copied"; setTimeout(() => { if (b.isConnected) b.textContent = "Copy"; }, 1200);
}

async function post(url, body) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
  let j = null; try { j = await r.json(); } catch {}
  if (!r.ok) throw new Error((j && j.error) || `snyvi answered ${r.status}`);
  return j || {};
}

async function friends() {
  const r = await fetch("/api/peers");
  if (!r.ok) throw new Error("could not read the friends");
  return r.json();
}

/* ---------- pairing ---------- */

const INTRO = `<p>One of you makes a code and says it to the other: over a call, a message, in the room. The relay never sees the code; what passes through it is sealed with it.</p>`;
const nameRow = (esc, me) => `<div class="pr-row"><label class="pr-quiet" for="pr-name">Your name, as they will see it</label></div>` +
  `<div class="pr-row"><input id="pr-name" maxlength="60" value="${esc(me)}" autocomplete="off"></div>`;

/** The pairing sheet. `code` is a friend's code to start with, from a
 *  snyvi://pair/… link; `mode` "join" opens on the field for one (Ctrl K's
 *  Join a friend's code…). Otherwise it asks which of the two the reader is:
 *  the one making the code, or the one who was told it. */
export async function pair(ctx, code = "", mode = "") {
  const { esc } = ctx;
  let me = "";
  try { me = (await friends()).me.name || ""; } catch {}
  if (code || mode === "join") return have(ctx, me, code);
  open("Pair with a friend", INTRO + nameRow(esc, me) +
    `<div class="pr-foot"><button type="button" data-pr="have">I have a code</button><button type="button" class="pr-go" data-pr="make">I'll make a code</button></div>` +
    `<div class="pr-said" aria-live="polite"></div>`);
  const name = () => box.querySelector("#pr-name")?.value.trim() || me;
  box.querySelector("[data-pr=make]").addEventListener("click", () => start(ctx, "/api/peers/pair", { name: name() }));
  box.querySelector("[data-pr=have]").addEventListener("click", () => have(ctx, name(), ""));
  box.querySelector("[data-pr=make]").focus({ preventScroll: true });
}

/** The friend who was told a code: the field for it, and Join. */
function have(ctx, me, code) {
  const { esc } = ctx;
  open("Join a friend's code", `<p>Type the code they made: three words and three letters.</p>` + nameRow(esc, me) +
    `<div class="pr-row"><input id="pr-code" placeholder="ocean-ladder-acorn-kpm" value="${esc(code)}" autocomplete="off" spellcheck="false" aria-label="Their code"><button type="button" class="pr-go" data-pr="join">Join</button></div>` +
    `<div class="pr-said" aria-live="polite"></div>`);
  const field = box.querySelector("#pr-code");
  const join = () => { const c = field.value.trim(); if (c) start(ctx, "/api/peers/join", { name: box.querySelector("#pr-name")?.value.trim() || me, code: c }); else field.focus(); };
  box.querySelector("[data-pr=join]").addEventListener("click", join);
  box.querySelector("#pr-name").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); join(); } });
  field.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); join(); } });
  (code ? box.querySelector("[data-pr=join]") : field).focus({ preventScroll: true });
}

async function start(ctx, url, body) {
  const { esc } = ctx;
  const busy = on => { for (const b of box.querySelectorAll("button.pr-go, [data-pr=have]")) b.disabled = on; };
  busy(true);
  say("Asking the relay…");
  let r;
  try { r = await post(url, body); }
  catch (e) { say(ctx.sayErr(e).why, true); busy(false); return; }
  const made = url.endsWith("/pair");
  open("Pair with a friend",
    (made
      ? `<p>Say this to your friend, or send it. It works once, for ten minutes.</p><div class="pr-code" aria-label="Your code">${esc(r.code)}</div>` +
        `<p class="pr-quiet">They press <b>I have a code</b> under <b>Pair with a friend…</b> (at the foot of their Home, or in ${/Mac/.test(navigator.platform) ? "⌘K" : "Ctrl K"}), or open</p><p class="pr-url">snyvi://pair/${esc(r.code)}</p>`
      : `<p>Waiting for <span style="font-family:var(--mono)">${esc(r.code)}</span> to meet its other half…</p>`) +
    `<div class="pr-said" aria-live="polite">Waiting for the other side…</div>` +
    `<div class="pr-foot"><button type="button" data-pr="close">Cancel</button>${made ? `<button type="button" class="pr-go" data-pr="copy">Copy</button>` : ""}</div>`);
  waiting = r.code;
  const cp = box.querySelector("[data-pr=copy]");
  if (cp) { cp.addEventListener("click", () => copy(r.code, cp)); cp.focus({ preventScroll: true }); }
  const until = r.until * 1000;
  const over = why => {
    clearInterval(poll); poll = 0; waiting = "";
    say(why, true);
    box.querySelector(".pr-foot").innerHTML = `<button type="button" data-pr="close">Close</button><button type="button" class="pr-go" data-pr="again">Try again</button>`;
    box.querySelector("[data-pr=again]").addEventListener("click", () => pair(ctx));
    box.querySelector("[data-pr=again]").focus({ preventScroll: true });
  };
  poll = setInterval(async () => {
    let s;
    try { s = await (await fetch(`/api/peers/pair/${encodeURIComponent(r.code)}`)).json(); } catch { return; }
    const p = s.pairing || {};
    if (p.state === "done") {
      waiting = "";
      // The whole box is drawn again: what it said while waiting is over.
      open(`Paired with ${esc(p.name)}`,
        `<div class="pr-emoji" aria-label="Four emoji">${esc(p.emoji)}</div>` +
        `<p>Ask them: do you see these same four? If not, remove ${esc(p.name)} from Home and pair again.</p>` +
        `<div class="pr-foot"><button type="button" class="pr-go" data-pr="close">Done</button></div>`);
      ctx.toast(`Paired with ${p.name}`, { sub: `what they send shows under From ${p.name}` });
      // A document's Send to… is drawn once there is a friend to send to, so
      // the page open under the sheet is drawn again to have it now.
      if (ctx.state?.doc) ctx.refreshDoc?.(ctx.state.doc.id);
    } else if (p.state === "failed") over(p.why || "the pairing did not finish");
    else if (p.state === "cancelled") over("the code was cancelled");
    else if (Date.now() > until) over("the code ran out. Make a new one");
    else {
      const left = Math.max(0, Math.round((until - Date.now()) / 60000));
      say(`Waiting for the other side… ${left ? `${left} min left` : "less than a minute left"}`);
    }
  }, 2000);
}

/* ---------- send ---------- */

/** Send this document to a friend. Each friend's row says what became of
 *  the last send to them; a document they already have says so, with Send
 *  again (F14). One line under the list says what happened, once (F15). */
export async function send(ctx, docId, title = "") {
  const { esc } = ctx;
  let j;
  try { j = await friends(); } catch (e) { ctx.toast("Could not read the friends", { sub: ctx.sayErr(e).why }); return; }
  const list = (j.friends || []).filter(f => !f.removed_at);
  open(`Send <span class="pr-title">${esc(title || "this document")}</span> to…`,
    (list.length
      ? `<ul>${list.map(f => `<li><span class="pr-nm">${esc(f.name)}</span><span class="pr-t">${f.away ? "away now; it waits for them" : f.last_to ? `last sent ${esc(ctx.rel(f.last_to))}` : "nothing sent yet"}</span><button type="button" class="pr-go" data-peer="${f.id}">Send</button></li>`).join("")}</ul>` +
        `<p class="pr-quiet" style="margin-top:10px">Sealed to their key. It lands under <b>From</b> and your name in their sidebar, or on the desk they keep your things on. The relay holds it seven days at most, read or not.</p>`
      : `<p>No friends yet. <b>Pair with a friend…</b> at the foot of Home makes one.</p>`) +
    `<div class="pr-said" aria-live="polite"></div><div class="pr-foot"><button type="button" data-pr="close">Close</button></div>`);
  const go = async (b, again) => {
    for (const x of box.querySelectorAll("button[data-peer]")) x.disabled = true;
    say("Sealing and sending…");
    try {
      const r = await post(`/api/docs/${encodeURIComponent(docId)}/send`, { peer: +b.dataset.peer, again });
      // This very version is with them already: nothing new would arrive.
      if (r.already) {
        say(`${r.to} already has this version: it arrived ${ctx.rel(r.already)}.`);
        b.textContent = "Send again"; b.dataset.again = "1";
        for (const x of box.querySelectorAll("button[data-peer]")) x.disabled = false;
        return;
      }
      say(r.sent ? `Sent to ${r.to}.` : `Waiting for ${r.to}: it goes when they or the relay can be reached.`);
      // Its row's button is spent and says so, quietly; the others can still go.
      for (const x of box.querySelectorAll("button[data-peer]")) x.disabled = x === b;
      b.className = "pr-spent"; b.textContent = r.sent ? "Sent ✓" : "Waiting";
      box.querySelector(".pr-foot").innerHTML = `<button type="button" class="pr-go" data-pr="close">Done</button>`;
      box.querySelector(".pr-foot .pr-go").focus();
    } catch (err) {
      say(ctx.sayErr(err).why, true);
      for (const x of box.querySelectorAll("button[data-peer]")) x.disabled = false;
    }
  };
  on("click", e => {
    const b = e.target.closest("button[data-peer]");
    if (b && !b.disabled) go(b, b.dataset.again === "1");
  });
}

/** The open document's Send to…, once it went somewhere, says how far it
 *  got (assets.rs `went`): read again in place when what came back moves,
 *  only the button, so nothing under the reader's eyes moves (F2). */
export async function sentNow(ctx) {
  const id = ctx.state?.doc?.id, b = document.querySelector(".doc-send[data-sent]");
  if (!id || !b) return;
  let j;
  try { j = await (await fetch(`/api/docs/${encodeURIComponent(id)}`)).json(); } catch { return; }
  if (ctx.state?.doc?.id !== id || !b.isConnected) return;
  const t = document.createElement("template"); t.innerHTML = j.html || "";
  const n = t.content.querySelector(".doc-send[data-sent]");
  if (!n) return;
  b.innerHTML = n.innerHTML; b.dataset.tipSub = n.dataset.tipSub || "";
}

/** A one-line field that grows to three lines as it is typed into, so the
 *  words stay in view (F10). Enter sends; a line has no newlines. */
function grow(el, go) {
  const fit = () => { el.style.height = "auto"; el.style.height = el.scrollHeight + 2 + "px"; count(el); };
  el.addEventListener("input", fit);
  el.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); go(); } });
  fit();
}
/** From 160 characters, how many of the 200 a line holds are used. */
function count(el) {
  const n = [...el.value].length, c = box?.querySelector(".pr-n");
  if (c) c.textContent = n >= 160 ? `${n} / 200` : "";
}

/* ---------- a line for a friend's notes ---------- */

/** A line, or a reply, longer than the 200 characters both daemons keep
 *  (`peer::NOTE_CHARS`): said in the sheet, and not sent. The field has no
 *  maxlength, since a browser cuts a paste at one without a word, and a long
 *  link cut there arrives broken (06981a8a31). */
function overLine(t) {
  const n = [...t].length;
  if (n <= 200) return false;
  say(`${n} characters; a line holds 200. A long link goes as a document, with Send to….`, true);
  return true;
}

export function note(ctx, peerId, name) {
  const { esc } = ctx;
  open(`A line for ${esc(name)}`,
    `<p>It goes on their Home, or on the desk they keep your things on, until they keep it. One line, as a note is; a date in it ("by Friday") becomes its date there.</p>` +
    `<div class="pr-row"><textarea id="pr-line" rows="1" placeholder="What should they not forget?" autocomplete="off"></textarea><button type="button" class="pr-go" data-pr="send">Send</button></div>` +
    `<div class="pr-n" aria-live="polite"></div><div class="pr-said" aria-live="polite"></div>`);
  const go = async () => {
    const t = box.querySelector("#pr-line").value.trim();
    if (!t || overLine(t)) return;
    box.querySelector("[data-pr=send]").disabled = true;
    say("Sending…");
    // A relay that cannot be reached keeps the line in the outbox, as it
    // keeps a document: it goes when it can, and the sheet says so.
    try { const r = await post(`/api/peers/${peerId}/note`, { text: t }); say(r.sent ? `Sent to ${name}.` : `Queued for ${name}; it goes when the relay can be reached.`); setTimeout(close, r.sent ? 900 : 2400); }
    catch (e) { say(ctx.sayErr(e).why, true); box.querySelector("[data-pr=send]").disabled = false; }
  };
  box.querySelector("[data-pr=send]").addEventListener("click", go);
  grow(box.querySelector("#pr-line"), go);
}

/* ---------- a friend's document, kept ---------- */

/** The window's capability, which a desk's routes ask for: kept by the page
 *  in this tab's session (ui/app/07-nav.js). A tab has none. */
const cap = () => { try { return sessionStorage.getItem("snyvi.cap") || ""; } catch { return ""; } };

async function deskCall(url, body) {
  const headers = { "content-type": "application/json", "x-snyvi-capability": cap() };
  const r = await fetch(url, body === undefined ? { headers } : { method: "POST", headers, body: JSON.stringify(body) });
  let j = null; try { j = r.status === 204 ? {} : await r.json(); } catch {}
  if (!r.ok) throw new Error((j && j.error) || `snyvi answered ${r.status}`);
  return j || {};
}

/** A button in a document's head: Send to…, Keep on a desk…, Save into the
 *  folder (src/server/assets.rs `doc_html`). */
export function head(ctx, b) {
  const id = b.dataset.send, title = b.dataset.sendTitle || "";
  if (b.dataset.act === "keep") return keepOn(ctx, [id], title);
  if (b.dataset.act === "save") return save(ctx, id, b);
  if (b.dataset.act === "unfile") return unfile(ctx, id, b);
  if (b.dataset.act === "reply") return reply(ctx, id, b.dataset.to || "them", title, +b.dataset.peer || 0);
  return send(ctx, id, title);
}

/** One line back to the friend who sent a document -- or, under the
 *  reader's own (`peer`, 1.49), an answer to that friend's reply: it shows
 *  under the head of both copies. Anything longer is a document of its own. */
function reply(ctx, id, to, title, peer = 0) {
  const { esc } = ctx;
  open(`Reply to ${esc(to)}`,
    `<p>About <span class="pr-title">${esc(title || "their document")}</span>. One line; it shows under the head of their copy, and of yours.</p>` +
    `<div class="pr-row"><textarea id="pr-line" rows="1" placeholder="Looks good; one question about step 3" autocomplete="off"></textarea><button type="button" class="pr-go" data-pr="send">Send</button></div>` +
    `<div class="pr-n" aria-live="polite"></div><div class="pr-said" aria-live="polite"></div>`);
  let busy = false;
  const go = async () => {
    const t = box.querySelector("#pr-line")?.value.trim();
    if (!t || busy || overLine(t)) return;
    busy = true;
    const here = box.querySelector(".pr-box");
    box.querySelector("[data-pr=send]").disabled = true;
    say("Sending…");
    try {
      const r = await post(`/api/docs/${encodeURIComponent(id)}/reply`, { text: t, peer });
      if (!here.isConnected) return;
      say(r.sent ? `Sent to ${r.to}.` : r.waits ? `Kept for ${r.to}: their snyvi is older, and it goes once they update.` : `Queued for ${r.to}; it goes when the relay can be reached.`);
      box.querySelector(".pr-row").remove();
      box.querySelector(".pr-box").insertAdjacentHTML("beforeend", `<div class="pr-foot"><button type="button" class="pr-go" data-pr="close">Done</button></div>`);
      box.querySelector(".pr-foot .pr-go").focus();
    } catch (e) { if (here.isConnected) { say(ctx.sayErr(e).why, true); box.querySelector("[data-pr=send]").disabled = false; } }
    finally { busy = false; }
  };
  on("click", e => { if (e.target.closest("[data-pr=send]")) go(); });
  grow(box.querySelector("#pr-line"), go);
  // Their copy and this one both carry it now: this head shows it when
  // Done takes the sheet away, drawn again as the reader asked for it.
  on("click", e => { if (e.target.closest(".pr-foot [data-pr=close]")) ctx.refreshDoc?.(id); });
}

/** Back to From <friend>: a friend's document that was filed into one of
 *  the reader's folders (both have the repository) or kept on a desk goes
 *  back under the friend's row, every version with it. Said where the
 *  button was; the head is drawn again as it lands, with Keep on a desk… */
async function unfile(ctx, id, b) {
  b.disabled = true;
  try {
    await post(`/api/docs/${encodeURIComponent(id)}/unfile`, {});
    if (b.isConnected) { const s = Object.assign(document.createElement("span"), { textContent: "Moved to their row" }); s.setAttribute("role", "status"); b.replaceWith(s); }
  } catch (e) {
    b.disabled = false;
    ctx.toast("Could not move it", { sub: ctx.sayErr(e).why });
  }
}

/** Keep a friend's documents on a desk: each, with every version of it,
 *  moves into the desk's project and onto its list, and still says who sent
 *  it. Nothing is written into the folder; Save does that. `ids` is one
 *  document, or every one under a friend's row (Keep all on a desk…). */
export async function keepOn(ctx, ids, title) {
  const { esc } = ctx;
  if (!cap()) { ctx.toast("Only the snyvi window can do that", { sub: "a desk is the window's" }); return; }
  let desks;
  try { desks = (await deskCall("/api/desks")).desks || []; }
  catch (e) { ctx.toast("Could not read the desks", { sub: ctx.sayErr(e).why }); return; }
  desks = [...desks.filter(d => !d.parked), ...desks.filter(d => d.parked)];
  open(`Keep <span class="pr-title">${esc(title || "this document")}</span> on…`,
    (desks.length
      ? `<ul>${desks.map(d => `<li><span class="pr-nm">${esc(d.name)}</span><span class="pr-t">${d.parked ? "parked" : ""}</span><button type="button" class="pr-go" data-desk="${d.id}">Keep</button></li>`).join("")}</ul>` +
        `<p class="pr-quiet" style="margin-top:10px">${ids.length > 1 ? `All ${ids.length} move` : "It moves"} into the desk's documents, every version, and still ${ids.length > 1 ? "say" : "says"} who sent ${ids.length > 1 ? "them" : "it"}. Nothing is written into the desk's folder until you press <b>Save into the folder</b>.</p>`
      : `<p>No desk yet. <b>New desk here</b>, on a project's menu in the sidebar, makes one; then keep it there.</p>`) +
    `<div class="pr-said" aria-live="polite"></div><div class="pr-foot"><button type="button" data-pr="close">Close</button></div>`);
  on("click", async e => {
    const b = e.target.closest("button[data-desk]");
    if (!b) return;
    for (const x of box.querySelectorAll("button[data-desk]")) x.disabled = true;
    say("Keeping…");
    let name = "", done = 0;
    try {
      for (const id of ids) { name = (await deskCall(`/api/docs/${encodeURIComponent(id)}/keep`, { desk: +b.dataset.desk })).desk; done++; }
      say(`Kept on ${name}.${ids.length === 1 ? " Save into the folder is in its head now." : ""}`);
      box.querySelector(".pr-foot").innerHTML = `<button type="button" class="pr-go" data-pr="close">Done</button>`;
      box.querySelector(".pr-go").focus();
    } catch (err) {
      say(`${done ? `${done} kept; then ` : ""}${ctx.sayErr(err).why}`, true);
      for (const x of box.querySelectorAll("button[data-desk]")) x.disabled = false;
    }
  });
}

/** Save into the folder: the stored bytes, written as `from-<friend>/<name>`
 *  in the folder of the desk it is on, never over a file. Said in the head,
 *  where the button was. */
export async function save(ctx, id, b) {
  if (!cap()) { ctx.toast("Only the snyvi window can do that", { sub: "it writes into a desk's folder" }); return; }
  if (b) b.disabled = true;
  try {
    const r = await deskCall(`/api/docs/${encodeURIComponent(id)}/save`, {});
    // Said where the button was; a toast only when that place is gone (F17).
    if (b && b.isConnected) { const s = Object.assign(document.createElement("span"), { textContent: `Saved as ${r.rel}` }); s.setAttribute("role", "status"); b.replaceWith(s); }
    else ctx.toast(`Saved into ${r.desk}'s folder`, { sub: r.rel });
    ctx.saved?.(id, r.path);
  } catch (e) {
    if (b) b.disabled = false;
    ctx.toast("Could not save it", { sub: ctx.sayErr(e).why });
  }
}

/* ---------- what the stream says ---------- */

/** What the page's event stream says about friends: a line, a reply or a
 *  tick from one rises in the corner (ui/corner.js), unless it came
 *  quietly, and settles there under Lately, where the daemon keeps it. An
 *  agent's offer is the corner's own, an On you row (app.js `onPeer`).
 *  Each card says who in its head and what in its title -- the line, the
 *  reply, the ticked line -- and its button goes where the thing is (F5). */
export function event(ctx, j) {
  const { esc } = ctx, from = esc(j.from || "");
  if (j.done && !j.quiet) ctx.rise({ kind: "friend", key: `pd${Date.now()}`, from: j.promise ? `<b>${from}</b> kept their promise` : `<b>${from}</b> ticked your line`, title: j.done + (j.commit ? ` · ${String(j.commit).slice(0, 7)}` : ""), label: "Home", go: ctx.home });
  else if (j.reply) {
    // The reply is in the head the next time the document is drawn; the
    // copy kept from before it is not. Open now, it is drawn again only
    // when the reader asks: the page does not move under their eyes.
    const open = ctx.state?.doc?.id === j.doc;
    if (!open) ctx.refreshDoc?.(j.doc);
    if (!j.quiet) ctx.rise({ kind: "friend", key: `pr${Date.now()}`, from: `<b>${from}</b> replied`, title: j.reply, label: open ? "Show it" : "Open", go: open ? () => ctx.refreshDoc(j.doc) : () => ctx.showDoc?.(j.doc) });
  }
  else if (j.from && !j.quiet) {
    // On their desk it is a suggestion there, to keep or not; else it waits
    // on Home. A promise is theirs, said as one.
    const where = j.desk ? { label: `Open ${j.desk}`, go: () => ctx.openDesk?.(j.desk_id) || ctx.home() } : { label: "Home", go: ctx.home };
    ctx.rise({ kind: "friend", key: `pn${Date.now()}`, from: j.promise ? `<b>${from}</b> promised you` : `<b>${from}</b>${j.desk ? ` · a suggestion on ${esc(j.desk)}` : ""}`, title: j.text || "a line", ...where });
  }
}
