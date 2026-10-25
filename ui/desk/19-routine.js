/* ui/desk/19-routine.js: a part of desk.js, one module. build.rs joins ui/desk/*.js in name
 * order (src/strip.rs `source`); SNYVI_UI_DIR serves the same join. */
// ---------- routines ----------

/* A routine is a line that comes back (src/routine.rs, plan 4f1379f4a4):
 * `newsroom · every day 07:30` typed into the notes field lands here, under
 * its own head below Notes, and at its hour snyvi starts the desk's
 * /newsroom in a panel in the back. Separate in the store and the brief,
 * the same things on screen: a row drawn like a note's with a clock ring in
 * the circle's place, the ⋯ menu every row has, and one sheet. Nothing here
 * is new to learn but the word `every`.
 *
 * The head shows only with a first routine: an empty one would be a second
 * thing to read on every desk. It arrives as a new note's row does, at the
 * list's foot, so nothing above it moves. */

/** This desk's routines, as the daemon last said them, and which desk. */
let rts = [], rtsAt = null;
/** The desk's slash commands, for the chip: `{ at, list }`. */
let rtCmds = { at: null, list: [] };
/** The routine whose menu is open, or 0. */
let rtMenu = 0;
/** One just removed from view: its row holds the Undo. */
let rtGone = null;
/** The sheet: `{ id, j, err, at }`, `at` the part to show first. */
let rtOpen = null;

/** Read again: on open, and on the `desknotes` event (`routine_run::changed`). */
async function routinesGet(id) {
  let j;
  try { j = await ctx.api(`/api/desks/${id}/routines`); } catch { return; }
  if (id !== deskId) return;
  // Every notes event asks; the rail is drawn again only when what it shows
  // moved, or a redraw would race a click on a card the event came for.
  const next = j.routines || [], shown = rtsAt === id && rts.length > 0;
  const moved = rtsAt !== id || JSON.stringify(next) !== JSON.stringify(rts);
  rts = next; rtsAt = id;
  if (rtCmds.at !== id) {
    try { rtCmds = { at: id, list: (await ctx.api(`/api/desks/${id}/commands`)).commands || [] }; } catch {}
  }
  if (rtOpen) rtSheetGet(rtOpen.id, rtOpen.at);
  if (moved && (rts.length || shown || rtGone) && current()) rail();
}

/** The routine a panel runs for, on this desk. */
const rtPane = pane => rtsAt === deskId && pane ? rts.find(r => r.pane === pane) : undefined;

/* The client's guess at a cadence on the end of a line, as `DUE_TAIL` is
 * for a date: only to say it was seen. src/due/every.rs is the truth. */
const EVERY_TAIL = /(?:^|[\s,·;-])((?:every\s+(?:day|weekday|(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*|\d{1,2}(?:st|nd|rd|th))|daily|weekdays)(?:\s+(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?)\s*$/i;
/** `{ every, cmd, ok }` for a line that ends in a cadence; `ok` when its
 *  first word is one of the desk's commands. */
function everyGuess(t) {
  const m = EVERY_TAIL.exec(t || "");
  if (!m || !m.index) return null;
  const cmd = (t.slice(0, m.index).trim().replace(/^\//, "").split(/\s+/)[0] || "");
  return { every: m[1].trim(), cmd, ok: rtCmds.at === deskId && rtCmds.list.includes(cmd) };
}
/** The chip's words for a cadence, or "" for none. */
function everyChip(t) {
  const g = everyGuess(t);
  return !g ? "" : g.ok ? `↻ ${g.every}` : "every needs a /command";
}

/** From the notes field's Enter: a line the chip read as a routine goes
 *  here, any other line to the notes. True when it was taken. */
async function routineAdd(d, text) {
  const g = everyGuess(text);
  if (!g || !g.ok) return false;
  const j = await ctx.api(`/api/desks/${d.id}/routines`, { text });
  if (j.routine) { rts = [...rts.filter(r => r.id !== j.routine.id), j.routine]; rtsAt = d.id; if (current()) rail(); }
  routinesGet(d.id);
  return true;
}

/** The section, under Notes; nothing at all with no routine. */
function routineSec(d) {
  const { esc } = ctx;
  if (rtsAt !== d.id || !rts.length && !(rtGone && rtGone.at === d.id)) return "";
  rtStyle();
  const rows = rts.map(r => rtRow(r, esc)).join("") +
    (rtGone && rtGone.at === d.id ? `<li class="dk-note gone" role="status"><span class="nm">${esc(rtGone.name)} · removed from view</span><button type="button" class="dk-undo" data-a="rt-back" data-r="${rtGone.id}">Undo</button></li>` + errLine(`r${rtGone.id}`, esc) : "");
  const running = rts.filter(r => r.running_since).length;
  return sec("routines", "rail.routines", "Routines", {
    cls: "dk-notes dk-rts", part: "rail.routines.head",
    tip: "Routines", sub: "Your lines with every: snyvi starts the desk's command at its hour, in a panel in the back. Type one in Notes: newsroom · every day 07:30",
    count: running ? `● ${rts.length}` : rts.length, tone: running ? "accent" : "", countTip: running ? `${running} running` : "",
  }, `<ul class="dk-list">${rows}</ul>`);
}

/** How long ago, in the rail's words. */
const rtAgo = s => s < 60 ? "just now" : s < 3600 ? `${s / 60 | 0} min ago` : s < 86400 ? `${s / 3600 | 0} h ago` : `${s / 86400 | 0} d ago`;

/** A row's one line of state: the whole of it, as the plan counts it. */
function rtMeta(r) {
  const now = Date.now() / 1000;
  if (r.suggested_by) return `${r.suggested_by} offers · ${r.every}`;
  if (r.running_since) return `running ${Math.max(1, (now - r.running_since) / 60 | 0)} min${r.running !== "session" ? ` · ${r.running}` : ""}`;
  if (r.file === "gone") return "command gone";
  if (r.file === "changed") return "changed since you allowed it";
  if (r.paused_at) return `paused · ${r.every}`;
  const last = r.last_at ? ` · ran ${rtAgo(now - r.last_at)}` : "";
  const st = r.last_state && !["done", "running"].includes(r.last_state) ? ` · ${r.last_state}` : "";
  return `${r.every} · next ${dueWord(r.due_at).w.replace(/^due /, "")}${last}${st}`;
}

function rtRow(r, esc) {
  const offer = !!r.suggested_by, meta = rtMeta(r);
  const tools = offer
    ? `<span class="dk-sug-tools"><button type="button" class="dk-keep" data-a="rt-sheet" data-r="${r.id}" aria-label="Look at ${esc(r.name)} and accept it">Accept…</button>` +
      `<button type="button" data-a="rt-x" data-r="${r.id}" data-tip="Not this one" data-tip-sub="nothing is deleted" aria-label="Do not keep ${esc(r.name)}">${ico("x")}</button></span>`
    : `<span class="dk-tail"><span class="dk-tools"><button type="button" data-a="rt-menu" data-r="${r.id}" aria-haspopup="menu" aria-expanded="${rtMenu === r.id}" data-tip="More" aria-label="More for ${esc(r.name)}">⋯</button></span></span>`;
  const allow = r.file === "changed" && !offer ? `<button type="button" class="dk-keep rt-allow" data-a="rt-allow" data-r="${r.id}" data-tip="Allow it as it is now" data-tip-sub=".claude/commands/${esc(r.cmd)}.md changed; it does not run until you allow it">Allow</button>` : "";
  return `<li class="dk-note dk-rt${offer ? " dk-sug" : ""}${r.running_since ? " on" : ""}${r.paused_at ? " paused" : ""}">` +
    `<span class="dk-lead"><span class="dk-tick dk-ring" aria-hidden="true">${RT_HANDS}</span></span>` +
    `<button type="button" class="nm" data-a="rt-sheet" data-r="${r.id}" data-tip="/${esc(r.name)}" data-tip-sub="${esc(meta)} · click for its sheet"><span class="nm-t" data-tip-cut>${esc(r.name)}</span></button>` +
    tools +
    `<span class="dk-meta"><span class="rt-meta">${esc(meta)}</span>${allow}</span>` +
    (rtMenu === r.id ? rtPop(r, esc) : "") + `</li>` + errLine(`r${r.id}`, esc);
}

/** A clock's two hands, in the circle a note's tick draws: the ring. */
const RT_HANDS = '<svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><path d="M6 3.2V6l2 1.3"/></svg>';

/** The ⋯ menu: Run now · Pause or Resume · Change… · History · Remove. */
function rtPop(r, esc) {
  const item = (a, l, tip = "") => `<button type="button" role="menuitem" data-a="${a}" data-r="${r.id}"${tip ? ` data-tip="${esc(tip)}"` : ""}>${l}</button>`;
  return `<span class="dk-due-pop rt-pop" role="menu" aria-label="${esc(r.name)}">` +
    (r.running_since ? "" : item("rt-run", "Run now", `/${r.name} in its panel in the back`)) +
    item(r.paused_at ? "rt-resume" : "rt-pause", r.paused_at ? "Resume" : "Pause") +
    item("rt-sheet", "Change…") + item("rt-history", "History") +
    item("rt-x", "Remove from view", "nothing is deleted") + `</span>`;
}

/** The row's clicks; true when one of them was this part's. */
async function routineAct(a, b, d) {
  if (!a.startsWith("rt-")) { if (rtMenu) { rtMenu = 0; rail(); } return false; }
  const id = +b.dataset.r, r = rts.find(x => x.id === id);
  const call = (act, why, back = () => {}) => told({ ...b.dataset }, `r${id}`, why, back, () => ctx.api(`/api/desks/${d.id}/routines/${id}/${act}`, {}));
  if (a === "rt-menu") { rtMenu = rtMenu === id ? 0 : id; rail(); if (rtMenu) ctx.tocEl.querySelector(".rt-pop button")?.focus(); return true; }
  rtMenu = 0;
  if (a === "rt-sheet" || a === "rt-history") { rtSheetGet(id, a === "rt-history" ? "runs" : ""); rail(); return true; }
  if (a === "rt-back") { rtGone = null; rail(); if (await call("restore", "Could not bring it back")) routinesGet(d.id); return true; }
  if (!r) return true;
  if (a === "rt-x") {
    rts = rts.filter(x => x !== r); rtGone = { id, name: r.name, at: d.id }; rail();
    if (!await call("remove", "Could not remove it", () => { rts.push(r); rtGone = null; })) return true;
    setTimeout(() => { if (rtGone && rtGone.id === id) { rtGone = null; if (current()) rail(); } }, 8000);
    return true;
  }
  const act = { "rt-run": "run", "rt-pause": "pause", "rt-resume": "resume", "rt-allow": "allow" }[a];
  if (act) {
    const why = { run: "Could not run it", pause: "Could not pause it", resume: "Could not resume it", allow: "Could not allow it" }[act];
    if (act === "run") r.running_since = Date.now() / 1000;
    rail();
    await call(act, why, () => { r.running_since = 0; });
    routinesGet(d.id);
  }
  return true;
}

/* ---------- the sheet ----------
 * Runs · When · Waits for you · Limits, and the runs it made. Over the
 * desk, never in it, so it moves nothing; Esc closes it. Opened from the
 * row, from Change… and History, and from Accept… on an agent's offer,
 * whose Save is what makes the offer the reader's. */

async function rtSheetGet(id, at = "") {
  const d = current();
  if (!d) return;
  let j;
  try { j = await ctx.api(`/api/desks/${d.id}/routines/${id}`); }
  catch (e) { rtOpen = { id, j: null, err: ctx.sayErr(e).why, at }; return rtSheet(); }
  const was = rtOpen && rtOpen.id === id ? rtOpen : null;
  rtOpen = { id, j, err: was ? was.err : "", at, limits: was ? was.limits : false };
  rtSheet();
}

function rtClose() {
  document.querySelector(".rt-sheet")?.remove();
  rtOpen = null;
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
  const r = j.routine, offer = !!r.suggested_by;
  const file = { ok: "allowed", new: "not allowed yet: Save allows it as it is now", changed: "changed since you allowed it: Save allows it as it is now", gone: "gone from the folder" }[r.file] || r.file;
  const keys = (j.keys || []).map(k => `<span class="rt-key${k.has ? "" : " no"}">${e(k.name)} ${k.has ? "✓" : "· not on this desk"}</span>`).join("");
  const runs = (j.runs || []).map(x => `<li><span class="rt-when">${e(new Date(x.started_at * 1000).toLocaleString([], { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }))}</span>` +
    `<span class="rt-why">${e({ clock: "at its hour", you: "Run now", answer: "your answers", card: "a Run card" }[x.why] || x.why)}</span>` +
    `<span class="rt-st">${e(x.state || (x.ended_at ? "" : "running"))}${x.ended_at && x.started_at && x.ended_at > x.started_at ? ` · ${Math.max(1, (x.ended_at - x.started_at) / 60 | 0)} min` : ""}</span>` +
    (x.line ? `<span class="rt-line">${e(x.line)}</span>` : x.why === "card" ? `<code class="rt-line">${e(x.what)}</code>` : "") + `</li>`).join("");
  const lim = rtOpen.limits
    ? `<label class="rt-lim"><input type="number" name="minutes" min="1" max="240" value="${r.minutes}"> min, then it stops · at <input type="number" name="five_hour" min="10" max="100" value="${r.five_hour}"> % of the five-hour window it waits</label>`
    : `<button type="button" class="rt-limline" data-rt="limits" data-tip="Change the limits">${r.minutes} min · waits past ${r.five_hour}% of the five-hour window</button>`;
  el.innerHTML = `<header class="rt-head"><b>${e(r.name)}</b><span class="rt-fine">${offer ? `offered by ${e(r.suggested_by)}` : r.runs ? `ran ${r.runs} time${r.runs === 1 ? "" : "s"}` : "not run yet"}</span><button type="button" class="rt-x" data-rt="close" aria-label="Close">✕</button></header>` +
    `<div class="rt-part"><h4>Runs</h4><p><code>/${e(r.name)}</code>${j.about ? ` · ${e(j.about)}` : ""}</p><p class="rt-fine">.claude/commands/${e(r.cmd)}.md · ${e(file)}</p>${keys ? `<p class="rt-keys">${keys}</p>` : ""}</div>` +
    `<div class="rt-part"><h4>When</h4><input name="every" value="${e(r.every)}" spellcheck="false" aria-label="When it runs"><p class="rt-fine">every day 07:30 · every weekday 9 · every mon 09:00 · every 1st${r.due_at && !r.paused_at ? ` · next ${e(dueWhen(r.due_at))}` : ""}</p></div>` +
    `<div class="rt-part"><h4>Waits for you</h4><textarea name="waits" rows="3" spellcheck="false" aria-label="What waits for you, one pattern a line" placeholder="python3 -I newsroom/publish.py *">${e((r.waits || []).join("\n"))}</textarea><p class="rt-fine">Commands the agent may not run, one a line, as Claude Code's permission rules write them. It hands each to you as a card, and Run on the card starts it here.</p></div>` +
    `<div class="rt-part"><h4>Limits</h4>${lim}</div>` +
    (rtOpen.err ? `<p class="rt-err" role="alert">${e(rtOpen.err)}</p>` : "") +
    `<div class="rt-acts"><button type="button" class="pri" data-rt="save">${offer ? "Save and accept" : "Save"}</button><button type="button" data-rt="close">Cancel</button>${offer || r.running_since ? "" : `<button type="button" data-rt="run">Run now</button>`}</div>` +
    `<div class="rt-part rt-runs"><h4>History</h4>${runs ? `<ul>${runs}</ul>` : `<p class="rt-fine">Nothing yet.</p>`}</div>`;
  if (rtOpen.at === "runs") el.querySelector(".rt-runs")?.scrollIntoView({ block: "nearest" });
  else el.querySelector("[name=every]")?.focus();
}

async function rtSheetClick(ev) {
  const b = ev.target.closest("[data-rt]");
  if (!b || !rtOpen) return;
  const d = current(), el = document.querySelector(".rt-sheet"), id = rtOpen.id, w = b.dataset.rt;
  if (w === "close") return rtClose();
  if (w === "limits") { rtOpen.limits = true; rtOpen.redraw = true; return rtSheet(); }
  if (!d) return;
  try {
    if (w === "run") await ctx.api(`/api/desks/${d.id}/routines/${id}/run`, {});
    if (w === "save") {
      const v = n => el.querySelector(`[name=${n}]`)?.value ?? "";
      await ctx.api(`/api/desks/${d.id}/routines/${id}`, {
        name: rtOpen.j.routine.name, every: v("every"), waits: v("waits"),
        minutes: +v("minutes") || rtOpen.j.routine.minutes, five_hour: +v("five_hour") || rtOpen.j.routine.five_hour,
      });
      rtClose();
    } else { rtOpen.err = ""; rtOpen.redraw = true; rtSheetGet(id, rtOpen.at); }
  } catch (e) {
    rtOpen.err = ctx.sayErr(e).why; rtOpen.redraw = true; rtSheet();
  }
  routinesGet(d.id);
}

function rtStyle() {
  if (document.getElementById("rt-css")) return;
  const s = document.createElement("style");
  s.id = "rt-css";
  s.textContent = RT_CSS;
  document.head.append(s);
}

/* The ring stands where a note's circle does, at its size, so a routine's
 * row is exactly a note row's height; the meta line is the note's. */
const RT_CSS = `
.dk-ring { color: var(--fg-3); }
.dk-rt.on .dk-ring { color: var(--accent-d); box-shadow: inset 0 0 0 1.5px var(--accent); }
.dk-rt.paused .nm-t, .dk-rt.paused .rt-meta { color: var(--fg-3); }
.dk-tick.dk-ring svg { width: 12px; height: 12px; }
.rt-meta { color: var(--fg-3); font-size: var(--fs-micro); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.dk-rt .rt-allow { margin-left: 6px; }
.dk-rt > .rt-pop { left: 27px; }
.rt-sheet { position: fixed; z-index: var(--z-pop, 30); top: 56px; right: 16px; width: min(460px, calc(100vw - 32px)); max-height: calc(100vh - 80px); overflow: auto;
  background: var(--bg-raise); color: var(--fg); border: 1px solid var(--rule); border-radius: var(--r-md); box-shadow: var(--shadow-3, var(--shadow)); padding: 12px 14px; font-size: 13px; }
.rt-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 6px; }
.rt-x { margin-left: auto; background: none; border: 0; color: var(--fg-3); cursor: pointer; font: inherit; }
.rt-fine { color: var(--fg-3); font-size: 11px; margin: 2px 0 0; }
.rt-part { margin: 10px 0 0; }
.rt-part h4 { margin: 0 0 4px; font-size: 11px; font-weight: 600; color: var(--fg-2); }
.rt-part p { margin: 0; }
.rt-part input[name=every], .rt-part textarea { width: 100%; box-sizing: border-box; font: inherit; font-family: var(--pn-font, monospace); font-size: 12px; color: var(--fg); background: var(--bg); border: 1px solid var(--rule); border-radius: var(--r-xs); padding: 4px 6px; }
.rt-part textarea { resize: vertical; min-height: 54px; }
.rt-lim input { width: 5ch; font: inherit; }
.rt-limline { background: none; border: 0; padding: 0; color: var(--fg-2); cursor: pointer; font: inherit; text-align: left; }
.rt-keys { display: flex; flex-wrap: wrap; gap: 4px 10px; margin-top: 4px; font-size: 11px; }
.rt-key.no { color: var(--warn); }
.rt-acts { display: flex; gap: 8px; margin-top: 12px; }
.rt-acts button { font: inherit; padding: 3px 10px; border-radius: var(--r-pill); border: 1px solid var(--rule); background: none; color: var(--fg); cursor: pointer; }
.rt-acts .pri { background: var(--accent); border-color: var(--accent); color: var(--bg); }
.rt-err { color: var(--warn); margin: 8px 0 0; }
.rt-runs ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
.rt-runs li { display: grid; grid-template-columns: auto auto 1fr; gap: 0 8px; font-size: 11px; color: var(--fg-2); }
.rt-runs .rt-line { grid-column: 1 / -1; color: var(--fg-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
`;
