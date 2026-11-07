/* ui/desk/27-page.js: a part of desk.js, one module. build.rs joins ui/desk/*.js in name
 * order (src/strip.rs `source`); SNYVI_UI_DIR serves the same join. */
// ---------- a desk's page (1.59, plan 48ca2d5b9e; docs/WALL.md) ----------
/*
 * Page is a view like Folder, always in the switcher after it: the desk's
 * page, edited in place, over the grid with one panel docked, the way a
 * Board opens (25-views.js). The view itself is ui/page.js, fetched the
 * first time Page is pressed.
 *
 * And one card, in the grid's corner, for all three doors: snyvi's own when
 * a thread ships, the agent's offer_post, and (from the view) the reader's
 * own. Have a look opens the view with the card's words in the moment form;
 * Not now is final for what the card was about. The card overlays the
 * panels and moves nothing; it is gone while the page is open.
 */

let pageMod = null, pageLoading = null;
/** The open cards on the desk they were read for. */
let pageCards = [], pageCardsOf = null;

function pageUse() {
  if (pageMod) return Promise.resolve(pageMod);
  let v = "";
  try { v = JSON.parse(document.getElementById("boot").textContent || "{}").v || ""; } catch { /* unversioned */ }
  return pageLoading ||= import(`/assets/page.js${v ? `?v=${v}` : ""}`).then(m => (pageMod = m), e => { pageLoading = null; throw e; });
}

/** The view's surface, from `viewsMount` while Page is open. */
function pageMount(surf, d) {
  if (surf.dataset.board === "page" && surf.childElementCount) return;
  surf.dataset.board = "page";
  const want = viewOn;
  pageUse().then(m => {
    if (viewOn !== want || !surf.isConnected) return;
    m.open({ host: surf, desk: d.id, api: ctx.api, esc: ctx.esc, toast: ctx.toast, rel: ctx.rel, sayErr: ctx.sayErr, seed: want.seed || null });
  }, () => { surf.innerHTML = `<p class="dk-none">Could not load the page.</p>`; });
}

/** Read the desk's cards once per desk, and again when one changes. */
function pageOffers(d, again) {
  if (!d || (!again && pageCardsOf === d.id)) return;
  pageCardsOf = d.id;
  ctx.api(`/api/desks/${d.id}/page?offers=1`).then(j => {
    if (pageCardsOf !== d.id) return;
    pageCards = j.offers || [];
    pageCard();
  }, () => {});
}

/** The newest card, drawn in the grid's corner, or none. */
function pageCard() {
  const grid = ctx.docEl.querySelector(".dk-grid"), { esc } = ctx;
  if (!grid) return;
  let el = grid.querySelector(":scope > .pg-card");
  const c = pageCards[0];
  if (!c || (viewOn && viewOn.page) || pageCardsOf !== deskId) { el?.remove(); return; }
  if (!el) {
    el = Object.assign(document.createElement("div"), { className: "pg-card" });
    el.setAttribute("role", "status");
    grid.append(el);
  }
  const head = c.by === "snyvi" ? `Shipped. Put ${esc(c.title)} on your page?` : `${esc(c.title)}: put it on your page?`;
  const more = pageCards.length > 1 ? `<small>+${pageCards.length - 1} more</small>` : "";
  const html = `<p class="pg-card-h">${head}${more}</p>${c.text ? `<p class="pg-card-t">${esc(c.text)}</p>` : ""}
    <div class="pg-card-b"><button type="button" data-pgcard="looked" data-o="${c.id}">Have a look</button><button type="button" data-pgcard="notnow" data-o="${c.id}">Not now</button></div>`;
  if (el.dataset.drawn !== html) { el.dataset.drawn = html; el.innerHTML = html; }
}

/** A card's buttons. True when the click was one of them. */
function pageClick(e) {
  const b = e.target.closest(".pg-card [data-pgcard]");
  if (!b) return false;
  e.preventDefault();
  const d = current(), id = +b.dataset.o, c = pageCards.find(x => x.id === id), answer = b.dataset.pgcard;
  if (!d || !c) return true;
  pageCards = pageCards.filter(x => x.id !== id);
  pageCard();
  ctx.api(`/api/desks/${d.id}/page/offers/${id}/${answer}`, {}).catch(err => ctx.toast("The card did not take that", ctx.sayErr(err).why));
  if (answer === "looked") openView("page", { about: c.about, title: c.title, text: c.text });
  return true;
}

/** A `page` event: the cards, or the page itself, of a desk. */
function pageSaid(j) {
  if (!j || j.desk !== deskId) return;
  if (j.what === "offers") pageOffers(current(), true);
  else pageMod?.changed(j);
}

const PAGE_DESK_CSS = `
.pg-card { position: absolute; right: 12px; bottom: 12px; z-index: var(--z-sticky); width: min(320px, calc(100% - 24px));
  padding: 10px 12px; border-radius: var(--r-md); background: var(--bg-raise); border: 1px solid var(--rule); box-shadow: var(--shadow-2, var(--shadow-1)); font-size: var(--fs-ui); }
.pg-card-h { margin: 0; font-weight: 600; }
.pg-card-h small { margin-left: 6px; font-weight: 400; color: var(--fg-3); }
.pg-card-t { margin: 4px 0 0; color: var(--fg-2); font-size: var(--fs-small); display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.pg-card-b { display: flex; gap: 6px; margin-top: 8px; }
.pg-card-b button { border: 1px solid var(--rule); border-radius: var(--r-sm); padding: 3px 10px; background: none; color: var(--fg); font: inherit; font-size: var(--fs-small); cursor: pointer; }
.pg-card-b button:first-child { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
`;
