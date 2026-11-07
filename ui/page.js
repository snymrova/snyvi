/* The Page view: a desk's page, edited in place (plan 48ca2d5b9e, step 2;
 * design round 40303cb7e4, mockup b6e2d38013; docs/WALL.md).
 *
 * Not on the wire until Page is pressed in a desk's head: ui/desk's page
 * part imports it the first time, the way the Board is. The seam is three
 * calls -- `open` with everything it needs, `changed` when a `page` event
 * names this desk, and `close`.
 *
 * Left is the page as it will look, in its tone, wearing its accent and its
 * wash, every field edited where it stands. A field that was drafted says
 * where from in a small chip; the chip is the undo, and puts the draft back.
 * Right is only what the page cannot show: who sees it, the tone, the
 * accent, the hero, the facts, the count, the moments, and the press.
 *
 * Nothing here sends anything anywhere but this daemon. Publish is the
 * reader's press, and it alone makes the daemon's outbox row (crate::wall).
 */

/** The eight, as ui/app.css pairs them: light ink, dark ink. */
const EIGHT = {
  passion: ["#8c0f26", "#f97e92"], crimson: ["#b91c1c", "#f87171"], rose: ["#be185d", "#f472b6"],
  violet: ["#7c3aed", "#a78bfa"], blue: ["#1d4ed8", "#60a5fa"], teal: ["#0f766e", "#2dd4bf"],
  green: ["#137639", "#4ade80"], graphite: ["#57534e", "#d6d3d1"],
};
const TONES = [["software", "Software"], ["book", "Book"], ["design", "Design"]];
const HEROES = [["mark", "Mark"], ["picture", "Picture"], ["clip", "Clip"], ["none", "None"]];
const FACTS = [["stage", "Stage"], ["kind", "Kind"], ["last", "Last moment"], ["looking", "Looking for"]];
const WHO = [["everyone", "Everyone", "On the wall on every Home, and at snyvi.page"], ["friends", "Friends only", "Sealed to the friends you paired with"], ["off", "Off", "Nowhere: kept here"]];
/** What a chip says, by where the field came from. */
const FROM = { readme: "from README", icon: "from the logo", git: "from git remote", views: "from the views", thread: "from the threads", desk: "from the desk's name" };
/** The words a heart wears, by tone (never "like"). */
const HEART = { software: "I'd use this", book: "I'd read this", design: "I'd try this" };

let o = null;      // what `open` was handed
let read = null;   // the last read: {page, moments, offers, held, cap} or {page: null, draft, …}
let seed = null;   // a card's words, waiting for the moment form
let said = "";     // the press's row
/** Hosts already listening: a redraw replaces what is inside, never the host. */
const wired = new WeakSet();

export function open(opts) {
  o = opts;
  seed = opts.seed || null;
  style();
  if (!wired.has(o.host)) {
    wired.add(o.host);
    o.host.addEventListener("click", click);
    o.host.addEventListener("submit", submit);
  }
  o.host.innerHTML = `<p class="dk-none">Reading the page…</p>`;
  load();
}

/** An error in the maker's words (app's `sayErr`). */
const why = e => (o && o.sayErr ? o.sayErr(e).why : "something went wrong");

export function close() { o = null; read = null; seed = null; said = ""; }

/** A `page` event for this desk: read again, unless it is only the cards. */
export function changed(j) {
  if (o && j && j.desk === o.desk && j.what !== "offers") load();
}

/** Prefill the moment form with a card's words (Have a look). */
export function take(s) { seed = s; if (read) draw(); }

function load() {
  const at = o;
  o.api(`/api/desks/${o.desk}/page`).then(j => { if (o === at) { read = j; draw(); } },
    e => { if (o === at) o.host.innerHTML = `<p class="dk-none">Could not read the page: ${o.esc(why(e))}</p>`; });
}

function save(body) {
  const at = o;
  return o.api(`/api/desks/${o.desk}/page`, body).then(j => { if (o === at) { read = j; draw(); } return j; },
    e => { o?.toast("The page did not take that", why(e)); throw e; });
}

function draw() {
  if (!o || !read) return;
  const p = read.page || draftAsPage(read);
  const scroll = o.host.querySelector(".pg-left")?.scrollTop || 0;
  o.host.innerHTML = `<div class="pg">${pageHtml(p, !read.page)}${sideHtml(p, !read.page)}</div>`;
  const left = o.host.querySelector(".pg-left");
  if (left) left.scrollTop = scroll;
  wire();
}

/** A draft, shaped as a page, for the view before anything is kept. */
function draftAsPage(r) {
  const d = r.draft || {};
  return { slug: r.slug, title: d.title, lede: d.lede, kind: d.kind, tone: d.tone || "software", stage: d.stage,
    looking_for: "", logo: "", cover: "", hero: "mark", facts: FACTS.map(f => f[0]), github: d.github, links: [],
    accent: d.accent || "passion", wash: d.wash || "", count_shown: true, visibility: "off", published_at: 0,
    provenance: d.from || {}, logo_path: r.logo_path };
}

function chip(p, f) {
  const src = (p.provenance || {})[f];
  return src ? `<button type="button" class="pg-chip" data-redraft="${f}" data-tip="Put the draft back">${FROM[src] || src}</button>` : "";
}

function field(p, f, tag, cls, ph) {
  const { esc } = o, v = p[f] || "";
  return `<${tag} class="${cls}${v ? "" : " pg-empty"}" contenteditable="plaintext-only" spellcheck="true" data-f="${f}" data-ph="${esc(ph)}">${esc(v)}</${tag}>`;
}

function mark(p) {
  const { esc } = o;
  if (p.logo) return `<img class="pg-mark" src="/pages/${esc(p.logo)}" alt="">`;
  return `<span class="pg-mark pg-mark-i" aria-hidden="true">${esc((p.title || "?").trim().charAt(0).toUpperCase())}</span>`;
}

function lastMoment() {
  const m = (read.moments || [])[0];
  if (!m) return "none yet";
  return o.rel ? o.rel((m.published_at || m.created_at) * 1000) : new Date((m.published_at || m.created_at) * 1000).toLocaleDateString();
}

function factsHtml(p) {
  const on = new Set(p.facts || []), { esc } = o, cells = [];
  if (on.has("stage")) cells.push(`<div><small>Stage</small>${field(p, "stage", "b", "", "say how far")}${chip(p, "stage")}</div>`);
  if (on.has("kind")) cells.push(`<div><small>Kind</small>${field(p, "kind", "b", "", "what it is")}${chip(p, "kind")}</div>`);
  if (on.has("last")) cells.push(`<div><small>Last moment</small><b>${esc(lastMoment())}</b></div>`);
  if (on.has("looking")) cells.push(`<div><small>Looking for</small>${field(p, "looking_for", "b", "", "say what would help…")}</div>`);
  return cells.length ? `<div class="pg-facts">${cells.join("")}</div>` : "";
}

function momentsHtml() {
  const { esc } = o, ms = read.moments || [];
  if (!ms.length) return `<p class="pg-quiet">No moments yet. A moment is a chapter accepted, a release, a clip: one thing that happened, in your words.</p>`;
  return `<ol class="pg-moments">${ms.map((m, i) => `<li${i ? "" : ` class="pg-new"`}>
    <div class="pg-m-h"><b>${esc(m.title)}</b><small>${m.published_at ? "up" : "not up yet"}</small>
      <button type="button" class="pg-x" data-hide="${m.id}" data-tip="Off the page; kept">✕</button></div>
    ${m.body_md ? `<p>${esc(m.body_md)}</p>` : ""}
    ${(m.files || []).map(f => /\.(mp4|webm)$/.test(f) ? `<video src="/pages/${esc(f)}" controls preload="metadata"></video>` : `<img src="/pages/${esc(f)}" alt="">`).join("")}
  </li>`).join("")}</ol>`;
}

function pageHtml(p, draft) {
  const { esc } = o, [l, d] = EIGHT[p.accent] || EIGHT.passion;
  const wash = /^#[0-9a-f]{6}$/i.test(p.wash || "") ? p.wash : "transparent";
  const links = (p.links || []).map(k => `<li><a href="${esc(k.url)}" target="_blank" rel="noopener noreferrer">${esc(k.label || k.url)}</a></li>`).join("");
  const gh = p.github ? `<li><a href="${esc(p.github)}" target="_blank" rel="noopener noreferrer">${esc(p.github.replace(/^https:\/\//, ""))}</a>${chip(p, "github")}</li>` : "";
  return `<div class="pg-left"><article class="pg-page pg-${esc(p.tone)}" data-accent="${esc(p.accent)}" style="--accent-l:${l};--accent-d:${d};--pg-wash:${wash}">
    ${draft ? `<p class="pg-draftnote">A draft from this desk. Nothing is kept until you make it your page, and nothing leaves until you press Publish.</p>` : ""}
    <header class="pg-head">${mark(p)}<div class="pg-names">${field(p, "title", "h1", "pg-title", "the name")}${chip(p, "title")}
      <span class="pg-by">${esc(p.slug ? `snyvi.page/${p.slug}` : "")}</span></div>
      <span class="pg-heart" data-tip="What a reader presses: ${esc(HEART[p.tone] || HEART.software)}">♥${p.count_shown ? "" : " <small>count hidden</small>"}</span></header>
    <div class="pg-hero">${field(p, "lede", "p", "pg-lede", "one or two lines on what it is")}${chip(p, "lede")}</div>
    ${factsHtml(p)}
    <div class="pg-body"><section><h2>Moments</h2>${draft ? `<p class="pg-quiet">Moments come once it is your page.</p>` : momentsHtml()}</section>
      <aside class="pg-links"><h2>Links</h2><ul>${gh}${links}</ul><p class="pg-foot">Made on a snyvi desk</p></aside></div>
  </article></div>`;
}

function seg(name, items, on) {
  const { esc } = o;
  return `<div class="pg-seg" role="group">${items.map(([v, label, tip]) =>
    `<button type="button" data-${name}="${v}" aria-pressed="${on === v}"${tip ? ` data-tip="${esc(tip)}"` : ""}>${esc(label)}</button>`).join("")}</div>`;
}

function sideHtml(p, draft) {
  const { esc } = o;
  if (draft) {
    return `<div class="pg-side"><h3>Your page</h3><p class="pg-quiet">Drafted from the README, the logo, the git remote, the views and the threads. Every field is yours to change, in place.</p>
      <button type="button" class="pg-press" data-start>Make it your page</button></div>`;
  }
  const star = (p.provenance || {}).accent ? p.accent : "";
  const sw = Object.keys(EIGHT).map(n => `<button type="button" class="pg-sw${p.accent === n ? " on" : ""}" data-accent="${n}" style="--sw:${EIGHT[n][0]}" aria-label="${n}${n === star ? ", from the logo" : ""}" data-tip="${n}${n === star ? " · from the logo" : ""}">${n === star ? "★" : ""}</button>`).join("");
  const facts = FACTS.map(([f, label]) => `<label><input type="checkbox" data-fact="${f}"${(p.facts || []).includes(f) ? " checked" : ""}> ${label}</label>`).join("");
  const m = seed || {};
  const held = read.cap ? `${(read.held / 1048576).toFixed(1)} of ${Math.round(read.cap / 1048576)} MB` : "";
  return `<div class="pg-side">
    <h3>Who sees it</h3>${seg("who", WHO, p.visibility)}
    <h3>Tone</h3>${seg("tone", TONES, p.tone)}
    <h3>Accent</h3><div class="pg-sws">${sw}</div>
    <h3>Hero</h3>${seg("hero", HEROES, p.hero)}
    <h3>Facts</h3><div class="pg-facts-pick">${facts}</div>
    <h3>The count</h3>${seg("count", [["shown", "Shown"], ["hidden", "Hidden", "The hearts still come, with names, to you"]], p.count_shown ? "shown" : "hidden")}
    <h3>Pictures</h3><form class="pg-pick" data-pick><select name="field"><option value="logo">Logo</option><option value="cover">Cover</option></select>
      <input name="path" placeholder="a path in this desk's folder" autocomplete="off"><button type="submit">Use</button></form>
    <h3>Name</h3><form class="pg-pick" data-slug><input name="slug" value="${esc(p.slug)}"${p.published_at ? " disabled" : ""} autocomplete="off"><button type="submit"${p.published_at ? " disabled" : ""}>Rename</button></form>
    ${p.published_at ? `<p class="pg-quiet">It is up as ${esc(p.slug)}; the name stays.</p>` : ""}
    <h3>A moment</h3><form class="pg-moment" data-moment>
      <input name="title" maxlength="80" placeholder="what happened" value="${esc(m.title || "")}" required>
      <textarea name="body" rows="3" maxlength="4000" placeholder="in your words">${esc(m.text || "")}</textarea>
      <input name="pick" placeholder="a picture or clip in the folder (optional)" autocomplete="off">
      <input type="hidden" name="about" value="${esc(m.about || "")}">
      <button type="submit">Keep the moment</button></form>
    ${held ? `<p class="pg-quiet">Holds ${held}.</p>` : ""}
    ${heartsHtml(p)}
    <div class="pg-pressrow"><button type="button" class="pg-press" data-publish${p.visibility === "off" ? " disabled" : ""}>${up(p) ? "Publish again" : "Publish"}</button>
      <span class="pg-said" aria-live="polite">${esc(said || rowSays(p))}</span>
      ${up(p) ? `<button type="button" class="pg-quietbtn" data-down>Take it down</button>` : ""}
      ${p.visibility === "everyone" && !p.checked_at ? `<button type="button" class="pg-quietbtn" data-owner data-tip="Writes .snyvi/owner in this desk's folder; the wall reads it in the repository">Add the check to the repo</button>` : ""}</div>
  </div>`;
}

const up = p => p.up_at > 0 && p.up_at >= (p.down_at || 0);

/** What the row says when nothing was just pressed. */
function rowSays(p) {
  if (p.visibility === "off") return "Choose who sees it first.";
  if (read.waiting) return `not up yet: ${read.waiting_why || "waiting for the wall"}`;
  if (up(p) && p.visibility === "everyone" && !p.checked_at) return `up at snyvi.page/${p.slug} · not on the wall yet: add the check to the repo`;
  if (up(p)) return p.visibility === "everyone" ? `up · snyvi.page/${p.slug}` : "sent to friends";
  return "";
}

/** The wall's last line, to the builder: hearts with names, never ranked. */
function heartsHtml(p) {
  const h = read.hearts || {}, { esc } = o;
  if (!h.n) return "";
  const names = (h.names || []).slice(0, 6).join(", ");
  return `<p class="pg-quiet pg-hearts">♥ ${h.n}${h.since ? ` since ${esc(o.rel ? o.rel(h.since * 1000) : "")}` : ""}${names ? ` · ${esc(names)}` : ""}${p.count_shown ? "" : " · the count is hidden on the page"}</p>`;
}

function wire() {
  const h = o.host;
  h.querySelectorAll("[data-f]").forEach(el => {
    el.addEventListener("keydown", e => { if (e.key === "Enter" && el.tagName !== "P") { e.preventDefault(); el.blur(); } });
    el.addEventListener("blur", () => {
      const f = el.dataset.f, v = el.textContent.trim(), p = read.page || draftAsPage(read);
      if (v === (p[f] || "")) return;
      save(read.page ? { edit: { [f]: v } } : { start: true, edit: { [f]: v } }).catch(() => draw());
    });
  });
}

function click(e) {
  if (!o) return;
  const t = e.target.closest("button");
  if (!t || !o.host.contains(t)) return;
  const d = t.dataset, p = read.page;
  if ("start" in d) return void save({ start: true });
  if (d.redraft) return void save({ redraft: d.redraft });
  if (!p) return;
  if (d.who) return void save({ edit: { visibility: d.who } });
  if (d.tone) return void save({ edit: { tone: d.tone } });
  if (d.hero) return void save({ edit: { hero: d.hero } });
  if (d.accent) return void save({ edit: { accent: d.accent } });
  if (d.count) return void save({ edit: { count_shown: d.count === "shown" } });
  if (d.hide) return void o.api(`/api/desks/${o.desk}/page/moments`, { id: +d.hide, hidden: true }).then(load, err => o.toast("Not taken off", why(err)));
  if ("publish" in d) return void publish(t);
  if ("down" in d) return void o.api(`/api/desks/${o.desk}/page/down`, {}).then(j => { said = j.said || "down"; load(); }, err => { said = why(err); draw(); });
  if ("owner" in d) return void o.api(`/api/desks/${o.desk}/page/owner`, {}).then(j => { said = `written ${j.path}; commit and push it: ${j.push}`; draw(); }, err => o.toast("The check was not written", why(err)));
}

function submit(e) {
  if (!o) return;
  const f = e.target, data = Object.fromEntries(new FormData(f));
  e.preventDefault();
  if ("pick" in f.dataset) return void save({ pick: { field: data.field, path: data.path.trim() } });
  if ("slug" in f.dataset) return void save({ edit: { slug: data.slug.trim() } });
  if ("moment" in f.dataset) {
    const body = { moment: { title: data.title, body_md: data.body, about: data.about }, pick: data.pick.trim() ? [data.pick.trim()] : [] };
    o.api(`/api/desks/${o.desk}/page/moments`, body).then(() => { seed = null; load(); }, err => o.toast("The moment did not take", why(err)));
  }
}

/** The facts are checkboxes: each change is the whole set. */
document.addEventListener("change", e => {
  if (!o || !o.host.contains(e.target) || !e.target.dataset.fact) return;
  const facts = [...o.host.querySelectorAll("[data-fact]")].filter(x => x.checked).map(x => x.dataset.fact);
  save({ edit: { facts } });
});

/** The press: Everyone goes to the wall, Friends only through the relay,
 *  sealed (server/api_wall.rs). The row says how it went, in the row. */
function publish(btn) {
  btn.disabled = true;
  o.api(`/api/desks/${o.desk}/page/publish`, {}).then(j => { said = j.said || "up · just now"; load(); },
    e => { said = why(e); draw(); });
}

function style() {
  if (document.getElementById("pg-css")) return;
  const s = document.createElement("style");
  s.id = "pg-css";
  s.textContent = PAGE_CSS;
  document.head.append(s);
}

/* Max width 1040, 16 px gutters on a phone, no horizontal scroll (the design
 * round). The page redeclares --accent from its own pair, the rule app.css
 * uses, so it wears its accent in light and dark alike; the wash is a tint
 * behind the hero and the facts, never ink. */
const PAGE_CSS = `
.pg { position: absolute; inset: 0; display: grid; grid-template-columns: minmax(0, 1fr) 248px; background: var(--bg-side); container-type: inline-size; overflow: auto; }
.pg-left { overflow: auto; padding: var(--sp-6) 16px; }
.pg-page[data-accent] { --accent: light-dark(color-mix(in srgb, var(--accent-l), #000 var(--deepen)), color-mix(in srgb, var(--accent-d), #fff var(--lift))); }
.pg-page { max-width: 1040px; margin: 0 auto; background: var(--bg); border: 1px solid var(--rule); border-radius: var(--r-md); padding: 24px; color: var(--fg); }
.pg-draftnote { margin: 0 0 16px; font-size: var(--fs-small); color: var(--fg-3); }
.pg-head { display: flex; gap: 12px; align-items: center; }
.pg-mark { width: 48px; height: 48px; border-radius: var(--r-md); object-fit: contain; flex: none; }
.pg-mark-i { display: grid; place-items: center; background: var(--accent); color: var(--on-accent); font-weight: 600; font-size: 20px; }
.pg-names { flex: 1; min-width: 0; }
.pg-title { margin: 0; font-size: 26px; line-height: 1.2; }
.pg-book .pg-title, .pg-book .pg-lede { font-family: var(--serif); }
.pg-by { display: block; font-size: var(--fs-small); color: var(--fg-3); }
.pg-heart { color: var(--accent); font-size: 18px; }
.pg-heart small { font-size: var(--fs-micro); color: var(--fg-3); }
.pg-hero { margin: 16px -24px 0; padding: 16px 24px; background: color-mix(in srgb, var(--pg-wash) 12%, transparent); }
.pg-lede { margin: 0; font-size: 17px; line-height: 1.5; }
.pg-book .pg-lede { font-size: 20px; }
.pg-design .pg-lede { font-size: 15px; }
.pg-facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin: 0 -24px; padding: 12px 24px;
  background: color-mix(in srgb, var(--pg-wash) 7%, transparent); border-block: 1px solid var(--rule); }
.pg-facts small { display: block; font-size: var(--fs-micro); color: var(--fg-3); text-transform: uppercase; letter-spacing: .04em; }
.pg-facts b { font-weight: 500; }
.pg-body { display: grid; grid-template-columns: minmax(0, 1fr) 200px; gap: 24px; margin-top: 20px; }
.pg-body h2 { font-size: var(--fs-small); color: var(--fg-3); text-transform: uppercase; letter-spacing: .04em; margin: 0 0 8px; }
.pg-moments { list-style: none; margin: 0; padding: 0 0 0 14px; border-left: 2px solid var(--rule); }
.pg-moments li { margin: 0 0 16px; position: relative; }
.pg-moments li::before { content: ""; position: absolute; left: -20px; top: 6px; width: 10px; height: 10px; border-radius: 50%; background: var(--rule-2); }
.pg-moments li.pg-new::before { background: var(--accent); }
.pg-moments img, .pg-moments video { display: block; max-width: 100%; border-radius: var(--r-sm); margin-top: 8px; }
.pg-m-h { display: flex; gap: 8px; align-items: baseline; }
.pg-m-h small { color: var(--fg-3); font-size: var(--fs-micro); }
.pg-x { margin-left: auto; border: 0; background: none; color: var(--fg-3); cursor: pointer; }
.pg-links ul { list-style: none; margin: 0; padding: 0; }
.pg-links li { margin: 0 0 6px; overflow-wrap: anywhere; }
.pg-links a { color: var(--accent); }
.pg-foot { font-size: var(--fs-micro); color: var(--fg-3); margin-top: 16px; }
.pg-chip { margin-left: 6px; border: 0; border-radius: var(--r-pill); padding: 1px 8px; background: var(--rule); color: var(--fg-3); font-size: var(--fs-micro); cursor: pointer; vertical-align: middle; }
[data-f] { border-radius: var(--r-xs); }
[data-f]:focus-visible { box-shadow: 0 0 0 2px var(--focus); }
[data-f].pg-empty:empty::before { content: attr(data-ph); color: var(--fg-3); }
.pg-quiet { font-size: var(--fs-small); color: var(--fg-3); }
.pg-side { overflow: auto; padding: var(--sp-6); border-left: 1px solid var(--rule); background: var(--bg); display: flex; flex-direction: column; gap: 6px; }
.pg-side h3 { margin: 10px 0 2px; font-size: var(--fs-small); color: var(--fg-2); }
.pg-seg { display: flex; flex-wrap: wrap; gap: 4px; }
.pg-seg button, .pg-pick button, .pg-moment button { border: 1px solid var(--rule); background: var(--bg-raise); color: var(--fg); border-radius: var(--r-sm); padding: 3px 8px; font: inherit; font-size: var(--fs-small); cursor: pointer; }
.pg-seg button[aria-pressed="true"] { border-color: var(--accent); color: var(--accent); }
.pg-sws { display: flex; gap: 6px; flex-wrap: wrap; }
.pg-sw { width: 22px; height: 22px; border-radius: 50%; border: 2px solid transparent; background: var(--sw); color: var(--bg); font-size: 11px; cursor: pointer; }
.pg-sw.on { border-color: var(--fg); }
.pg-facts-pick { display: grid; grid-template-columns: 1fr 1fr; font-size: var(--fs-small); }
.pg-pick, .pg-moment { display: flex; gap: 4px; flex-wrap: wrap; }
.pg-pick input, .pg-moment input, .pg-moment textarea, .pg-pick select { flex: 1; min-width: 0; font: inherit; font-size: var(--fs-small); padding: 3px 6px; border: 1px solid var(--rule); border-radius: var(--r-sm); background: var(--bg-raise); color: var(--fg); }
.pg-moment input, .pg-moment textarea { flex-basis: 100%; }
.pg-pressrow { margin-top: 12px; display: flex; flex-direction: column; gap: 6px; }
.pg-press { border: 0; border-radius: var(--r-sm); padding: 8px 12px; background: var(--accent); color: var(--on-accent); font: inherit; font-weight: 600; cursor: pointer; }
.pg-press:disabled { opacity: .5; cursor: default; }
.pg-said { font-size: var(--fs-small); color: var(--fg-2); min-height: 1.4em; overflow-wrap: anywhere; }
.pg-quietbtn { align-self: flex-start; border: 0; background: none; padding: 0; color: var(--fg-2); font: inherit; font-size: var(--fs-small); text-decoration: underline; cursor: pointer; }
.pg-hearts { color: var(--fg-2); }
/* By its own width: beside a docked panel the view is narrower than the window. */
@container (max-width: 640px) {
  .pg-left, .pg-side { grid-column: 1 / -1; }
  .pg-side { border-left: 0; border-top: 1px solid var(--rule); }
  .pg-body { grid-template-columns: 1fr; }
  .pg-page { padding: 16px; }
  .pg-hero, .pg-facts { margin-inline: -16px; padding-inline: 16px; }
}
`;
