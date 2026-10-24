/* snyvi.com, built.

     node site/build.mjs [--out site/out] [--check] [--offline]

   Static pages, no framework. What it reads, so the site can never drift
   from the app:

   - the theme tokens, from ui/app.css and ui/themes.css, as they are;
   - snyvi's face, from FACES in ui/app/*.js (docs/DESIGN.md §2.2: never
     redrawn by hand);
   - the docs, rendered by snyvi itself (`snyvi render`, comrak + syntect),
     so a page here reads exactly as it does in the window;
   - the release notes, from GitHub (or the git tags with --offline);
   - the version, from the newest release (Cargo.toml when there is none).

   --check fails when first paint (the home page's HTML, CSS and JS,
   gzipped) is over the budget below. */

import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { gunzipSync, gzipSync } from "node:zlib";
import { createHash } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const SRC = join(HERE, "src");
const args = process.argv.slice(2);
const flag = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const OUT = resolve(flag("--out") || join(HERE, "out"));
const CHECK = args.includes("--check");
const OFFLINE = args.includes("--offline");
const ORIGIN = "https://snyvi.com";
const REPO = "snymrova/snyvi";
const BUDGET = 40 * 1024;   // first paint, gzipped: HTML + CSS + JS

const read = p => readFileSync(join(ROOT, p), "utf8");
// The version a visitor installs is the newest release, not Cargo.toml's:
// main carries the next version's bump before its release is out.
const RELEASES = releases().sort((a, b) => b.at.localeCompare(a.at));
const VERSION = RELEASES.length ? RELEASES[0].tag.replace(/^v/, "") : read("Cargo.toml").match(/^version\s*=\s*"([^"]+)"/m)[1];
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
// A tag that sets words apart (a cell, an item, a span in a row) leaves a
// space, so "1.34.1</span><time>12 Oct" is not "1.34.112 Oct"; the ones
// inside a sentence leave nothing, so "<b>Run</b>." stays "Run.".
const INLINE = /^<\/?(a|b|i|em|strong|code|kbd|sup|sub|abbr)\b/i;
const stripTags = s => s.replace(/<[^>]+>/g, t => INLINE.test(t) ? "" : " ").replace(/\s+([.,;:!?)])/g, "$1").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();
const hash = s => createHash("sha256").update(s).digest("hex").slice(0, 10);
const write = (rel, data) => { const p = join(OUT, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, data); };
const copy = (from, rel) => { const p = join(OUT, rel); mkdirSync(dirname(p), { recursive: true }); copyFileSync(from, p); };

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

/* ---------- the tokens: the app's own, unedited ---------- */
const noComments = s => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\n\s*\n+/g, "\n");
const appCss = read("ui/app.css");
const tokFrom = appCss.indexOf("\n:root {\n  --sans");
const derive = appCss.indexOf(":root, [data-theme] {", tokFrom);
const tokTo = appCss.indexOf("\n}", derive) + 2;
if (tokFrom < 0 || derive < 0) throw new Error("tokens: the :root block or the accent derivation moved in ui/app.css");
const TOKENS = noComments(appCss.slice(tokFrom, tokTo)) + "\n" + noComments(read("ui/themes.css"));
// The themes whose ground is dark: their pictures are the -dark ones.
const DARK = [...TOKENS.matchAll(/\[data-theme="([a-z]+)"\]\s*\{\s*color-scheme:\s*dark/g)].map(m => m[1]);
if (!DARK.includes("ink")) throw new Error("tokens: Ink is not dark any more?");

/* ---------- the face: FACES, from the app ---------- */
const APP = join(ROOT, "ui", "app");
const appJs = readdirSync(APP).filter(p => p.endsWith(".js")).sort().map(p => readFileSync(join(APP, p), "utf8")).join("\n");
const fFrom = appJs.indexOf("  const EYE = ");
const fTo = appJs.indexOf("  /* The same head at the 72 px peek's size", fFrom);
if (fFrom < 0 || fTo < 0) throw new Error("faces: FACES or mascotHead moved in ui/app/");
const { FACES, mascotHead } = new Function(`${appJs.slice(fFrom, fTo)}\nreturn { FACES, mascotHead };`)();
const headRest = mascotHead("rest");
const cut = headRest.indexOf(FACES.rest);
const mark = (feel = "rest", cls = "") =>
  headRest.slice(0, cut).replace('class="mk"', `class="mk${cls ? " " + cls : ""}"`) + `<g class="mk-face">${FACES[feel] || FACES.rest}</g></svg>`;

/* ---------- icons: one stroke, one weight, drawn here ---------- */
const ICONS = {
  story: '<path d="M8 4.6C6.8 3.7 5 3.1 2.5 3.1v9.4c2.5 0 4.3.6 5.5 1.5 1.2-.9 3-1.5 5.5-1.5V3.1C11 3.1 9.2 3.7 8 4.6zM8 4.6V14"/>',
  install: '<path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10"/>',
  guide: '<path d="M4 1.8h5l3 3v9.4H4zM9 1.8v3h3M6.2 8.2h3.6M6.2 10.8h3.6"/>',
  changelog: '<circle cx="8" cy="8" r="5.6"/><path d="M8 5v3.2l2.1 1.3"/>',
  privacy: '<path d="M8 1.8 13 3.8v4c0 3-2.2 5.2-5 6.4-2.8-1.2-5-3.4-5-6.4v-4z"/>',
  blog: '<path d="M10.8 2.6 13.4 5.2 6 12.6 2.6 13.4 3.4 10z"/><path d="M9.2 4.2l2.6 2.6"/>',
  code: '<path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5"/>',
  maker: '<circle cx="8" cy="5.6" r="2.6"/><path d="M3 13.6c.6-2.4 2.6-4 5-4s4.4 1.6 5 4"/>',
  ext: '<path d="M6 3.5h6.5V10M12.5 3.5 4 12"/>',
  search: '<circle cx="7" cy="7" r="4.5"/><path d="m10.4 10.4 3.1 3.1"/>',
  theme: '<circle cx="8" cy="8" r="5.6"/><path d="M8 2.4v11.2a5.6 5.6 0 0 0 0-11.2z" fill="currentColor" stroke="none"/>',
  menu: '<path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11"/>',
  copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="1.6"/><path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2"/>',
  arrow: '<path d="M3 8h10M9 4l4 4-4 4"/>',
  chev: '<path d="m6 3.5 4.5 4.5L6 12.5"/>',
  play: '<path d="M5 3.5v9l7-4.5z" fill="currentColor"/>',
  pause: '<path d="M5.5 3.5v9M10.5 3.5v9"/>',
  close: '<path d="m4 4 8 8M12 4l-8 8"/>',
};
const icon = (n, cls = "") => `<svg class="ic${cls ? " " + cls : ""}" viewBox="0 0 16 16" aria-hidden="true">${ICONS[n]}</svg>`;

/* ---------- pictures of the real window, light and dark ---------- */
const MEDIA = join(ROOT, "docs", "media");
const used = new Set();
function webpSize(file) {
  const b = readFileSync(file);
  const kind = b.toString("ascii", 12, 16);
  if (kind === "VP8X") return [1 + b.readUIntLE(24, 3), 1 + b.readUIntLE(27, 3)];
  if (kind === "VP8 ") return [b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff];
  if (kind === "VP8L") { const n = b.readUInt32LE(21); return [1 + (n & 0x3fff), 1 + ((n >> 14) & 0x3fff)]; }
  throw new Error(`webp: can't size ${file}`);
}
function shot(name, alt, eager) {
  const img = (tone, cls) => {
    const f = `${name}-${tone}.webp`;
    if (!existsSync(join(MEDIA, f))) throw new Error(`shot: docs/media/${f} is missing`);
    used.add(f);
    const [w, h] = webpSize(join(MEDIA, f));
    return `<img class="${cls}" src="/media/${f}" width="${w / 2}" height="${h / 2}" alt="${esc(alt)}" ${eager ? 'fetchpriority="high"' : 'loading="lazy"'} decoding="async">`;
  };
  return `<figure class="shot">${img("light", "lt")}${img("dark", "dk")}</figure>`;
}
// A few seconds of the real window: the tour's own clips (docs/media/tour,
// served from /tour/, which the app's tour plays too), each over its last
// frame (ui/tour, the picture the app falls back to). No src until site.js
// sees it coming: nothing of it is first paint, and with motion off or no
// script the last frame, the thing done, is the picture.
const TOUR = join(MEDIA, "tour"), TOUR_PICS = join(ROOT, "ui", "tour");
const clips = new Set();
function clip(name, alt) {
  const vid = (tone, cls) => {
    const f = `tour-${name}-${tone}`;
    if (!existsSync(join(TOUR, `${f}.mp4`))) throw new Error(`clip: docs/media/tour/${f}.mp4 is missing`);
    clips.add(f);
    const poster = existsSync(join(TOUR_PICS, `${f}.webp`)) ? ` poster="/tour/${f}.webp"` : "";
    return `<video class="${cls}" width="560" height="315" muted loop playsinline preload="none" disablepictureinpicture disableremoteplayback${poster} data-src="/tour/${f}.mp4" aria-label="${esc(alt)}"></video>`;
  };
  return `<figure class="shot clip" data-clip>${vid("light", "lt")}${vid("dark", "dk")}<button class="clip-btn" type="button" aria-label="Pause">${icon("pause")}${icon("play")}</button></figure>`;
}
// Which picture shows is the theme's, not the system's: a reader on Midnight
// in a light OS sees the dark window.
const SHOT_CSS = `
.shot .dk { display: none; }
${DARK.map(t => `[data-theme="${t}"] .shot .dk`).join(", ")} { display: block; }
${DARK.map(t => `[data-theme="${t}"] .shot .lt`).join(", ")} { display: none; }`;

/* ---------- install, for every OS ---------- */
const OSES = [
  ["macos", "macOS", "brew install --cask snymrova/snyvi/snyvi",
    `No Homebrew? <code>curl -fsSL https://snyvi.com/install.sh | sh</code> works on a Mac too.`],
  ["linux", "Linux", "curl -fsSL https://snyvi.com/install.sh | sh",
    `No root, and every download is checked against its checksum. <a href="https://github.com/${REPO}/blob/main/install.sh">Read it first</a>.`],
  // Scoop leads until winget-pkgs merges snymrova.snyvi (#450634); then winget.
  ["windows", "Windows", "scoop bucket add snyvi https://github.com/snymrova/scoop-snyvi; scoop install snyvi",
    `No prompt, no admin. Or <a href="/install#windows">the installer</a>.`],
];
const install = () => `<div class="install" data-install>
<div class="tabs" role="tablist" aria-label="Your system">${OSES.map(([id, label], i) =>
    `<button class="tab" type="button" role="tab" data-os="${id}" aria-selected="${i === 0}">${label}</button>`).join("")}</div>
${OSES.map(([id, label, cmd, note]) => `<div class="os-panel" data-os="${id}" role="tabpanel" aria-label="${label}">
<p class="os-name">${label}</p>
<div class="cmd"><code><span class="pr">$ </span>${esc(cmd)}</code><button class="copy" type="button">${icon("copy")}<span>Copy</span></button></div>
<p class="install-note">${note} <a href="/install">Every way to install</a></p>
</div>`).join("\n")}
</div>`;

/* ---------- the pages' own markup ---------- */
function expand(html) {
  return html
    .replace(/\{\{version\}\}/g, VERSION)
    .replace(/\{\{install\}\}/g, install)
    .replace(/\{\{icon:([a-z]+)\}\}/g, (_, n) => icon(n))
    .replace(/\{\{mascot:([a-z]+):?([a-z-]*)\}\}/g, (_, f, c) => mark(f, c))
    .replace(/\{\{shot:([a-z]+)\|([^|}]+)(?:\|(eager))?\}\}/g, (_, n, alt, e) => shot(n, alt, !!e))
    .replace(/\{\{clip:([a-z]+)\|([^|}]+)\}\}/g, (_, n, alt) => clip(n, alt));
}
function readPage(file) {
  const raw = readFileSync(file, "utf8");
  const m = raw.match(/^<!--(\{[\s\S]*?\})-->\n?/);
  if (!m) throw new Error(`${file}: no front matter`);
  return { ...JSON.parse(m[1]), body: expand(raw.slice(m[0].length)) };
}

/* ---------- the docs, rendered by snyvi ---------- */
const BIN = process.env.SNYVI_BIN ||
  ["target/release/snyvi", "target/debug/snyvi"].map(p => join(ROOT, p)).find(existsSync) || "snyvi";
// Each doc's description is written for a search result, not cut from its
// first paragraph, which talks to a reader of the repository.
const DOCS = {
  "GUIDE.md": { path: "/guide", nav: "guide", head: "Guide",
    description: "Everything snyvi does, in full: installing it, connecting your agents, desks and panels, notes, Your turn, Home, search, themes and the keys." },
  "WIDGETS.md": { path: "/guide/widgets", nav: "widgets", head: "Widgets",
    description: "Arrange snyvi's sidebars, and give a desk a small status box that an agent, a script or snyvi itself keeps up to date." },
  "PEER.md": { path: "/guide/friends", nav: "friends", head: "A friend's snyvi",
    description: "How a document reaches a friend's snyvi: pairing with three words, sealed to their key, through a relay that reads none of it." },
};
const ROUTES = { ...Object.fromEntries(Object.entries(DOCS).map(([f, d]) => [f, d.path])), "../README.md": "/", "../install.sh": `https://github.com/${REPO}/blob/main/install.sh` };
function docLinks(html) {
  return html.replace(/(href|src)="([^"#:][^"]*?)(#[^"]*)?"/g, (all, attr, p, frag = "") => {
    if (/^(https?:|mailto:|\/)/.test(p)) return all;
    if (attr === "src" && p.startsWith("media/")) {
      const f = p.slice(6);
      if (existsSync(join(MEDIA, f))) { used.add(f); return `src="/media/${f}"`; }
    }
    if (ROUTES[p]) return `${attr}="${ROUTES[p]}${frag}"`;
    const inRepo = posix.normalize(posix.join("docs", p));
    return `${attr}="https://github.com/${REPO}/blob/main/${inRepo}${frag}"`;
  });
}
function renderDoc(file, meta) {
  let html = execFileSync(BIN, ["render", join(ROOT, "docs", file)], { encoding: "utf8", maxBuffer: 64 << 20 });
  // The renderer puts a heading's id on an anchor inside it; the site wants it on the heading.
  html = html.replace(/<h([1-6])><a tabindex="-1" href="#([^"]+)" aria-hidden="true" class="anchor" id="[^"]+"><\/a>/g, '<h$1 id="$2">');
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
  const title = h1 ? stripTags(h1[1]) : meta.head;
  html = docLinks(html).replace(/<img (?![^>]*loading=)/g, '<img loading="lazy" decoding="async" ');
  return { ...meta, title: `${title} · snyvi`, h1: title, rail: "toc", source: `docs/${file}`, body: html };
}

/* ---------- the changelog: every release, newest first ---------- */
function releases() {
  if (!OFFLINE) {
    try {
      const out = execFileSync("gh", ["api", `repos/${REPO}/releases?per_page=100`, "--paginate", "--jq",
        ".[] | select(.draft|not) | [.tag_name, .name, .published_at, .html_url] | @tsv"], { encoding: "utf8" });
      return out.trim().split("\n").filter(Boolean).map(l => { const [tag, name, at, url] = l.split("\t"); return { tag, name, at, url }; });
    } catch (e) { console.warn(`changelog: gh failed (${e.message.split("\n")[0]}), using git tags`); }
  }
  const out = execFileSync("git", ["-C", ROOT, "for-each-ref", "--sort=-creatordate", "--format=%(refname:short)\t%(subject)\t%(creatordate:iso-strict)", "refs/tags/v*"], { encoding: "utf8" });
  return out.trim().split("\n").filter(Boolean).map(l => { const [tag, name, at] = l.split("\t"); return { tag, name, at, url: `https://github.com/${REPO}/releases/tag/${tag}` }; });
}
// A release's title is its PR's: the first line of the merge commit's body
// (GitHub writes the PR title there), or the commit's subject when the tag
// is not on a merge.
function titleOf(tag) {
  try {
    const [parents, subject, body] = execFileSync("git", ["-C", ROOT, "log", "-1", "--format=%P%x00%s%x00%b", tag], { encoding: "utf8" }).split("\0");
    return (parents.trim().split(" ").length > 1 ? body.split("\n")[0] : subject).trim();
  } catch { return ""; }
}
function changelog() {
  const months = new Map();
  for (const r of RELEASES) {
    const d = new Date(r.at);
    const key = d.toLocaleString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
    if (!months.has(key)) months.set(key, []);
    const summary = titleOf(r.tag).replace(/^v?\d+\.\d+\.\d+\s*[:·-]?\s*/, "");
    months.get(key).push(`<li><a href="${esc(r.url)}"><span class="v">${esc(r.tag.replace(/^v/, ""))}</span><time datetime="${esc(r.at)}">${d.toLocaleString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" })}</time><span>${summary ? esc(/^snyvi\b/.test(summary) ? summary : summary[0].toUpperCase() + summary.slice(1)) : "Release notes"}</span></a></li>`);
  }
  const body = `<h1>Changelog</h1>
<p class="lede">Every release, newest first. snyvi updates itself to each one at a quiet moment, so this is mostly a record of what already arrived. The full notes for each are on GitHub.</p>
${[...months].map(([m, items]) => `<h2 id="${m.toLowerCase().replace(/\s+/g, "-")}">${m}</h2>\n<ul class="versions">${items.join("")}</ul>`).join("\n")}`;
  return { path: "/changelog", nav: "changelog", head: "Changelog", title: "Changelog · snyvi", h1: "Changelog",
    description: `Every snyvi release, newest first. The latest is ${VERSION}.`, rail: "toc", body };
}

/* ---------- the frame: snyvi's sidebar, the page, the rail ---------- */
const NAV = [
  ["story", "/", "The story", "story"],
  ["install", "/install", "Install", "install"],
  ["guide", "/guide", "Guide", "guide", [["widgets", "/guide/widgets", "Widgets"], ["friends", "/guide/friends", "A friend's snyvi"]]],
  ["changelog", "/changelog", "Changelog", "changelog"],
  ["blog", "/blog", "Blog", "blog"],
  ["privacy", "/privacy", "Privacy", "privacy"],
];
const headings = (html, max = 3) => [...html.matchAll(/<h([23]) id="([^"]+)"[^>]*>([\s\S]*?)<\/h\1>/g)]
  .filter(m => +m[1] <= max).map(m => ({ level: +m[1], id: m[2], text: stripTags(m[3]) }));

function sidebar(page) {
  const rows = NAV.map(([id, href, label, ic, kids]) => {
    const cur = page.nav === id;
    let out = `<a class="row" href="${href}"${cur ? ' aria-current="page"' : ""}>${icon(ic)}<span>${label}</span></a>`;
    if (id === "story" && cur) {
      out += `<div class="sub">${headings(page.body, 2).filter(h => h.id !== "close").map(h => `<a class="row" href="/#${h.id}">${esc(h.text)}</a>`).join("")}</div>`;
    }
    if (kids) out += `<div class="sub">${kids.map(([kid, kh, kl]) => `<a class="row" href="${kh}"${page.nav === kid ? ' aria-current="page"' : ""}>${kl}</a>`).join("")}</div>`;
    return out;
  }).join("\n");
  return `<aside class="side" id="side" aria-label="snyvi.com">
<div class="brand"><a class="brand-name" href="/">${mark("rest")}snyvi</a><span class="fact">v${VERSION}</span></div>
<nav class="nav" aria-label="Pages">
<button class="row search-row" type="button" data-search>${icon("search")}<span>Search</span><kbd>⌘K</kbd></button>
<div class="label">snyvi.com</div>
${rows}
<div class="label">Elsewhere</div>
<a class="row" href="https://github.com/${REPO}">${icon("code")}<span>GitHub</span>${icon("ext", "ext")}</a>
<a class="row" href="https://github.com/${REPO}/releases/latest">${icon("install")}<span>Latest release</span>${icon("ext", "ext")}</a>
<a class="row" href="https://mrova.rocks/snyvi">${icon("maker")}<span>The maker</span>${icon("ext", "ext")}</a>
</nav>
<div class="foot"><button class="theme-btn" id="theme-btn" type="button" aria-haspopup="menu" aria-expanded="false" aria-controls="theme-menu">${icon("theme")}<span class="theme-name">Paper</span></button><span class="fact">MIT</span></div>
</aside>`;
}

function rail(page) {
  if (page.rail === "none") return "";
  const hs = headings(page.body, page.nav === "guide" ? 2 : 3).filter(h => h.id !== "close");
  // On the story the sidebar already lists the sections; the rail keeps to facts and actions.
  const toc = hs.length && page.nav !== "story" ? `<ol class="toc">${hs.map(h => `<li class="h${h.level}"><a href="#${h.id}">${esc(h.text)}</a></li>`).join("")}</ol>` : "";
  const hasInstall = page.body.includes("data-install");
  return `<aside class="rail" aria-label="On this page">
${toc}
<dl class="meta">
<dt>Version</dt><dd class="fact">${VERSION}</dd>
<dt>Licence</dt><dd>MIT</dd>
<dt>Runs on</dt><dd>Linux, macOS, Windows</dd>
<dt>Listens on</dt><dd class="fact">127.0.0.1</dd>
${page.source ? `<dt>Source</dt><dd><a href="https://github.com/${REPO}/blob/main/${page.source}">${page.source.replace("docs/", "")}</a></dd>` : ""}
</dl>
<div class="acts">
${hasInstall ? `<button class="act" type="button" id="act-copy">${icon("copy")}<span>Copy the install line</span></button>` : `<a class="act" href="/install">${icon("install")}<span>Install</span></a>`}
<button class="act" type="button" data-film>${icon("play")}<span>Watch the film</span><kbd>f</kbd></button>
<button class="act" type="button" data-search>${icon("search")}<span>Search</span><kbd>⌘K</kbd></button>
<button class="act" type="button" onclick="document.getElementById('theme-btn').click()">${icon("theme")}<span>Theme</span><kbd>t</kbd></button>
<a class="act" href="https://github.com/${REPO}">${icon("code")}<span>Open on GitHub</span></a>
</div>
</aside>`;
}

// The window's keys are the Mac's glyphs here; site.js shows a Linux or
// Windows reader what their keyboard says (the desk's ⌃⌥ is Ctrl Alt on
// every system, ui/desk/07-actions.js).
const PC_KEYS = { "⌘K": "Ctrl K", "⌃⌥Z": "Ctrl Alt Z" };
// What a search engine is told snyvi is, on the home page: the facts the
// page says, as data.
const LD = JSON.stringify({
  "@context": "https://schema.org", "@type": "SoftwareApplication", name: "snyvi", url: ORIGIN,
  description: "All your passion projects, in one calm place. A desktop app where your Claude Code sessions work, one desk for each project.",
  applicationCategory: "DeveloperApplication", operatingSystem: "Linux, macOS, Windows",
  softwareVersion: VERSION, license: "https://opensource.org/licenses/MIT",
  downloadUrl: `${ORIGIN}/install`, codeRepository: `https://github.com/${REPO}`,
  offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
}).replace(/</g, "\\u003c");
const pcKeys = html => html.replace(/<kbd>(⌘K|⌃⌥Z)<\/kbd>/g, (_, k) => `<kbd data-pc="${PC_KEYS[k]}">${k}</kbd>`);

let CSS_V = "", JS_V = "";
function frame(page) {
  const url = ORIGIN + (page.path === "/404" ? "/" : page.path);
  const head = page.nav === "story" ? "From the snyvi desk" : "snyvi.com";
  return `<!doctype html>
<html lang="en" data-theme="paper"${page.arrive ? " data-arrive" : ""}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(page.title)}</title>
<meta name="description" content="${esc(page.description)}">
${page.noindex ? '<meta name="robots" content="noindex">' : `<link rel="canonical" href="${url}">`}
<meta property="og:type" content="${page.article ? "article" : "website"}">
<meta property="og:site_name" content="snyvi">
<meta property="og:title" content="${esc(page.h1 || page.title)}">
<meta property="og:description" content="${esc(page.description)}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${ORIGIN}${page.og || "/og.png"}">
<meta name="twitter:card" content="summary_large_image">
<meta name="color-scheme" content="light dark">${page.path === "/" ? `\n<script type="application/ld+json">${LD}</script>` : ""}
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<script>(()=>{const r=document.documentElement;let t,a;try{t=localStorage.getItem("snyvi-site-theme");a=localStorage.getItem("snyvi-site-accent")}catch{}r.dataset.theme=t||(matchMedia("(prefers-color-scheme: dark)").matches?"ink":"paper");if(a)r.dataset.accent=a;r.classList.add("js")})()</script>
<link rel="preload" href="/fonts/inter.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/fonts/archivo.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/assets/site.css?v=${CSS_V}">
<script defer src="/assets/site.js?v=${JS_V}"></script>
</head>
<body>
<a class="skip" href="#doc">Skip to the page</a>
<header class="bar"><a class="brand-name" href="/">${mark("rest")}snyvi</a><button class="icon-btn" type="button" data-search aria-label="Search">${icon("search")}</button><button class="icon-btn" type="button" id="nav-btn" aria-expanded="false" aria-controls="side" aria-label="Pages">${icon("menu")}</button></header>
${sidebar(page)}
<div class="pop theme-menu" id="theme-menu" role="menu" aria-label="Theme" hidden><div class="menu-label">Theme</div><div class="theme-list"></div><div class="accents" aria-label="Accent"></div></div>
<main id="doc">
<article class="doc">
<div class="doc-head"><span class="led${page.arrive ? " info" : ""}"></span><span>${head}</span><span class="sep">·</span><span>${esc(page.head)}</span><span class="sep">·</span><span class="fact">v${VERSION}</span></div>
${page.body}
</article>
</main>
${rail(page)}
<dialog id="palette" class="palette" aria-label="Search snyvi.com"><input type="search" placeholder="Search every page" aria-label="Search every page" autocomplete="off" spellcheck="false"><ul class="results" role="listbox"></ul><div class="palette-foot"><span><kbd>↑</kbd> <kbd>↓</kbd> move</span><span><kbd>↵</kbd> open</span><span><kbd>esc</kbd> close</span></div></dialog>
<dialog id="film" class="film" aria-label="The film"><button class="icon-btn film-close" id="film-close" type="button" aria-label="Close the film">${icon("close")}</button><video controls playsinline preload="none" data-src="/media/demo.mp4"></video></dialog>
</body>
</html>
`;
}

/* ---------- build ---------- */
const pages = readdirSync(join(SRC, "pages")).filter(f => f.endsWith(".html")).map(f => readPage(join(SRC, "pages", f)));
for (const [f, meta] of Object.entries(DOCS)) pages.push(renderDoc(f, meta));
pages.push(changelog());
for (const p of pages) { p.h1 ||= stripTags((p.body.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) || ["", p.head])[1]); }

const css = TOKENS + "\n" + readFileSync(join(SRC, "site.css"), "utf8") + SHOT_CSS;
const PAIRS = { passion: [appCss.match(/--accent-l:\s*(#[0-9a-f]+)/)[1], appCss.match(/--accent-d:\s*(#[0-9a-f]+)/)[1]] };
for (const m of appCss.matchAll(/:root\[data-accent="([a-z]+)"\]\s*\{\s*--accent-l:\s*(#[0-9a-f]+);\s*--accent-d:\s*(#[0-9a-f]+)/g)) PAIRS[m[1]] = [m[2], m[3]];
const js = `window.SNYVI_ACCENTS=${JSON.stringify(PAIRS)};window.SNYVI_FACES=${JSON.stringify({ rest: FACES.rest, whoa: FACES.whoa })};` +
  `window.SNYVI_MARK=f=>${JSON.stringify(mark("rest"))}.replace(${JSON.stringify(FACES.rest)},(${JSON.stringify(FACES)})[f]||${JSON.stringify(FACES.rest)});\n` +
  readFileSync(join(SRC, "site.js"), "utf8");
CSS_V = hash(css); JS_V = hash(js);
write("assets/site.css", css);
write("assets/site.js", js);

const index = [];
for (const p of pages) {
  const file = p.path === "/" ? "index.html" : p.path.slice(1) + ".html";
  write(file, pcKeys(frame(p)));
  if (p.noindex) continue;
  index.push({ d: 0, t: p.h1, u: p.path, p: p.head, b: p.description.slice(0, 160) });
  const re = /<h([23]) id="([^"]+)"[^>]*>([\s\S]*?)<\/h\1>([\s\S]*?)(?=<h[1-3][ >]|$)/g;
  for (const m of p.body.matchAll(re)) {
    if (m[2] === "close") continue;
    index.push({ d: +m[1] - 1, t: stripTags(m[3]), u: `${p.path}#${m[2]}`, p: p.h1, b: stripTags(m[4]).slice(0, 160) });
  }
}
write("search.json", JSON.stringify(index));

// What the pages point at, and nothing else from docs/media.
for (const f of used) copy(join(MEDIA, f), `media/${f}`);
copy(join(MEDIA, "faces.svg"), "media/faces.svg");
copy(join(MEDIA, "demo.mp4"), "media/demo.mp4");
// All of them, not only the page's: the window's tour plays them from
// snyvi.com/tour/ (ui/about.js TOUR_CLIPS). The pictures are for the page's.
for (const f of readdirSync(TOUR).filter(f => f.endsWith(".mp4"))) copy(join(TOUR, f), `tour/${f}`);
for (const f of clips) if (existsSync(join(TOUR_PICS, `${f}.webp`))) copy(join(TOUR_PICS, `${f}.webp`), `tour/${f}.webp`);
for (const f of ["inter.woff2", "inter-italic.woff2", "jetbrains-mono.woff2"]) copy(join(ROOT, "ui", "fonts", f), `fonts/${f}`);
copy(join(ROOT, "ui", "fonts", "OFL.txt"), "fonts/OFL.txt");
copy(join(HERE, "fonts", "archivo.woff2"), "fonts/archivo.woff2");
copy(join(HERE, "fonts", "OFL.txt"), "fonts/OFL-archivo.txt");
copy(join(ROOT, "icons", "icon.svg"), "favicon.svg");
if (existsSync(join(SRC, "og.png"))) copy(join(SRC, "og.png"), "og.png");
// A post's film, its poster and its share picture, served beside it.
for (const f of readdirSync(join(SRC, "blog"))) copy(join(SRC, "blog", f), `blog/${f}`);
write("assets/mermaid.js", gunzipSync(readFileSync(join(ROOT, "ui", "mermaid.min.js.gz"))));
for (const f of ["_headers", "_redirects"]) copy(join(SRC, f), f);
write("robots.txt", `User-agent: *\nAllow: /\nSitemap: ${ORIGIN}/sitemap.xml\n`);
write("sitemap.xml", `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${pages.filter(p => !p.noindex).map(p => `<url><loc>${ORIGIN}${p.path}</loc></url>`).join("\n")}\n</urlset>\n`);

/* ---------- the budget ---------- */
const gz = s => gzipSync(s, { level: 9 }).length;
const home = readFileSync(join(OUT, "index.html"), "utf8");
const first = gz(home) + gz(css) + gz(js);
const total = (dir => { let n = 0; const walk = d => readdirSync(d).forEach(f => { const p = join(d, f); statSync(p).isDirectory() ? walk(p) : (n += statSync(p).size); }); walk(dir); return n; })(OUT);
console.log(`snyvi.com ${VERSION}: ${pages.length} pages, ${index.length} search entries, ${used.size} pictures`);
console.log(`first paint ${(first / 1024).toFixed(1)} KB gzipped (HTML ${(gz(home) / 1024).toFixed(1)} + CSS ${(gz(css) / 1024).toFixed(1)} + JS ${(gz(js) / 1024).toFixed(1)}), budget ${BUDGET / 1024} KB; site ${(total / 1e6).toFixed(1)} MB`);
if (CHECK && first > BUDGET) { console.error("over the first-paint budget"); process.exit(1); }
