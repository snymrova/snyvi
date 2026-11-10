/* ui/desk/21-routine-sheet.js: a part of desk.js, one module. build.rs joins ui/desk/*.js in name
 * order (src/strip.rs `source`); SNYVI_UI_DIR serves the same join. */
// ---------- a routine's sheet ----------

/* What it does · When · Only if · Wakes on · Runs with · Ask me before ·
 * Before it runs on its own · Limits · History (1.53, plan f30461f2c1
 * §3.10; said in the reader's words in 1.53.1, audit 566d17f746 R5: it
 * read as a permissions file; the four parts after What it does are 1.63's,
 * 28-routine-when.js). Over the desk, never in it, so it moves nothing,
 * and beside the rail, so the row it is for stays in sight (U10); Esc
 * closes it. Opened by Enter in the Routines field (the draft's own reply),
 * from a row, from Change… and History, and from Accept… on an agent's
 * offer.
 *
 * What it asks for depends on the state, which its head says (U7). A
 * draft or an offer: Try once now, with words or none, Start it (a time or
 * a watch first, C3), Cancel -- nothing runs on its own before Start,
 * which allows the file as it is now. A live one: Save, once something
 * changed (U12), Run now or Stop, Pause or Resume, Remove from view: all
 * the ⋯ menu does (U13). The
 * suggested Waits come from the file's own lines, unticked, each with the
 * lines it catches; Ready says what would stop a run and never blocks. */

/** The sheet: `{ id, j, err, at, limits, diff, paste, parts, form, was,
 *  tw }`, `at` the part to show first, `form` what it says while the
 *  reader changes it, `was` what it said as read (Save waits for a change),
 *  `tw` a try's words. */
let rtOpen = null;

/** Read it again. `fresh` after the sheet's own save: what it says is the
 *  daemon's again. */
async function rtSheetGet(id, at = "", fresh = false) {
  const d = current();
  if (!d) return;
  let j;
  try { j = await ctx.api(`/api/desks/${d.id}/routines/${id}`); }
  catch (e) { rtOpen = { id, j: null, err: ctx.sayErr(e).why, at }; return rtSheet(); }
  // A file changes on disk with no event: what the sheet read is the row's too.
  const i = rts.findIndex(x => x.id === id);
  if (i >= 0 && JSON.stringify(rts[i]) !== JSON.stringify(j.routine)) { rts[i] = j.routine; rail(); }
  const was = rtOpen && rtOpen.id === id ? rtOpen : null;
  rtOpen = { id, j, err: was ? was.err : "", at, limits: was ? was.limits : false, diff: was ? was.diff : false, paste: was ? was.paste : false,
    parts: was ? was.parts : new Set(), form: was && !fresh ? was.form : null, was: was && !fresh ? was.was : null, tw: was ? was.tw : "", redraw: fresh };
  rtSheet();
}

/** The sheet from a reply that already holds it: Enter's. */
function rtSheetShow(j) {
  rtOpen = { id: j.routine.id, j, err: "", at: "", limits: false, diff: false, paste: false, parts: new Set(), form: null, was: null, tw: "", redraw: true };
  rtSheet();
}

function rtClose() {
  document.querySelector(".rt-sheet")?.remove();
  rtOpen = null;
}

/** The cadences the When field is shown, each one press away. */
const RT_WHENS = ["every day 9", "every weekday 9", "every mon 9:00", "every 1st"];

/** A run's why, in the sheet's words. */
const RT_WHY = { clock: "at its hour", you: "Run now", try: "Try once now", answer: "your answers", card: "a Run card", event: "an event" };

/** A while to the minute, as History says it: `2 h 10 min`, `40 min`. */
function rtWhile(s) {
  const h = s / 3600 | 0, m = (s % 3600) / 60 | 0;
  return h ? `${h} h${m ? ` ${m} min` : ""}` : `${Math.max(1, m)} min`;
}

/* Why a run started, said once: a clock's and a try's `woke` already say
 *  it ("at its hour (09:30) · case"), so it stands alone; an event's or an
 *  answer's woke is only what came with it. */
function rtWoke(x) {
  const why = RT_WHY[x.why] || x.why;
  if (!x.woke) return why;
  return x.why === "clock" || x.why === "try" ? x.woke : `${why} · ${x.woke}`;
}

/* A run's line: its hour, why and what woke it, and how late a clock's
 * catch-up started; how it ended and the minutes it ran -- without the
 * ones the machine slept through, said apart (#198) -- and how far it moved
 * the five-hour window, when both readings were fresh (R12). A day's quiet
 * runs are one line, with how many (R10). */
function rtRuns(j, e) {
  return (j.runs || []).map(x => `<li><span class="rt-when">${e(new Date(x.started_at * 1000).toLocaleString([], { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }))}</span>` +
    `<span class="rt-why">${e(rtWoke(x))}${x.late_s ? ` · ${rtWhile(x.late_s)} late` : ""}</span>` +
    `<span class="rt-st">${e(x.state || (x.ended_at ? "" : "running"))}${x.more ? ` · ${x.more + 1} today` : ""}${x.ended_at && x.started_at && x.ended_at > x.started_at ? ` · ${Math.max(1, (x.ended_at - x.started_at - (x.slept_s || 0)) / 60 | 0)} min` : ""}${x.slept_s ? ` · slept ${rtWhile(x.slept_s)}` : ""}` +
    `${x.five_before >= 0 && x.five_after >= 0 ? ` · window moved ${Math.max(0, Math.round(x.five_after - x.five_before))}%` : ""}</span>` +
    (x.line ? `<span class="rt-line">${e(x.line)}</span>` : x.why === "card" ? `<code class="rt-line">${e(x.what)}</code>` : "") + `</li>`).join("");
}

/** Runs: the file and where it lives, or the reader's words; the diff when
 *  it changed since it was allowed. */
function rtRunsPart(j, e) {
  const r = j.routine, p = j.place;
  if (!r.cmd) {
    return `<div class="rt-part"><h4>What it does</h4><textarea name="words" rows="2" spellcheck="true" aria-label="Your words, the prompt">${e(r.name)}</textarea>` +
      `<p class="rt-fine">your words, said to a new Claude in a panel in the back</p></div>`;
  }
  const file = { ok: "", new: "", changed: r.state === "draft" || r.state === "offer" ? "" : "changed since you started it · Save takes it as it is now", gone: "the file is gone", two: "two files hold this name: rename one" }[r.file] ?? r.file;
  const whose = p ? { "yours · skill": "one of your skills", "yours · command": "one of your commands", "project · skill": "this project's skill", "project · command": "this project's command" }[p.where] || p.where : "";
  const keys = (j.keys || []).map(k => `<span class="rt-key${k.has ? "" : " no"}">${e(k.name)} ${k.has ? "✓" : "· not on this desk"}</span>`).join("");
  const diff = j.diff
    ? `<button type="button" class="rt-limline" data-rt="diff" aria-expanded="${!!rtOpen.diff}">${rtOpen.diff ? "Fold what changed" : "See what changed"}</button>` +
      (rtOpen.diff ? `<pre class="rt-diff">${j.diff.split("\n").map(l => `<span class="${l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : ""}">${e(l)}</span>`).join("\n")}</pre>` : "")
    : "";
  return `<div class="rt-part"><h4>What it does</h4><p><code>/${e(r.name)}</code>${j.about ? ` · ${e(j.about)}` : ""}</p>` +
    `<p class="rt-fine" data-tip="${e(p ? p.file : r.path)}">${whose ? `${e(whose)} · ` : ""}${e(p ? p.file : r.path)}${file ? ` · ${e(file)}` : ""}</p>${diff}` +
    (keys ? `<p class="rt-keys">${keys}</p>` : "") + `</div>`;
}

/** Waits for you: the file's suggestions as ticks, each with the lines it
 *  catches, then the reader's own patterns, and what each of those catches. */
function rtWaitsPart(j, e) {
  const r = j.routine, sug = j.suggested || [];
  const own = (r.waits || []).filter(w => !sug.some(s => s.pattern === w));
  const lines = n => n.length ? `catches line${n.length > 1 ? "s" : ""} ${n.join(" ")}` : "catches no line in the file";
  const ticks = sug.map(s => `<label class="rt-sug"><input type="checkbox" data-p="${e(s.pattern)}"${s.on ? " checked" : ""}><code>${e(s.pattern)}</code><span class="rt-fine">${e(s.why)} · ${lines(s.lines)}</span></label>`).join("");
  const caught = (j.catches || []).filter(c => own.includes(c.pattern)).map(c => `<li><code>${e(c.pattern)}</code> ${r.cmd ? lines(c.lines) : ""}</li>`).join("");
  const empty = !sug.length && !own.length ? `<p class="rt-fine">Nothing yet: it may do every step itself.</p>` : "";
  return `<div class="rt-part"><h4>Ask me before</h4>${ticks ? `<div class="rt-sugs">${ticks}</div>` : ""}${empty}` +
    `<textarea name="waits" rows="1" spellcheck="false" aria-label="Commands it asks you before running, one a line" placeholder="a command it must ask you before, like a publish or a deploy">${e(own.join("\n"))}</textarea>` +
    (caught ? `<ul class="rt-caught">${caught}</ul>` : "") +
    `<p class="rt-fine" data-tip="One a line, as Claude Code's permission rules write them: python3 -I publish.py *" data-tip-sub="${j.place && /skill$/.test(j.place.where) ? "a skill's scripts run from its folder: put * before a script's path, python3 -I *scripts/publish.py *" : "a pattern catches its dry run too"}">When it gets there, it stops and gives you the command on a card, with Run.</p></div>`;
}

/** Before it runs on its own: what would stop a run, each with its fix as
 *  a button or words; what is fine in one quiet line under them; and what
 *  only the command's author acts on (`author`) folded away, since a
 *  reader starting a routine has nothing to do with it (R5). */
function rtReadyPart(j, e) {
  const all = j.ready || [];
  const line = (x, i) => {
    const fix = !x.fix ? "" : typeof x.fix === "string" ? ` <span class="rt-fix">· ${e(x.fix)}</span>` : `<button type="button" class="rt-fixb" data-rt="${e(x.fix.act)}">${e(x.fix.label)}</button>`;
    const paste = x.paste ? `<button type="button" class="rt-limline" data-rt="paste" aria-expanded="${!!rtOpen.paste}">${rtOpen.paste ? "Fold the lines" : "the lines to add"}</button>` +
      (rtOpen.paste ? `<pre class="rt-diff">${e(x.paste)}</pre><button type="button" class="rt-fixb" data-rt="copy" data-i="${i}">Copy</button>` : "") : "";
    return `<li class="${x.ok ? "ok" : "no"}"><span class="rt-mark" aria-hidden="true">${x.ok ? "✓" : "!"}</span><span>${e(x.says)}${fix}${paste}</span></li>`;
  };
  const no = all.map((x, i) => !x.ok && !x.author ? line(x, i) : "").join("");
  const ok = all.filter(x => x.ok && !x.author).map(x => e(x.says));
  const author = all.map((x, i) => x.author ? line(x, i) : "").join("");
  if (!all.length) return "";
  return `<div class="rt-part"><h4>Before it runs on its own</h4>${no ? `<ul class="rt-ready">${no}</ul>` : `<p class="rt-fine">Nothing stops it.</p>`}` +
    (ok.length ? `<p class="rt-fine">✓ ${ok.join(" · ")}</p>` : "") +
    (author ? `<details class="rt-author"${rtOpen.paste ? " open" : ""}><summary>For the command's author</summary><ul class="rt-ready">${author}</ul></details>` : "") + `</div>`;
}

/** The acts, by state: everything the row's ⋯ menu does (U13). Try and
 *  Run now take words (B6), said as a run would be woken with them. */
function rtActs(j, e) {
  const r = j.routine, running = !!r.running_since;
  // Try once, then start: until a try has run, Try is the main button
  // and Start the second (R7); after one, Start is.
  const tried = (j.runs || []).length > 0;
  const words = `<input name="tw" class="rt-tw" value="${e(rtOpen.tw || "")}" placeholder="with words…" spellcheck="false" autocomplete="off" maxlength="60" aria-label="Words for this run, as an event or a time would give" data-tip="With words" data-tip-sub="a line its watch would print, tag 5304, or one of its times' words">`;
  const stop = `<button type="button" data-rt="panel">Show the panel</button><button type="button" data-rt="stop" data-tip="Stop" data-tip-sub="ends the run under way, as its minutes would">Stop</button>`;
  if (r.state === "draft" || r.state === "offer") {
    const start = `<button type="button"${tried ? ` class="pri"` : ""} data-rt="start" data-tip="Start it" data-tip-sub="from its next hour, or its watch's first line, it runs on its own, with the file as it is now">Start it</button>`;
    return `<div class="rt-acts">${running ? stop : `<button type="button"${tried ? "" : ` class="pri"`} data-rt="try" data-tip="Try once now" data-tip-sub="one run in a panel in the back, while you watch; its questions come to On you">${tried ? "Try again" : "Try once now"}</button>${words}`}` +
      start + `<button type="button" data-rt="cancel">${r.state === "offer" ? "Not this one" : "Cancel"}</button></div>`;
  }
  return `<div class="rt-acts"><button type="button" class="pri" data-rt="save" disabled data-tip="Save" data-tip-sub="once something here changed">Save</button>` +
    (running ? stop : `<button type="button" data-rt="run">Run now</button>${words}`) +
    `<button type="button" data-rt="${r.paused_at ? "resume" : "pause"}">${r.paused_at ? "Resume" : "Pause"}</button>` +
    `<button type="button" data-rt="cancel" data-tip="Remove from view" data-tip-sub="nothing is deleted">Remove from view</button><button type="button" data-rt="close">Close</button></div>`;
}

/** Its state, as the head says it (U7). */
function rtHeadSays(r, e) {
  const n = r.runs ? ` · ran ${r.runs} time${r.runs === 1 ? "" : "s"}` : "";
  const w = r.watch_live, now = Date.now() / 1000;
  const next = r.due_at ? `next ${rtNextAt(r.due_at)}` : "";
  const watching = w && w.watching ? `watching${w.heard_at ? ` · last heard ${rtHour(w.heard_at)}` : ""}` : "";
  const says = r.state === "offer" ? `offered by ${r.suggested_by} · nothing runs until you start it`
    : r.state === "draft" ? (r.running_since ? "draft · trying now" : !r.every && !r.watch ? "draft · when?" : "draft · try it once, then start it")
    : r.running_since ? `running ${Math.max(1, (now - r.running_since - (r.slept_s || 0)) / 60 | 0)} min`
    : r.paused_at ? "paused"
    : w && w.stopped ? "watch stopped"
    : ["live", next, watching].filter(Boolean).join(" · ");
  return e(says + (r.state === "draft" || r.state === "offer" ? "" : n));
}

function rtSheet() {
  rtStyle();
  let el = document.querySelector(".rt-sheet");
  if (!rtOpen) { el?.remove(); return; }
  const e = ctx.esc, j = rtOpen.j;
  if (!el) {
    el = document.createElement("section");
    el.className = "rt-sheet";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-label", "Routine");
    document.body.append(el);
    el.addEventListener("click", rtSheetClick);
    el.addEventListener("keydown", ev => { ev.stopPropagation(); if (ev.key === "Escape") rtClose(); });
    for (const k of ["input", "change"]) el.addEventListener(k, ev => { if (!rtOpen || !rtOpen.j) return; rtWhenInput(ev, el); rtStartDraw(el); rtDirtyDraw(el); });
  }
  rtBeside(el);
  // A read from outside (the clock redraws the rail often) keeps what is
  // being typed or was changed: only the head, the acts and History are
  // the daemon's to say again.
  if (el.dataset.r === String(rtOpen.id) && !rtOpen.redraw && j && (rtTyping(el) || rtDirty(el))) return rtSheetPatch(el, j, e);
  // Drawn from the daemon's read: that is what a change is measured from.
  if (!rtOpen.redraw) { rtOpen.form = null; rtOpen.was = null; }
  rtOpen.redraw = false;
  el.dataset.r = String(rtOpen.id);
  if (!j) { el.innerHTML = `<p class="rt-err" role="alert">${e(rtOpen.err || "Could not read it")}</p><div class="rt-acts"><button type="button" data-rt="close">Close</button></div>`; return; }
  // What it says while changed is drawn over what the daemon read.
  const f = rtOpen.form, r = f ? { ...j.routine, name: f.name, waits: f.waits.split("\n").filter(Boolean), minutes: f.minutes, five_hour: f.five_hour } : j.routine;
  const jv = f ? { ...j, routine: r, suggested: (j.suggested || []).map(x => ({ ...x, on: r.waits.includes(x.pattern) })) } : j;
  const lim = rtOpen.limits
    ? `<label class="rt-lim">stops after <input type="number" name="minutes" min="1" max="240" value="${r.minutes}"> min · pauses when your five-hour window is <input type="number" name="five_hour" min="10" max="100" value="${r.five_hour}"> % used</label>`
    : `<button type="button" class="rt-limline" data-rt="limits" data-tip="Change the limits">stops after ${r.minutes} min · pauses when your five-hour window is ${r.five_hour}% used</button>`;
  const runs = rtRuns(j, e);
  el.innerHTML = `<header class="rt-head"><b>${e(r.name)}</b><span class="rt-fine">${rtHeadSays(j.routine, e)}</span><button type="button" class="rt-x" data-rt="close" aria-label="Close">✕</button></header>` +
    rtRunsPart(jv, e) + rtWhenPart(jv, e) +
    rtWaitsPart(jv, e) + rtReadyPart(jv, e) +
    `<div class="rt-part"><h4>Limits</h4>${lim}</div>` +
    `<p class="rt-err" role="alert"${rtOpen.err ? "" : " hidden"}>${e(rtOpen.err || "")}</p>` +
    rtActs(j, e) +
    `<div class="rt-part rt-runs"><h4>History</h4>${runs ? `<ul>${runs}</ul>` : `<p class="rt-fine">Nothing yet.</p>`}</div>`;
  el.dataset.running = String(!!j.routine.running_since);
  if (!rtOpen.was) rtOpen.was = JSON.stringify(rtSheetBody(el, j.routine));
  if (f) rtWhenRead(el);
  rtStartDraw(el); rtDirtyDraw(el);
  if (rtOpen.at === "runs") el.querySelector(".rt-runs")?.scrollIntoView({ block: "nearest" });
  // The focus goes to its ✕, not a field: an accent ring on a field no one
  // has touched read as an error (R8). Esc still closes it. A redraw of the
  // sheet's own leaves it where its click put it.
  else if (!f) el.querySelector(".rt-x")?.focus({ preventScroll: true });
}

/** The head, the acts while the focus is not in them, and History, said
 *  again from a new read, with nothing typed lost. */
/* The reader is in a field of the sheet. Its ✕ has the focus from the
 *  moment it opens, and a button held is no reason to keep a stale body. */
function rtTyping(el) {
  const a = document.activeElement;
  return !!a && el.contains(a) && a.matches("input, select, textarea");
}

function rtSheetPatch(el, j, e) {
  const head = el.querySelector(".rt-head .rt-fine");
  if (head) head.innerHTML = rtHeadSays(j.routine, e);
  const runs = el.querySelector(".rt-runs"), list = rtRuns(j, e);
  if (runs) runs.innerHTML = `<h4>History</h4>${list ? `<ul>${list}</ul>` : `<p class="rt-fine">Nothing yet.</p>`}`;
  const acts = el.querySelector(".rt-acts"), on = String(!!j.routine.running_since);
  if (acts && el.dataset.running !== on && !acts.contains(document.activeElement)) {
    rtOpen.tw = el.querySelector("[name=tw]")?.value || "";
    acts.outerHTML = rtActs(j, e); el.dataset.running = on;
    rtStartDraw(el); rtDirtyDraw(el);
  }
}

/** Whether the sheet says something other than it did as read. */
const rtDirty = el => !!(rtOpen && rtOpen.j && rtOpen.was) && JSON.stringify(rtSheetBody(el, rtOpen.j.routine)) !== rtOpen.was;
/** Save, only once something changed (U12). */
function rtDirtyDraw(el) {
  const b = el.querySelector("[data-rt=save]");
  if (b) b.disabled = !rtDirty(el);
}
/** Start, only with a time or a watch (C3), said on the button. */
function rtStartDraw(el) {
  const b = el.querySelector("[data-rt=start]");
  if (!b || !rtOpen || !rtOpen.j) return;
  const ok = rtHasWhen(rtWhenBody(el, rtOpen.j.routine));
  b.disabled = !ok;
  b.dataset.tipSub = ok ? "from its next hour, or its watch's first line, it runs on its own, with the file as it is now" : "set a when first: a time, or a watch";
}

/** Beside the rail when it is open, so the row it is for stays in sight
 *  (U10); over it when the window has no room for both. */
function rtBeside(el) {
  const t = ctx.tocEl, at = t && t.offsetParent ? t.getBoundingClientRect() : null;
  const right = at && at.width && at.left - 16 - 480 >= 16 ? innerWidth - at.left + 16 : 16;
  el.style.right = `${right}px`;
}

/** What the sheet says now, as Save sends it: the ticks and the reader's
 *  own patterns are one Waits list. */
function rtSheetBody(el, r) {
  const v = n => el.querySelector(`[name=${n}]`)?.value ?? "";
  const ticked = [...el.querySelectorAll(".rt-sug input:checked")].map(x => x.dataset.p);
  const waits = [...ticked, ...v("waits").split("\n").map(x => x.trim()).filter(Boolean)];
  return {
    name: r.cmd ? r.name : v("words").trim() || r.name, waits: waits.join("\n"),
    minutes: +v("minutes") || r.minutes, five_hour: +v("five_hour") || r.five_hour,
    ...rtWhenSend(rtWhenBody(el, r)),
  };
}

async function rtSheetClick(ev) {
  const b = ev.target.closest("[data-rt]");
  if (!b || !rtOpen) return;
  const d = current(), el = document.querySelector(".rt-sheet"), id = rtOpen.id, w = b.dataset.rt;
  // A redraw of the sheet's own keeps what it says.
  const again = () => {
    if (rtOpen.j && !rtOpen.form) rtOpen.form = { ...rtSheetBody(el, rtOpen.j.routine), ...rtWhenBody(el, rtOpen.j.routine) };
    rtOpen.tw = el.querySelector("[name=tw]")?.value || "";
    rtOpen.redraw = true; rtSheet();
  };
  if (w === "close") return rtClose();
  if (rtOpen.j && rtWhenClick(w, b, el, () => { rtOpen.tw = el.querySelector("[name=tw]")?.value || ""; rtOpen.redraw = true; rtSheet(); })) return;
  if (w === "limits") { rtOpen.limits = true; return again(); }
  if (w === "diff") { rtOpen.diff = !rtOpen.diff; return again(); }
  if (w === "paste") { rtOpen.paste = !rtOpen.paste; return again(); }
  if (w === "copy") {
    const x = (rtOpen.j?.ready || [])[+b.dataset.i];
    try { await navigator.clipboard.writeText(x?.paste || ""); b.textContent = "Copied"; } catch { b.textContent = "Select it and copy"; }
    return;
  }
  if (!d || !rtOpen.j) return;
  const r = rtOpen.j.routine, base = `/api/desks/${d.id}/routines/${id}`;
  if (w === "panel") { rtClose(); return drawer(r.pane); }
  if (w === "cancel") { rtClose(); return rtRemove(d, r, { a: "rt-x", r: String(id) }); }
  const tw = (el.querySelector("[name=tw]")?.value || "").trim();
  b.disabled = true;
  try {
    if (w === "login") { await ctx.api("/api/start-at-login", {}); }
    // A draft's Try and Start keep what the sheet says first.
    else if (w === "try" || w === "start") {
      await ctx.api(base, rtSheetBody(el, r));
      await ctx.api(`${base}/${w}`, w === "try" ? { words: tw } : {});
      if (w === "start") { rtClose(); rtSaidStarted(id); routinesGet(d.id); return; }
      if (w === "try") rtOpen.tw = "";
    }
    // Run now with words is a try of a live routine: the words woke it.
    else if (w === "run") { await ctx.api(`${base}/${tw ? "try" : "run"}`, tw ? { words: tw } : {}); rtOpen.tw = ""; }
    else if (w === "stop" || w === "pause" || w === "resume") await ctx.api(`${base}/${w}`, {});
    else if (w === "save") { await ctx.api(base, rtSheetBody(el, r)); rtClose(); routinesGet(d.id); return; }
    rtOpen.err = "";
    rtSheetGet(id, rtOpen.at, w === "try");
  } catch (e) {
    rtOpen.err = ctx.sayErr(e).why;
    const no = el.querySelector(".rt-err");
    if (no) { no.textContent = rtOpen.err; no.hidden = false; }
    b.disabled = false; rtStartDraw(el); rtDirtyDraw(el);
  }
  routinesGet(d.id);
}

// The When's own rules (`28-routine-when.js`) join these in `rtStyle`, at
// use: that part loads after this one, so naming it here would throw.
const RT_SHEET_CSS = `
.rt-sheet { position: fixed; z-index: var(--z-pop, 30); top: 56px; right: 16px; width: min(480px, calc(100vw - 32px)); max-height: calc(100vh - 80px); overflow: auto;
  background: var(--bg-raise); color: var(--fg); border: 1px solid var(--rule); border-radius: var(--r-md); box-shadow: var(--shadow-3, var(--shadow)); padding: 12px 14px; font-size: 13px; }
.rt-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 6px; }
.rt-head b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.rt-x { margin-left: auto; background: none; border: 0; color: var(--fg-3); cursor: pointer; font: inherit; }
.rt-fine { color: var(--fg-3); font-size: 11px; margin: 2px 0 0; }
.rt-part { margin: 10px 0 0; }
.rt-part h4 { margin: 0 0 4px; font-size: 11px; font-weight: 600; color: var(--fg-2); }
.rt-part p { margin: 0; }
.rt-part textarea { width: 100%; box-sizing: border-box; font: inherit; font-family: var(--pn-font, monospace); font-size: 12px; color: var(--fg); background: var(--bg); border: 1px solid var(--rule); border-radius: var(--r-xs); padding: 4px 6px; }
.rt-part textarea[name=words] { font-family: inherit; }
.rt-part textarea::placeholder { font-family: var(--sans); }
.rt-part textarea { resize: vertical; min-height: 40px; }
.rt-lim input { width: 5ch; font: inherit; }
.rt-limline { background: none; border: 0; padding: 0; color: var(--fg-2); cursor: pointer; font: inherit; font-size: 11px; text-align: left; text-decoration: underline dotted; }
.rt-keys { display: flex; flex-wrap: wrap; gap: 4px 10px; margin-top: 4px; font-size: 11px; }
.rt-key.no { color: var(--warn); }
.rt-sugs { display: grid; gap: 3px; margin-bottom: 6px; }
.rt-sug { display: grid; grid-template-columns: auto 1fr; gap: 0 6px; align-items: baseline; font-size: 12px; cursor: pointer; }
.rt-sug .rt-fine { grid-column: 2; }
.rt-caught { list-style: none; margin: 4px 0 0; padding: 0; font-size: 11px; color: var(--fg-3); }
.rt-ready { list-style: none; margin: 0; padding: 0; display: grid; gap: 3px; font-size: 12px; }
.rt-ready li { display: grid; grid-template-columns: 14px 1fr; gap: 0 4px; }
.rt-ready li.ok { color: var(--fg-3); }
.rt-ready .rt-limline { margin-left: 6px; }
.rt-ready li.no .rt-mark { color: var(--warn); font-weight: 600; }
.rt-fix { color: var(--fg-2); }
.rt-fixb { margin-left: 6px; font: inherit; font-size: 11px; padding: 0 8px; border-radius: var(--r-pill); border: 1px solid var(--rule); background: none; color: var(--fg); cursor: pointer; }
.rt-diff { margin: 4px 0 0; padding: 6px; max-height: 220px; overflow: auto; font-family: var(--pn-font, monospace); font-size: 11px; background: var(--bg); border: 1px solid var(--rule); border-radius: var(--r-xs); white-space: pre-wrap; }
.rt-diff .add { color: var(--ok, var(--accent-d)); }
.rt-diff .del { color: var(--danger); }
.rt-whens { display: flex; flex-wrap: wrap; gap: 4px 6px; margin-top: 4px; align-items: baseline; }
.rt-when-b { font: inherit; font-size: 11px; padding: 0 7px; border-radius: var(--r-pill); border: 1px solid var(--rule); background: none; color: var(--fg-2); cursor: pointer; }
.rt-when-b:hover { border-color: var(--fg-3); color: var(--fg); }
.rt-author { margin-top: 6px; font-size: 11px; color: var(--fg-3); }
.rt-author summary { cursor: pointer; }
.rt-author .rt-ready { margin-top: 4px; }
.rt-acts { display: flex; flex-wrap: wrap; gap: 6px 8px; margin-top: 12px; }
.rt-acts .rt-tw { width: 9em; font: inherit; font-size: 12px; padding: 2px 6px; color: var(--fg); background: var(--bg); border: 1px solid var(--rule); border-radius: var(--r-pill); }
.rt-acts button { font: inherit; padding: 3px 10px; border-radius: var(--r-pill); border: 1px solid var(--rule); background: none; color: var(--fg); cursor: pointer; }
.rt-acts button:disabled { opacity: .5; cursor: default; }
.rt-acts .pri { background: var(--accent); border-color: var(--accent); color: var(--bg); }
.rt-err { color: var(--warn); margin: 8px 0 0; }
.rt-runs ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
.rt-runs li { display: grid; grid-template-columns: auto minmax(0, auto) 1fr; gap: 0 8px; font-size: 11px; color: var(--fg-2); }
.rt-runs .rt-why { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rt-runs .rt-line { grid-column: 1 / -1; color: var(--fg-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
`;
