/* A desk's page, template A · Product (1.62, views audit e512285a2b, the
 * template round 61a6577558): the one layout and stylesheet both sides of a
 * page draw with -- the Page view in the window (ui/page.js), where every
 * word is edited where it stands, and snyvi.page (wall/src/render.ts), where
 * nothing is. So what the builder sees is what goes up.
 *
 * No DOM and no escaping here: `layout` places pieces each side has already
 * made, the window's as fields and the Worker's as escaped text. A piece left
 * empty is left out, and so is its box. The stylesheet is scoped to `.pt`,
 * carries its own palette (light and dark, as the reader's system says), and
 * reads only the accent pair and the wash the page gives it; it is sized by
 * the page's own width, so a page beside a docked panel reads as on a phone.
 *
 * Plain JavaScript the Worker's bundler and the window both take: no import,
 * no export but these.
 */

/** The eight, as ui/app.css pairs them: light ink, dark ink. */
export const EIGHT = {
  passion: ["#8c0f26", "#f97e92"], crimson: ["#b91c1c", "#f87171"], rose: ["#be185d", "#f472b6"],
  violet: ["#7c3aed", "#a78bfa"], blue: ["#1d4ed8", "#60a5fa"], teal: ["#0f766e", "#2dd4bf"],
  green: ["#137639", "#4ade80"], graphite: ["#57534e", "#d6d3d1"],
};

/** The words a heart wears, by tone (never "like"). */
export const HEART = { software: "I'd use this", book: "I'd read this", design: "I'd try this" };

export const TONES = ["software", "book", "design"];

/** The page's own custom properties: its accent pair and its wash, for the
 *  `style` of the `.pt` element. */
export function vars(p) {
  const [l, d] = EIGHT[p.accent] || EIGHT.passion;
  const wash = /^#[0-9a-f]{6}$/i.test(p.wash || "") ? p.wash : "transparent";
  return `--pt-al:${l};--pt-ad:${d};--pt-wash:${wash}`;
}

/** The page whole, from its pieces (each HTML, or "" for none):
 *  mark, nav (links in the head), heart, title, lede, cta (the main link and
 *  any second one), cover, facts (cells), points (cards), story, moments,
 *  links, foot; `note`, a line above it all (the window's draft note); and
 *  `focus`, one moment drawn large under the head (snyvi.page/<slug>/m/<id>).
 *  `tone` is the page's, `style` its vars. */
export function layout(s) {
  const tone = TONES.includes(s.tone) ? s.tone : "software";
  const hero = `<section class="pt-hero${s.cover ? "" : " pt-solo"}"><div class="pt-claim">${s.title}${s.lede}` +
    (s.cta ? `<div class="pt-acts">${s.cta}</div>` : "") + `</div>` +
    (s.cover ? `<div class="pt-pic">${s.cover}</div>` : "") + `</section>`;
  // The outer box is the container the page is sized by: an element cannot
  // query its own width.
  return `<div class="pt-c"><div class="pt pt-${tone}" style="${s.style || ""}">` +
    (s.note || "") +
    `<nav class="pt-nav">${s.mark}<span class="pt-sp"></span>${s.nav || ""}${s.heart || ""}</nav>` +
    (s.focus ? `<section class="pt-this">${s.focus}</section>` : "") +
    hero +
    (s.facts ? `<div class="pt-facts">${s.facts}</div>` : "") +
    (s.points ? `<div class="pt-pts">${s.points}</div>` : "") +
    `<div class="pt-two"><div>` +
    (s.story ? `<section class="pt-story"><h3>Why it's being built</h3>${s.story}</section>` : "") +
    `<section class="pt-ms"><h3>Moments</h3>${s.moments}</section></div>` +
    `<aside class="pt-aside">${s.links ? `<h3>Links</h3>${s.links}` : ""}<p class="pt-foot">${s.foot || ""}</p></aside></div>` +
    `</div></div>`;
}

export const CSS = `
.pt-c { container: pt / inline-size; }
.pt { color-scheme: light dark;
  --pt-bg: light-dark(#faf9f6, #15181f); --pt-raise: light-dark(#fff, #1c2029);
  --pt-fg: light-dark(#1f1d1a, rgba(255,255,255,.88)); --pt-fg2: light-dark(#5c574f, rgba(255,255,255,.64));
  --pt-fg3: light-dark(#736c61, rgba(255,255,255,.47)); --pt-rule: light-dark(#e6e2da, rgba(255,255,255,.1));
  --pt-accent: light-dark(var(--pt-al), var(--pt-ad)); --pt-on: light-dark(#fff, #15181f);
  --pt-r: 10px; --pt-r2: 14px; --pt-pill: 999px;
  max-width: 1040px; margin: 0 auto; padding: 22px 28px 40px; background: var(--pt-bg); color: var(--pt-fg);
  font: 16px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; box-sizing: border-box; }
.pt *, .pt *::before, .pt *::after { box-sizing: border-box; }
.pt a { color: var(--pt-accent); }
.pt-nav { display: flex; align-items: center; gap: 12px; }
.pt-sp { flex: 1; }
.pt-nav a { color: var(--pt-fg2); text-decoration: none; font-size: 14px; }
.pt-nav a:hover { color: var(--pt-fg); }
.pt-mark { width: 40px; height: 40px; border-radius: var(--pt-r); object-fit: contain; flex: none; }
.pt-mark-i { display: grid; place-items: center; background: var(--pt-accent); color: var(--pt-on); font-weight: 700; font-size: 18px; }
.pt-heart { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--pt-rule); border-radius: var(--pt-pill); padding: 5px 12px;
  color: var(--pt-accent); font-size: 14px; white-space: nowrap; background: var(--pt-raise); }
.pt-hero { display: grid; grid-template-columns: 1.05fr .95fr; gap: 36px; align-items: center; padding: 48px 0 36px;
  background: linear-gradient(180deg, transparent, color-mix(in srgb, var(--pt-wash) 8%, transparent)); }
.pt-hero.pt-solo { grid-template-columns: minmax(0, 720px); }
.pt-title { font-size: 46px; line-height: 1.06; letter-spacing: -.02em; margin: 0 0 14px; font-weight: 700; }
.pt-lede { font-size: 18.5px; color: var(--pt-fg2); margin: 0 0 24px; max-width: 520px; }
.pt-book .pt-title, .pt-book .pt-lede, .pt-book .pt-story { font-family: "Source Serif 4", Georgia, "Times New Roman", serif; }
.pt-book .pt-title { font-weight: 600; letter-spacing: -.01em; }
.pt-book .pt-lede { font-size: 21px; }
.pt-design .pt-title { letter-spacing: -.035em; }
.pt-acts { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
.pt-btn { display: inline-flex; align-items: center; gap: 8px; background: var(--pt-accent); color: var(--pt-on); border-radius: var(--pt-r);
  padding: 10px 16px; font-weight: 600; text-decoration: none; font-size: 15px; }
.pt-ghost { display: inline-flex; align-items: center; gap: 6px; color: var(--pt-fg); border: 1px solid var(--pt-rule); border-radius: var(--pt-r);
  padding: 9px 14px; text-decoration: none; font-size: 15px; }
.pt-pic { border-radius: var(--pt-r2); overflow: hidden; border: 1px solid var(--pt-rule); background: var(--pt-raise); aspect-ratio: 4 / 3; }
.pt-pic img, .pt-pic video { display: block; width: 100%; height: 100%; object-fit: cover; }
.pt-facts { display: flex; gap: 28px; flex-wrap: wrap; padding: 16px 0; border-block: 1px solid var(--pt-rule); }
.pt-facts small, .pt-k { display: block; font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: var(--pt-fg3); }
.pt-facts b { font-weight: 500; }
.pt-pts { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin: 34px 0; }
.pt-pts > div { background: var(--pt-raise); border: 1px solid var(--pt-rule); border-radius: var(--pt-r2); padding: 18px; }
.pt-pts b { display: block; margin-bottom: 4px; }
.pt-pts p { margin: 0; color: var(--pt-fg2); font-size: 14.5px; }
.pt-two { display: grid; grid-template-columns: 1.4fr 1fr; gap: 40px; margin-top: 24px; }
.pt h3 { font-size: 13px; letter-spacing: .06em; text-transform: uppercase; color: var(--pt-fg3); margin: 0 0 8px; font-weight: 600; }
.pt-story { margin-bottom: 24px; }
.pt-story p { margin: 0 0 12px; }
.pt-tl { list-style: none; margin: 0; padding: 0; }
.pt-tl li { display: grid; grid-template-columns: 92px 1fr; gap: 14px; padding: 12px 0; border-top: 1px solid var(--pt-rule); }
.pt-tl time { font-size: 13px; color: var(--pt-fg3); }
.pt-tl h4 { margin: 0 0 2px; font-size: 16px; }
.pt-tl p { margin: 0 0 6px; color: var(--pt-fg2); font-size: 14.5px; }
.pt-tl img, .pt-tl video { display: block; max-width: 100%; border-radius: var(--pt-r); margin-top: 8px; }
.pt-aside ul { list-style: none; margin: 0; padding: 0; }
.pt-aside li { margin: 0 0 8px; overflow-wrap: anywhere; }
.pt-foot { margin: 22px 0 0; font-size: 12px; color: var(--pt-fg3); }
.pt-foot a { color: var(--pt-fg2); }
.pt-this { margin: 28px 0 8px; padding: 22px 24px; border-radius: var(--pt-r2); background: var(--pt-raise); border: 1px solid var(--pt-rule); border-left: 4px solid var(--pt-accent); }
.pt-this time { font-size: 13px; color: var(--pt-fg3); }
.pt-this h2 { font-size: 28px; line-height: 1.15; margin: 4px 0 10px; }
.pt-this p { margin: 0 0 10px; color: var(--pt-fg2); }
.pt-this img, .pt-this video { display: block; max-width: 100%; border-radius: var(--pt-r); margin-top: 10px; }
.pt-tl time a { color: inherit; text-decoration: none; }
.pt-tl time a:hover { text-decoration: underline; }
.pt-quiet { color: var(--pt-fg3); font-size: 14px; }
@container pt (max-width: 760px) {
  .pt { padding: 18px 16px 32px; }
  .pt-hero, .pt-two { grid-template-columns: 1fr; gap: 24px; }
  .pt-pts { grid-template-columns: 1fr; }
  .pt-title { font-size: 34px; }
  .pt-tl li { grid-template-columns: 1fr; gap: 2px; }
}
`;
