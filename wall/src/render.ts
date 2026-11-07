/*
 * What a page looks like at snyvi.page/<slug>: one fixed template in three
 * tones (Software · Book · Design), the page's accent and its wash,
 * following the reader's light or dark (design round 40303cb7e4). Rendered
 * once at each write and kept in R2, so a read costs no Worker time.
 *
 * Never the builder's HTML: every field is escaped, a moment's Markdown is
 * cut to the reader's set (paragraphs, emphasis, code, https links), there
 * is no script at all, and the CSP the read is served with allows pictures
 * and clips from this origin only.
 */

export interface PageJson {
  slug: string; title: string; lede: string; kind: string; tone: string; stage: string;
  looking_for: string; logo: string; cover: string; hero: string; facts: string[];
  github: string; links: { label: string; url: string }[]; accent: string; wash: string;
  count_shown: boolean;
}
export interface MomentJson { id: number; title: string; body_md: string; files: string[]; at: number }

/** The eight, as snyvi's app.css pairs them: light ink, dark ink. */
const EIGHT: Record<string, [string, string]> = {
  passion: ["#8c0f26", "#f97e92"], crimson: ["#b91c1c", "#f87171"], rose: ["#be185d", "#f472b6"],
  violet: ["#7c3aed", "#a78bfa"], blue: ["#1d4ed8", "#60a5fa"], teal: ["#0f766e", "#2dd4bf"],
  green: ["#137639", "#4ade80"], graphite: ["#57534e", "#d6d3d1"],
};
const HEART: Record<string, string> = { software: "I'd use this", book: "I'd read this", design: "I'd try this" };

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

/** The page whole, as snyvi.page/<slug> serves it. */
export function pageHtml(p: PageJson, moments: MomentJson[], hearts: number, origin: string): string {
  const [l, d] = EIGHT[p.accent] || EIGHT.passion;
  const wash = /^#[0-9a-f]{6}$/i.test(p.wash || "") ? p.wash : "transparent";
  const tone = ["software", "book", "design"].includes(p.tone) ? p.tone : "software";
  const facts = new Set(p.facts || []);
  const last = moments[0];
  const cells = [
    facts.has("stage") && p.stage ? `<div><small>Stage</small><b>${esc(p.stage)}</b></div>` : "",
    facts.has("kind") && p.kind ? `<div><small>Kind</small><b>${esc(p.kind)}</b></div>` : "",
    facts.has("last") && last ? `<div><small>Last moment</small><b>${esc(when(last.at))}</b></div>` : "",
    facts.has("looking") && p.looking_for ? `<div><small>Looking for</small><b>${esc(p.looking_for)}</b></div>` : "",
  ].join("");
  const mark = fileOk(p.logo) ? `<img class="mark" src="/files/${p.logo}" alt="">` : `<span class="mark i">${esc((p.title || "?").charAt(0).toUpperCase())}</span>`;
  const hero = p.hero === "picture" && fileOk(p.cover) ? `<div class="cover">${media(p.cover)}</div>` : "";
  const links = [
    httpsOk(p.github) ? `<li><a href="${esc(p.github)}" rel="nofollow noopener noreferrer">${esc(p.github.replace(/^https:\/\//, ""))}</a></li>` : "",
    ...(p.links || []).filter((k) => httpsOk(k.url)).slice(0, 6).map((k) => `<li><a href="${esc(k.url)}" rel="nofollow noopener noreferrer">${esc(k.label || k.url)}</a></li>`),
  ].join("");
  const ms = moments.slice(0, 50).map((m, i) => `<li${i ? "" : ' class="new"'}><time>${esc(when(m.at))}</time><h3>${esc(m.title)}</h3>${md(m.body_md)}${(m.files || []).slice(0, 4).map(media).join("")}</li>`).join("");
  const count = p.count_shown ? `<span class="heart" title="${esc(HEART[tone])}">♥ ${hearts}</span>` : `<span class="heart" title="${esc(HEART[tone])}">♥</span>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(p.title)} · snyvi.page</title><meta name="description" content="${esc(p.lede)}">
<meta property="og:title" content="${esc(p.title)}"><meta property="og:description" content="${esc(p.lede)}"><meta property="og:url" content="${esc(origin)}/${esc(p.slug)}">
<style>
:root{color-scheme:light dark;--bg:light-dark(#faf9f6,#15181f);--raise:light-dark(#fff,#1c2029);--fg:light-dark(#1f1d1a,rgba(255,255,255,.87));--fg2:light-dark(#5c574f,rgba(255,255,255,.62));--fg3:light-dark(#736c61,rgba(255,255,255,.47));--rule:light-dark(#e6e2da,rgba(255,255,255,.1));--accent:light-dark(${l},${d});--wash:${wash}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1040px;margin:0 auto;padding:24px 16px 48px}a{color:var(--accent)}
.head{display:flex;gap:14px;align-items:center}.mark{width:56px;height:56px;border-radius:12px;object-fit:contain;flex:none}.mark.i{display:grid;place-items:center;background:var(--accent);color:var(--bg);font-weight:600;font-size:26px}
h1{margin:0;font-size:34px;line-height:1.15}.by{color:var(--fg3);font-size:13px}.heart{margin-left:auto;color:var(--accent);font-size:18px;white-space:nowrap}
.book h1,.book .lede{font-family:"Source Serif 4",Georgia,serif}.lede{font-size:18px;margin:0}.book .lede{font-size:20px}.design .lede{font-size:15px}
.hero{margin:20px -16px 0;padding:20px 16px;background:color-mix(in srgb,var(--wash) 12%,transparent)}.cover img,.cover video{width:100%;border-radius:12px;margin-top:16px}
.facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:0 -16px;padding:12px 16px;background:color-mix(in srgb,var(--wash) 7%,transparent);border-block:1px solid var(--rule)}
.facts small{display:block;font-size:11px;color:var(--fg3);text-transform:uppercase;letter-spacing:.04em}.facts b{font-weight:500}
.body{display:grid;grid-template-columns:minmax(0,1fr) 220px;gap:32px;margin-top:24px}h2{font-size:12px;color:var(--fg3);text-transform:uppercase;letter-spacing:.04em;margin:0 0 10px}
ol{list-style:none;margin:0;padding:0 0 0 16px;border-left:2px solid var(--rule)}li{position:relative;margin:0 0 22px}ol li::before{content:"";position:absolute;left:-23px;top:8px;width:12px;height:12px;border-radius:50%;background:var(--rule)}ol li.new::before{background:var(--accent)}
li h3{margin:2px 0 4px;font-size:17px}time{font-size:12px;color:var(--fg3)}li img,li video{display:block;max-width:100%;border-radius:10px;margin-top:8px}
ul{list-style:none;margin:0;padding:0}ul li{margin:0 0 8px;overflow-wrap:anywhere}.foot{margin-top:40px;font-size:12px;color:var(--fg3)}
@media (max-width:720px){.body{grid-template-columns:1fr}h1{font-size:26px}}
</style></head><body><main class="${tone}">
<header class="head">${mark}<div><h1>${esc(p.title)}</h1><div class="by">snyvi.page/${esc(p.slug)}</div></div>${count}</header>
<div class="hero"><p class="lede">${esc(p.lede)}</p>${hero}</div>
${cells ? `<div class="facts">${cells}</div>` : ""}
<div class="body"><section><h2>Moments</h2>${ms ? `<ol>${ms}</ol>` : `<p class="by">No moments yet.</p>`}</section>
<aside><h2>Links</h2><ul>${links}</ul><p class="foot">Made on a snyvi desk. What is here is what its builder pressed Publish on, and nothing else of their machine.</p></aside></div>
</main></body></html>`;
}

/** A page's card on the wall: the head row, one line, the newest moment. */
export function card(p: PageJson, moments: MomentJson[], hearts: number, checkedAt: number) {
  const m = moments[0];
  return {
    slug: p.slug, title: p.title, lede: p.lede, kind: p.kind, tone: p.tone, stage: p.stage,
    accent: EIGHT[p.accent] ? p.accent : "passion", wash: /^#[0-9a-f]{6}$/i.test(p.wash || "") ? p.wash : "",
    logo: fileOk(p.logo) ? p.logo : "", cover: p.hero === "picture" && fileOk(p.cover) ? p.cover : "",
    hearts: p.count_shown ? hearts : null, checked_at: checkedAt,
    moment: m ? { id: m.id, title: m.title, at: m.at, file: (m.files || []).find(fileOk) || "" } : null,
  };
}
