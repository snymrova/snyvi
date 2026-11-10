/* What people are building: Home's section (plan 48ca2d5b9e, step 6;
 * design round 40303cb7e4; docs/WALL.md).
 *
 * Not on the wire until Home has drawn: ui/home.js imports it after its
 * first draw, and keeps its section's height while it loads, so the cards
 * fill in place and nothing on Home moves. The window never fetches the
 * internet: the wall comes through this daemon (`/api/wall`, kept an hour),
 * its pictures through `/api/wall/file/{name}`, and a heart is signed by
 * the daemon (`/api/wall/heart`).
 *
 * Three segments: Everyone (the wall, newest moment first), Following (the
 * pages this reader follows), Friends (pages friends sent Friends only).
 * The hearts are shown, never ranked; a page that hides its count shows the
 * heart alone. Your own pages are one line on the segments' row.
 *
 * A follow (1.62, D2) is signed by the daemon at the wall, like a heart, so
 * the builder hears it; the daemon keeps the list (`follows` in the read).
 * Follows this browser kept before 1.62 are said to the wall once, then
 * dropped here. When a followed page posted since Home last showed it, one
 * line on the segments' row says so; pressing it, or Following, shows them.
 *
 * The section never changes height (no layout shift): the segments' row,
 * then one row of cards of one height that scrolls sideways, 0 cards or 12.
 * Reading, offline and empty all draw inside that same box. Its height is
 * WALL_H below, and ui/home.js holds it before this chunk arrives.
 */

let read = null, at = 0, loading = null;
let seg = "everyone";
let saidFor = null;      // a card's row that just said something, by slug
let moved = false;       // the browser's old follows, said to the wall once a load
/** How long a read stands before the next draw asks again. */
const FRESH_MS = 5 * 60 * 1000;
const SHOWN = 12;
const store = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || d); } catch { return JSON.parse(d); } };
const keep = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* not kept */ } };

/** The section's body as it stands: the cards when read, else the frame
 *  that holds their place. */
export function html(c) {
  style();
  return `<div class="wl" data-wall>${read ? body(c) : frame("", `<p class="wl-quiet">Reading the wall…</p>`, true)}</div>`;
}

/** After each draw of Home: listen on the new section, and read the wall
 *  when the last read is old. */
export function fill(el, c) {
  if (!el) return;
  el.addEventListener("click", e => click(e, el, c));
  if (read && Date.now() - at < FRESH_MS) return;
  loading ||= c.deskApi("/api/wall").then(j => { read = j; at = Date.now(); }, () => { read ||= { wall: { pages: [], offline: true }, mine: [], friends: [], follows: [] }; at = Date.now(); })
    .finally(() => { loading = null; if (el.isConnected) el.innerHTML = body(c); moveFollows(el, c); });
}

const followed = () => (read.follows || []).map(f => f.slug);

/** Follows from before 1.62, kept in this browser: each said to the wall,
 *  and the browser's list dropped once all of them were taken. */
async function moveFollows(el, c) {
  const old = store("snyvi.wall.follow", "[]").filter(s => !followed().includes(s));
  if (moved || !old.length || !read || (read.wall && read.wall.offline)) return;
  moved = true;
  let all = true;
  for (const slug of old) {
    try { await c.deskApi("/api/wall/follow", { slug, on: true }); (read.follows ||= []).push({ slug, at: 0, seen: Date.now() / 1000 | 0 }); } catch { all = false; }
  }
  if (all) try { localStorage.removeItem("snyvi.wall.follow"); } catch { /* kept */ }
  if (el.isConnected) el.innerHTML = body(c);
}

/** Followed pages whose newest moment came after Home last showed them. */
function news() {
  const seen = Object.fromEntries((read.follows || []).map(f => [f.slug, f.seen]));
  return ((read.wall && read.wall.pages) || []).filter(p => p.slug in seen && p.moment && p.moment.at > seen[p.slug]);
}

/** Following was shown: what it holds is seen, here and at the daemon. */
function sawFollows(c) {
  const t = Date.now() / 1000 | 0;
  for (const f of read.follows || []) f.seen = t;
  c.deskApi("/api/wall/seen", {}).catch(() => {});
}

function body(c) {
  const { esc } = c;
  const mine = (read.mine || []).map(m => `${m.title} ${m.visibility === "everyone" ? (m.checked ? "is on the wall" : "is up, not on the wall until its check is in the repo") : "went to friends"}${m.hearts ? ` · ${m.hearts} ♥${m.since ? ` since ${c.rel(m.since * 1000)}` : ""}` : ""}${(m.names || []).length ? ` · ${m.names.slice(0, 3).join(", ")}` : ""}${m.follows ? ` · ${m.follows} follow` : ""}${m.reads ? ` · opened ${m.reads} times this week` : ""}`).join(" · ");
  const xs = cards(c), ns = seg === "following" ? [] : news();
  const line = ns.length ? `<button type="button" class="wl-news" data-wl="news">New from ${esc(ns[0].title)}: ${esc(ns[0].moment.title)}${ns.length > 1 ? ` · and ${ns.length - 1} more` : ""}</button>` : "";
  return frame(line + (mine ? `<span class="wl-mine" data-tip="${esc(mine)}">${esc(mine)}</span>` : ""), xs, !/wl-card/.test(xs));
}

/** The box every state draws in: the segments' row (and your own pages'
 *  line), then the cards' row, or a line in its place. */
function frame(mine, inner, none) {
  const segs = [["everyone", "Everyone"], ["following", "Following"], ["friends", "Friends"]].map(([k, l]) =>
    `<button type="button" data-wl="seg" data-k="${k}" aria-pressed="${seg === k}">${l}</button>`).join("");
  return `<div class="wl-head"><div class="wl-segs" role="group" aria-label="Whose pages">${segs}</div>${mine}</div><div class="wl-cards${none ? " wl-none" : ""}">${inner}</div>`;
}

function list() {
  const pages = (read.wall && read.wall.pages) || [];
  if (seg === "friends") return (read.friends || []).map(f => ({ ...f.page, from: f.from, friend: true, moment: f.moment && f.moment.title ? f.moment : null }));
  if (seg === "following") { const f = followed(); return pages.filter(p => f.includes(p.slug)); }
  return pages;
}

function cards(c) {
  const { esc } = c, xs = list().slice(0, SHOWN);
  if (!xs.length) {
    if (seg === "friends") return `<p class="wl-quiet">Pages your friends send Friends only land here.</p>`;
    if (seg === "following") return `<p class="wl-quiet">Follow a page on Everyone, and its moments come here.</p>`;
    return `<p class="wl-quiet">${read.wall && read.wall.offline ? "The wall did not answer; the last one this snyvi saw is shown when there is one." : "Nobody is on the wall yet. Put yours there from Page, in a desk's ⋯."}</p>`;
  }
  const hearted = store("snyvi.wall.hearted", "[]"), follow = followed();
  return xs.map(p => {
    const m = p.moment, on = hearted.includes(p.slug), fol = follow.includes(p.slug);
    const logo = p.logo ? `<img class="wl-logo" src="/api/wall/file/${esc(p.logo)}" alt="" loading="lazy">` : `<span class="wl-logo wl-i" aria-hidden="true">${esc((p.title || "?").charAt(0).toUpperCase())}</span>`;
    const heart = p.friend ? "" : `<button type="button" class="wl-heart" data-wl="heart" data-k="${esc(p.slug)}" aria-pressed="${on}" data-tip="${on ? "Take the heart back" : "A heart: the builder sees your name"}">♥${p.hearts == null ? "" : ` ${p.hearts}`}</button>`;
    const said = saidFor && saidFor.slug === p.slug ? `<span class="wl-said">${esc(saidFor.text)}</span>` : "";
    return `<article class="wl-card" data-accent-name="${esc(p.accent || "passion")}" style="--wl-wash:${/^#[0-9a-f]{6}$/i.test(p.wash || "") ? p.wash : "transparent"}">
      <header>${logo}<div class="wl-t"><b>${esc(p.title)}</b><small>${esc(p.friend ? `from ${p.from}` : p.kind || "")}</small></div>${heart}</header>
      <p class="wl-lede">${esc(p.lede || "")}</p>
      ${m ? `<p class="wl-m"><span>${esc(m.title)}</span>${m.at ? ` <small>${esc(c.rel(m.at * 1000))}</small>` : ""}</p>` : ""}
      <footer>${p.friend ? "" : `<a href="https://snyvi.page/${esc(p.slug)}" target="_blank" rel="noopener noreferrer">Open</a><button type="button" data-wl="follow" data-k="${esc(p.slug)}" aria-pressed="${fol}">${fol ? "Following" : "Follow"}</button>`}${said}</footer>
    </article>`;
  }).join("");
}

function click(e, el, c) {
  const b = e.target.closest("[data-wl]");
  if (!b || !el.contains(b)) return;
  const k = b.dataset.k;
  if (b.dataset.wl === "seg" || b.dataset.wl === "news") {
    seg = b.dataset.wl === "news" ? "following" : k;
    if (seg === "following" && news().length) sawFollows(c);
    el.innerHTML = body(c);
    return;
  }
  if (b.dataset.wl === "follow") {
    const on = !followed().includes(k);
    b.disabled = true;
    c.deskApi("/api/wall/follow", { slug: k, on }).then(() => {
      read.follows = (read.follows || []).filter(f => f.slug !== k);
      if (on) read.follows.push({ slug: k, at: Date.now() / 1000 | 0, seen: Date.now() / 1000 | 0 });
      saidFor = on ? { slug: k, text: "its builder sees that you follow" } : null;
      el.innerHTML = body(c);
    }, () => {
      saidFor = { slug: k, text: "the wall did not take it; try again in a while" };
      el.innerHTML = body(c);
    });
    return;
  }
  if (b.dataset.wl === "heart") {
    b.disabled = true;
    c.deskApi("/api/wall/heart", { slug: k }).then(j => {
      const h = store("snyvi.wall.hearted", "[]").filter(x => x !== k);
      if (j.on) h.push(k);
      keep("snyvi.wall.hearted", h);
      const p = ((read.wall && read.wall.pages) || []).find(x => x.slug === k);
      if (p && p.hearts != null) p.hearts = j.hearts;
      saidFor = null;
      el.innerHTML = body(c);
    }, () => {
      saidFor = { slug: k, text: "the wall did not take it; try again in a while" };
      el.innerHTML = body(c);
    });
  }
}

let styled = false;
function style() {
  if (styled) return;
  styled = true;
  document.head.append(Object.assign(document.createElement("style"), { id: "wl-css", textContent: WALL_CSS }));
}

/* One height, whatever is in it: WALL_H = the head's row (30) + its gap (8)
 * + the cards' row (140: a 128 px card, whose lines need 124, and room for
 * a thin scrollbar under it). ui/home.js's placeholder says 178px too. No
 * line in a card may shrink to fit (flex: none): one that did was clipped. A card wears its page's wash as
 * a faint tint and its accent on the heart; the eight are app.css's, by name. */
const WALL_CSS = `
.wl { height: 178px; display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.wl-head { height: 30px; flex: none; display: flex; align-items: center; gap: 12px; min-width: 0; }
.wl-quiet { margin: 8px 0; font-size: var(--fs-small); color: var(--fg-3); }
.wl-news { margin-left: auto; min-width: 0; flex: 0 1 auto; border: 0; background: none; padding: 2px 6px; border-radius: var(--r-sm); color: var(--accent); font: inherit; font-size: var(--fs-small); cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wl-news:hover { background: var(--wash); }
.wl-news + .wl-mine { margin-left: 0; }
.wl-mine { margin-left: auto; min-width: 0; font-size: var(--fs-small); color: var(--fg-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wl-segs { flex: none; display: inline-flex; gap: 2px; padding: 2px; border-radius: var(--r-pill); background: var(--wash); }
.wl-segs button { border: 0; background: none; padding: 2px var(--sp-4); border-radius: var(--r-pill); color: var(--fg-2); font: inherit; font-size: var(--fs-small); cursor: pointer; }
.wl-segs button[aria-pressed="true"] { background: var(--bg-raise); color: var(--fg); box-shadow: var(--shadow-1); }
.wl-cards { height: 140px; scrollbar-width: thin; scrollbar-color: var(--rule-2) transparent; flex: none; display: grid; grid-auto-flow: column; grid-auto-columns: minmax(240px, 280px); align-items: start; gap: 10px;
  overflow-x: auto; overflow-y: hidden; overscroll-behavior-x: contain; scroll-snap-type: x proximity; }
.wl-cards.wl-none { display: block; overflow: hidden; }
.wl-card { height: 128px; box-sizing: border-box; overflow: hidden; scroll-snap-align: start; display: flex; flex-direction: column; gap: 4px; padding: 10px 12px; border: 1px solid var(--rule); border-radius: var(--r-md); background: color-mix(in srgb, var(--wl-wash) 6%, var(--bg-raise)); }
.wl-card > * { flex: none; }
.wl-card header { display: flex; gap: 8px; align-items: center; }
.wl-logo { width: 28px; height: 28px; border-radius: var(--r-sm); object-fit: contain; flex: none; }
.wl-i { display: grid; place-items: center; background: var(--rule); color: var(--fg-2); font-weight: 600; font-size: var(--fs-ui); }
.wl-t { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.wl-t b, .wl-lede, .wl-m span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wl-t small, .wl-m small { color: var(--fg-3); font-size: var(--fs-micro); }
.wl-lede { margin: 0; font-size: var(--fs-small); color: var(--fg-2); }
.wl-m { margin: 0; font-size: var(--fs-small); display: flex; gap: 6px; align-items: baseline; min-width: 0; }
.wl-heart { border: 0; background: none; color: var(--fg-3); font: inherit; font-size: var(--fs-ui); cursor: pointer; padding: 2px 4px; border-radius: var(--r-sm); }
.wl-heart[aria-pressed="true"] { color: var(--accent); }
.wl-card footer { display: flex; gap: 10px; align-items: center; min-width: 0; font-size: var(--fs-small); margin-top: auto; }
.wl-card footer a { color: var(--fg-2); }
.wl-card footer button { border: 0; background: none; padding: 0; color: var(--fg-2); font: inherit; font-size: var(--fs-small); cursor: pointer; }
.wl-card footer button[aria-pressed="true"] { color: var(--fg); }
.wl-said { min-width: 0; color: var(--fg-3); font-size: var(--fs-micro); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
`;
