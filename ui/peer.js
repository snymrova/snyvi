/* A friend's snyvi: the sheets.
 *
 * Pairing (a code to say, or a friend's code to type, then four emoji both
 * sides compare), Send to… (a document to one of the friends), a line for a
 * friend's notes, and an agent's offer (Send, or Not now). Each is one box
 * over the page, built here and gone when it closes, so a reader who never
 * pairs never fetches a byte of this. Home's Friends section and the
 * document menu are where these are opened from (ui/home.js, ui/menu.js);
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
#peer h2 .pr-x { margin-left: auto; color: var(--fg-3); font-size: var(--fs-ui); }
#peer h2 .pr-x:hover { color: var(--fg); }
#peer p { margin: 0 0 10px; color: var(--fg-2); font-size: var(--fs-ui); line-height: 1.45; }
#peer .pr-quiet { color: var(--fg-3); }
#peer .pr-code { font-family: var(--mono); font-size: var(--fs-h2); letter-spacing: 0.02em; text-align: center; padding: 14px 10px; margin: 8px 0 10px; border: 1px dashed var(--rule-2); border-radius: var(--r-md); user-select: all; }
#peer .pr-emoji { font-size: 34px; text-align: center; padding: 10px 0 6px; letter-spacing: 0.25em; }
#peer .pr-row { display: flex; gap: 8px; align-items: center; margin: 8px 0 0; }
#peer input { flex: 1; min-width: 0; font: inherit; padding: 7px 10px; border: 1px solid var(--rule-2); border-radius: var(--r-sm); background: var(--bg); color: var(--fg); }
#peer input:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
#peer button { font: inherit; padding: 7px 12px; border-radius: var(--r-sm); border: 1px solid var(--rule-2); background: var(--bg); color: var(--fg); cursor: pointer; }
#peer button:hover, #peer button:focus-visible { border-color: var(--fg-3); }
#peer button.pr-go { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
#peer button.pr-go[disabled] { opacity: .6; cursor: default; }
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
  clearInterval(poll); poll = 0;
  el.innerHTML = `<div class="pr-box"><h2>${title}<button type="button" class="pr-x pr-link" data-pr="close" aria-label="Close">✕</button></h2>${html}</div>`;
  el.hidden = false;
  const first = el.querySelector("input, button.pr-go, button:not(.pr-x)");
  (first || el.querySelector("button")).focus({ preventScroll: true });
  return el;
}

export function close() {
  if (!box || box.hidden) return false;
  clearInterval(poll); poll = 0;
  box.hidden = true;
  if (opener && opener.isConnected && opener !== document.body) opener.focus({ preventScroll: true });
  opener = null;
  return true;
}

const say = (s, err = false) => { const el = box?.querySelector(".pr-said"); if (el) { el.textContent = s || ""; el.classList.toggle("err", !!err); } };

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

/** The pairing sheet. `code` is a friend's code to start with, from a
 *  snyvi://pair/… link or Home's field. */
export async function pair(ctx, code = "") {
  const { esc } = ctx;
  let me = "";
  try { me = (await friends()).me.name || ""; } catch {}
  open("Pair with a friend",
    `<p>Both of you run snyvi. One makes a code and says it to the other -- over a call, a message, in the room. Nothing but the code leaves either machine until both have typed it.</p>` +
    `<div class="pr-row"><label class="pr-quiet" for="pr-name">Your name, as they will see it</label></div>` +
    `<div class="pr-row"><input id="pr-name" maxlength="60" value="${esc(me)}" autocomplete="off"></div>` +
    `<div class="pr-row"><button type="button" class="pr-go" data-pr="make">Make a code</button><span class="pr-quiet">or</span>` +
    `<input id="pr-code" placeholder="type their code" value="${esc(code)}" autocomplete="off" spellcheck="false" aria-label="A friend's code"><button type="button" data-pr="join">Join</button></div>` +
    `<div class="pr-said" aria-live="polite"></div>`);
  const name = () => box.querySelector("#pr-name")?.value.trim() || me;
  box.querySelector("[data-pr=make]").addEventListener("click", () => start(ctx, "/api/peers/pair", { name: name() }));
  const join = () => { const c = box.querySelector("#pr-code").value.trim(); if (c) start(ctx, "/api/peers/join", { name: name(), code: c }); else box.querySelector("#pr-code").focus(); };
  box.querySelector("[data-pr=join]").addEventListener("click", join);
  box.querySelector("#pr-code").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); join(); } });
  if (code) box.querySelector("[data-pr=join]").focus();
}

async function start(ctx, url, body) {
  const { esc } = ctx;
  for (const b of box.querySelectorAll("button.pr-go, [data-pr=join]")) b.disabled = true;
  say("Asking the relay…");
  let r;
  try { r = await post(url, body); }
  catch (e) { say(ctx.sayErr(e).why, true); for (const b of box.querySelectorAll("button.pr-go, [data-pr=join]")) b.disabled = false; return; }
  const made = url.endsWith("/pair");
  open("Pair with a friend",
    (made
      ? `<p>Say this to your friend, or send it. It works once, for ten minutes.</p><div class="pr-code" aria-label="Your code">${esc(r.code)}</div>` +
        `<p class="pr-quiet">They type it under <b>Pair with a friend</b> on their Home, or open <span style="font-family:var(--mono)">snyvi://pair/${esc(r.code)}</span>.</p>`
      : `<p>Waiting for <span style="font-family:var(--mono)">${esc(r.code)}</span> to meet its other half…</p>`) +
    `<div class="pr-emoji" aria-live="polite"></div><div class="pr-said" aria-live="polite">Waiting for the other side…</div>` +
    `<div class="pr-foot"><button type="button" data-pr="close">Cancel</button></div>`);
  const until = r.until * 1000;
  poll = setInterval(async () => {
    let s;
    try { s = await (await fetch(`/api/peers/pair/${encodeURIComponent(r.code)}`)).json(); } catch { return; }
    const p = s.pairing || {};
    if (p.state === "done") {
      clearInterval(poll); poll = 0;
      box.querySelector(".pr-emoji").textContent = p.emoji;
      say(`Paired with ${p.name}. Ask them: do you see these same four? If not, remove them from Home and pair again.`);
      box.querySelector(".pr-foot").innerHTML = `<button type="button" class="pr-go" data-pr="close">Done</button>`;
      box.querySelector(".pr-go").focus();
      ctx.toast(`Paired with ${p.name}`, { sub: "their documents will show under From " + p.name });
    } else if (p.state === "failed") {
      clearInterval(poll); poll = 0;
      say(p.why || "The pairing did not finish", true);
      box.querySelector(".pr-foot").innerHTML = `<button type="button" data-pr="again">Try again</button><button type="button" data-pr="close">Close</button>`;
      box.querySelector("[data-pr=again]").addEventListener("click", () => pair(ctx));
    } else if (Date.now() > until) {
      clearInterval(poll); poll = 0;
      say("The code ran out. Make a new one.", true);
      box.querySelector(".pr-foot").innerHTML = `<button type="button" data-pr="again">Try again</button><button type="button" data-pr="close">Close</button>`;
      box.querySelector("[data-pr=again]").addEventListener("click", () => pair(ctx));
    } else {
      const left = Math.max(0, Math.round((until - Date.now()) / 60000));
      say(`Waiting for the other side… ${left ? `${left} min left` : "less than a minute left"}`);
    }
  }, 2000);
}

/* ---------- send ---------- */

/** Send this document to a friend. */
export async function send(ctx, docId, title = "") {
  const { esc } = ctx;
  let j;
  try { j = await friends(); } catch (e) { ctx.toast("Could not read the friends", { sub: ctx.sayErr(e).why }); return; }
  const list = (j.friends || []).filter(f => !f.removed_at);
  open(`Send <span class="pr-title">${esc(title || "this document")}</span> to…`,
    (list.length
      ? `<ul>${list.map(f => `<li><span class="pr-nm">${esc(f.name)}</span><span class="pr-t">${f.last_to ? `last sent ${esc(ctx.rel(f.last_to))}` : "nothing sent yet"}</span><button type="button" class="pr-go" data-peer="${f.id}">Send</button></li>`).join("")}</ul>` +
        `<p class="pr-quiet" style="margin-top:10px">Sealed to their key and left at the relay; they see it under <b>From ${esc(j.me.name)}</b>. The relay holds it seven days at most, unread or not.</p>`
      : `<p>No friends yet. <b>Pair with a friend</b> on Home makes one.</p>`) +
    `<div class="pr-said" aria-live="polite"></div><div class="pr-foot"><button type="button" data-pr="close">Close</button></div>`);
  box.addEventListener("click", async e => {
    const b = e.target.closest("button[data-peer]");
    if (!b) return;
    for (const x of box.querySelectorAll("button[data-peer]")) x.disabled = true;
    say("Sealing and sending…");
    try {
      const r = await post(`/api/docs/${encodeURIComponent(docId)}/send`, { peer: +b.dataset.peer });
      say(r.sent ? `Sent to ${r.to}.` : `Queued for ${r.to}; the relay could not be reached, so it goes when it can.`);
      box.querySelector(".pr-foot").innerHTML = `<button type="button" class="pr-go" data-pr="close">Done</button>`;
      box.querySelector(".pr-go").focus();
    } catch (err) {
      say(ctx.sayErr(err).why, true);
      for (const x of box.querySelectorAll("button[data-peer]")) x.disabled = false;
    }
  });
}

/* ---------- a line for a friend's notes ---------- */

export function note(ctx, peerId, name) {
  const { esc } = ctx;
  open(`A line for ${esc(name)}`,
    `<p>It waits on their Home until they put it on one of their desks. One line, as a note is.</p>` +
    `<div class="pr-row"><input id="pr-line" maxlength="200" placeholder="What should they not forget?" autocomplete="off"><button type="button" class="pr-go" data-pr="send">Send</button></div>` +
    `<div class="pr-said" aria-live="polite"></div>`);
  const go = async () => {
    const t = box.querySelector("#pr-line").value.trim();
    if (!t) return;
    box.querySelector("[data-pr=send]").disabled = true;
    say("Sending…");
    try { await post(`/api/peers/${peerId}/note`, { text: t }); say(`Sent to ${name}.`); setTimeout(close, 900); }
    catch (e) { say(ctx.sayErr(e).why, true); box.querySelector("[data-pr=send]").disabled = false; }
  };
  box.querySelector("[data-pr=send]").addEventListener("click", go);
  box.querySelector("#pr-line").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); go(); } });
}

/* ---------- an agent's offer ---------- */

/** An agent in a panel offered a document to a friend: the question, where
 *  the reader is. `o` is the `peeroffers` event, or a row from /api/peers. */
/** What the page's event stream says about friends: an agent's offer is
 *  put to the reader where they are, with the agent's name on it; a line
 *  from a friend is a toast that opens Home, unless it came quietly. */
export function event(ctx, j) {
  if (j.offer != null) offer(ctx, j);
  else if (j.from && !j.quiet) ctx.toast(`A line from ${j.from}`, { sub: "waiting on Home, under Friends", kind: "news", go: ctx.home });
}

export function offer(ctx, o) {
  const { esc } = ctx;
  const id = o.offer != null ? o.offer : o.id;
  if (id == null) return;
  open(`Send <span class="pr-title">${esc(o.title || "a document")}</span> to ${esc(o.to || "a friend")}?`,
    `<p>${esc(o.by || "An agent")}${o.desk ? ` on the desk <b>${esc(o.desk)}</b>` : ""} offers it. Nothing has gone: it goes only if you press Send.</p>` +
    `<div class="pr-said" aria-live="polite"></div>` +
    `<div class="pr-foot"><button type="button" data-pr="no">Not now</button><button type="button" class="pr-go" data-pr="yes">Send</button></div>`);
  const answer = async yes => {
    for (const b of box.querySelectorAll(".pr-foot button")) b.disabled = true;
    try {
      const r = await post(`/api/peers/offers/${id}`, { send: yes });
      if (!yes) { close(); return; }
      say(r.sent ? `Sent to ${r.to}.` : `Queued for ${r.to}; it goes when the relay can be reached.`);
      box.querySelector(".pr-foot").innerHTML = `<button type="button" class="pr-go" data-pr="close">Done</button>`;
      box.querySelector(".pr-go").focus();
    } catch (e) { say(ctx.sayErr(e).why, true); for (const b of box.querySelectorAll(".pr-foot button")) b.disabled = false; }
  };
  box.querySelector("[data-pr=yes]").addEventListener("click", () => answer(true));
  box.querySelector("[data-pr=no]").addEventListener("click", () => answer(false));
}
