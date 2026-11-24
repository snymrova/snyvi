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
 *  when nearly exact; a longer one at 0.7. And the best has to be clear of
 *  the next thing it could have meant. */
const SHORT = 6, NEAR = 0.85, BAR = 0.7, CLEAR = 0.04;

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
      if (s >= (p.length <= SHORT ? NEAR : BAR) && s > score) score = s;
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
  const out = pal.commands.map(c => ({ say: [c.t, ...(ALSO[c.cmd] || [])], label: c.t.replace(/…$/, ""), go: () => pal.pick(c) }));
  for (const k of ctx.state.desks?.desks || []) out.push({ say: [`desk ${k.name}`], label: `Desk · ${k.name}`, go: () => ctx.showDesk(k.id, true) });
  const desk = ctx.state.view === "desk" && ctx.desk();
  if (desk) {
    for (const p of desk.panelsHere()) out.push({ say: [`panel ${NUM[p.slot]}`, ...(p.name ? [`panel ${p.name}`, p.name] : [])], label: `Panel ${p.slot}${p.name ? ` · ${p.name}` : ""}`, go: () => desk.panelHere(p.id) });
    for (const v of desk.viewsHere() || []) out.push({ say: [v.label, `${v.label} view`], label: v.label, go: () => desk.viewHere(v.v) });
  }
  return out;
}

// ---------- the daemon ----------

let ctx = null;
const api = (path, body) => fetch(path, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", "x-snyvi-capability": ctx.capability }, body: body ? JSON.stringify(body) : undefined })
  .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`); return j; });
/** How voice stands, asked once and again whenever the sheet changes it. */
let stood = null;
const status = fresh => (fresh || !stood ? (stood = api("/api/voice").catch(e => { stood = null; throw e; })) : stood);

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
async function microphone() {
  ac ||= new AudioContext();
  loaded ||= ac.audioWorklet.addModule(`/assets/voice-worklet.js${ctx.v ? `?v=${ctx.v}` : ""}`);
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

// ---------- the bar ----------

const CSS = `
#voicebar { position: fixed; left: 50%; bottom: 56px; z-index: var(--z-toast); transform: translateX(-50%); pointer-events: none;
  display: flex; align-items: center; gap: 10px; max-width: min(560px, 90vw); padding: 7px 14px; border-radius: var(--r-pill);
  font-size: var(--fs-ui); color: var(--fg-2); background: var(--bg-raise); border: 1px solid var(--rule); box-shadow: var(--shadow);
  opacity: 0; transition: opacity var(--dur-move); }
#voicebar.show { opacity: 1; transition-duration: var(--dur-quick); }
#voicebar .vm { flex: none; width: 44px; height: 6px; border-radius: var(--r-pill); background: var(--rule); overflow: hidden; }
#voicebar .vm i { display: block; height: 100%; width: 0; background: var(--accent); transition: width var(--dur-instant) linear; }
#voicebar:not(.live) .vm { display: none; }
#voicebar .vt { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#voicebar .vt b { font-weight: 600; color: var(--fg); }
#voicebar .vt q { quotes: "“" "”"; }
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
  bar = Object.assign(document.createElement("div"), { id: "voicebar", innerHTML: `<span class="vm"><i></i></span><span class="vt"></span>` });
  bar.setAttribute("role", "status");
  document.body.append(bar);
}
/** Say `html` in the bar. `live` shows the meter; `ms` takes it down after. */
function say(html, { live = false, ms = 0 } = {}) {
  mount();
  clearTimeout(barT);
  bar.querySelector(".vt").innerHTML = html;
  bar.classList.toggle("live", live);
  bar.classList.add("show");
  if (ms) barT = setTimeout(() => bar.classList.remove("show", "live"), ms);
}
const meter = level => { if (bar) bar.querySelector(".vm i").style.width = `${Math.min(100, Math.round(Math.sqrt(level) * 110))}%`; };
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const KEY = /Mac/.test(navigator.platform) ? "⌃⌥M" : "Ctrl Alt M";
const PAL = /Mac/.test(navigator.platform) ? "⌘K" : "Ctrl K";

// ---------- the take ----------

/** A key held for less than this was a slip, not a take. */
const SLIP = 200;
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
  catch (e) { say(`Voice did not work: ${esc(ctx.sayErr(e).why)}`, { ms: 4000 }); }
  finally { taking = null; }
}

async function take(mine, until, dry) {
  let st;
  try { st = await status(); } catch { st = {}; }
  if (!st.on) { say(`Voice is off. Turn it on in <b>${PAL} › Voice…</b>`, { ms: 3200 }); return; }
  say("…");
  // Both at once: the socket wakes the helper while the microphone opens.
  const [sock, mic] = await Promise.all([socket(), microphone()]);
  let peak = 0;
  try {
    sock.send(JSON.stringify({ t: "start", rate: mic.rate }));
    mic.node.port.onmessage = ev => {
      let m = 0;
      for (const x of ev.data) { const a = x < 0 ? -x : x; if (a > m) m = a; }
      peak = Math.max(peak, m); meter(m);
      if (sock.readyState === 1) sock.send(ev.data.buffer);
    };
    if (!mine.up) { say("Listening", { live: true }); await until; }
  } finally { mic.stop(); }
  if (Date.now() - mine.at < SLIP) { sock.close(); say("Hold the key while you speak", { ms: 2200 }); return; }
  say("…");
  const line = await new Promise((ok, no) => {
    const t = setTimeout(() => no(new Error("the helper took too long")), 8000);
    sock.onmessage = ev => { clearTimeout(t); try { ok(JSON.parse(ev.data)); } catch (e) { no(e); } };
    sock.onclose = sock.onerror = () => { clearTimeout(t); no(new Error("the daemon closed the socket")); };
    if (sock.readyState !== 1) return sock.onclose();
    sock.send(JSON.stringify({ t: "end" }));
  }).finally(() => { sock.onclose = sock.onerror = null; sock.close(); });
  if (line.error) throw new Error(line.error);
  if (line.quiet) { say(`Too quiet · ${esc(mic.label)}`, { ms: 3200 }); return; }
  const heard = (line.heard || "").trim();
  if (!heard) { say("Heard nothing to act on", { ms: 2600 }); return; }
  const hit = match(heard, await targets(ctx));
  if (!hit) { say(`<q>${esc(heard)}</q> · no command`, { ms: 3600 }); return; }
  say(`<q>${esc(heard)}</q> → <b>${esc(hit.label)}</b>`, { ms: 2600 });
  if (!dry) hit.go();
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
      <div class="vs-row"><button type="button" data-a="off">Turn voice off</button><button type="button" data-a="remove">Remove the download · ${mb(st.bytes)}</button></div>`;
    mics();
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
