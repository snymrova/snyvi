/* ui/desk/21-routine-sheet.js: a part of desk.js, one module. build.rs joins ui/desk/*.js in name
 * order (src/strip.rs `source`); SNYVI_UI_DIR serves the same join. */
// ---------- a routine's sheet ----------

/* What it does · When · Ask me before · Before it runs on its own ·
 * Limits · History (1.53, plan f30461f2c1 §3.10; said in the reader's
 * words in 1.53.1, audit 566d17f746 R5: it read as a permissions file). Over the desk, never in it, so it moves nothing; Esc
 * closes it. Opened by Enter in the Routines field (the draft's own reply),
 * from a row, from Change… and History, and from Accept… on an agent's
 * offer.
 *
 * What it asks for depends on the state. A draft or an offer: Try once
 * now, Start it, Cancel -- nothing runs on its own before Start, which
 * allows the file as it is now. A live one: Save, Run now, Close. The
 * suggested Waits come from the file's own lines, unticked, each with the
 * lines it catches; Ready says what would stop a run and never blocks. */

/** The sheet: `{ id, j, err, at, limits, diff, paste }`, `at` the part to show first. */
let rtOpen = null;

async function rtSheetGet(id, at = "") {
  const d = current();
  if (!d) return;
  let j;
  try { j = await ctx.api(`/api/desks/${d.id}/routines/${id}`); }
  catch (e) { rtOpen = { id, j: null, err: ctx.sayErr(e).why, at }; return rtSheet(); }
  // A file changes on disk with no event: what the sheet read is the row's too.
  const i = rts.findIndex(x => x.id === id);
  if (i >= 0 && JSON.stringify(rts[i]) !== JSON.stringify(j.routine)) { rts[i] = j.routine; rail(); }
  const was = rtOpen && rtOpen.id === id ? rtOpen : null;
  rtOpen = { id, j, err: was ? was.err : "", at, limits: was ? was.limits : false, diff: was ? was.diff : false, paste: was ? was.paste : false };
  rtSheet();
}

/** The sheet from a reply that already holds it: Enter's. */
function rtSheetShow(j) {
  rtOpen = { id: j.routine.id, j, err: "", at: "", limits: false, diff: false, paste: false, redraw: true };
  rtSheet();
}

function rtClose() {
  document.querySelector(".rt-sheet")?.remove();
  rtOpen = null;
}

/** The cadences the When field is shown, each one press away. */
const RT_WHENS = ["every day 9", "every weekday 9", "every mon 9:00", "every 1st"];

/** A run's why, in the sheet's words. */
const RT_WHY = { clock: "at its hour", you: "Run now", try: "Try once now", answer: "your answers", card: "a Run card" };

function rtRuns(j, e) {
  return (j.runs || []).map(x => `<li><span class="rt-when">${e(new Date(x.started_at * 1000).toLocaleString([], { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }))}</span>` +
    `<span class="rt-why">${e(RT_WHY[x.why] || x.why)}</span>` +
    `<span class="rt-st">${e(x.state || (x.ended_at ? "" : "running"))}${x.ended_at && x.started_at && x.ended_at > x.started_at ? ` · ${Math.max(1, (x.ended_at - x.started_at) / 60 | 0)} min` : ""}</span>` +
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

/** The acts, by state. */
function rtActs(j, e) {
  const r = j.routine;
  // Try once, then start: until a try has run, Try is the main button
  // and Start the second (R7); after one, Start is.
  const tried = (j.runs || []).length > 0;
  const start = `<button type="button"${tried ? ` class="pri"` : ""} data-rt="start" data-tip="Start it" data-tip-sub="from its next hour it runs on its own, with the file as it is now">Start it</button>`;
  if (r.state === "draft" || r.state === "offer") {
    const trying = !!r.running_since;
    return `<div class="rt-acts">${trying ? `<button type="button" data-rt="panel">Show the panel</button>` : `<button type="button"${tried ? "" : ` class="pri"`} data-rt="try" data-tip="Try once now" data-tip-sub="one run in a panel in the back, while you watch; its questions come to On you">${tried ? "Try again" : "Try once now"}</button>`}` +
      start + `<button type="button" data-rt="cancel">${r.state === "offer" ? "Not this one" : "Cancel"}</button></div>`;
  }
  return `<div class="rt-acts"><button type="button" class="pri" data-rt="save">Save</button><button type="button" data-rt="close">Close</button>${r.running_since ? `<button type="button" data-rt="panel">Show the panel</button>` : `<button type="button" data-rt="run">Run now</button>`}</div>`;
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
  }
  // A redraw keeps what is being typed: the clock redraws the rail often.
  if (el.contains(document.activeElement) && el.dataset.r === String(rtOpen.id) && !rtOpen.redraw) return;
  rtOpen.redraw = false;
  el.dataset.r = String(rtOpen.id);
  if (!j) { el.innerHTML = `<p class="rt-err" role="alert">${e(rtOpen.err || "Could not read it")}</p><div class="rt-acts"><button type="button" data-rt="close">Close</button></div>`; return; }
  const r = j.routine;
  const fine = r.state === "offer" ? `offered by ${e(r.suggested_by)} · nothing runs until you start it`
    : r.state === "draft" ? (r.running_since ? "a draft · trying now" : "a draft · try it once, then start it")
    : r.runs ? `ran ${r.runs} time${r.runs === 1 ? "" : "s"}` : "not run yet";
  const lim = rtOpen.limits
    ? `<label class="rt-lim">stops after <input type="number" name="minutes" min="1" max="240" value="${r.minutes}"> min · waits when your Claude plan's five hours are <input type="number" name="five_hour" min="10" max="100" value="${r.five_hour}"> % used</label>`
    : `<button type="button" class="rt-limline" data-rt="limits" data-tip="Change the limits">stops after ${r.minutes} min · waits when your Claude plan's five hours are ${r.five_hour}% used</button>`;
  const runs = rtRuns(j, e);
  el.innerHTML = `<header class="rt-head"><b>${e(r.name)}</b><span class="rt-fine">${fine}</span><button type="button" class="rt-x" data-rt="close" aria-label="Close">✕</button></header>` +
    rtRunsPart(j, e) +
    `<div class="rt-part"><h4>When</h4><input name="every" value="${e(r.every)}" spellcheck="false" aria-label="When it runs"><p class="rt-fine rt-whens">${RT_WHENS.map(w => `<button type="button" class="rt-when-b" data-rt="when" data-w="${w}">${w}</button>`).join("")}${r.due_at && r.state === "live" ? `<span>next ${e(dueWhen(r.due_at))}</span>` : ""}</p></div>` +
    rtWaitsPart(j, e) + rtReadyPart(j, e) +
    `<div class="rt-part"><h4>Limits</h4>${lim}</div>` +
    (rtOpen.err ? `<p class="rt-err" role="alert">${e(rtOpen.err)}</p>` : "") +
    rtActs(j, e) +
    `<div class="rt-part rt-runs"><h4>History</h4>${runs ? `<ul>${runs}</ul>` : `<p class="rt-fine">Nothing yet.</p>`}</div>`;
  if (rtOpen.at === "runs") el.querySelector(".rt-runs")?.scrollIntoView({ block: "nearest" });
  // The focus goes to its ✕, not its When field: an accent ring on a field
  // no one has touched read as an error (R8). Esc still closes it.
  else el.querySelector(".rt-x")?.focus({ preventScroll: true });
}

/** What the sheet says now, as Save sends it: the ticks and the reader's
 *  own patterns are one Waits list. */
function rtSheetBody(el, r) {
  const v = n => el.querySelector(`[name=${n}]`)?.value ?? "";
  const ticked = [...el.querySelectorAll(".rt-sug input:checked")].map(x => x.dataset.p);
  const waits = [...ticked, ...v("waits").split("\n").map(x => x.trim()).filter(Boolean)];
  return {
    name: r.cmd ? r.name : v("words").trim() || r.name, every: v("every"), waits: waits.join("\n"),
    minutes: +v("minutes") || r.minutes, five_hour: +v("five_hour") || r.five_hour,
  };
}

async function rtSheetClick(ev) {
  const b = ev.target.closest("[data-rt]");
  if (!b || !rtOpen) return;
  const d = current(), el = document.querySelector(".rt-sheet"), id = rtOpen.id, w = b.dataset.rt;
  const again = () => { rtOpen.redraw = true; rtSheet(); };
  if (w === "close") return rtClose();
  // An example is a press away from the field, which keeps the rest typed.
  if (w === "when") { const f = el.querySelector("[name=every]"); if (f) { f.value = b.dataset.w; f.focus(); } return; }
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
  b.disabled = true;
  try {
    if (w === "login") { await ctx.api("/api/start-at-login", {}); }
    // A draft's Try and Start keep what the sheet says first.
    else if (w === "try" || w === "start") {
      await ctx.api(base, rtSheetBody(el, r));
      await ctx.api(`${base}/${w}`, {});
      if (w === "start") { rtClose(); rtSaidStarted(id); routinesGet(d.id); return; }
    }
    else if (w === "run") await ctx.api(`${base}/run`, {});
    else if (w === "save") { await ctx.api(base, rtSheetBody(el, r)); rtClose(); routinesGet(d.id); return; }
    rtOpen.err = "";
    rtSheetGet(id, rtOpen.at);
  } catch (e) {
    rtOpen.err = ctx.sayErr(e).why; again();
  }
  routinesGet(d.id);
}

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
.rt-part input[name=every], .rt-part textarea { width: 100%; box-sizing: border-box; font: inherit; font-family: var(--pn-font, monospace); font-size: 12px; color: var(--fg); background: var(--bg); border: 1px solid var(--rule); border-radius: var(--r-xs); padding: 4px 6px; }
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
.rt-acts { display: flex; gap: 8px; margin-top: 12px; }
.rt-acts button { font: inherit; padding: 3px 10px; border-radius: var(--r-pill); border: 1px solid var(--rule); background: none; color: var(--fg); cursor: pointer; }
.rt-acts button:disabled { opacity: .5; cursor: default; }
.rt-acts .pri { background: var(--accent); border-color: var(--accent); color: var(--bg); }
.rt-err { color: var(--warn); margin: 8px 0 0; }
.rt-runs ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
.rt-runs li { display: grid; grid-template-columns: auto auto 1fr; gap: 0 8px; font-size: 11px; color: var(--fg-2); }
.rt-runs .rt-line { grid-column: 1 / -1; color: var(--fg-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
`;
