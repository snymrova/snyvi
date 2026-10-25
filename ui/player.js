/* A song in a document, played by snyvi's own controls (render.rs `player`,
 * audit 3c6958c2a8). WebKit, the Linux window's engine, draws an <audio>'s
 * volume as a 94 px slider that rises above the speaker, out of the
 * element's box -- and its controls clip to that box, so in a 54 px song
 * only a sliver of it ever showed. Its bar was also not the pill a reader
 * pressed: 31 px, grey, low in the box, the title gone. So the pill stays
 * the player: play, the title, where it is, how long, and the volume beside
 * the speaker, all inside the same 54 px, the same in every engine. The
 * <audio> under it has no controls of its own, which also spares WebKit
 * the scripted controls a song in the page used to cost (#117, #120).
 *
 * A video keeps the engine's controls: in a box over 136 px tall, WebKit
 * keeps the volume inside it.
 *
 * Fetched on the first press; the press itself has already started the
 * sound (04-doc.js), so no engine sees a play() a moment after the gesture.
 * A song waits beside its pill, no controls of its own, until this makes
 * the pill its controls. */

const STYLE = `
.doc-song { display: flex; align-items: center; gap: 10px; width: 100%; height: 54px; padding: 0 14px 0 8px; box-sizing: border-box; border: 1px solid var(--rule-2); border-radius: 27px; background: var(--bg-raise); color: var(--fg); container-type: inline-size; text-align: left; }
.doc-song button { flex: none; display: grid; place-items: center; padding: 0; border: 0; border-radius: 50%; background: none; color: inherit; cursor: pointer; }
.doc-song .ds-pp { width: 38px; height: 38px; background: var(--fg); color: var(--bg-raise); }
.doc-song .ds-mute { width: 30px; height: 30px; color: var(--fg-2); }
.doc-song button:hover { color: var(--fg); }
.doc-song .ds-pp:hover { color: var(--bg-raise); opacity: .85; }
.doc-song svg { width: 16px; height: 16px; fill: currentColor; }
.doc-song .ds-t { flex: 0 1 auto; max-width: 32%; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.doc-song input { min-width: 0; margin: 0; accent-color: var(--accent); cursor: pointer; }
.doc-song .ds-seek { flex: 1 1 60px; }
.doc-song .ds-vol { flex: none; width: 64px; }
.doc-song .ds-time { flex: none; font-size: var(--fs-small); color: var(--fg-2); font-variant-numeric: tabular-nums; white-space: nowrap; }
.doc-song .ds-dl { flex: none; display: grid; place-items: center; width: 30px; height: 30px; border-radius: 50%; color: var(--fg-2); }
.doc-song .ds-dl:hover { color: var(--fg); }
@container (max-width: 420px) { .doc-song .ds-t, .doc-song .ds-vol { display: none; } }
`;

const ICON = {
  play: '<path d="M4 2.5v11l9.5-5.5z"/>',
  pause: '<path d="M3.5 2.5h3v11h-3zM9.5 2.5h3v11h-3z"/>',
  sound: '<path d="M2 6h3l4-3.5v11L5 10H2z"/><path d="M11 5.2a4 4 0 0 1 0 5.6l-.9-.9a2.7 2.7 0 0 0 0-3.8zM12.8 3.4a6.5 6.5 0 0 1 0 9.2l-.9-.9a5.2 5.2 0 0 0 0-7.4z"/>',
  muted: '<path d="M2 6h3l4-3.5v11L5 10H2z"/><path d="M10.6 5.6l1.6 1.6 1.6-1.6.9.9-1.6 1.6 1.6 1.6-.9.9-1.6-1.6-1.6 1.6-.9-.9 1.6-1.6-1.6-1.6z"/>',
  down: '<path d="M7.25 2h1.5v7.2l2.7-2.7 1.06 1.06L8 12.06 3.49 7.56 4.55 6.5l2.7 2.7zM3 13h10v1.5H3z"/>',
};
const svg = k => `<svg viewBox="0 0 16 16" aria-hidden="true">${ICON[k]}</svg>`;

/** 75 s as 1:15, an hour and more as 1:02:05; a length not yet known as --:--. */
function clock(s) {
  if (!isFinite(s)) return "--:--";
  s = Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

let doc = null;

/** The pill `b` was pressed and its player `m` is playing: a song beside
 *  it, which makes the pill its controls; a video in its place, with the
 *  engine's controls, which takes the keyboard. */
export function pressed(docEl, b, m) {
  if (!doc) watch(docEl);
  if (m.localName === "audio") return song(b, m);
  m.classList.add("doc-live"); m.focus();
}

/** Once, for the document's element. One player sounds at a time: choosing
 *  between two takes means hearing one and then the other, not both over
 *  each other. Media events do not bubble, so that listener captures.
 *
 *  And a pressed player plays on through a redraw of its document -- a pin,
 *  a preview -- rather than going back to a button. The redraw replaces the
 *  element's children; the observer, a microtask, puts each pressed player
 *  back in its slot of the new page (the nth player, the same file) before
 *  the engine's task that pauses a player that left the page. A file is the
 *  document's own (`/files/<id>/`), so another document never matches. */
function watch(docEl) {
  doc = docEl;
  docEl.addEventListener("play", e => {
    for (const m of docEl.querySelectorAll("audio, video")) if (m !== e.target && !m.paused) m.pause();
  }, true);
  new MutationObserver(recs => {
    const old = [];
    for (const r of recs) for (const n of r.removedNodes) {
      if (n.nodeType === 1) old.push(...(n.matches(".doc-play, .doc-live") ? [n] : []), ...n.querySelectorAll(".doc-play, .doc-live"));
    }
    if (!old.some(e => e.classList.contains("doc-live"))) return;
    const now = docEl.querySelectorAll(".doc-play");
    old.forEach((e, i) => {
      const b = now[i], t = b && b.nextElementSibling, m = t && t.content && t.content.firstElementChild;
      const src = e.classList.contains("doc-live") && (e.querySelector("audio") || e).getAttribute("src");
      if (src && m && m.getAttribute("src") === src) { t.remove(); b.replaceWith(e); }
    });
  }).observe(docEl, { childList: true });
  const s = document.createElement("style");
  s.textContent = STYLE;
  document.head.append(s);
}

/** The pressed pill `b` becomes the controls of `a`, which is already
 *  playing beside it. Same box, same place: nothing on the page moves. */
function song(b, a) {
  const name = (b.getAttribute("aria-label") || "").replace(/^Play /, "") || "song";
  const el = document.createElement("div");
  el.className = "doc-song doc-live";
  el.setAttribute("role", "group"); el.setAttribute("aria-label", name);
  el.innerHTML =
    `<button type="button" class="ds-pp"></button><span class="ds-t"></span>` +
    `<input type="range" class="ds-seek" min="0" max="0" step="any" value="0" aria-label="Seek">` +
    `<span class="ds-time"></span><button type="button" class="ds-mute"></button>` +
    `<input type="range" class="ds-vol" min="0" max="1" step="0.05" aria-label="Volume">`;
  const [pp, seek, time, mute, vol] = ["ds-pp", "ds-seek", "ds-time", "ds-mute", "ds-vol"].map(c => el.querySelector("." + c));
  el.querySelector(".ds-t").textContent = name;
  // Download (#183): the song's own file, last in the pill, where copy.js's
  // ↓ sat over the pill before Play. Only a file this daemon serves: the
  // web's is the web's to keep.
  const src = new URL(a.getAttribute("src") || "", location.href);
  if (src.origin === location.origin) {
    const dl = document.createElement("a");
    dl.className = "ds-dl"; dl.href = src.href; dl.download = decodeURIComponent(src.pathname.split("/").pop());
    dl.setAttribute("aria-label", `Download ${name}`); dl.dataset.tip = "Download";
    dl.innerHTML = svg("down");
    el.append(dl);
  }
  // While the seek is held, the clock follows the thumb rather than the song.
  let held = false;
  const at = () => {
    const d = a.duration, t = held ? +seek.value : a.currentTime;
    if (isFinite(d)) seek.max = String(d);
    if (!held) seek.value = String(a.currentTime);
    time.textContent = a.error ? "Couldn't play it" : `${clock(t)} / ${clock(d)}`;
    seek.setAttribute("aria-valuetext", `${clock(t)} of ${clock(d)}`);
  };
  const state = () => {
    const on = !a.paused && !a.ended;
    pp.innerHTML = svg(on ? "pause" : "play"); pp.setAttribute("aria-label", on ? "Pause" : "Play");
  };
  const loud = () => {
    const off = a.muted || a.volume === 0;
    mute.innerHTML = svg(off ? "muted" : "sound"); mute.setAttribute("aria-label", off ? "Unmute" : "Mute");
    vol.value = String(off ? 0 : a.volume);
  };
  for (const e of ["timeupdate", "durationchange", "loadedmetadata", "seeked", "error"]) a.addEventListener(e, at);
  for (const e of ["play", "pause", "ended"]) a.addEventListener(e, state);
  a.addEventListener("volumechange", loud);
  pp.addEventListener("click", () => (a.paused || a.ended ? a.play().catch(() => {}) : a.pause()));
  seek.addEventListener("input", () => { held = true; at(); });
  seek.addEventListener("change", () => { held = false; a.currentTime = +seek.value; at(); });
  mute.addEventListener("click", () => {
    // Unmuting a song turned all the way down brings it back to be heard.
    if (a.muted || a.volume === 0) { a.muted = false; if (a.volume === 0) a.volume = 0.5; } else a.muted = true;
  });
  vol.addEventListener("input", () => { a.volume = +vol.value; a.muted = a.volume === 0; });
  at(); state(); loud();
  const had = document.activeElement === b;
  b.replaceWith(el);
  el.append(a);
  if (had || !document.activeElement || document.activeElement === document.body) pp.focus();
}
