/* ui/desk/28-routine-when.js: a part of desk.js, one module. build.rs joins ui/desk/*.js in name
 * order (src/strip.rs `source`); SNYVI_UI_DIR serves the same join. */
// ---------- a routine's when: times, Only if, Wakes on, Runs with ----------

/* What wakes a routine and what it runs with (1.63, plan d621276291 step
 * 4), the four parts of its sheet between What it does and Ask me before:
 *
 * - **When**: its times, up to six hours over its lines. A line is a
 *   cadence and its hours (`every day 09:30 13:00`), the words that hour
 *   adds to the prompt (`case`), and its Only if tick (C1): on by default
 *   for a time with no words, off for one with words, so a quiet Monday
 *   still runs its case. Each line says when it first runs, read by the
 *   daemon (`GET …/routines/read`), never by a grammar of the window's own.
 * - **Only if**: a command asked before a ticked time's run (C2: the clock
 *   only). Exit 0 runs, 1 is a quiet run with no panel, else a failed gate.
 * - **Wakes on**: a command that keeps running, and the shape of the lines
 *   it prints that may reach the prompt: words and holes, `tag <number>`,
 *   never a pattern (R11). Only ids reach the prompt.
 * - **Runs with**: the model, its effort, and the context: everything, or
 *   without the reader's global notes (S2).
 *
 * Only if and Wakes on fold to one line while empty, so a routine of one
 * hour reads as it did. What the sheet says is kept across its own redraws
 * (`rtOpen.form`), so a time added never loses one typed. */

/** The shapes a watch's lines are offered in, each one press away. */
const RT_SHAPES = ["tag <number>", "id <number>", "reply <number> <word>"];

/** The model and effort lists' words. */
const rtPickName = v => v ? v[0].toUpperCase() + v.slice(1) : "Default";

/** The When's lines as the sheet shows them: what it says now, or the
 *  daemon's read of them. */
function rtTimesOf(j) {
  if (rtOpen.form) return rtOpen.form.times;
  return (j.times || []).map(t => ({ every: t.every, words: t.words, gated: t.gated, next: t.next }));
}

/** A field's value as the sheet says it now, or the routine's. */
const rtNow = (r, k) => rtOpen.form ? rtOpen.form[k] : r[k];

/** One line of the When. */
function rtTimeRow(t, i, draft, e) {
  const next = t.next ? `${draft ? "first run" : "next"} ${rtNextAt(t.next)}` : "";
  return `<li class="rt-time" data-i="${i}">` +
    `<input name="t-every" value="${e(t.every)}" placeholder="every weekday 9" spellcheck="false" autocomplete="off" aria-label="When it runs, line ${i + 1}">` +
    `<input name="t-words" value="${e(t.words || "")}" placeholder="words it adds" spellcheck="false" autocomplete="off" maxlength="60" aria-label="Words this time adds to the prompt" data-tip="Words it adds" data-tip-sub="said after the command at this hour: case, news">` +
    `<label class="rt-only" data-tip="Only if" data-tip-sub="its Only if command is asked first at this hour"><input type="checkbox" name="t-gated"${t.gated ? " checked" : ""}${t.touched ? ` data-touched="1"` : ""}>Only if</label>` +
    `<button type="button" class="rt-tx" data-rt="t-x" data-i="${i}" aria-label="Take this time out" data-tip="Take this time out">✕</button>` +
    `<span class="rt-fine rt-tnext" aria-live="polite">${e(next)}</span></li>`;
}

/** When it runs next, short: `tomorrow 9:00`, `Wed 9:00`. */
function rtNextAt(at) {
  const d = new Date(at * 1000), now = new Date();
  const day = d.toDateString() === now.toDateString() ? "today"
    : d.toDateString() === new Date(now.getTime() + 86400000).toDateString() ? "tomorrow"
    : d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
  return `${day} ${d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

/** The four parts, between What it does and Ask me before. */
function rtWhenPart(j, e) {
  const r = j.routine, draft = r.state === "draft" || r.state === "offer";
  const times = rtTimesOf(j), gate = rtNow(r, "gate") || "", watch = rtNow(r, "watch") || "";
  const open = rtOpen.parts || (rtOpen.parts = new Set());
  const when = `<div class="rt-part rt-whenp${gate.trim() ? "" : " nogate"}"><h4>When</h4>` +
    (times.length ? `<ul class="rt-times">${times.map((t, i) => rtTimeRow(t, i, draft, e)).join("")}</ul>` : `<p class="rt-fine">${watch.trim() ? "no hour: it runs when its watch wakes it" : "no hour yet: pick one, or give it a watch below, to Start it"}</p>`) +
    `<p class="rt-fine rt-whens">${RT_WHENS.map(w => `<button type="button" class="rt-when-b" data-rt="when" data-w="${w}">${w}</button>`).join("")}` +
    (times.length < 6 ? `<button type="button" class="rt-when-b" data-rt="t-add">+ a time</button>` : `<span>six times at most</span>`) + `</p></div>`;
  const fold = (k, h, said) => `<div class="rt-part"><h4>${h}</h4><button type="button" class="rt-limline" data-rt="open" data-k="${k}">${said}</button></div>`;
  const scripts = j.scripts && j.scripts.folder
    ? `<p class="rt-fine" data-tip="${e(j.scripts.folder)}" data-tip-sub="first on PATH for Only if and Wakes on; a change in it asks you to allow it again">its scripts: ${e(j.scripts.folder)}${j.scripts.files && j.scripts.files.length ? ` · ${e(j.scripts.files.slice(0, 4).join(" "))}${j.scripts.files.length > 4 ? ` +${j.scripts.files.length - 4}` : ""}` : " · none yet"}</p>` : "";
  const onlyIf = !gate.trim() && !open.has("gate") ? fold("gate", "Only if", "always · add a check that can say a day is quiet")
    : `<div class="rt-part"><h4>Only if</h4><input name="gate" value="${e(gate)}" placeholder="a command: exit 0 runs, exit 1 is a quiet day" spellcheck="false" autocomplete="off" aria-label="Only if: a command asked first">` +
      `<p class="rt-fine">asked before each time ticked Only if · exit 0 runs, 1 is a quiet run with no panel, anything else is a failed gate · in the desk's folder, with only the keys it names</p></div>`;
  const shape = rtNow(r, "shape") || "";
  const w = r.watch_live, waiting = j.waiting || 0;
  const state = !r.watch ? "" : !w ? "not watching yet: it starts once the routine is started" : w.stopped ? `stopped${w.said ? `: ${w.said}` : ""}` : w.watching ? `watching${w.heard_at ? ` · last heard ${rtHour(w.heard_at)}` : ""}` : `starting${w.said ? ` · ${w.said}` : ""}`;
  const counts = [state, waiting ? `${waiting} waiting` : "", r.dropped ? `${r.dropped} dropped: not the shape, or too many` : ""].filter(Boolean).join(" · ");
  const wakes = !watch.trim() && !open.has("watch") ? fold("watch", "Wakes on", "only its times · add a watch that wakes it when something happens")
    : `<div class="rt-part"><h4>Wakes on</h4><input name="watch" value="${e(watch)}" placeholder="a command that keeps running and prints a line when something happens" spellcheck="false" autocomplete="off" aria-label="Wakes on: a command that keeps running">` +
      `<p class="rt-shape"><label>its lines' shape <input name="shape" value="${e(shape)}" placeholder="a few short words" spellcheck="false" autocomplete="off" maxlength="64" aria-label="The shape of a line that may reach the prompt"></label>` +
      RT_SHAPES.map(s => `<button type="button" class="rt-when-b" data-rt="shape" data-w="${e(s)}">${e(s)}</button>`).join("") + `</p>` +
      (counts ? `<p class="rt-fine${w && w.stopped ? " rt-warn" : ""}">${e(counts)}</p>` : "") +
      `<p class="rt-fine">waits 60 s for more lines, then one run · at most 6 an hour · a line out of its shape is dropped, never cut to fit</p></div>`;
  const sel = (n, list, now, label) => `<label>${label} <select name="${n}">${list.map(v => `<option value="${e(v)}"${v === now ? " selected" : ""}>${e(rtPickName(v))}</option>`).join("")}</select></label>`;
  const slim = rtNow(r, "slim");
  const runsWith = `<div class="rt-part"><h4>Runs with</h4><p class="rt-with">` +
    sel("model", j.models || [""], rtNow(r, "model") || "", "Model") + sel("effort", j.efforts || [""], rtNow(r, "effort") || "", "Effort") +
    `<label data-tip="Context" data-tip-sub="without your global notes, a run starts with about half the context: your ~/.claude/CLAUDE.md is left out, your commands and skills stay">Context <select name="slim"><option value=""${slim ? "" : " selected"}>everything</option><option value="1"${slim ? " selected" : ""}>without my global notes</option></select></label></p></div>`;
  return when + onlyIf + wakes + scripts + runsWith;
}

/** What the four parts say now, as Save sends them. */
function rtWhenBody(el, r) {
  const v = n => el.querySelector(`[name=${n}]`);
  const times = [...el.querySelectorAll(".rt-time")].map(li => ({
    every: li.querySelector("[name=t-every]").value.trim(),
    words: li.querySelector("[name=t-words]").value.trim(),
    gated: li.querySelector("[name=t-gated]").checked,
    touched: !!li.querySelector("[name=t-gated]").dataset.touched,
    next: 0,
  }));
  return {
    times,
    gate: v("gate") ? v("gate").value.trim() : r.gate || "",
    watch: v("watch") ? v("watch").value.trim() : r.watch || "",
    shape: v("shape") ? v("shape").value.trim() : r.shape || "",
    model: v("model")?.value ?? r.model ?? "",
    effort: v("effort")?.value ?? r.effort ?? "",
    slim: v("slim") ? v("slim").value === "1" : !!r.slim,
  };
}

/** The body Save sends: a line with no cadence is not sent. */
const rtWhenSend = b => ({ ...b, times: b.times.filter(t => t.every).map(t => ({ every: t.every, words: t.words, gated: t.gated })) });

/** Whether it may Start as the sheet says it (C3): a time, or a watch. */
const rtHasWhen = b => b.times.some(t => t.every) || !!b.watch;

/** Each line's next, read by the daemon 200 ms after its last key. */
let rtWhenT = 0, rtWhenN = 0;
function rtWhenRead(el, only) {
  const d = current();
  if (!d || !rtOpen || !rtOpen.j) return;
  clearTimeout(rtWhenT);
  const n = ++rtWhenN, draft = ["draft", "offer"].includes(rtOpen.j.routine.state);
  rtWhenT = setTimeout(() => {
    for (const li of el.querySelectorAll(".rt-time")) {
      if (only && li !== only) continue;
      const every = li.querySelector("[name=t-every]").value.trim(), out = li.querySelector(".rt-tnext");
      if (!every) { out.textContent = ""; out.classList.remove("rt-warn"); continue; }
      ctx.api(`/api/desks/${d.id}/routines/read?text=${encodeURIComponent(`when · ${every}`)}`).then(j => {
        if (n !== rtWhenN || !out.isConnected) return;
        const ok = !!(j.every && j.next);
        out.textContent = ok ? `${j.every} · ${draft ? "first run" : "next"} ${rtNextAt(j.next)}` : "not a when snyvi reads: every day 9 · every weekday 9 · every mon 9:00 · every day 09:30 13:00";
        out.classList.toggle("rt-warn", !ok);
      }).catch(() => {});
    }
  }, 200);
}

/** The parts' clicks; true when one was theirs. `again` redraws the sheet
 *  with what it says kept. */
function rtWhenClick(w, b, el, again) {
  const r = rtOpen.j.routine;
  const keep = () => { rtOpen.form = { ...rtSheetBody(el, r), ...rtWhenBody(el, r) }; };
  if (w === "open") { keep(); rtOpen.parts.add(b.dataset.k); again(); el.querySelector(`[name=${b.dataset.k}]`)?.focus(); return true; }
  if (w === "t-add" || w === "when") {
    keep();
    const ts = rtOpen.form.times, blank = ts.find(t => !t.every);
    if (w === "when" && blank) blank.every = b.dataset.w;
    else if (ts.length < 6) ts.push({ every: w === "when" ? b.dataset.w : "", words: "", gated: true, next: 0 });
    again();
    const rows = el.querySelectorAll(".rt-time"), li = rows[rows.length - 1];
    li?.querySelector(w === "when" ? "[name=t-words]" : "[name=t-every]")?.focus();
    rtWhenRead(el);
    return true;
  }
  if (w === "t-x") { keep(); rtOpen.form.times.splice(+b.dataset.i, 1); again(); return true; }
  if (w === "shape") { const f = el.querySelector("[name=shape]"); if (f) { f.value = b.dataset.w; f.dispatchEvent(new Event("input", { bubbles: true })); f.focus(); } return true; }
  return false;
}

/** What typing in the parts does: a time's words untick its Only if until
 *  the reader ticks it themselves (C1), a gate shows the ticks, a cadence
 *  is read again. */
function rtWhenInput(ev, el) {
  const t = ev.target, li = t.closest(".rt-time");
  if (t.name === "t-gated") t.dataset.touched = "1";
  if (t.name === "t-words" && li) {
    const g = li.querySelector("[name=t-gated]");
    if (!g.dataset.touched) g.checked = !t.value.trim();
  }
  if (t.name === "gate") el.querySelector(".rt-whenp")?.classList.toggle("nogate", !t.value.trim());
  if (t.name === "t-every" && li) rtWhenRead(el, li);
}

const RT_WHEN_CSS = `
.rt-times { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
.rt-time { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr) auto auto; gap: 2px 6px; align-items: center; }
.rt-time .rt-tnext { grid-column: 1 / -1; margin: 0; min-height: 14px; }
.rt-part .rt-time input[type=text], .rt-time input:not([type]), .rt-part input[name=gate], .rt-part input[name=watch], .rt-shape input {
  width: 100%; box-sizing: border-box; font: inherit; font-family: var(--pn-font, monospace); font-size: 12px; color: var(--fg); background: var(--bg); border: 1px solid var(--rule); border-radius: var(--r-xs); padding: 3px 6px; }
.rt-time input[name=t-words] { font-family: inherit; }
.rt-only { display: flex; align-items: center; gap: 3px; font-size: 11px; color: var(--fg-2); cursor: pointer; white-space: nowrap; }
.rt-whenp.nogate .rt-only { visibility: hidden; }
.rt-tx { background: none; border: 0; color: var(--fg-3); cursor: pointer; font: inherit; font-size: 11px; padding: 0 2px; }
.rt-tx:hover { color: var(--fg); }
.rt-shape { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 6px; margin-top: 4px; font-size: 11px; color: var(--fg-2); }
.rt-shape label { display: flex; align-items: center; gap: 6px; flex: 1 1 14em; }
.rt-shape input { width: auto; flex: 1; min-width: 8em; }
.rt-with { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 12px; color: var(--fg-2); }
.rt-with select { font: inherit; font-size: 12px; color: var(--fg); background: var(--bg); border: 1px solid var(--rule); border-radius: var(--r-xs); padding: 1px 4px; }
.rt-warn { color: var(--warn); }
`;
