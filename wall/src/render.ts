/*
 * What a page looks like at snyvi.page/<slug>: template A · Product (1.62,
 * ui/page-template.js, the same module the Page view in the window draws
 * with), in three tones (Software · Book · Design), the page's accent and
 * its wash, following the reader's light or dark. Rendered once at each
 * write and kept in R2, so a read costs no Worker time.
 *
 * Beside it (1.62, social audit 16627c32e2): each moment's own address,
 * `/<slug>/m/<id>`, the page with that moment drawn large and its own
 * preview; `feed.xml`, an Atom feed of the moments, to follow without
 * snyvi; `badge.svg` for a README; and every head carries a link preview
 * (the cover, or `card.png`, drawn by card.ts). The foot is a door to
 * snyvi.com, saying which page it came from and nothing else.
 *
 * Never the builder's HTML: every field is escaped, a moment's Markdown is
 * cut to the reader's set (paragraphs, emphasis, code, https links), there
 * is no script at all, and the CSP the read is served with allows pictures
 * and clips from this origin only.
 */

import { CSS as TEMPLATE_CSS, EIGHT, HEART, layout, vars } from "../../ui/page-template.js";

export interface PageJson {
  slug: string; title: string; lede: string; kind: string; tone: string; stage: string;
  looking_for: string; logo: string; cover: string; hero: string; facts: string[];
  github: string; links: { label: string; url: string }[]; accent: string; wash: string;
  count_shown: boolean;
  cta?: { label: string; url: string }; points?: { title: string; text: string }[]; story?: string;
}
export interface MomentJson { id: number; title: string; body_md: string; files: string[]; at: number }


export const CSP = "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const FILE_RE = /^[0-9a-f]{16}\.(svg|png|jpg|webp|gif|avif|mp4|webm)$/;
export const fileOk = (f: unknown): f is string => typeof f === "string" && FILE_RE.test(f);
const httpsOk = (u: unknown): u is string => typeof u === "string" && /^https:\/\/[^\s"'<>]+$/.test(u) && u.length <= 300;

/** The reader's set of Markdown: paragraphs, **strong**, *em*, `code`,
 *  [words](https://…). Everything escaped first, so nothing else survives. */
export function md(src: string): string {
  return String(src ?? "").slice(0, 4000).split(/\n{2,}/).map((p) => p.trim()).filter(Boolean).map((p) => {
    let h = esc(p);
    h = h.replace(/`([^`]+)`/g, "<code>$1</code>");
    h = h.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    h = h.replace(/\*([^*]+)\*/g, "<em>$1</em>");
    h = h.replace(/\[([^\]]+)\]\((https:\/\/[^\s)&"]+)\)/g, '<a href="$2" rel="nofollow noopener noreferrer">$1</a>');
    return `<p>${h.replace(/\n/g, "<br>")}</p>`;
  }).join("");
}

function media(f: string): string {
  if (!fileOk(f)) return "";
  return /\.(mp4|webm)$/.test(f)
    ? `<video src="/files/${f}" controls preload="metadata"></video>`
    : `<img src="/files/${f}" alt="" loading="lazy">`;
}

function when(at: number): string {
  return at ? new Date(at * 1000).toISOString().slice(0, 10) : "";
}

/** A picture a link preview can show: X, Slack and the rest take these. */
const raster = (f: unknown): f is string => fileOk(f) && /\.(png|jpg|webp|gif)$/.test(f);

/** The text of a moment's Markdown, plain, for a preview's one line. */
const plain = (src: string, n: number) => String(src ?? "").replace(/[*`]/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/\s+/g, " ").trim().slice(0, n);

/** The head's preview tags: what a link to this address shows where it is
 *  pasted. Always the large card: the cover, a moment's picture, or the
 *  page's drawn card. */
function head(o: { title: string; desc: string; url: string; image: string; feed: string }): string {
  const t = esc(o.title), d = esc(o.desc), i = esc(o.image);
  return `<title>${t}</title><meta name="description" content="${d}"><link rel="canonical" href="${esc(o.url)}">
<meta property="og:type" content="website"><meta property="og:site_name" content="snyvi.page"><meta property="og:title" content="${t}"><meta property="og:description" content="${d}">
<meta property="og:url" content="${esc(o.url)}"><meta property="og:image" content="${i}"><meta property="og:image:alt" content="${t}">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${t}"><meta name="twitter:description" content="${d}"><meta name="twitter:image" content="${i}">
<link rel="alternate" type="application/atom+xml" title="${esc(o.title)}" href="${esc(o.feed)}">`;
}

/** The page's own preview picture: its cover, or its drawn card. */
const pageImage = (p: PageJson, origin: string) => raster(p.cover) ? `${origin}/files/${p.cover}` : `${origin}/${p.slug}/card.png`;

/** The page whole, as snyvi.page/<slug> serves it; with `focus`, as that
 *  moment's own address serves it, which shows no count (hearts move, and
 *  a moment's page is drawn only when the moment or the page is written). */
export function pageHtml(p: PageJson, moments: MomentJson[], hearts: number, origin: string, focus?: MomentJson): string {
  const tone = ["software", "book", "design"].includes(p.tone) ? p.tone : "software";
  const facts = new Set(p.facts || []);
  const last = moments[0];
  const cells = [
    facts.has("stage") && p.stage ? `<div><small>Stage</small><b>${esc(p.stage)}</b></div>` : "",
    facts.has("kind") && p.kind ? `<div><small>Kind</small><b>${esc(p.kind)}</b></div>` : "",
    facts.has("last") && last ? `<div><small>Last moment</small><b>${esc(when(last.at))}</b></div>` : "",
    facts.has("looking") && p.looking_for ? `<div><small>Looking for</small><b>${esc(p.looking_for)}</b></div>` : "",
  ].join("");
  const mark = fileOk(p.logo) ? `<img class="pt-mark" src="/files/${p.logo}" alt="">` : `<span class="pt-mark pt-mark-i">${esc((p.title || "?").charAt(0).toUpperCase())}</span>`;
  const cover = p.hero === "picture" && fileOk(p.cover) ? media(p.cover) : "";
  const out = (u: string, words: string, cls = "") => `<a${cls ? ` class="${cls}"` : ""} href="${esc(u)}" rel="nofollow noopener noreferrer">${esc(words)}</a>`;
  const links = [
    httpsOk(p.github) ? `<li>${out(p.github, p.github.replace(/^https:\/\//, ""))}</li>` : "",
    ...(p.links || []).filter((k) => httpsOk(k.url)).slice(0, 6).map((k) => `<li>${out(k.url, k.label || k.url)}</li>`),
  ].join("");
  const nav = (p.links || []).filter((k) => httpsOk(k.url) && k.label).slice(0, 2).map((k) => out(k.url, k.label)).join("");
  const cta = p.cta && httpsOk(p.cta.url) && p.cta.label ? out(p.cta.url, `${p.cta.label} →`, "pt-btn") : "";
  const points = (p.points || []).filter((x) => x && x.title).slice(0, 3).map((x) => `<div><b>${esc(x.title)}</b>${x.text ? `<p>${esc(x.text)}</p>` : ""}</div>`).join("");
  const ms = moments.slice(0, 50).map((m) => `<li id="m-${m.id}"><time><a href="${esc(origin)}/${esc(p.slug)}/m/${m.id}">${esc(when(m.at))}</a></time><div><h4>${esc(m.title)}</h4>${md(m.body_md)}${(m.files || []).slice(0, 4).map(media).join("")}</div></li>`).join("");
  const heart = `<span class="pt-heart" title="${esc(HEART[tone as keyof typeof HEART])}">♥ ${esc(HEART[tone as keyof typeof HEART])}${p.count_shown && !focus ? ` · ${hearts}` : ""}</span>`;
  const accent = (EIGHT as Record<string, unknown>)[p.accent] ? p.accent : "passion";
  const home = `${origin}/${p.slug}`, feed = `${home}/feed.xml`;
  const door = `https://snyvi.com/?from=${encodeURIComponent(p.slug)}`;
  const shown = focus ? `<time>${esc(when(focus.at))}</time><h2>${esc(focus.title)}</h2>${md(focus.body_md)}${(focus.files || []).slice(0, 4).map(media).join("")}` : "";
  const body = layout({
    tone, style: vars({ accent, wash: p.wash }),
    mark, nav, heart,
    title: `<h1 class="pt-title">${esc(p.title)}</h1>`,
    lede: p.lede ? `<p class="pt-lede">${esc(p.lede)}</p>` : "",
    cta, cover, facts: cells, points,
    story: p.story ? md(p.story) : "",
    moments: ms ? `<ul class="pt-tl">${ms}</ul>` : `<p class="pt-quiet">No moments yet.</p>`,
    focus: shown,
    links: `<ul>${links}<li><a href="${esc(feed)}">Follow by feed</a></li></ul>`,
    foot: `Made on <a href="${esc(door)}">snyvi</a> · <a href="${esc(door)}">build yours →</a><br>What is here is what its builder pressed Publish on, and nothing else of their machine.`,
  });
  const fileImg = focus && (focus.files || []).find(raster);
  const tags = focus
    ? head({ title: `${focus.title} · ${p.title}`, desc: plain(focus.body_md, 200) || p.lede, url: `${home}/m/${focus.id}`, image: fileImg ? `${origin}/files/${fileImg}` : pageImage(p, origin), feed })
    : head({ title: `${p.title} · snyvi.page`, desc: p.lede, url: home, image: pageImage(p, origin), feed });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${tags}
<style>
body{margin:0;background:light-dark(#faf9f6,#15181f);color-scheme:light dark}
${TEMPLATE_CSS}
</style></head><body><main>${body}</main></body></html>`;
}

/** A page's card on the wall: the head row, one line, the newest moment. */
export function card(p: PageJson, moments: MomentJson[], hearts: number, checkedAt: number) {
  const m = moments[0];
  return {
    slug: p.slug, title: p.title, lede: p.lede, kind: p.kind, tone: p.tone, stage: p.stage,
    accent: (EIGHT as Record<string, unknown>)[p.accent] ? p.accent : "passion", wash: /^#[0-9a-f]{6}$/i.test(p.wash || "") ? p.wash : "",
    logo: fileOk(p.logo) ? p.logo : "", cover: p.hero === "picture" && fileOk(p.cover) ? p.cover : "",
    hearts: p.count_shown ? hearts : null, checked_at: checkedAt,
    moment: m ? { id: m.id, title: m.title, at: m.at, file: (m.files || []).find(fileOk) || "" } : null,
  };
}

/** The moments as an Atom feed: any feed reader follows a page, no account
 *  and no snyvi needed. */
export function feedXml(p: PageJson, moments: MomentJson[], origin: string): string {
  const home = `${origin}/${p.slug}`;
  const iso = (at: number) => new Date((at || 0) * 1000).toISOString();
  const entries = moments.slice(0, 30).map((m) => `<entry><id>${esc(home)}/m/${m.id}</id><title>${esc(m.title)}</title><updated>${iso(m.at)}</updated>
<link rel="alternate" href="${esc(home)}/m/${m.id}"/><content type="html">${esc(md(m.body_md) + (m.files || []).filter(raster).slice(0, 1).map((f) => `<p><img src="${origin}/files/${f}" alt=""></p>`).join(""))}</content></entry>`).join("\n");
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><id>${esc(home)}</id><title>${esc(p.title)}</title><subtitle>${esc(p.lede)}</subtitle>
<link rel="alternate" href="${esc(home)}"/><link rel="self" href="${esc(home)}/feed.xml"/><updated>${iso(moments[0]?.at || 0)}</updated><author><name>${esc(p.title)}</name></author>
${entries}
</feed>`;
}

/** A README's badge: snyvi.page on the left, the page's name and hearts
 *  (when its count is shown) on the right, in its accent. Widths are
 *  measured at 11 px, about 6.6 px a letter. */
export function badgeSvg(p: PageJson, hearts: number): string {
  const l = "snyvi.page", r = `${p.slug}${p.count_shown ? ` ♥ ${hearts}` : ""}`;
  const lw = Math.round(l.length * 6.6 + 12), rw = Math.round(r.length * 6.6 + 12);
  const ink = ((EIGHT as Record<string, string[]>)[p.accent] || EIGHT.passion)[0];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${lw + rw}" height="20" role="img" aria-label="${esc(`${l}: ${r}`)}"><title>${esc(`${l}: ${r}`)}</title>
<rect width="${lw}" height="20" rx="3" fill="#555"/><rect x="${lw}" width="${rw}" height="20" rx="3" fill="${ink}"/><rect x="${lw}" width="4" height="20" fill="${ink}"/>
<g fill="#fff" font-family="Verdana,DejaVu Sans,sans-serif" font-size="11"><text x="6" y="14">${esc(l)}</text><text x="${lw + 6}" y="14">${esc(r)}</text></g></svg>`;
}
