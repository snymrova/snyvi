/* /friend/{id}: everything between the reader and one friend, both ways,
 * newest first (1.49, audit 6f451571c6 cut C).
 *
 * Fetched when the page opens (app.js `showFriend`), so first paint never
 * pays for it. One list, from `/api/peers/{id}/talk` (src/peer/timeline.rs):
 * their documents and what went to them, their lines and promises, the
 * replies under documents either way. Each row has the buttons it has
 * elsewhere -- Open, Keep on, Reply, Answer -- and nothing new; nothing is
 * deleted here (snyvi never deletes). The foot sends: a line, or one of the
 * reader's documents found by name.
 *
 * Live: the page's stream tells it something moved (`refresh`). At the top
 * it draws again; scrolled down, a pill over the page says so and the list
 * stays where the reader is (no layout shift). */

const STYLE = `
.fr { max-width: 760px; margin: 0 auto; padding: 40px 48px 64px; }
@media (max-width: 760px) { .fr { padding: 8px 16px 48px; } }
.fr-head { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 12px; margin: 8px 0 4px; }
.fr-head h1 { margin: 0; font-size: var(--fs-h2, 20px); }
.fr-sub { margin: 0 0 18px; color: var(--fg-3); font-size: var(--fs-small); }
.fr-sub .away { color: var(--warn); }
.fr-list { list-style: none; margin: 0; padding: 0; }
.fr-it { display: flex; gap: 10px; padding: 9px 0; border-top: 1px solid var(--rule); font-size: var(--fs-ui); }
.fr-it:first-child { border-top: 0; }
.fr-dir { flex: none; width: 1.2em; color: var(--fg-3); text-align: center; line-height: 20px; }
.fr-it.in .fr-dir { color: var(--accent); }
.fr-b { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.fr-t { color: var(--fg); line-height: 20px; overflow-wrap: anywhere; }
.fr-t a { color: inherit; }
.fr-k { color: var(--fg-3); }
.fr-acts { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; color: var(--fg-3); font-size: var(--fs-small); }
.fr-acts button { padding: 0; border: 0; background: none; font: inherit; color: var(--accent); cursor: pointer; }
.fr-acts button:hover { text-decoration: underline; }
.fr-acts .ok { color: var(--ok); }
.fr-acts .warn { color: var(--warn); }
.fr-keep { display: flex; flex-wrap: wrap; gap: 6px; }
.fr-keep button { padding: 2px 8px; border: 1px solid var(--rule-2); border-radius: var(--r-sm); color: var(--fg); }
.fr-more { margin: 12px 0 0; }
.fr-more button, .fr-foot button { font: inherit; padding: 5px 12px; border: 1px solid var(--rule-2); border-radius: var(--r-sm); background: var(--bg); color: var(--fg); cursor: pointer; }
.fr-foot { position: sticky; bottom: 0; margin: 20px 0 0; padding: 12px 0 0; background: var(--bg); border-top: 1px solid var(--rule); display: flex; flex-direction: column; gap: 8px; }
.fr-foot .row { display: flex; gap: 8px; }
.fr-foot input { flex: 1; min-width: 0; font: inherit; padding: 6px 10px; border: 1px solid var(--rule-2); border-radius: var(--r-sm); background: var(--bg); color: var(--fg); }
.fr-foot input:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
.fr-pick { list-style: none; margin: 0; padding: 0; }
.fr-pick li { display: flex; gap: 10px; align-items: baseline; padding: 4px 0; font-size: var(--fs-ui); }
.fr-pick li span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fr-said { min-height: 1.3em; color: var(--fg-2); font-size: var(--fs-small); }
.fr-new { position: fixed; top: 56px; left: 50%; transform: translateX(-50%); z-index: var(--z-pop, 30); padding: 4px 12px; border-radius: var(--r-pill); border: 1px solid var(--rule-2); background: var(--bg-raise); box-shadow: var(--shadow-2); font: inherit; font-size: var(--fs-small); color: var(--fg); cursor: pointer; }
`;

let c = null, id = 0, items = [], more = false, info = null, desks = null, keepOpen = "", styled = false;

/** The page for friend `fid`, drawn into the document column. */
export async function show(ctx, fid) {
  c = ctx; id = fid; items = []; more = false; keepOpen = "";
  if (!styled) { styled = true; document.head.append(Object.assign(document.createElement("style"), { textContent: STYLE })); }
  c.docEl.innerHTML = `<div class="fr"><p class="fr-sub">…</p></div>`;
  await load(0);
  if (c.view() !== "friend") return;
  draw();
  c.docEl.querySelector("h1")?.focus({ preventScroll: true });
}

async function load(before) {
  const r = await fetch(`/api/peers/${id}/talk${before ? `?before=${before}` : ""}`).catch(() => null);
  if (!r || !r.ok) { info = null; return false; }
  const j = await r.json();
  info = j; more = j.more;
  items = before ? [...items, ...j.items] : j.items;
  return true;
}

/** Something about friends moved: read again. At the top of the page it
 *  draws at once; scrolled into the list, a pill says so, over the page. */
export async function refresh() {
  if (!c || c.view() !== "friend") return;
  const at = c.main.scrollTop;
  const keep = items.length;
  if (!(await load(0)) || c.view() !== "friend") return;
  if (at < 80) return draw();
  // What was further down stays loaded: More… brought it.
  if (keep > items.length) more = true;
  if (!c.docEl.querySelector(".fr-new")) {
    const b = Object.assign(document.createElement("button"), { className: "fr-new", type: "button", textContent: "Something new · show it" });
    b.addEventListener("click", () => { b.remove(); draw(); c.main.scrollTo({ top: 0, behavior: "smooth" }); });
    c.docEl.querySelector(".fr")?.append(b);
  }
}

function draw() {
  const { esc } = c;
  if (!info) { c.docEl.innerHTML = `<div class="fr"><h1 tabindex="-1">A friend</h1><p class="fr-sub">Could not read what passed between you.</p></div>`; return; }
  const f = info.friend, away = info.away;
  document.title = `${f.name} · snyvi`;
  const where = info.desk ? `their things land on <a href="/desk/${info.desk.id}" data-desk="${info.desk.id}">${esc(info.desk.name)}</a>` : `their things land under From ${esc(f.name)}`;
  const sub = [`paired ${esc(c.rel(f.paired_at))}`, away ? `<span class="away">away since ${esc(c.rel(away))}; what you send waits for them</span>` : "", where, f.muted ? "muted" : ""].filter(Boolean).join(" · ");
  c.docEl.innerHTML = `<div class="fr"><div class="fr-head"><h1 tabindex="-1">${c.who(f.name)} ${esc(f.name)}</h1></div><p class="fr-sub">${sub}</p>` +
    (items.length ? `<ul class="fr-list">${items.map(row).join("")}</ul>` : `<p class="fr-sub">Nothing has passed between you yet. A line or a document, below, starts it.</p>`) +
    (more ? `<p class="fr-more"><button type="button" data-fr="more">More…</button></p>` : "") +
    `<div class="fr-foot"><div class="row"><input id="fr-line" maxlength="400" placeholder="A line for ${esc(f.name)}…" autocomplete="off" aria-label="A line for ${esc(f.name)}"><button type="button" data-fr="line">Send</button></div>` +
    `<div class="row"><input id="fr-find" placeholder="Send a document: its name…" autocomplete="off" aria-label="Find a document to send"></div><ul class="fr-pick"></ul><div class="fr-said" aria-live="polite"></div></div></div>`;
  wire();
}

/** How far something that went got, in a word, with when. */
function went(x) {
  const { esc } = c;
  if (!x.sent_at) return x.waiting ? `<span class="warn">waiting: ${esc(x.waiting)}</span>` : `<span>waiting to go</span>`;
  if (x.done_at) return `<span class="ok">${x.kind === "promise" ? "kept" : "done"} ✓${x.commit ? ` · ${esc(x.commit.slice(0, 7))}` : ""}</span>`;
  if (x.read_at) return `<span>read ${esc(c.rel(x.read_at))}</span>`;
  if (x.arrived_at) return `<span>arrived ${esc(c.rel(x.arrived_at))}</span>`;
  if (x.held_at) return `<span class="warn">waiting while they are away</span>`;
  return `<span>sent ${esc(c.rel(x.sent_at))}</span>`;
}

function row(x) {
  const { esc } = c, f = info.friend, inn = x.dir === "in";
  const when = `<span>${esc(c.rel(x.at))}</span>`;
  const due = x.due_at ? `<span>by ${esc(new Date(x.due_at * 1000).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" }))}</span>` : "";
  let what = "", acts = "";
  if (x.kind === "doc") {
    what = `<a href="/d/${esc(x.doc_id)}" data-id="${esc(x.doc_id)}">${esc(x.text || "a document")}</a>`;
    acts = inn ? `${when}<button type="button" data-fr="keepdoc" data-k="${esc(x.doc_id)}">Keep on a desk…</button><button type="button" data-fr="reply" data-k="${esc(x.doc_id)}">Reply…</button>`
      : `${when}${went(x)}`;
  } else if (x.kind === "reply") {
    what = `<span class="fr-k">${inn ? `${esc(f.name)} replied:` : "You replied:"}</span> ${linked(x.text)}`;
    acts = `${when}<a href="/d/${esc(x.doc_id)}" data-id="${esc(x.doc_id)}">the document</a>` + (inn ? `<button type="button" data-fr="answer" data-k="${esc(x.doc_id)}">Answer…</button>` : "");
  } else if (x.kind === "promise") {
    what = `<span class="fr-k">${inn ? `${esc(f.name)} promised you:` : "You promised:"}</span> ${linked(x.text)}`;
    acts = `${when}${due}${inn ? (x.done_at ? `<span class="ok">kept ✓</span>` : "") : went(x)}`;
  } else {
    what = linked(x.text);
    const state = x.removed_at ? "<span>put away</span>" : x.done_at ? `<span class="ok">ticked and told ✓</span>` : x.taken_at ? "<span>kept on a desk</span>" : "";
    acts = inn ? `${when}${due}${state || `<button type="button" data-fr="keepline" data-k="${x.note_id}" aria-expanded="${keepOpen === x.key}">Keep on ▾</button>`}` : `${when}${due}${went(x)}`;
  }
  const list = keepOpen === x.key && desks ? `<div class="fr-keep" role="menu">${desks.map(d => `<button type="button" role="menuitem" data-fr="keepto" data-k="${x.note_id}" data-n="${d.id}">${esc(d.name)}</button>`).join("") || "<span>No desk yet.</span>"}</div>` : "";
  return `<li class="fr-it ${inn ? "in" : "out"}" data-key="${esc(x.key)}"><span class="fr-dir" aria-label="${inn ? `from ${esc(f.name)}` : "from you"}">${inn ? "↙" : "↗"}</span><span class="fr-b"><span class="fr-t">${what}</span><span class="fr-acts">${acts}</span>${list}</span></li>`;
}

/** A line, escaped, with its web links as links out: Home's `linkedLine`
 *  (ui/home.js), copied since chunks cannot import each other -- http or
 *  https, never this machine, bidi controls off, nothing fetched. */
function linked(text) {
  const { esc } = c;
  text = String(text || "").replace(/[\u202a-\u202e\u2066-\u2069]/g, "");
  let html = "", from = 0;
  for (const m of text.matchAll(/https?:\/\/[^\s<>"'`]+/g)) {
    let s = m[0].replace(/[.,;:!?'"]+$/, "");
    while (s.endsWith(")") && s.split(")").length > s.split("(").length) s = s.slice(0, -1);
    let u;
    try { u = new URL(s); } catch { continue; }
    if (!u.hostname || /^(localhost|127\.|0\.0\.0\.0|\[::1?\])/i.test(u.hostname)) continue;
    const host = u.host.replace(/^www\./, ""), rest = (u.pathname === "/" ? "" : u.pathname) + u.search + u.hash;
    html += esc(text.slice(from, m.index)) + `<a href="${esc(s)}" target="_blank" rel="noopener noreferrer">${esc(host + (rest.length > 28 ? rest.slice(0, 28) + "…" : rest))}</a>`;
    from = m.index + s.length;
  }
  return html + esc(text.slice(from));
}

/** A POST and its answer; an error the daemon said is thrown with its words. */
async function post(url, body) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
  let j = null; try { j = await r.json(); } catch {}
  if (!r.ok) throw new Error((j && j.error) || `snyvi answered ${r.status}`);
  return j || {};
}

function said(t) { const el = c.docEl.querySelector(".fr-said"); if (el) el.textContent = t; }

function wire() {
  const root = c.docEl.querySelector(".fr");
  if (!root) return;
  const line = root.querySelector("#fr-line"), find = root.querySelector("#fr-find");
  const sendLine = async () => {
    const t = line.value.trim();
    if (!t) return;
    if ([...t].length > 200) return said(`${[...t].length} characters; a line holds 200.`);
    said("Sending…");
    try {
      const r = await post(`/api/peers/${id}/note`, { text: t });
      line.value = "";
      said(r.sent ? `Sent to ${r.to}.` : `Waiting for ${r.to}; it goes when they can be reached.`);
      refresh();
    } catch (e) { said(c.sayErr(e).why); }
  };
  line.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); sendLine(); } });
  let timer = 0;
  find.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => pick(find.value.trim()), 180); });
  root.addEventListener("click", async e => {
    const b = e.target.closest("[data-fr]");
    if (!b) return;
    const k = b.dataset.fr, key = b.dataset.k;
    if (k === "more") { const last = items.at(-1); if (last && await load(last.at)) draw(); }
    else if (k === "line") sendLine();
    else if (k === "reply" || k === "answer") {
      const m = await c.peerCtx.peer();
      const it = items.find(x => x.doc_id === key && x.kind === "doc") || {};
      m.reply(c.peerCtx, key, info.friend.name, it.text || "", k === "answer" ? id : 0);
    }
    else if (k === "keepdoc") { const m = await c.peerCtx.peer(); const it = items.find(x => x.doc_id === key) || {}; m.keepOn(c.peerCtx, [key], it.text || ""); }
    else if (k === "keepline") {
      const it = items.find(x => x.note_id === +key);
      keepOpen = keepOpen === it?.key ? "" : it?.key || "";
      if (keepOpen && !desks) { try { desks = ((await c.deskApi("/api/desks")).desks || []).filter(d => !d.parked); } catch { desks = []; } }
      draw();
    }
    else if (k === "keepto") {
      try {
        const r = await c.deskApi(`/api/peers/notes/${key}`, { what: "keep", desk: +b.dataset.n });
        keepOpen = ""; said(`Kept on ${r.name}.`); refresh();
      } catch (err) { said(c.sayErr(err).why); }
    }
    else if (k === "send") {
      b.disabled = true;
      try {
        let r = await post(`/api/docs/${encodeURIComponent(key)}/send`, { peer: id });
        if (r.already) { said(`${r.to} already has this version: it arrived ${c.rel(r.already)}. Press Send again to send it anyway.`); b.textContent = "Send again"; b.dataset.fr = "again"; b.disabled = false; return; }
        said(r.sent ? `Sent to ${r.to}.` : `Waiting for ${r.to}; it goes when they can be reached.`); refresh();
      } catch (err) { said(c.sayErr(err).why); b.disabled = false; }
    }
    else if (k === "again") {
      b.disabled = true;
      try { const r = await post(`/api/docs/${encodeURIComponent(key)}/send`, { peer: id, again: true }); said(r.sent ? `Sent to ${r.to} again.` : `Waiting for ${r.to}.`); refresh(); }
      catch (err) { said(c.sayErr(err).why); b.disabled = false; }
    }
  });
}

/** Documents by name, to send: a search of the library as the field is
 *  typed in, eight at most; nothing while it is empty. */
async function pick(q) {
  const { esc } = c, ul = c.docEl.querySelector(".fr-pick");
  if (!ul) return;
  if (!q) { ul.innerHTML = ""; return; }
  let hits = [];
  try { hits = await (await fetch(`/api/search?q=${encodeURIComponent(q)}&limit=8`)).json(); } catch { hits = []; }
  ul.innerHTML = hits.map(h => `<li><span>${esc(h.title)} <span class="fr-k">· ${esc(h.project)}</span></span><button type="button" data-fr="send" data-k="${esc(h.id)}">Send</button></li>`).join("") ||
    `<li><span class="fr-k">Nothing by that name.</span></li>`;
}
