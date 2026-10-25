/* What's new and the first three steps (#191): one chunk for the three ways
 * snyvi points at its own controls.
 *
 *   Show me →   a link on the What's new page (`/show?f=<id>`): the view the
 *               feature lives in, then a ring round it for a moment.
 *   The dots    for two weeks after an update, a small accent dot on each
 *               control that page told of, until the reader first presses it.
 *   The steps   a first desk's three moments -- Connect, Ask Claude, read
 *               Claude's page and answer -- each ringed in turn, with a card
 *               that says which of three it is and a way to skip them.
 *
 * What it points at comes from `/api/guide`, which reads features.toml in the
 * binary: an id and a selector, never a selector from a document. A page can
 * only name an id, and an id not in the table does nothing, so a document
 * cannot make Show me ring anything snyvi did not name itself.
 *
 * Everything drawn here is an overlay: the ring and the card are fixed
 * layers over the page, and a dot is a background on the control, so
 * nothing that comes and goes moves the page (no layout shift). The steps
 * watch the page on a slow clock rather than hooking into the desk's code:
 * a panel's strip, its state and the rail's rows are what they read, which
 * is also what the reader sees. */

const CSS = `
.gd-ring { position: fixed; z-index: var(--z-tip); pointer-events: none; border: 2px solid var(--accent); border-radius: var(--r-md);
  box-shadow: 0 0 0 4px var(--accent-bg); opacity: 0; transition: opacity var(--dur-move) var(--ease-out), left var(--dur-move) var(--ease-out), top var(--dur-move) var(--ease-out), width var(--dur-move) var(--ease-out), height var(--dur-move) var(--ease-out); }
.gd-ring.on { opacity: 1; animation: gd-pulse calc(var(--dur-moment) * 2) var(--ease-out) infinite alternate; }
@keyframes gd-pulse { from { box-shadow: 0 0 0 2px var(--accent-bg); } to { box-shadow: 0 0 0 7px var(--accent-bg); } }
.gd-card { position: fixed; z-index: var(--z-tip); width: 264px; padding: 10px 12px 9px; background: var(--bg-raise); color: var(--fg);
  border: 1px solid var(--rule-2); border-radius: var(--r-md); box-shadow: var(--shadow); font-size: var(--fs-small); line-height: 1.4;
  opacity: 0; transform: translateY(4px); transition: opacity var(--dur-move) var(--ease-out), transform var(--dur-move) var(--ease-out); }
.gd-card.on { opacity: 1; transform: none; }
.gd-card[hidden] { display: none; }
.gd-n { display: flex; align-items: center; gap: 4px; margin: 0 0 4px; font-size: var(--fs-micro); color: var(--fg-3); }
.gd-n .d { width: 6px; height: 6px; border-radius: 50%; background: var(--rule-2); }
.gd-n .d.on { background: var(--accent); }
.gd-n span:last-child { margin-left: 4px; }
.gd-card b { display: block; font-weight: 600; margin-bottom: 2px; }
.gd-card p { margin: 0; color: var(--fg-2); }
.gd-skip { margin-top: 6px; padding: 0; font: inherit; font-size: var(--fs-micro); color: var(--fg-3); background: none; border: 0; cursor: pointer; }
.gd-skip:hover { color: var(--fg); text-decoration: underline; }
[data-gd-new] { background-image: radial-gradient(circle at calc(100% - 4px) 4px, var(--accent) 3px, transparent 3.5px); }
@media (prefers-reduced-motion: reduce) { .gd-ring.on { animation: none; } }
`;

function style() {
  if (document.getElementById("gd-css")) return;
  const s = document.createElement("style");
  s.id = "gd-css"; s.textContent = CSS;
  document.head.append(s);
}

const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** What /api/guide says: asked once for the features, which are the
 *  binary's and do not change; the steps' flag is asked again each time a
 *  desk starts them (`steps`). */
let said = null;
const table = () => said || (said = fetch("/api/guide").then(r => r.ok ? r.json() : null).catch(() => null));

/** On screen and drawn: an element a rerender has not replaced, with a box,
 *  in the window. */
function seen(el) {
  if (!el || !el.isConnected) return false;
  const b = el.getBoundingClientRect();
  return b.width > 0 && b.height > 0 && b.bottom > 0 && b.top < innerHeight && getComputedStyle(el).visibility !== "hidden";
}
const first = sel => [...document.querySelectorAll(sel)].find(seen) || null;

// ---------- the ring ----------
let ringEl = null;
function ring(target, pad = 5) {
  style();
  if (!ringEl) { ringEl = document.createElement("div"); ringEl.className = "gd-ring"; ringEl.setAttribute("aria-hidden", "true"); document.body.append(ringEl); }
  if (!target) { ringEl.classList.remove("on"); return; }
  const b = target.getBoundingClientRect();
  Object.assign(ringEl.style, { left: `${b.left - pad}px`, top: `${b.top - pad}px`, width: `${b.width + pad * 2}px`, height: `${b.height + pad * 2}px` });
  ringEl.classList.add("on");
}

// ---------- Show me → ----------
/** Show me → on the What's new page (`u`, the link's URL): to the
 *  feature's view, then a ring
 *  round the control for a moment. A desk feature opens the desk last on
 *  (the page's ⌃` does the same). */
export async function show(u, swap, toast) {
  const id = u.searchParams.get("f"), t = await table(), f = t && t.features.find(x => x.id === id);
  if (!f) return;
  // The view from the address: a desk is /desk/<id>. A page's control is in
  // the head of the page the link was pressed on, so it needs no move.
  if (f.view === "desk" && !location.pathname.startsWith("/desk/")) swap();
  for (let i = 0; i < 40; i++) {
    const el = first(f.sel);
    if (el) {
      el.scrollIntoView({ block: "nearest" });
      used([f.id]);
      // Found again on every beat: a view that has just opened draws its
      // parts more than once, and the element found first may be gone.
      const until = Date.now() + 2600;
      const follow = () => { const now = first(f.sel); ring(Date.now() < until ? now : null); if (Date.now() < until) setTimeout(follow, 150); };
      follow();
      return;
    }
    await sleep(100);
  }
  toast(`${f.title} isn't on this page`, { sub: f.view === "desk" ? "it's on a desk: open one, then press Show me again" : "" });
}

// ---------- the dots ----------
const USED = "snyvi.guide.used";
const usedSet = (() => { try { return new Set(JSON.parse(localStorage.getItem(USED) || "[]")); } catch { return new Set(); } })();
/** A control pressed once is known: its dot goes, in this browser. Kept per
 *  viewer, a convenience -- lost, a dot shows again, and that is all. */
function used(ids) {
  let more = false;
  for (const id of ids) if (!usedSet.has(id)) { usedSet.add(id); more = true; }
  if (!more) return;
  try { localStorage.setItem(USED, JSON.stringify([...usedSet].slice(-200))); } catch { /* this window only */ }
  for (const el of document.querySelectorAll("[data-gd-new]")) {
    const left = el.dataset.gdNew.split(" ").filter(id => !usedSet.has(id));
    if (left.length) el.dataset.gdNew = left.join(" "); else undot(el);
  }
}
function undot(el) {
  delete el.dataset.gdNew;
  if (el.dataset.gdTip === "") delete el.dataset.tip; else if (el.dataset.gdTip != null) el.dataset.tipSub = el.dataset.gdTip;
  if (el.dataset.gdTip === "") delete el.dataset.tipSub;
  delete el.dataset.gdTip;
}

let dotting = false, dotClock = 0;
/** The dots, for the controls the last What's new page told of -- started
 *  by a desk's opening (ui/desk/20-first.js), first paint carrying none of
 *  it; a dot on a page's head shows from then on too. At most
 *  three, newest first, each until its first press or until the page is two
 *  weeks old (the daemon stops naming the page then). The page redraws its
 *  parts often, so a slow clock puts a dot back on a control drawn again. */
export async function dots() {
  if (dotting) return;
  dotting = true;
  const t = await table(), page = t && t.whats_new;
  if (!page) return;
  const on = t.features.filter(f => (page.ids || []).includes(f.id) && !usedSet.has(f.id)).slice(0, 3);
  if (!on.length) return;
  style();
  document.addEventListener("pointerdown", e => {
    const el = e.target.closest && e.target.closest("[data-gd-new]");
    if (el) used(el.dataset.gdNew.split(" "));
  }, true);
  const mark = () => {
    if (document.hidden) return;
    const live = on.filter(f => !usedSet.has(f.id));
    if (!live.length) { clearInterval(dotClock); return; }
    const by = new Map();
    for (const f of live) { const el = first(f.sel); if (el) by.set(el, [...(by.get(el) || []), f]); }
    for (const [el, fs] of by) {
      const ids = fs.map(f => f.id).join(" ");
      if (el.dataset.gdNew === ids) continue;
      const sub = fs.map(f => `New in ${f.since.replace(/\.0$/, "")} · ${f.title}`).join(" · ");
      if (el.dataset.gdNew == null) el.dataset.gdTip = el.dataset.tip ? el.dataset.tipSub || "" : "";
      el.dataset.gdNew = ids;
      if (el.dataset.tip) el.dataset.tipSub = sub;
      else { el.dataset.tip = fs[0].title; el.dataset.tipSub = sub; }
    }
  };
  mark();
  dotClock = setInterval(mark, 1200);
}

// ---------- the first three steps ----------
const STEPS = [
  ["Connect Claude", "One press, once: what Claude writes lands on this desk."],
  ["Ask Claude", "Claude starts in this folder and sends you a page."],
  ["Read Claude's page, then answer", ""],
];
let stepClock = 0, cardEl = null;

/** The card beside the ring: which step of three, what it is, and Skip. */
function card(n, target, line, skip) {
  if (!cardEl) {
    cardEl = document.createElement("div");
    cardEl.className = "gd-card"; cardEl.setAttribute("role", "status");
    document.body.append(cardEl);
  }
  if (!target) { cardEl.classList.remove("on"); cardEl.hidden = true; return; }
  const key = `${n}|${line}`;
  if (cardEl.dataset.k !== key) {
    cardEl.dataset.k = key;
    const dots = [0, 1, 2].map(i => `<span class="d${i <= n ? " on" : ""}"></span>`).join("");
    cardEl.innerHTML = `<p class="gd-n">${dots}<span>Step ${n + 1} of 3</span></p><b>${esc(STEPS[n][0])}</b><p>${esc(line)}</p><button type="button" class="gd-skip">Skip the steps</button>`;
    cardEl.querySelector(".gd-skip").addEventListener("click", skip);
  }
  cardEl.hidden = false;
  // Under the thing when there is room, over it when not, kept in the window.
  const b = target.getBoundingClientRect(), h = cardEl.offsetHeight || 96, w = 264, gap = 12;
  const top = b.bottom + gap + h < innerHeight ? b.bottom + gap : Math.max(8, b.top - gap - h);
  // Level with a wide thing's left edge, centred on a narrow one.
  const left = Math.min(innerWidth - w - 8, Math.max(8, b.width > w ? b.left : b.left + b.width / 2 - w / 2));
  Object.assign(cardEl.style, { top: `${top}px`, left: `${left}px` });
  requestAnimationFrame(() => cardEl.classList.add("on"));
}

/** Where the first desk is, read off the page: the panel's strip says
 *  Connect or Ask Claude; once Claude is going, step 3 rings what the reader
 *  does next -- the panel that is done and waits for an answer, else the
 *  page Claude sent, else the panel at work. */
function where() {
  const strip = first(".pn-connect:not([hidden])"), btn = strip && strip.querySelector(".w-btn");
  // The card sits by the strip, not the button: over the button it hid the
  // strip's own sentence.
  if (btn && strip.querySelector(".pn-ready")) return { n: 1, el: btn, at: strip, line: STEPS[1][1] };
  if (btn && /connect/i.test(btn.textContent)) return { n: 0, el: btn, at: strip, line: STEPS[0][1] };
  const done = first(".pn.done");
  if (done) return { n: 2, el: done, line: "Claude is done and waits for you. Answer it here, in its panel." };
  const doc = first(".dk-docs .dk-doc a.new") || first(".dk-docs .dk-doc a");
  if (doc) return { n: 2, el: doc, line: "Claude's page landed here. Open it, read it, then answer Claude in its panel." };
  const busy = [...document.querySelectorAll(".pn")].find(p => seen(p) && /working/.test(p.querySelector(".pn-state")?.textContent || ""));
  if (busy) return { n: 2, el: busy, line: "Claude is at work. Its page will land on the right." };
  return null;
}

/** A first desk's three steps, while they are neither done nor skipped.
 *  `c.api` posts with the window's capability, `c.say` is the desk's toast.
 *  Done when a panel that was
 *  done goes back to work: the reader answered Claude, and the loop closed
 *  once -- the moment snyvi counts as a maker started (the onboarding's
 *  "activated"). Returns the way to stop it, for when the desk closes. */
export async function steps(c) {
  stop();
  said = null;
  const t = await table();
  if (!t || !t.steps) return stop;
  style();
  const wasDone = new WeakSet();
  const end = async (why) => {
    stop();
    try { await c.api("/api/guide", { steps: false }); } catch { /* asked again next desk */ }
    if (why === "done") c.say("That's the loop", "Claude asks, you answer, the work moves. snyvi keeps it all.");
  };
  const tick = () => {
    if (document.hidden) return;
    for (const p of document.querySelectorAll(".pn")) {
      if (p.classList.contains("done")) wasDone.add(p);
      else if (wasDone.has(p) && /working/.test(p.querySelector(".pn-state")?.textContent || "")) return void end("done");
    }
    const w = where();
    ring(w && w.el, w && w.n === 2 && w.el.classList.contains("pn") ? 2 : 5);
    card(w ? w.n : 0, w && (w.at || w.el), w ? w.line : "", () => end("skip"));
  };
  tick();
  stepClock = setInterval(tick, 700);
  addEventListener("resize", tick);
  addEventListener("scroll", tick, true);
  stopTick = tick;
  return stop;
}
let stopTick = null;
export function stop() {
  clearInterval(stepClock); stepClock = 0;
  if (stopTick) { removeEventListener("resize", stopTick); removeEventListener("scroll", stopTick, true); stopTick = null; }
  ring(null);
  if (cardEl) { cardEl.classList.remove("on"); cardEl.hidden = true; }
}
