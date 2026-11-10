/* The Page view: a desk's page, edited in place (plan 48ca2d5b9e, step 2;
 * docs/WALL.md; 1.62's template A and intro, views audit e512285a2b).
 *
 * Not on the wire until Page is opened from a desk's ⋯: ui/desk's page
 * part imports it the first time, the way the Board is. The seam is three
 * calls -- `open` with everything it needs, `changed` when a `page` event
 * names this desk, and `close`.
 *
 * Before there is a page, the view says what one is -- What are you
 * building? -- and offers the two ways in: Claude builds it (the reader's
 * press types snyvi's words into the docked Claude, which fills the fields
 * with `page_draft`), or the reader starts from the draft shown under it.
 *
 * Then: left is the page as it will look at snyvi.page, drawn by the same
 * template the Worker draws with (ui/page-template.js), every word edited
 * where it stands. A field that was drafted says where from in a small
 * chip; the chip is the undo, and puts the draft back. Right is only what
 * the page cannot show: asking Claude, the three things Publish needs (who
 * sees it, its name, the count) and the press; the look and a moment fold
 * away under them.
 *
 * Nothing here sends anything anywhere but this daemon. Publish is the
 * reader's press, and it alone makes the daemon's outbox row (crate::wall).
 *
 * Once it is up (1.62, social audit 16627c32e2): Copy link and Post it…
 * beside the press and on each moment that is up. Post it… opens the
 * builder's own X, Bluesky or LinkedIn compose box in their browser with
 * the words and the address in it; they post, snyvi never does. Checked,
 * the page offers its README badge; unchecked, Claude in the panel can
 * commit and push the check when asked.
 */

const PAGE = "https://snyvi.page";

const TONES = [["software", "Software"], ["book", "Book"], ["design", "Design"]];
const HEROES = [["picture", "Picture"], ["none", "None"]];
const FACTS = [["stage", "Stage"], ["kind", "Kind"], ["last", "Last moment"], ["looking", "Looking for"]];
const WHO = [["everyone", "Everyone", "On the wall on every Home, and at snyvi.page"], ["friends", "Friends only", "Sealed to the friends you paired with"], ["off", "Off", "Nowhere: kept here"]];
/** What a chip says, by where the field came from. */
const FROM = { readme: "from README", icon: "from the logo", git: "from git remote", views: "from the views", thread: "from the threads", desk: "from the desk's name" };

let o = null;      // what `open` was handed
let T = null;      // ui/page-template.js, once loaded
let read = null;   // the last read: {page, moments, offers, held, cap} or {page: null, draft, …}
let seed = null;   // a card's words, waiting for the moment form
let said = "";     // the press's row
let asked = "";    // what Ask Claude said, in its box
let wrote = "";    // .snyvi/owner, once written here: Claude can push it
/** Hosts already listening: a redraw replaces what is inside, never the host. */
const wired = new WeakSet();

export function open(opts) {
  o = opts;
  seed = opts.seed || null;
  asked = "";
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

export function close() { o = null; read = null; seed = null; said = ""; asked = ""; wrote = ""; }

/** A `page` event for this desk: read again, unless it is only the cards. */
export function changed(j) {
  if (o && j && j.desk === o.desk && j.what !== "offers") load();
}

/** Prefill the moment form with a card's words (Have a look). */
export function take(s) { seed = s; if (read) draw(); }

/** The template, from the same build as this file. */
function template() {
  if (T) return Promise.resolve(T);
  return import(`/assets/page-template.js${new URL(import.meta.url).search}`).then(m => (T = m));
}

function load() {
  const at = o;
  Promise.all([o.api(`/api/desks/${o.desk}/page`), template()]).then(([j]) => { if (o === at) { read = j; draw(); } },
    e => { if (o === at) o.host.innerHTML = `<p class="dk-none">Could not read the page: ${o.esc(why(e))}</p>`; });
}

function save(body) {
  const at = o;
  return o.api(`/api/desks/${o.desk}/page`, body).then(j => { if (o === at) { read = j; draw(); } return j; },
    e => { o?.toast("The page did not take that", why(e)); throw e; });
}

function draw() {
  if (!o || !read || !T) return;
  const p = read.page || draftAsPage(read);
  const scroll = o.host.querySelector(".pg-left")?.scrollTop || 0;
  const folds = [...o.host.querySelectorAll("details[data-fold]")].filter(d => d.open).map(d => d.dataset.fold);
  o.host.innerHTML = read.page
    ? `<div class="pg">${pageHtml(p, false)}${sideHtml(p, folds)}</div>`
    : `<div class="pg pg-new">${pageHtml(p, true)}</div>`;
  const left = o.host.querySelector(".pg-left");
  if (left) left.scrollTop = scroll;
  wire();
}

/** A draft, shaped as a page, for the view before anything is kept. */
function draftAsPage(r) {
  const d = r.draft || {};
  return { slug: r.slug, title: d.title, lede: d.lede, kind: d.kind, tone: d.tone || "software", stage: d.stage,
    looking_for: "", logo: "", cover: "", hero: "mark", facts: FACTS.map(f => f[0]), github: d.github, links: [],
    cta: { label: "", url: "" }, points: [], story: "",
    accent: d.accent || "passion", wash: d.wash || "", count_shown: true, visibility: "off", published_at: 0,
    provenance: d.from || {}, logo_path: r.logo_path };
}

function chip(p, f) {
  const src = (p.provenance || {})[f];
  return src ? `<button type="button" class="pg-chip" data-redraft="${f}" data-tip="Put the draft back">${FROM[src] || src}</button>` : "";
}

/** A field edited where it stands: `f` the page's, or `data` its own. */
function field(f, v, tag, cls, ph, data = `data-f="${f}"`) {
  const { esc } = o;
  return `<${tag} class="${cls}${v ? "" : " pg-empty"}" contenteditable="plaintext-only" spellcheck="true" ${data} data-ph="${esc(ph)}">${esc(v || "")}</${tag}>`;
}

function mark(p) {
  const { esc } = o;
  if (p.logo) return `<img class="pt-mark" src="/pages/${esc(p.logo)}" alt="">`;
  return `<span class="pt-mark pt-mark-i" aria-hidden="true">${esc((p.title || "?").trim().charAt(0).toUpperCase())}</span>`;
}

const when = m => (o.rel ? o.rel((m.published_at || m.created_at) * 1000) : new Date((m.published_at || m.created_at) * 1000).toLocaleDateString());

function factsHtml(p) {
  const on = new Set(p.facts || []), { esc } = o, cells = [], m = (read.moments || [])[0];
  if (on.has("stage")) cells.push(`<div><small>Stage</small>${field("stage", p.stage, "b", "", "say how far")}${chip(p, "stage")}</div>`);
  if (on.has("kind")) cells.push(`<div><small>Kind</small>${field("kind", p.kind, "b", "", "what it is")}${chip(p, "kind")}</div>`);
  if (on.has("last")) cells.push(`<div><small>Last moment</small><b>${esc(m ? when(m) : "none yet")}</b></div>`);
  if (on.has("looking")) cells.push(`<div><small>Looking for</small>${field("looking_for", p.looking_for, "b", "", "what would help…")}</div>`);
  return cells.join("");
}

/** Three cards, always three here: one left empty is not on the page. */
function pointsHtml(p) {
  const ps = p.points || [];
  return [0, 1, 2].map(i => `<div class="${ps[i] ? "" : "pg-faint"}">` +
    field("", (ps[i] || {}).title, "b", "", "a reason, in a few words", `data-pt="${i}" data-k="title"`) +
    field("", (ps[i] || {}).text, "p", "", "and a line on it", `data-pt="${i}" data-k="text"`) + `</div>`).join("");
}

function momentsHtml() {
  const { esc } = o, ms = read.moments || [];
  if (!ms.length) return `<p class="pt-quiet">No moments yet. A moment is a chapter accepted, a release, a clip: one thing that happened, in your words.</p>`;
  return `<ul class="pt-tl">${ms.map(m => `<li><time>${esc(when(m))}</time><div>
    <h4>${esc(m.title)} <small class="pg-up">${m.published_at ? "up" : "not up yet"}</small>${m.published_at && shared(read.page) ? shareHtml(`${PAGE}/${read.page.slug}/m/${m.id}`, m.title) : ""}
      <button type="button" class="pg-x" data-hide="${m.id}" data-tip="Off the page; kept" aria-label="Take ${esc(m.title)} off the page">✕</button></h4>
    ${m.body_md ? `<p>${esc(m.body_md)}</p>` : ""}
    ${(m.files || []).map(f => /\.(mp4|webm)$/.test(f) ? `<video src="/pages/${esc(f)}" controls preload="metadata"></video>` : `<img src="/pages/${esc(f)}" alt="">`).join("")}
  </div></li>`).join("")}</ul>`;
}

/** The intro, before there is a page: what one is, and the two ways in. */
function introHtml() {
  const { esc } = o;
  return `<section class="pg-intro" aria-label="What are you building?">
    <h2>What are you building?</h2>
    <p>Your page says it in one place: what it is, why you're making it, and what happened lately. It's a landing page at <b>snyvi.page/${esc(read.slug || "")}</b>, in snyvi's look and your accent.</p>
    <p>Publish it for everyone and it goes on <i>What people are building</i>, on every snyvi's Home. People who like it press ♥ or follow it, and once a day you hear who, and how many opened it. Each thing you ship can be a moment on it, with an address of its own to post where your people are.</p>
    <div class="pg-intro-b"><button type="button" class="pg-press" data-ask-build>Ask Claude to build it</button>
      <button type="button" class="pg-quietbtn" data-start>Start from the draft below</button></div>
    <p class="pg-asked" aria-live="polite">${esc(asked)}</p>
    <p class="pg-quiet">Claude reads this project and writes the words; nothing leaves this machine until you press Publish.</p>
  </section>`;
}

function pageHtml(p, draft) {
  const { esc } = o;
  const links = [
    p.github ? `<li><a href="${esc(p.github)}" target="_blank" rel="noopener noreferrer">${esc(p.github.replace(/^https:\/\//, ""))}</a>${chip(p, "github")}</li>` : "",
    ...(p.links || []).map(k => `<li><a href="${esc(k.url)}" target="_blank" rel="noopener noreferrer">${esc(k.label || k.url)}</a></li>`),
  ].join("");
  // In here the button's words are a field, so it is a box, not a link.
  const cta = p.cta && p.cta.url
    ? `<span class="pt-btn">${field("", p.cta.label, "span", "", "the button's words", "data-cta")} →</span>`
    : (draft ? "" : `<button type="button" class="pt-ghost pg-faint" data-look-open>Add a main link</button>`);
  const cover = p.hero === "picture" && p.cover
    ? (/\.(mp4|webm)$/.test(p.cover) ? `<video src="/pages/${esc(p.cover)}" muted preload="metadata"></video>` : `<img src="/pages/${esc(p.cover)}" alt="">`) : "";
  const page = T.layout({
    tone: p.tone, style: T.vars(p),
    note: draft ? `<p class="pg-draftnote">A draft from this desk's README, logo and git remote. Nothing is kept until you start, and nothing leaves until you press Publish.</p>` : "",
    mark: mark(p),
    heart: `<span class="pt-heart" data-tip="What a reader presses">♥ ${esc(T.HEART[p.tone] || T.HEART.software)}${p.count_shown ? "" : " <small>count hidden</small>"}</span>`,
    title: field("title", p.title, "h1", "pt-title", "the name") + chip(p, "title"),
    lede: field("lede", p.lede, "p", "pt-lede", "one or two lines on what it is, and for whom") + chip(p, "lede"),
    cta, cover, facts: factsHtml(p),
    points: draft ? "" : pointsHtml(p),
    story: draft ? "" : field("story", p.story, "div", "pg-story", "why you're building it, in a few paragraphs"),
    moments: draft ? `<p class="pt-quiet">Moments come once it is your page.</p>` : momentsHtml(),
    links: links ? `<ul>${links}</ul>` : "",
    foot: `Made on <u>snyvi</u> · build yours →`,
  });
  return `<div class="pg-left">${draft ? introHtml() : ""}<div class="pg-sheet">${page}</div></div>`;
}

function seg(name, items, on) {
  const { esc } = o;
  return `<div class="pg-seg" role="group">${items.map(([v, label, tip]) =>
    `<button type="button" data-${name}="${v}" aria-pressed="${on === v}"${tip ? ` data-tip="${esc(tip)}"` : ""}>${esc(label)}</button>`).join("")}</div>`;
}

function sideHtml(p, folds) {
  const { esc } = o;
  const star = (p.provenance || {}).accent ? p.accent : "";
  const sw = Object.keys(T.EIGHT).map(n => `<button type="button" class="pg-sw${p.accent === n ? " on" : ""}" data-accent="${n}" style="--sw:${T.EIGHT[n][0]}" aria-label="${n}${n === star ? ", from the logo" : ""}" data-tip="${n}${n === star ? " · from the logo" : ""}">${n === star ? "★" : ""}</button>`).join("");
  const facts = FACTS.map(([f, label]) => `<label><input type="checkbox" data-fact="${f}"${(p.facts || []).includes(f) ? " checked" : ""}> ${label}</label>`).join("");
  const m = seed || {};
  const held = read.cap ? `${(read.held / 1048576).toFixed(1)} of ${Math.round(read.cap / 1048576)} MB` : "";
  const cta = p.cta || {};
  const open = k => (folds.includes(k) || (k === "moment" && seed) ? " open" : "");
  return `<div class="pg-side">
    <form class="pg-ask" data-ask><h3>Ask Claude</h3>
      <input name="what" maxlength="300" autocomplete="off" placeholder="what to change, or leave it to Claude" aria-label="What should Claude change on the page?">
      <button type="submit">Ask</button><p class="pg-asked" aria-live="polite">${esc(asked)}</p></form>
    <h3>Who sees it</h3>${seg("who", WHO, p.visibility)}
    <h3>Its name</h3><form class="pg-pick" data-slug><input name="slug" value="${esc(p.slug)}"${p.published_at ? " disabled" : ""} autocomplete="off" aria-label="The page's name, in its address"><button type="submit"${p.published_at ? " disabled" : ""}>Rename</button></form>
    ${p.published_at ? `<p class="pg-quiet">It is up as ${esc(p.slug)}; the name stays.</p>` : ""}
    <h3>The count</h3>${seg("count", [["shown", "Shown"], ["hidden", "Hidden", "The hearts still come, with names, to you"]], p.count_shown ? "shown" : "hidden")}
    <div class="pg-pressrow"><button type="button" class="pg-press" data-publish${p.visibility === "off" ? " disabled" : ""}>${up(p) ? "Publish again" : "Publish"}</button>
      <span class="pg-said" aria-live="polite">${esc(said || rowSays(p))}</span>
      ${up(p) ? `<button type="button" class="pg-quietbtn" data-down>Take it down</button>` : ""}
      ${shared(p) ? shareHtml(`${PAGE}/${p.slug}`, p.lede ? `${p.title}: ${p.lede}` : p.title) : ""}
      ${p.visibility === "everyone" && !p.checked_at ? `<button type="button" class="pg-quietbtn" data-owner data-tip="Writes .snyvi/owner in this desk's folder; the wall reads it in the repository">Add the check to the repo</button>` : ""}
      ${wrote && !p.checked_at ? `<button type="button" class="pg-quietbtn" data-ask-push data-tip="Types it into the docked Claude: commit ${esc(wrote)} on its own and push it">Ask Claude to push it</button>` : ""}</div>
    ${heartsHtml(p)}${badgeHtml(p, folds)}
    <details class="pg-fold" data-fold="look"${open("look")}><summary>The look</summary>
      <h3>Tone</h3>${seg("tone", TONES, p.tone)}
      <h3>Accent</h3><div class="pg-sws">${sw}</div>
      <h3>The picture</h3>${seg("hero", HEROES, p.hero === "picture" ? "picture" : "none")}
      <form class="pg-pick" data-pick><select name="field" aria-label="Which picture"><option value="cover">Cover</option><option value="logo">Logo</option></select>
        <input name="path" placeholder="a path in this desk's folder" autocomplete="off" aria-label="A picture's path"><button type="submit">Use</button></form>
      <h3>The main link</h3><form class="pg-pick" data-cta-form>
        <input name="label" maxlength="40" value="${esc(cta.label || "")}" placeholder="its words: Try the beta" autocomplete="off" aria-label="The main link's words">
        <input name="url" maxlength="300" value="${esc(cta.url || "")}" placeholder="https://…" autocomplete="off" aria-label="The main link's address"><button type="submit">Set</button></form>
      <h3>Facts</h3><div class="pg-facts-pick">${facts}</div>
      ${held ? `<p class="pg-quiet">Holds ${held}.</p>` : ""}
    </details>
    <details class="pg-fold" data-fold="moment"${open("moment")}><summary>A moment</summary>
      <form class="pg-moment" data-moment>
      <input name="title" maxlength="80" placeholder="what happened" value="${esc(m.title || "")}" required aria-label="What happened">
      <textarea name="body" rows="3" maxlength="4000" placeholder="in your words" aria-label="In your words">${esc(m.text || "")}</textarea>
      <input name="pick" placeholder="a picture or clip in the folder (optional)" autocomplete="off" aria-label="A picture or clip">
      <input type="hidden" name="about" value="${esc(m.about || "")}">
      <button type="submit">Keep the moment</button></form>
    </details>
  </div>`;
}

const up = p => p.up_at > 0 && p.up_at >= (p.down_at || 0);
/** Up for everyone: it has an address worth posting. */
const shared = p => !!p && up(p) && p.visibility === "everyone";

/** Copy link, and Post it… to the builder's own account: three compose
 *  boxes, each a link that opens in their browser with the words in it.
 *  The menu opens over what is under it; nothing moves. */
function shareHtml(url, text) {
  const { esc } = o, e = encodeURIComponent, t = String(text || "").slice(0, 200);
  const to = [["X", `https://x.com/intent/post?text=${e(t)}&url=${e(url)}`], ["Bluesky", `https://bsky.app/intent/compose?text=${e(`${t} ${url}`)}`],
    ["LinkedIn", `https://www.linkedin.com/sharing/share-offsite/?url=${e(url)}`]];
  return `<span class="pg-share"><button type="button" class="pg-quietbtn" data-copy="${esc(url)}" data-tip="${esc(url.replace(/^https:\/\//, ""))}">Copy link</button>` +
    `<details class="pg-post"><summary class="pg-quietbtn">Post it…</summary><div role="menu">${to.map(([n, u]) =>
      `<a role="menuitem" href="${esc(u)}" target="_blank" rel="noopener noreferrer">On ${n}</a>`).join("")}<p>Your account, your words; snyvi posts nothing.</p></div></details></span>`;
}

/** Checked and on the wall: the line a README shows its badge with. */
function badgeHtml(p, folds) {
  if (!shared(p) || !p.checked_at) return "";
  const { esc } = o, line = `[![${p.title} on snyvi.page](${PAGE}/${p.slug}/badge.svg)](${PAGE}/${p.slug})`;
  return `<details class="pg-fold" data-fold="badge"${folds.includes("badge") ? " open" : ""}><summary>A badge for the README</summary>
    <p class="pg-quiet">It shows the page's name${p.count_shown ? " and its hearts" : ""}, and opens the page.</p>
    <input class="pg-badge" readonly value="${esc(line)}" aria-label="The badge's Markdown">
    <div class="pg-intro-b"><button type="button" class="pg-quietbtn" data-copy="${esc(line)}">Copy</button>
      <button type="button" class="pg-quietbtn" data-ask-badge>Ask Claude to add it</button></div></details>`;
}

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
  if (!h.n && !h.follows && !h.reads) return "";
  const names = (h.names || []).slice(0, 6).join(", "), fols = (h.followers || []).slice(0, 6).join(", ");
  const heard = [h.n ? `♥ ${h.n}${h.since ? ` since ${o.rel ? o.rel(h.since * 1000) : ""}` : ""}${names ? ` · ${names}` : ""}${p.count_shown ? "" : " · the count is hidden on the page"}` : "",
    h.follows ? `${h.follows} follow${fols ? `, lately ${fols}` : ""}` : "", h.reads ? `opened ${h.reads} times this week` : ""].filter(Boolean);
  return heard.length ? `<p class="pg-quiet pg-hearts">${esc(heard.join(" · "))}</p>` : "";
}

/** An edit from the page: kept, or the page started with it. */
const edit = e => save(read.page ? { edit: e } : { start: true, edit: e }).catch(() => draw());

function wire() {
  const p = () => read.page || draftAsPage(read);
  o.host.querySelectorAll("[data-f], [data-pt], [data-cta]").forEach(el => {
    const many = el.dataset.f === "story";
    el.addEventListener("keydown", e => { if (e.key === "Enter" && !many && el.tagName !== "P") { e.preventDefault(); el.blur(); } });
    el.addEventListener("blur", () => {
      if (el.dataset.pt != null) return pointsBlur();
      const v = (many ? el.innerText : el.textContent).trim();
      if ("cta" in el.dataset) { const c = p().cta || {}; if (v !== (c.label || "")) edit({ cta: { label: v, url: c.url || "" } }); return; }
      const f = el.dataset.f;
      if (v !== (p()[f] || "")) edit({ [f]: v });
    });
  });
}

/** The three points are one field: any of them changed sends all three. */
function pointsBlur() {
  const text = (i, k) => (o.host.querySelector(`[data-pt="${i}"][data-k="${k}"]`)?.textContent || "").trim();
  const kept = [0, 1, 2].map(i => ({ title: text(i, "title"), text: text(i, "text") })).filter(x => x.title || x.text);
  const now = ((read.page || {}).points || []).map(x => ({ title: x.title, text: x.text || "" }));
  if (JSON.stringify(kept) === JSON.stringify(now)) return;
  edit({ points: kept });
}

/* Ask Claude (1.62, decision 2): snyvi's words, with the reader's in them,
 * typed into the docked Claude when it is at its prompt (`o.ask`, the views
 * part's), else copied; what came of it is said where the press was. */
function askClaude(what) {
  const w = String(what || "").replace(/[\x00-\x1f\x7f]+/g, " ").trim();
  const text = read.page
    ? (w ? `Update this desk's snyvi page with page_draft: ${w}. Keep the rest. Don't publish; that's mine.`
      : `Read this project again and refresh this desk's snyvi page with page_draft where it is out of date. Don't publish; that's mine.`)
    : `Build this desk's snyvi page with page_draft: read the project (the README, what it does, who it's for), then fill the title, a lede of one or two lines, the main link, three points and the story, in my voice as far as you can tell it. Pick a picture in the folder for the cover, or take a screenshot of the work into it. Don't publish; that's mine.`;
  const why = o.ask ? o.ask(text) : "Ask Claude needs a panel beside the page.";
  asked = why || "Asked. The page fills in as Claude writes it.";
  draw();
}

/** Ask Claude for a chore of the page's, said in the press's row. */
function askFor(text) {
  said = (o.ask ? o.ask(text) : "Ask Claude needs a panel beside the page.") || "Asked Claude in the panel.";
  draw();
}

/** Copy, said on the button that was pressed. */
function copy(btn, text) {
  const was = btn.textContent;
  navigator.clipboard.writeText(text).then(() => { btn.textContent = "Copied"; }, () => { btn.textContent = "Not copied"; })
    .finally(() => setTimeout(() => { if (btn.isConnected) btn.textContent = was; }, 1600));
}

function click(e) {
  if (!o) return;
  const t = e.target.closest("button");
  if (!t || !o.host.contains(t)) return;
  const d = t.dataset, p = read.page;
  if ("askBuild" in d) return void askClaude("");
  if (d.copy) return void copy(t, d.copy);
  if ("start" in d) return void save({ start: true });
  if (d.redraft) return void save({ redraft: d.redraft });
  if (!p) return;
  if ("lookOpen" in d) { const f = o.host.querySelector('[data-fold="look"]'); if (f) { f.open = true; f.querySelector("[data-cta-form] input")?.focus(); } return; }
  if (d.who) return void save({ edit: { visibility: d.who } });
  if (d.tone) return void save({ edit: { tone: d.tone } });
  if (d.hero) return void save({ edit: { hero: d.hero } });
  if (d.accent) return void save({ edit: { accent: d.accent } });
  if (d.count) return void save({ edit: { count_shown: d.count === "shown" } });
  if (d.hide) return void o.api(`/api/desks/${o.desk}/page/moments`, { id: +d.hide, hidden: true }).then(load, err => o.toast("Not taken off", why(err)));
  if ("publish" in d) return void publish(t);
  if ("down" in d) return void o.api(`/api/desks/${o.desk}/page/down`, {}).then(j => { said = j.said || "down"; load(); }, err => { said = why(err); draw(); });
  if ("owner" in d) return void o.api(`/api/desks/${o.desk}/page/owner`, {}).then(j => { wrote = j.path; said = `written ${j.path}; commit and push it, then Publish again: ${j.push}`; draw(); }, err => o.toast("The check was not written", why(err)));
  if ("askPush" in d) return void askFor(`Commit ${wrote || ".snyvi/owner"} on its own (snyvi's check that this desk's page is mine) and push it. Nothing else in the commit. Then tell me, and I'll press Publish again.`);
  if ("askBadge" in d) return void askFor(`Add this line near the top of the README, under the title, then commit and push it: ${o.host.querySelector(".pg-badge")?.value || ""}`);
}

function submit(e) {
  if (!o) return;
  const f = e.target, data = Object.fromEntries(new FormData(f));
  e.preventDefault();
  if ("ask" in f.dataset) return void askClaude(data.what);
  if ("pick" in f.dataset) return void save({ pick: { field: data.field, path: data.path.trim() } });
  if ("slug" in f.dataset) return void save({ edit: { slug: data.slug.trim() } });
  if ("ctaForm" in f.dataset) return void save({ edit: { cta: { label: data.label.trim(), url: data.url.trim() } } });
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

/** The template's stylesheet and the view's, once, with the chunk. */
function style() {
  if (document.getElementById("pg-css")) return;
  const s = document.createElement("style");
  s.id = "pg-css";
  s.textContent = PAGE_CSS;
  document.head.append(s);
  template().then(m => {
    if (document.getElementById("pt-css")) return;
    const t = document.createElement("style");
    t.id = "pt-css";
    t.textContent = m.CSS;
    document.head.append(t);
  }, () => {});
}

/* The page follows the window's theme here (the published one follows the
 * reader's system), and sits on a sheet with the view's own controls round
 * it. 16 px gutters on a phone, no horizontal scroll. */
const PAGE_CSS = `
.pg { position: absolute; inset: 0; display: grid; grid-template-columns: minmax(0, 1fr) 260px; background: var(--bg-side); container-type: inline-size; overflow: auto; }
.pg.pg-new { grid-template-columns: minmax(0, 1fr); }
.pg-left { overflow: auto; padding: var(--sp-6) 16px; }
.pg-sheet { max-width: 1040px; margin: 0 auto; border: 1px solid var(--rule); border-radius: var(--r-md); overflow: hidden; }
.pg .pt { color-scheme: inherit; }
.pg-draftnote { margin: 0 0 16px; font-size: var(--fs-small); color: var(--fg-3); }
.pg-intro { max-width: 640px; margin: 8px auto 20px; padding: 20px 22px; border-radius: var(--r-md); background: var(--bg-raise); box-shadow: var(--shadow-1); color: var(--fg-2); }
.pg-intro h2 { margin: 0 0 8px; font-size: 20px; color: var(--fg); }
.pg-intro p { margin: 0 0 10px; line-height: 1.55; }
.pg-intro b { color: var(--fg); font-weight: 500; }
.pg-intro-b { display: flex; gap: 14px; align-items: center; flex-wrap: wrap; margin: 14px 0 4px; }
.pg-asked { min-height: 1.4em; margin: 4px 0; font-size: var(--fs-small); color: var(--fg-2); overflow-wrap: anywhere; }
.pg-story { white-space: pre-wrap; min-height: 3em; }
.pg-faint { opacity: .55; }
.pg-faint:focus-within { opacity: 1; }
.pg-up { font-size: var(--fs-micro); color: var(--fg-3); font-weight: 400; }
.pg-x { margin-left: 4px; border: 0; background: none; color: var(--fg-3); cursor: pointer; }
.pg-chip { margin-left: 6px; border: 0; border-radius: var(--r-pill); padding: 1px 8px; background: var(--rule); color: var(--fg-3); font-size: var(--fs-micro); cursor: pointer; vertical-align: middle; }
.pg [data-f], .pg [data-pt], .pg [data-cta] { border-radius: var(--r-xs); }
.pg [data-f]:focus:not(:focus-visible), .pg [data-pt]:focus:not(:focus-visible), .pg [data-cta]:focus:not(:focus-visible) { outline: none; }
.pg [data-f]:focus-visible, .pg [data-pt]:focus-visible, .pg [data-cta]:focus-visible { box-shadow: 0 0 0 2px var(--focus); }
.pg .pg-empty:empty::before { content: attr(data-ph); color: var(--fg-3); font-weight: 400; }
.pg-quiet { font-size: var(--fs-small); color: var(--fg-3); }
.pg-side { overflow: auto; padding: var(--sp-6); border-left: 1px solid var(--rule); background: var(--bg); display: flex; flex-direction: column; gap: 6px; }
.pg-side h3 { margin: 10px 0 2px; font-size: var(--fs-small); color: var(--fg-2); }
.pg-ask { display: flex; flex-wrap: wrap; gap: 4px; padding-bottom: 8px; border-bottom: 1px solid var(--rule); }
.pg-ask h3 { flex-basis: 100%; margin-top: 0; }
.pg-ask .pg-asked { flex-basis: 100%; }
.pg-fold { border-top: 1px solid var(--rule); padding-top: 6px; margin-top: 8px; }
.pg-fold summary { cursor: pointer; font-size: var(--fs-ui); font-weight: 600; color: var(--fg); padding: 4px 0; }
.pg-seg { display: flex; flex-wrap: wrap; gap: 4px; }
.pg-seg button, .pg-pick button, .pg-moment button, .pg-ask button { border: 1px solid var(--rule); background: var(--bg-raise); color: var(--fg); border-radius: var(--r-sm); padding: 3px 8px; font: inherit; font-size: var(--fs-small); cursor: pointer; }
.pg-seg button[aria-pressed="true"] { border-color: var(--accent); color: var(--accent); }
.pg-sws { display: flex; gap: 6px; flex-wrap: wrap; }
.pg-sw { width: 22px; height: 22px; border-radius: 50%; border: 2px solid transparent; background: var(--sw); color: var(--bg); font-size: 11px; cursor: pointer; }
.pg-sw.on { border-color: var(--fg); }
.pg-facts-pick { display: grid; grid-template-columns: 1fr 1fr; font-size: var(--fs-small); }
.pg-pick, .pg-moment { display: flex; gap: 4px; flex-wrap: wrap; }
.pg-pick input, .pg-moment input, .pg-moment textarea, .pg-pick select, .pg-ask input { flex: 1; min-width: 0; font: inherit; font-size: var(--fs-small); padding: 3px 6px; border: 1px solid var(--rule); border-radius: var(--r-sm); background: var(--bg-raise); color: var(--fg); }
.pg-moment input, .pg-moment textarea, [data-cta-form] input { flex-basis: 100%; }
.pg-pressrow { margin-top: 12px; display: flex; flex-direction: column; gap: 6px; }
.pg-press { border: 0; border-radius: var(--r-sm); padding: 8px 12px; background: var(--accent); color: var(--on-accent); font: inherit; font-weight: 600; cursor: pointer; }
.pg-press:disabled { opacity: .5; cursor: default; }
.pg-share { display: inline-flex; gap: 10px; align-items: center; margin-left: 6px; vertical-align: middle; font-weight: 400; }
.pg-post { position: relative; display: inline-block; }
.pg-post > summary { list-style: none; cursor: pointer; }
.pg-post > summary::-webkit-details-marker { display: none; }
.pg-post > div { position: absolute; z-index: 5; top: calc(100% + 4px); left: 0; min-width: 210px; padding: 6px; border-radius: var(--r-md); background: var(--bg-raise); box-shadow: var(--shadow-1); display: flex; flex-direction: column; }
.pg-post a { padding: 5px 8px; border-radius: var(--r-sm); color: var(--fg); text-decoration: none; font-size: var(--fs-small); }
.pg-post a:hover { background: var(--wash); }
.pg-post p { margin: 4px 8px 2px; font-size: var(--fs-micro); color: var(--fg-3); }
.pg-badge { width: 100%; box-sizing: border-box; font: var(--fs-micro) var(--mono); padding: 4px 6px; border: 1px solid var(--rule); border-radius: var(--r-sm); background: var(--bg-raise); color: var(--fg-2); }
.pg-said { font-size: var(--fs-small); color: var(--fg-2); min-height: 1.4em; overflow-wrap: anywhere; }
.pg-quietbtn { align-self: flex-start; border: 0; background: none; padding: 0; color: var(--fg-2); font: inherit; font-size: var(--fs-small); text-decoration: underline; cursor: pointer; }
.pg-hearts { color: var(--fg-2); }
/* By its own width: beside a docked panel the view is narrower than the window. */
@container (max-width: 640px) {
  .pg { grid-template-columns: 1fr; }
  .pg-side { border-left: 0; border-top: 1px solid var(--rule); }
}
`;
