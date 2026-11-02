/* Music while you work (#204, mockups f8c3ab0b33). The reader's, on every
 * page: ♪ in the sidebar's head, or in its rail when it is folded, opens
 * this pop beside the sidebar, the way a folded section opens.
 *
 * Three sources: the stations snyvi lists (src/music.rs, each probed before
 * it was listed), a stream the reader adds by its address, and a music
 * folder they pick. A station plays through the daemon (/api/music/play/n),
 * which fetches the one stream pressed: the page's CSP lets media come from
 * the daemon alone, and stays so. A folder's track is the daemon's file
 * (/api/music/file/n), with Range, so it seeks.
 *
 * One <audio>, made once and kept on <body>: the page never reloads between
 * documents, desks and Home, so the music plays on through all of them.
 * One sound at a time, the rule ui/player.js keeps in a document: music
 * pauses a song or a video that starts, and a song pauses for the music.
 * Nothing here starts on its own -- only a press plays. */

const STYLE = `
#music-pop { position: fixed; z-index: var(--z-pop); width: 300px; max-height: min(600px, calc(100vh - 16px)); display: flex; flex-direction: column;
  background: var(--bg-raise); border: 1px solid var(--rule); border-radius: var(--r-sm); box-shadow: var(--shadow); font-size: var(--fs-ui);
  animation: sheet-l var(--dur-quick) var(--ease-out); }
#music-pop[hidden] { display: none; }
#music-pop .mu-h { flex: none; display: flex; align-items: center; height: 36px; padding: 0 6px 0 12px; font-size: var(--fs-small); font-weight: 600; color: var(--fg-3); }
#music-pop .mu-h span { flex: 1; }
#music-pop .mu-b { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 0 8px 8px; scrollbar-width: thin; }
#music-pop .mu-x, #music-pop .mu-ib { width: 26px; height: 26px; display: grid; place-items: center; padding: 0; border: 0; border-radius: var(--r-xs); background: none; color: var(--fg-3); cursor: pointer; }
#music-pop .mu-x:hover, #music-pop .mu-ib:hover { background: var(--rule); color: var(--fg); }
#music-pop svg { width: 14px; height: 14px; }
.mu-seg { display: flex; margin: 0 0 8px; padding: 2px; border-radius: var(--r-sm); background: var(--rule); }
.mu-seg button { flex: 1; height: 24px; border: 0; border-radius: var(--r-xs); background: none; font: inherit; font-size: var(--fs-small); color: var(--fg-2); cursor: pointer; }
.mu-seg button[aria-pressed="true"] { background: var(--bg-raise); color: var(--fg); font-weight: 600; box-shadow: var(--shadow-1); }
.mu-grp { display: flex; flex-wrap: wrap; gap: 4px; margin: 0 0 6px; }
.mu-chip { height: 22px; padding: 0 8px; border: 1px solid var(--rule-2); border-radius: var(--r-pill); background: none; font: inherit; font-size: var(--fs-small); color: var(--fg-2); cursor: pointer; }
.mu-chip:hover { color: var(--fg); border-color: var(--fg-3); }
.mu-chip[aria-pressed="true"] { background: var(--fg); border-color: var(--fg); color: var(--bg-raise); font-weight: 600; }
.mu-row { display: flex; align-items: center; gap: 8px; width: 100%; min-height: 30px; padding: 0 4px 0 6px; border: 0; border-radius: var(--r-xs); background: none; font: inherit; color: var(--fg); text-align: left; cursor: pointer; }
.mu-row:hover { background: var(--rule); }
.mu-row .mu-pp { flex: none; width: 20px; height: 20px; display: grid; place-items: center; border-radius: 50%; color: var(--fg-3); }
.mu-row:hover .mu-pp { background: var(--fg); color: var(--bg-raise); }
.mu-row .mu-pp svg { width: 10px; height: 10px; }
.mu-row .mu-t { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mu-row .mu-m { flex: none; font-size: var(--fs-micro); color: var(--fg-3); font-variant-numeric: tabular-nums; }
.mu-row.on { background: var(--accent-bg, var(--rule)); }
.mu-row.on .mu-t { font-weight: 600; }
.mu-row.on .mu-pp { background: var(--accent); color: #fff; }
.mu-row.bad .mu-m { color: var(--danger); }
.mu-row .mu-rm { visibility: hidden; }
.mu-row:hover .mu-rm, .mu-row:focus-within .mu-rm { visibility: visible; }
.mu-add { display: flex; align-items: center; gap: 6px; width: 100%; height: 28px; padding: 0 8px; border: 0; border-radius: var(--r-xs); background: none; font: inherit; font-size: var(--fs-small); color: var(--fg-3); cursor: pointer; }
.mu-add:hover { background: var(--rule); color: var(--fg); }
.mu-url { display: flex; gap: 4px; margin: 2px 0 4px; }
.mu-url input { flex: 1; min-width: 0; height: 28px; padding: 0 8px; border: 1px solid var(--rule-2); border-radius: var(--r-xs); background: var(--bg); color: var(--fg); font: inherit; font-size: var(--fs-small); }
.mu-err { margin: 2px 8px 6px; font-size: var(--fs-small); color: var(--danger); }
.mu-note { margin: 4px 6px 10px; font-size: var(--fs-small); color: var(--fg-3); }
.mu-fl { display: flex; align-items: center; gap: 6px; padding: 0 4px 6px 6px; font-size: var(--fs-small); color: var(--fg-3); }
.mu-fl b { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg-2); font-weight: 600; }
.mu-fl .sp { flex: 1; }
.mu-tog { border: 0; background: none; padding: 2px 4px; border-radius: var(--r-xs); font: inherit; font-size: var(--fs-small); color: var(--fg-3); cursor: pointer; }
.mu-tog:hover { color: var(--fg); }
.mu-tog[aria-pressed="true"] { color: var(--accent); font-weight: 600; }
.mu-pill { flex: none; display: flex; align-items: center; gap: 4px; height: 36px; margin: 0 8px 8px; padding: 0 6px 0 4px; border: 1px solid var(--rule-2); border-radius: var(--r-pill); background: var(--bg); }
.mu-pill[hidden] { display: none; }
.mu-pill .mu-play { flex: none; width: 28px; height: 28px; display: grid; place-items: center; padding: 0; border: 0; border-radius: 50%; background: var(--fg); color: var(--bg-raise); cursor: pointer; }
.mu-pill .mu-play svg { width: 12px; height: 12px; }
.mu-pill .mu-now { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 550; padding-left: 4px; }
.mu-pill .mu-live { flex: none; font-size: var(--fs-micro); font-weight: 700; letter-spacing: .06em; color: var(--accent); }
.mu-pill .mu-live.wait { color: var(--fg-3); }
.mu-pill .mu-live.bad { color: var(--danger); letter-spacing: 0; font-weight: 500; font-size: var(--fs-micro); }
.mu-pill input { width: 56px; margin: 0; accent-color: var(--accent); cursor: pointer; }
.mu-eq { display: inline-flex; align-items: flex-end; gap: 1.5px; height: 9px; }
.mu-eq i { width: 2px; height: 100%; background: currentColor; border-radius: var(--r-xs); transform-origin: bottom; animation: mu-eq .9s ease-in-out infinite; }
.mu-eq i:nth-child(2) { animation-delay: -.3s; } .mu-eq i:nth-child(3) { animation-delay: -.6s; }
@keyframes mu-eq { 0%, 100% { transform: scaleY(.3); } 50% { transform: scaleY(1); } }
@media (prefers-reduced-motion: reduce) { .mu-eq i { animation: none; transform: scaleY(.7); } }
.md-btn[data-media="music"] { position: relative; }
.md-btn[data-media="music"][data-on] { color: var(--accent); }
.md-btn[data-media="music"] > .mu-eq { position: absolute; right: 3px; bottom: 4px; height: 7px; }
@media (max-width: 760px) { #music-pop { left: 44px !important; top: 0 !important; bottom: 0; max-height: none; border-radius: 0; } }
`;

const ICON = {
  play: '<path d="M4 2.5v11l9.5-5.5z"/>',
  pause: '<path d="M3.5 2.5h3v11h-3zM9.5 2.5h3v11h-3z"/>',
  next: '<path d="M3 3v10l7-5zM11 3h2v10h-2z"/>',
  sound: '<path d="M2 6h3l4-3.5v11L5 10H2z"/><path d="M11 5.2a4 4 0 0 1 0 5.6l-.9-.9a2.7 2.7 0 0 0 0-3.8z"/>',
  muted: '<path d="M2 6h3l4-3.5v11L5 10H2z"/><path d="M10.6 5.6l1.6 1.6 1.6-1.6.9.9-1.6 1.6 1.6 1.6-.9.9-1.6-1.6-1.6 1.6-.9-.9 1.6-1.6-1.6-1.6z"/>',
  x: '<path d="M4.2 3.1 8 6.9l3.8-3.8 1.1 1.1L9.1 8l3.8 3.8-1.1 1.1L8 9.1l-3.8 3.8-1.1-1.1L6.9 8 3.1 4.2z"/>',
  plus: '<path d="M7.25 3h1.5v4.25H13v1.5H8.75V13h-1.5V8.75H3v-1.5h4.25z"/>',
};
const svg = k => `<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">${ICON[k]}</svg>`;
const EQ = '<span class="mu-eq" aria-hidden="true"><i></i><i></i><i></i></span>';

let ctx = null, pop = null, audio = null;
/** A failure as the reader reads it (app.js `sayErr`). */
const why = e => ctx.sayErr(e).why;
/** What the pop shows and what plays. `now` is what is loaded: a station's
 *  play number, or a folder track's; `name` what the pill and the OS say. */
const S = { tab: "st", grp: "Focus", data: null, files: null, adding: false, err: "", bad: new Set(), now: null, name: "", group: "", wait: false, shuffle: false };

const remember = (k, v) => { try { localStorage.setItem("snyvi.music." + k, v); } catch { /* a private window */ } };
const recall = k => { try { return localStorage.getItem("snyvi.music." + k); } catch { return null; } };

/** Once, from app.js: the page's context (its capability's API, esc). */
export function init(c) {
  if (ctx) return;
  ctx = c;
  const st = document.createElement("style");
  st.textContent = STYLE;
  document.head.append(st);
  S.tab = recall("tab") === "fd" ? "fd" : "st";
  S.grp = recall("grp") || "Focus";
  S.shuffle = recall("shuffle") === "1";
}

/** ♪ was pressed: open the pop beside the sidebar, or close it. */
export function toggle(btn) {
  if (pop && !pop.hidden) return close();
  open(btn);
}

async function open(btn) {
  if (!pop) build();
  pop.hidden = false;
  place(btn);
  if (!S.data) await load();
  draw();
  place(btn);
  pop.querySelector(".mu-row.on, .mu-row, .mu-chip, button")?.focus();
}

function close(back = true) {
  if (!pop || pop.hidden) return;
  pop.hidden = true;
  if (back) document.querySelector(":root[data-side='0'] #rail-nav [data-media=music], .side-head [data-media=music]")?.focus();
}

/** Beside the sidebar, level with the button, inside the window. */
function place(btn) {
  const side = document.getElementById("side")?.getBoundingClientRect();
  const r = (btn || document.querySelector("[data-media=music]")).getBoundingClientRect();
  const h = pop.offsetHeight;
  pop.style.left = Math.round((side ? side.right : r.right) + 6) + "px";
  pop.style.top = Math.round(Math.max(8, Math.min(r.top - 8, innerHeight - h - 8))) + "px";
}

function build() {
  pop = document.createElement("div");
  pop.id = "music-pop";
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", "Music");
  pop.hidden = true;
  pop.innerHTML = `<div class="mu-h"><span>Music</span><button class="mu-x" data-mu="close" data-tip="Close" aria-label="Close">${svg("x")}</button></div>` +
    `<div class="mu-b"></div><div class="mu-pill" hidden></div>`;
  document.body.append(pop);
  pop.addEventListener("click", onClick);
  pop.addEventListener("keydown", e => {
    if (e.key === "Escape") { e.stopPropagation(); if (S.adding) { S.adding = false; draw(); } else close(); }
    if (e.key === "Enter" && e.target.matches(".mu-url input")) { e.preventDefault(); addUrl(); }
  });
  pop.addEventListener("input", e => {
    if (e.target.matches(".mu-vol")) { audio.volume = +e.target.value; audio.muted = audio.volume === 0; }
  });
  // A press anywhere else puts it away, as a folded section's popover goes.
  document.addEventListener("pointerdown", e => {
    if (!pop.hidden && !pop.contains(e.target) && !e.target.closest?.("[data-media=music]")) close(false);
  }, true);
}

async function load() {
  try { S.data = await ctx.api("/api/music"); S.err = ""; }
  catch (e) { S.err = why(e); S.data = { stations: [], mine: [], folder: null }; }
}

/** The list for the tab: the stations by group, or the folder's tracks. */
function draw() {
  const d = S.data, esc = ctx.esc;
  const seg = `<div class="mu-seg" role="tablist"><button data-tab="st" role="tab" aria-pressed="${S.tab === "st"}">Stations</button><button data-tab="fd" role="tab" aria-pressed="${S.tab === "fd"}">Your folder</button></div>`;
  let body = "";
  if (S.tab === "st") {
    const groups = [...new Set(d.stations.map(s => s.group)), ...(d.mine.length ? ["Yours"] : [])];
    if (!groups.includes(S.grp)) S.grp = groups[0] || "Focus";
    body += `<div class="mu-grp">${groups.map(g => `<button class="mu-chip" data-grp="${esc(g)}" aria-pressed="${g === S.grp}">${esc(g)}</button>`).join("")}</div>`;
    const rows = S.grp === "Yours"
      ? d.mine.map((m, i) => ({ n: d.stations.length + i, name: m.name, url: m.url }))
      : d.stations.map((s, n) => ({ n, name: s.name, group: s.group })).filter(s => s.group === S.grp);
    body += rows.map(r => row(`p${r.n}`, r.name, S.grp, r.url)).join("");
    body += S.adding
      ? `<div class="mu-url"><input type="url" placeholder="https://…/stream.mp3" aria-label="A stream's address" autocomplete="off" spellcheck="false"><button class="btn" data-mu="add-ok">Add</button></div>`
      : `<button class="mu-add" data-mu="add">${svg("plus")} Add a stream's address</button>`;
  } else if (!d.folder) {
    body += `<p class="mu-note">Play the music you already have. snyvi reads only the folder you pick, two levels down, and never your whole home.</p>` +
      `<div style="padding:0 6px"><button class="btn" data-mu="pick">Choose a folder…</button></div>`;
  } else {
    const files = S.files || [];
    body += `<div class="mu-fl"><b data-tip="${esc(d.folder)}">${esc(d.folder)}</b><span>· ${files.length}${S.capped ? "+" : ""}</span><span class="sp"></span>` +
      `<button class="mu-tog" data-mu="shuffle" aria-pressed="${S.shuffle}">Shuffle</button><button class="mu-tog" data-mu="pick">Change</button></div>`;
    body += S.files == null ? `<p class="mu-note">Reading the folder…</p>`
      : files.length ? files.map((f, n) => row(`f${n}`, f.replace(/^.*\//, "").replace(/\.[^.]+$/, ""), d.folder, null, f)).join("")
      : `<p class="mu-note">No music in this folder: mp3, m4a, ogg, opus, flac or wav, two levels down.</p>`;
    if (S.files == null) loadFiles();
  }
  pop.querySelector(".mu-b").innerHTML = seg + body + (S.err ? `<p class="mu-err" role="alert">${esc(S.err)}</p>` : "");
  pill();
}

function row(key, name, group, url, path) {
  const esc = ctx.esc, on = S.now === key, playing = on && audio && !audio.paused;
  const meta = S.bad.has(key) ? "Couldn't play it" : on ? (S.wait ? "…" : playing ? EQ : "paused") : "";
  const rm = url ? `<span class="mu-ib mu-rm" role="button" tabindex="-1" data-rm="${esc(url)}" data-tip="Take it out" aria-label="Take ${esc(name)} out">${svg("x")}</span>` : "";
  return `<button class="mu-row${on ? " on" : ""}${S.bad.has(key) ? " bad" : ""}" data-play="${key}" data-name="${esc(name)}" data-group="${esc(group)}"${path ? ` data-tip="${esc(path)}"` : ""}>` +
    `<span class="mu-pp">${svg(playing ? "pause" : "play")}</span><span class="mu-t">${esc(name)}</span><span class="mu-m">${meta}</span>${rm}</button>`;
}

async function loadFiles() {
  try { const j = await ctx.api("/api/music/files"); S.files = j.files || []; S.capped = !!j.capped; }
  catch (e) { S.files = []; S.err = why(e); }
  if (S.tab === "fd") draw();
}

async function onClick(e) {
  const t = e.target.closest("[data-mu], [data-tab], [data-grp], [data-play], [data-rm]");
  if (!t) return;
  S.err = "";
  if (t.dataset.rm) { e.stopPropagation(); return removeUrl(t.dataset.rm); }
  if (t.dataset.tab) { S.tab = t.dataset.tab; remember("tab", S.tab); return draw(); }
  if (t.dataset.grp) { S.grp = t.dataset.grp; remember("grp", S.grp); return draw(); }
  if (t.dataset.play) return press(t.dataset.play, t.dataset.name, t.dataset.group);
  switch (t.dataset.mu) {
    case "close": return close();
    case "add": S.adding = true; draw(); return pop.querySelector(".mu-url input")?.focus();
    case "add-ok": return addUrl();
    case "pick": return pick();
    case "shuffle": S.shuffle = !S.shuffle; remember("shuffle", S.shuffle ? "1" : ""); return draw();
    case "pp": return audio.paused ? audio.play().catch(() => {}) : audio.pause();
    case "next": return next();
    case "mute": audio.muted = !audio.muted; if (!audio.muted && audio.volume === 0) audio.volume = .5; return pill();
    case "stop": return stop();
  }
}

async function addUrl() {
  const input = pop.querySelector(".mu-url input"), url = input?.value.trim();
  if (!url) { S.adding = false; return draw(); }
  try { S.data = await ctx.api("/api/music/mine", { url }); S.adding = false; S.grp = "Yours"; }
  catch (e) { S.err = why(e); }
  draw();
}

async function removeUrl(url) {
  const n = S.data.stations.length + S.data.mine.findIndex(m => m.url === url);
  if (S.now === `p${n}`) stop();
  try { S.data = await ctx.api("/api/music/mine", { url, remove: true }); } catch (e) { S.err = why(e); }
  draw();
}

/** The desktop's folder dialog, the daemon's: the page never names a path. */
async function pick() {
  try {
    await window.__TAURI_INTERNALS__?.invoke("allow_foreground").catch(() => {});
    const r = await fetch("/api/music/folder", { method: "POST", headers: { "x-snyvi-capability": ctx.capability } });
    if (r.status === 204) return;
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(r.status === 409 ? "A folder dialog is already open." : j.error || `HTTP ${r.status}`);
    S.data = j; S.files = null; S.tab = "fd"; remember("tab", "fd");
  } catch (e) { S.err = why(e); }
  draw();
}

function player() {
  if (audio) return audio;
  audio = document.createElement("audio");
  audio.preload = "none";
  const v = +(recall("vol") ?? .7);
  audio.volume = isFinite(v) ? Math.min(1, Math.max(0, v)) : .7;
  document.body.append(audio);
  const redraw = () => { if (pop && !pop.hidden) draw(); badge(); };
  audio.addEventListener("playing", () => { S.wait = false; redraw(); });
  audio.addEventListener("waiting", () => { S.wait = true; redraw(); });
  audio.addEventListener("pause", redraw);
  audio.addEventListener("volumechange", () => { remember("vol", String(audio.volume)); pill(); });
  audio.addEventListener("error", () => { if (S.now) S.bad.add(S.now); S.wait = false; redraw(); });
  audio.addEventListener("ended", () => (S.now?.[0] === "f" ? next() : redraw()));
  // One sound at a time: a song or a video starting in a document pauses
  // the music (media events do not bubble; this captures).
  document.addEventListener("play", e => { if (e.target !== audio && !audio.paused) audio.pause(); }, true);
  if ("mediaSession" in navigator) {
    const ms = navigator.mediaSession;
    ms.setActionHandler("play", () => audio.play().catch(() => {}));
    ms.setActionHandler("pause", () => audio.pause());
    ms.setActionHandler("stop", () => stop());
    try { ms.setActionHandler("nexttrack", () => (S.now?.[0] === "f" ? next() : null)); } catch { /* not in every engine */ }
  }
  return audio;
}

/** A row pressed: the one already loaded pauses or goes on; another plays. */
function press(key, name, group) {
  const a = player();
  if (S.now === key && !S.bad.has(key)) { a.paused ? a.play().catch(() => {}) : a.pause(); return; }
  S.bad.delete(key);
  S.now = key; S.name = name; S.group = group; S.wait = true;
  a.src = key[0] === "p" ? `/api/music/play/${key.slice(1)}` : `/api/music/file/${key.slice(1)}`;
  for (const m of document.querySelectorAll("#doc audio, #doc video")) if (!m.paused) m.pause();
  a.play().catch(() => {});
  if ("mediaSession" in navigator && window.MediaMetadata) navigator.mediaSession.metadata = new MediaMetadata({ title: name, artist: group, album: "snyvi" });
  draw(); badge();
}

function next() {
  const files = S.files || [];
  if (!files.length || S.now?.[0] !== "f") return;
  const at = +S.now.slice(1);
  let n = (at + 1) % files.length;
  if (S.shuffle && files.length > 1) do { n = Math.floor(Math.random() * files.length); } while (n === at);
  press(`f${n}`, files[n].replace(/^.*\//, "").replace(/\.[^.]+$/, ""), S.data.folder);
}

/** Stop lets the station go: the daemon's fetch ends with the request. */
function stop() {
  if (!audio) return;
  audio.pause();
  audio.removeAttribute("src");
  audio.load();
  S.now = null; S.name = ""; S.wait = false;
  if ("mediaSession" in navigator) navigator.mediaSession.metadata = null;
  if (pop && !pop.hidden) draw();
  badge();
}

/** The pill at the pop's foot, the song pill's controls (ui/player.js). */
function pill() {
  const el = pop?.querySelector(".mu-pill");
  if (!el) return;
  if (!S.now) { el.hidden = true; return; }
  const esc = ctx.esc, live = S.now[0] === "p", bad = S.bad.has(S.now), off = audio.muted || audio.volume === 0;
  const state = bad ? `<span class="mu-live bad">Couldn't play it</span>` : S.wait ? `<span class="mu-live wait">…</span>` : live ? `<span class="mu-live">LIVE</span>` : "";
  el.hidden = false;
  el.innerHTML = `<button class="mu-play" data-mu="pp" aria-label="${audio.paused ? "Play" : "Pause"}">${svg(audio.paused ? "play" : "pause")}</button>` +
    `<span class="mu-now" data-tip="${esc(S.name)}">${esc(S.name)}</span>${state}` +
    (live ? "" : `<button class="mu-ib" data-mu="next" data-tip="Next" aria-label="Next">${svg("next")}</button>`) +
    `<button class="mu-ib" data-mu="mute" aria-label="${off ? "Unmute" : "Mute"}">${svg(off ? "muted" : "sound")}</button>` +
    `<input class="mu-vol" type="range" min="0" max="1" step="0.05" value="${off ? 0 : audio.volume}" aria-label="Volume">` +
    `<button class="mu-ib" data-mu="stop" data-tip="Stop" aria-label="Stop">${svg("x")}</button>`;
}

/** ♪ says music is playing while the pop is closed: small bars on it,
 *  placed over the icon, so nothing beside it moves. */
function badge() {
  const on = !!(audio && S.now && !audio.paused);
  for (const b of document.querySelectorAll("[data-media=music]")) {
    b.toggleAttribute("data-on", on);
    const eq = b.querySelector(".mu-eq");
    if (on && !eq) b.insertAdjacentHTML("beforeend", EQ);
    if (!on && eq) eq.remove();
    b.dataset.tip = on ? `Music: ${S.name}` : "Music";
  }
}
