/* Voice: hold a key, say a command, let go (1.70).
 *
 * A chunk, fetched on the first hold of ⌃⌥M or the first "Voice…" in the
 * palette; first paint carries one line for the key. Three things live here:
 * the take (the microphone while the key is down, sent to the daemon's voice
 * socket), the bar that says what was heard and what it does, and the sheet
 * that turns voice on and off.
 *
 * What a phrase MEANS is decided here and nowhere else. The daemon hands the
 * sound to its helper and hands back the words (src/voice.rs); this file
 * matches them against what the window can do -- the palette's commands, the
 * desks, this desk's panels and views -- and runs the one it matched exactly
 * as a pick in the palette would. So a spoken command is the reader's own
 * press with another way in, on the window's capability, and no words from
 * anywhere else can become one: there is no route that takes a phrase.
 *
 * 1.70 says only where to go. Nothing here sends, approves, removes, or types
 * into a panel.
 *
 * The match is by sound, not spelling, because that is how the model is
 * wrong: "Opening box" for open inbox, "About stavey" for about snyvi. And a
 * short phrase has to be nearly exact, which is what keeps a cough from
 * opening a page. bench/voice.mjs holds the phrases this was tuned on.
 */

// ---------- the timings ----------
/* Every wait in voice, in one place, in milliseconds: they were chosen before
 * a window had run a take, and the first review is where they are tuned. */
/** A key held for less than this was a slip, not a take. */
const SLIP = 200;
/** The early microphone (see `early`) is closed if M has not followed. */
const EARLY_FOR = 1000;
/** After the key comes up the bar says nothing new for this long: a warm
 *  helper answers in 90 to 170 (docs/VOICE.md), well inside it. */
const GRACE = 400;
/** Held this long with nothing said, the bar offers three things to say. */
const HINT_AFTER = 1000;
/** A sample this loud is someone speaking, not the room (of 1). */
const SPEECH = 0.06;
/** How long each last word stays: an arrival, a miss, a slip, an error. */
const SHOWN = { went: 2600, miss: 3600, slip: 2200, off: 3200, err: 4000 };

// ---------- the match ----------

const NUM = { 1: "one", 2: "two", 3: "three", 4: "four", 5: "five", 6: "six", 7: "seven", 8: "eight", 9: "nine" };
/** Lower case, digits as words, nothing but letters and spaces. */
const norm = t => t.toLowerCase().replace(/\d/g, n => ` ${NUM[n] || ""} `).replace(/[^a-z ]+/g, " ").replace(/\s+/g, " ").trim();
/** The letters alone: where the model put the spaces is not evidence. */
const run = t => norm(t).replace(/ /g, "");
/** The sound's skeleton: doubled letters once, and after the first letter no
 *  vowels, which are what the model gets wrong first. */
const skel = t => { const r = run(t).replace(/(.)\1+/g, "$1"); return r.slice(0, 1) + r.slice(1).replace(/[aeiouy]/g, ""); };

/** How many characters two strings share, in order: the longest run they
 *  have in common, then the same on each side of it (Ratcliff/Obershelp, as
 *  Python's difflib, which the spike's scores were taken with). */
function shared(a, b) {
  if (!a || !b) return 0;
  let best = 0, ai = 0, bi = 0;
  for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) {
    let k = 0;
    while (i + k < a.length && j + k < b.length && a[i + k] === b[j + k]) k++;
    if (k > best) { best = k; ai = i; bi = j; }
  }
  return best ? best + shared(a.slice(0, ai), b.slice(0, bi)) + shared(a.slice(ai + best), b.slice(bi + best)) : 0;
}
const alike = (a, b) => a.length + b.length ? 2 * shared(a, b) / (a.length + b.length) : 0;

/** A phrase of six letters or fewer -- keys, home, on you -- is matched only
 *  when nearly exact; a longer one at 0.7. Four letters or fewer -- back --
 *  closer still, or "black" is "back". And the best has to be clear of the
 *  next thing it could have meant. */
const TINY = 4, SHORT = 6, EXACT = 0.9, NEAR = 0.85, BAR = 0.7, CLEAR = 0.04;
/** What a phrase of `n` letters has to score. */
const bar_ = n => (n <= TINY ? EXACT : n <= SHORT ? NEAR : BAR);

/** What `heard` means among `targets` (`{ say: [phrases], ... }`), or null.
 *  Only the first sentence counts: the model sometimes says a phrase twice. */
export function match(heard, targets) {
  const first = heard.split(/[.?!]/).find(s => s.trim()) || "";
  const h = run(first), hs = skel(first);
  if (!h) return null;
  let best = null, top = 0, next = 0;
  for (const t of targets) {
    let score = 0;
    for (const phrase of t.say) {
      const p = run(phrase);
      const s = Math.max(alike(h, p), alike(hs, skel(phrase)));
      if (s >= bar_(p.length) && s > score) score = s;
    }
    if (score > top) { next = top; top = score; best = t; }
    else if (score > next) next = score;
  }
  return best && top - next >= CLEAR ? best : null;
}

/** What a palette command is called aloud, beside its own title. */
const ALSO = { home: ["go home"], inbox: ["open inbox"], theme: ["themes"], connect: ["agents"], sidebars: ["sidebars"], chime: ["chime"], updates: ["updates", "check updates"], about: ["about"], voice: ["voice"] };

/** Everything that can be said now: the palette's commands, each desk, and
 *  on a desk its panels and its views. Built at each take, so a desk made a
 *  minute ago is there. */
async function targets(ctx) {
  const pal = await ctx.pal();
  const out = pal.commands.map(c => ({ kind: "cmd", say: [c.t, ...(ALSO[c.cmd] || [])], label: c.t.replace(/…$/, ""), go: () => pal.pick(c) }));
  for (const k of ctx.state.desks?.desks || []) out.push({ kind: "desk", say: [`desk ${k.name}`], label: `Desk · ${k.name}`, go: () => ctx.showDesk(k.id, true) });
  const desk = ctx.state.view === "desk" && ctx.desk();
  if (desk) {
    for (const p of desk.panelsHere()) out.push({ kind: "panel", say: [`panel ${NUM[p.slot]}`, ...(p.name ? [`panel ${p.name}`, p.name] : [])], label: `Panel ${p.slot}${p.name ? ` · ${p.name}` : ""}`, go: () => desk.panelHere(p.id) });
    for (const v of desk.viewsHere() || []) out.push({ kind: "view", say: [v.label, `${v.label} view`], label: v.label, go: () => desk.viewHere(v.v) });
  }
  // The way back from a wrong arrival, by the same voice that made it: the
  // step the window's back arrow takes.
  out.push({ kind: "back", say: ["back", "go back"], label: "Back", go: () => history.back() });
  return out;
}

/** A target as it is said: its first phrase, in lower case. */
const spoken = t => t.say[0].replace(/…$/, "").toLowerCase();
/** Three things to say here, for a hand that is holding the key and a head
 *  that has gone blank: what is nearest first -- a panel, a view, a desk --
 *  and the rest from the commands. Only ever from the live `targets`. */
export function hints(targets) {
  const out = [];
  for (const kind of ["panel", "view", "desk", "cmd", "cmd", "cmd"]) {
    const t = out.length < 3 && targets.find(t => t.kind === kind && !out.includes(t));
    if (t) out.push(t);
  }
  return out.map(spoken);
}

// ---------- the daemon ----------

let ctx = null;
const api = (path, body) => fetch(path, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", "x-snyvi-capability": ctx.capability }, body: body ? JSON.stringify(body) : undefined })
  .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`); return j; });
/** How voice stands, asked once and again whenever the sheet changes it. */
let stood = null;
const status = fresh => (fresh || !stood ? (stood = api("/api/voice").then(st => (mark(st.on), st), e => { stood = null; throw e; })) : stood);
/** Whether voice is on, kept for the next time this window opens: first
 *  paint reads it and calls `ready` at idle (ui/app/09-answers.js). */
const mark = on => { try { on ? localStorage.setItem("snyvi.voice.on", "1") : localStorage.removeItem("snyvi.voice.on"); } catch {} };

/** The voice socket, allowed: the capability in the first frame, never the
 *  URL, as the desk's socket has it (ui/app/07-nav.js). */
function socket() {
  return new Promise((ok, no) => {
    const s = new WebSocket(location.origin.replace(/^http/, "ws") + "/api/voice/listen");
    s.binaryType = "arraybuffer";
    s.onerror = s.onclose = () => no(new Error("the daemon did not answer"));
    s.onopen = () => s.send(JSON.stringify({ capability: ctx.capability }));
    s.onmessage = ev => { let j = null; try { j = JSON.parse(ev.data); } catch {} j && j.ok ? ok(s) : no(new Error(j?.error || "refused")); };
  });
}

// ---------- the microphone ----------

/** One audio context for the page, made at the first take: the worklet is
 *  loaded into it once. */
let ac = null, loaded = null;
const micId = () => { try { return localStorage.getItem("snyvi.voice.mic") || ""; } catch { return ""; } };
/** The audio path without a microphone on it: made at idle by `ready`, so a
 *  take has only the microphone left to ask for. An engine starts a context
 *  made without a press asleep; the take wakes it. */
function prepare() {
  ac ||= new AudioContext();
  loaded ||= ac.audioWorklet.addModule(`/assets/voice-worklet.js${ctx.v ? `?v=${ctx.v}` : ""}`);
  loaded.catch(() => { loaded = null; });
}
async function microphone() {
  prepare();
  const id = micId();
  // No processing: the helper levels the take itself, and an engine's noise
  // gate eats the first consonant of a short command.
  const audio = { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false, ...(id ? { deviceId: { exact: id } } : {}) };
  const [stream] = await Promise.all([navigator.mediaDevices.getUserMedia({ audio }), loaded, ac.resume()]);
  const src = ac.createMediaStreamSource(stream), node = new AudioWorkletNode(ac, "snyvi-take");
  // On to the output through a gain of nothing: an engine may not run a node
  // that leads nowhere, and the reader must not hear themselves.
  const mute = ac.createGain();
  mute.gain.value = 0;
  src.connect(node).connect(mute).connect(ac.destination);
  return { rate: ac.sampleRate, node, label: stream.getAudioTracks()[0]?.label || "the microphone",
    stop() { src.disconnect(); node.disconnect(); mute.disconnect(); node.port.onmessage = null; stream.getTracks().forEach(t => t.stop()); } };
}

/** Voice was on when this window last knew (`mark`), and the page is idle:
 *  everything a take needs but the microphone and the socket. The socket
 *  stays shut because opening it wakes the helper (src/server/api_voice.rs),
 *  and a helper kept awake by an idle window is 220 MB held for nothing. */
export async function ready(c) {
  ctx = c;
  let st;
  try { st = await status(true); } catch { return; }
  if (!st.on) return;
  try { prepare(); } catch {}
  ctx.pal().catch(() => {});
  let on = false;
  try { on = localStorage.getItem("snyvi.voice.early") === "1"; } catch {}
  if (on) for (const ev of ["keydown", "keyup"]) addEventListener(ev, early, true);
}

/* The early microphone, off unless `snyvi.voice.early` is 1. With it, the
 * microphone is asked for when Ctrl and Alt are both down, before M, so the
 * first word cannot be clipped. It is off because Ctrl and Alt are the
 * desk's own keys: every ⌃⌥2 would open the microphone and blink the
 * system's light for a take that never came (audit b56b6ceccd, A1). Nothing
 * heard this way goes anywhere: the worklet's port has no listener until a
 * take claims the microphone, and it is closed on any key but M, on either
 * key coming up, or after EARLY_FOR. */
let armed = null, armT = 0;
const disarm = () => { clearTimeout(armT); const a = armed; armed = null; a?.then(m => m.stop(), () => {}); };
function early(e) {
  if (taking) return;
  const chord = e.type === "keydown" && e.ctrlKey && e.altKey && !e.metaKey && !e.getModifierState?.("AltGraph");
  if (chord && (e.key === "Control" || e.key === "Alt")) { if (!armed) { (armed = microphone()).catch(() => {}); armT = setTimeout(disarm, EARLY_FOR); } }
  else if (!(chord && e.code === "KeyM")) disarm();
}
/** The microphone for a take: the early one if it is there, or a new one. */
function claim() { const a = armed; armed = null; clearTimeout(armT); return a || microphone(); }

// ---------- the bar ----------

const CSS = `
#voicebar { position: fixed; left: 50%; bottom: 56px; z-index: var(--z-toast); transform: translateX(-50%); pointer-events: none;
  display: flex; align-items: center; gap: 10px; max-width: min(560px, 90vw); padding: 7px 14px; border-radius: var(--r-pill);
  font-size: var(--fs-ui); color: var(--fg-2); background: var(--bg-raise); border: 1px solid var(--rule); box-shadow: var(--shadow);
  opacity: 0; transition: opacity var(--dur-move), border-color var(--dur-quick); }
#voicebar.show { opacity: 1; transition-duration: var(--dur-quick); }
#voicebar .vm { flex: none; width: 64px; height: 6px; border-radius: var(--r-pill); background: var(--rule); overflow: hidden; opacity: .45; }
#voicebar .vm i { display: block; height: 100%; width: 0; background: var(--accent); transition: width var(--dur-instant) linear; }
#voicebar:not(.held) .vm { display: none; }
#voicebar.held { min-width: 176px; }
#voicebar.live { border-color: var(--accent); }
#voicebar.live .vm { opacity: 1; }
#voicebar .vt { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#voicebar .vt b { font-weight: 600; color: var(--fg); }
#voicebar .vt q { quotes: "“" "”"; }
#voicebar .vh { position: absolute; left: 50%; bottom: calc(100% + 6px); transform: translateX(-50%); white-space: nowrap; padding: 4px 12px;
  border-radius: var(--r-pill); font-size: var(--fs-small); color: var(--fg-3); background: var(--bg-raise); border: 1px solid var(--rule);
  opacity: 0; transition: opacity var(--dur-move); }
#voicebar.hint .vh { opacity: 1; }
#voicesheet details summary { cursor: pointer; color: var(--fg); }
#voicesheet details p { margin-top: 6px; max-height: 132px; overflow: auto; color: var(--fg-3); font-size: var(--fs-small); }
#voicesheet { position: fixed; left: 50%; bottom: 96px; z-index: var(--z-pop); transform: translateX(-50%); width: min(420px, 92vw);
  padding: 16px 18px; border-radius: var(--r-md); background: var(--bg-raise); border: 1px solid var(--rule); box-shadow: var(--shadow);
  font-size: var(--fs-ui); color: var(--fg-2); display: grid; gap: 10px; }
#voicesheet h2 { margin: 0; font-size: var(--fs-body-s); font-weight: 600; color: var(--fg); }
#voicesheet p { margin: 0; }
#voicesheet .vs-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
#voicesheet select { flex: 1; min-width: 0; font: inherit; color: var(--fg); background: var(--bg); border: 1px solid var(--rule-2); border-radius: var(--r-sm); padding: 4px 6px; }
#voicesheet button { font: inherit; color: var(--fg); background: var(--bg); border: 1px solid var(--rule-2); border-radius: var(--r-sm); padding: 5px 12px; cursor: pointer; }
#voicesheet button.go { color: var(--bg); background: var(--accent); border-color: var(--accent); }
#voicesheet button:disabled { opacity: .5; cursor: default; }
#voicesheet .vs-err { color: var(--danger); }
#voicesheet .vs-dim { color: var(--fg-3); font-size: var(--fs-small); }
`;
let bar = null, barT = 0;
function mount() {
  if (bar) return;
  document.head.append(Object.assign(document.createElement("style"), { id: "voice-css", textContent: CSS }));
  bar = Object.assign(document.createElement("div"), { id: "voicebar", innerHTML: `<span class="vh"></span><span class="vm"><i></i></span><span class="vt"></span>` });
  bar.setAttribute("role", "status");
  document.body.append(bar);
}
/** Say `html` in the bar. `held` is the bar while the key is down: one
 *  width, the meter in it, dim until `lit`. `ms` takes the bar down after. */
function say(html, { held = false, ms = 0 } = {}) {
  mount();
  clearTimeout(barT);
  offKey?.();
  bar.querySelector(".vt").innerHTML = html;
  bar.classList.toggle("held", held);
  if (!held) { lit(false); hint(null); }
  bar.classList.add("show");
  if (ms) barT = setTimeout(hide, ms);
}
function hide() { clearTimeout(barT); offKey?.(); bar?.classList.remove("show", "held", "live", "hint"); }
/** The line above the bar: what can be said here, or nothing. It lies over
 *  the page as the bar does, and the bar under it does not change. */
function hint(list) {
  if (!bar) return;
  if (list?.length) bar.querySelector(".vh").textContent = `Say: ${list.join(" · ")}`;
  bar.classList.toggle("hint", !!list?.length);
}
/** The microphone is open, or shut: the meter at full and the bar edged in
 *  the accent, or neither. The one sign of it, set nowhere else. */
function lit(on) { bar?.classList.toggle("live", on); if (!on) meter(0); }
/** The bar lies over a panel's last line, which is where the next key goes.
 *  So once it has said where a take went, the first key takes it down. The
 *  key itself is not touched: it goes on to whatever has the keys. */
let offKey = null;
function leaveOnKey() {
  const on = e => { if (["Control", "Alt", "Shift", "Meta", "AltGraph"].includes(e.key) || (e.ctrlKey && e.altKey && e.code === "KeyM")) return; hide(); };
  addEventListener("keydown", on, true);
  offKey = () => { removeEventListener("keydown", on, true); offKey = null; };
}
const meter = level => { if (bar) bar.querySelector(".vm i").style.width = `${Math.min(100, Math.round(Math.sqrt(level) * 110))}%`; };
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const KEY = /Mac/.test(navigator.platform) ? "⌃⌥M" : "Ctrl Alt M";
const PAL = /Mac/.test(navigator.platform) ? "⌘K" : "Ctrl K";

// ---------- when it does not work ----------

/** What went wrong, as a line a person can act on. The engine's own names
 *  for a refused or missing microphone, and this file's and the daemon's
 *  own words for the rest; anything else is said as it came. */
function plain(e) {
  const m = `${e?.name || ""} ${e?.message || e || ""}`;
  if (/NotAllowed|SecurityError|Permission/i.test(m)) return "snyvi may not use the microphone · allow it in the system's settings";
  if (/Overconstrained/i.test(m)) return `The microphone you chose is not here · pick one in <b>${PAL} › Voice…</b>`;
  if (/NotFound|NotReadable/i.test(m)) return "No microphone found";
  if (/voice is off/.test(m)) { stood = null; return `Voice is off. Turn it on in <b>${PAL} › Voice…</b>`; }
  if (/took too long/.test(m)) return "The speech helper did not answer · say it once more";
  if (/did not answer|closed the socket|Failed to fetch|NetworkError/i.test(m)) return "snyvi's daemon did not answer · is it running?";
  if (/no capability|refused/.test(m)) return "This window may not use voice · open it from snyvi again";
  if (/fetch voice again/.test(m)) return `Voice needs fetching again · <b>${PAL} › Voice…</b>`;
  return `Voice did not work: ${esc(ctx.sayErr(e).why)}`;
}

// ---------- the take ----------

let taking = null;

/** The key went down (ui/app/09-answers.js), or the sheet's Try was pressed.
 *  `until` resolves when it comes up. `dry` hears and matches and runs
 *  nothing, which is the sheet's way to try a phrase. */
export async function hold(c, until, dry = false) {
  ctx = c;
  if (taking) return;
  const mine = taking = { up: false, at: Date.now() };
  // The window losing the keys ends a take too: the key's coming up would
  // go to whatever took them, and the microphone would stay open.
  until = Promise.race([until, new Promise(gone => addEventListener("blur", gone, { once: true }))]);
  until.then(() => { mine.up = true; });
  try { await take(mine, until, dry); }
  catch (e) { say(plain(e), { ms: SHOWN.err }); }
  finally { taking = null; }
}

async function take(mine, until, dry) {
  let st;
  try { st = await status(); } catch { st = {}; }
  if (!st.on) { say(`Voice is off. Turn it on in <b>${PAL} › Voice…</b>`, { ms: SHOWN.off }); return; }
  // One bar for the whole hold, and one word: the meter is dim until the
  // microphone is truly open, and nothing else changes when it is.
  say("Listening", { held: true });
  // Whether the helper was asleep, asked before the socket wakes it: it is
  // the one case in which the answer is worth a word of its own.
  // What can be said now, read while the reader speaks: the hints want it
  // in a second, the match when the key comes up.
  const all = targets(ctx);
  all.catch(() => {});
  let cold = false;
  api("/api/voice").then(now => { cold = !now.warm; }, () => {});
  // Both at once: the socket wakes the helper while the microphone opens.
  // Neither waits for the other. Sound that comes before the socket is open
  // is held here and sent when it is, so the first word is not lost to it.
  const opening = socket();
  opening.catch(() => {});
  let mic;
  try { mic = await claim(); } catch (e) { opening.then(s => s.close(), () => {}); throw e; }
  const held = [];
  let sock = null, spoke = false, hintT = 0;
  mic.node.port.onmessage = ev => {
    let m = 0;
    for (const x of ev.data) { const a = x < 0 ? -x : x; if (a > m) m = a; }
    meter(m);
    if (m >= SPEECH && !spoke) { spoke = true; hint(null); }
    if (!sock) held.push(ev.data.buffer); else if (sock.readyState === 1) sock.send(ev.data.buffer);
  };
  const opened = opening.then(s => { s.send(JSON.stringify({ t: "start", rate: mic.rate })); for (const b of held.splice(0)) s.send(b); return (sock = s); });
  opened.catch(() => {});
  try {
    // A socket that will not open ends the take now, not at the key's coming up.
    if (!mine.up) {
      lit(true);
      hintT = setTimeout(() => all.then(ts => { if (!spoke && !mine.up) hint(hints(ts)); }, () => {}), HINT_AFTER);
      await Promise.race([until, opened.then(() => until)]);
    }
    await opened;
  } catch (e) { opening.then(s => s.close(), () => {}); throw e; }
  finally { clearTimeout(hintT); hint(null); mic.stop(); lit(false); }
  if (Date.now() - mine.at < SLIP) { sock.close(); say("Hold the key while you speak", { ms: SHOWN.slip }); return; }
  // The key is up and the meter has gone dim, which is the truth. A warm
  // helper answers before anything else needs saying.
  const slow = setTimeout(() => say(cold ? "Waking…" : "…", { held: true }), GRACE);
  const line = await new Promise((ok, no) => {
    const t = setTimeout(() => no(new Error("the helper took too long")), 8000);
    sock.onmessage = ev => { clearTimeout(t); try { ok(JSON.parse(ev.data)); } catch (e) { no(e); } };
    sock.onclose = sock.onerror = () => { clearTimeout(t); no(new Error("the daemon closed the socket")); };
    if (sock.readyState !== 1) return sock.onclose();
    sock.send(JSON.stringify({ t: "end" }));
  }).finally(() => { clearTimeout(slow); sock.onclose = sock.onerror = null; sock.close(); });
  if (line.error) throw new Error(line.error);
  if (line.quiet) { say(`Too quiet · ${esc(mic.label)}`, { ms: SHOWN.miss }); return; }
  const heard = (line.heard || "").trim();
  if (!heard) { say("Heard nothing to act on", { ms: SHOWN.miss }); return; }
  const hit = match(heard, await all);
  if (!hit) { say(`<q>${esc(heard)}</q> · no command`, { ms: SHOWN.miss }); return; }
  say(`<q>${esc(heard)}</q> → <b>${esc(hit.label)}</b>`, { ms: SHOWN.went });
  if (!dry) { hit.go(); leaveOnKey(); }
}

// ---------- the sheet ----------

let sheetEl = null, poll = 0;
const mb = n => `${Math.round(n / 1048576)} MB`;
function closeSheet() {
  clearInterval(poll);
  sheetEl?.remove(); sheetEl = null;
  removeEventListener("keydown", sheetKey, true);
  removeEventListener("pointerdown", sheetOut, true);
}
const sheetKey = e => { if (e.key === "Escape") { e.stopPropagation(); closeSheet(); } };
const sheetOut = e => { if (sheetEl && !sheetEl.contains(e.target)) closeSheet(); };

/** "Voice…" in the palette: what turning it on fetches, the microphone, a
 *  phrase to try, off, and remove. Over the page, moving nothing. */
export async function sheet(c) {
  ctx = c;
  mount();
  closeSheet();
  sheetEl = Object.assign(document.createElement("div"), { id: "voicesheet" });
  sheetEl.setAttribute("role", "dialog");
  sheetEl.setAttribute("aria-label", "Voice");
  document.body.append(sheetEl);
  addEventListener("keydown", sheetKey, true);
  addEventListener("pointerdown", sheetOut, true);
  sheetEl.addEventListener("click", sheetClick);
  sheetEl.addEventListener("change", e => { if (e.target.id === "vs-mic") try { localStorage.setItem("snyvi.voice.mic", e.target.value); } catch {} });
  // A press and hold on Try is a take that runs nothing.
  sheetEl.addEventListener("pointerdown", e => {
    if (!e.target.closest("[data-a=try]")) return;
    hold(ctx, new Promise(up => addEventListener("pointerup", up, { once: true })), true);
  });
  await draw(true);
}

async function draw(fresh) {
  if (!sheetEl) return;
  let st;
  try { st = await status(fresh); } catch (e) { sheetEl.innerHTML = `<h2>Voice</h2><p class="vs-err">Could not ask snyvi · ${esc(ctx.sayErr(e).why)}</p>`; return; }
  if (!sheetEl) return;
  clearInterval(poll);
  const head = `<h2>Voice</h2><p>Hold <b>${KEY}</b>, say a command, let go. It takes you places: a desk, a panel, anything in ${PAL}'s commands. It never sends or approves.</p>`;
  const err = st.error ? `<p class="vs-err">${esc(st.error)}</p>` : "";
  if (st.fetching) {
    sheetEl.innerHTML = `${head}<p role="status">${esc(st.fetching)}…</p>`;
    poll = setInterval(() => draw(true), 1000);
  } else if (!st.installed) {
    sheetEl.innerHTML = `${head}<p>Turning it on fetches a speech helper and its model, about 200 MB, onto this machine. What you say is heard here and goes nowhere else.</p>${err}
      <div class="vs-row"><button type="button" class="go" data-a="fetch">Turn voice on</button></div>`;
  } else if (!st.on) {
    sheetEl.innerHTML = `${head}<p>Voice is off. Its download is still here (${mb(st.bytes)}).</p>${err}
      <div class="vs-row"><button type="button" class="go" data-a="on">Turn voice on</button><button type="button" data-a="remove">Remove the download</button></div>`;
  } else {
    sheetEl.innerHTML = `${head}${err}
      <div class="vs-row"><label for="vs-mic">Microphone</label><select id="vs-mic"><option value="">The system's own</option></select></div>
      <div class="vs-row"><button type="button" data-a="try">Hold to try a phrase</button><span class="vs-dim">Say “go home”. Nothing runs from here.</span></div>
      <details><summary>What you can say</summary><p></p></details>
      <div class="vs-row"><button type="button" data-a="off">Turn voice off</button><button type="button" data-a="remove">Remove the download · ${mb(st.bytes)}</button></div>`;
    mics();
    // Everything that can be said from where the window is now.
    const list = sheetEl.querySelector("details p");
    targets(ctx).then(ts => { list.textContent = ts.map(spoken).join(" · "); }, () => {});
  }
}

/** The microphones by name. An engine names them only to a page it has let
 *  listen once, so before the first take there is only the system's own. */
async function mics() {
  const sel = sheetEl?.querySelector("#vs-mic");
  if (!sel) return;
  let all = [];
  try { all = (await navigator.mediaDevices.enumerateDevices()).filter(x => x.kind === "audioinput" && x.deviceId && x.label); } catch {}
  const now = micId();
  for (const x of all) sel.append(Object.assign(document.createElement("option"), { value: x.deviceId, textContent: x.label, selected: x.deviceId === now }));
}

async function sheetClick(e) {
  const a = e.target.closest("button[data-a]")?.dataset.a;
  if (!a || a === "try") return;
  e.target.closest("button").disabled = true;
  try {
    if (a === "fetch") await api("/api/voice/fetch", {});
    else if (a === "remove") await api("/api/voice/remove", {});
    else await api("/api/voice/on", { on: a === "on" });
  } catch (err) { ctx.toast("Voice", { sub: ctx.sayErr(err).why }); }
  await draw(true);
}
