/* ui/desk/24-checks.js: a part of desk.js, one module. build.rs joins ui/desk/*.js in name
 * order (src/strip.rs `source`); SNYVI_UI_DIR serves the same join. */
// ---------- checks you hold on a note (1.58, H2.1) ----------

/* A held check is one line, in the reader's words, of what they will try once
 * a note's work is done (src/desk/checks.rs). The builder is told only how
 * many (`checks_held`); the lines come to this page alone, in the list's own
 * read (`checks`, by note id).
 *
 * Two places on a row, and nothing outside it moves:
 * - While the work is not out, a small mark among the row's marks, "2
 *   checks", opens a card over the rows below, as the gate does: the lines
 *   with a ✕ each, an agent's suggestions as ghosts with Keep and ✕, and a
 *   box, "What will you try?". The gate's "Hold a check…" opens the same card
 *   on a line with none.
 * - At check-it -- the work landed, or an agent's tick inside the week it can
 *   be taken back -- the row grows once, under its marks, into the lines with
 *   a ✓ and a ✗ each. "✓ works" lights only when every line is ✓; a ✗ opens
 *   the row's own "not yet…" with that line already written, and Enter
 *   reopens it with those words, which the next agent's brief leads with.
 *   The circle still ticks a line the old way. */

/** note id → its live checks, the reader's first, then suggestions. */
let noteChecks = new Map();
/** The line whose checks card is open, and what is typed in its box. */
let checksOpen = 0, checkDraft = "", checkFocused = false;
/** A check just taken off, holding its row and its Undo for a moment. */
let checkGone = null, checkTimer = 0;
/** How many a line holds, as src/desk/checks.rs says. */
const CHECKS_MAX = 7, CHECK_CHARS = 160;

/** From the list's read: every line's checks, with one just taken off kept
 *  in its place through the read that no longer has it. */
function setChecks(j) {
  noteChecks = new Map(Object.entries(j || {}).map(([k, v]) => [+k, v]));
  const g = checkGone;
  if (g) {
    const list = noteChecks.get(g.note) || [];
    if (!list.some(c => c.id === g.c.id)) list.splice(Math.min(g.i, list.length), 0, g.c);
    noteChecks.set(g.note, list);
  }
}

const checksOf = x => noteChecks.get(x.id) || [];
/** The reader's own, kept ones: what check-it runs. */
const heldOf = x => checksOf(x).filter(c => !c.suggested_by && !c.gone);
/** The row is at check-it, with lines to run. */
const atCheck = x => !x.gone && !x.suggested_by && heldOf(x).length > 0 && (x.done ? !!x.recheck : !!shippedOf(x));

/** The mark among the row's marks: how many are held, or that an agent
 *  suggested some. Nothing on a line with none: the gate offers the first. */
function checkMark(x, esc) {
  if (x.done || atCheck(x)) return "";
  const held = heldOf(x).length, sug = checksOf(x).filter(c => c.suggested_by && !c.gone).length;
  if (!held && !sug) return "";
  const w = held ? ctx.plural(held, "check") : `${sug} suggested`;
  const sub = `${sug ? `${ctx.plural(sug, "check")} suggested, waiting for Keep · ` : ""}the builder sees only how many`;
  return `<button type="button" class="dk-held${sug ? " sug" : ""}" data-a="check-open" data-n="${x.id}" aria-expanded="${checksOpen === x.id}" data-tip="${held ? `${esc(w)} you hold` : "Checks suggested"}" data-tip-sub="${esc(sub)}" aria-label="${esc(w)} on ${esc(x.text)}">${ICO_CHK}${esc(w)}</button>`;
}
const ICO_CHK = `<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 4.5h10M3 8h6M3 11.5h4"/><path d="m10 11 1.6 1.6L14.5 9.5"/></svg>`;

/** One check's row in the card, or its Undo while it is just off. */
function checkLine(x, c, esc) {
  if (c.gone) return `<span class="dk-check gone" role="status"><span class="t">${esc(c.text)}</span><button type="button" class="dk-undo" data-a="check-back" data-n="${x.id}" data-c="${c.id}">Undo</button></span>`;
  const x_ = `<button type="button" class="dk-check-x" data-a="check-x" data-n="${x.id}" data-c="${c.id}" data-tip="${c.suggested_by ? "Not this one" : "Remove it"}" data-tip-sub="nothing is deleted" aria-label="Remove: ${esc(c.text)}">${ico("x")}</button>`;
  if (c.suggested_by) return `<span class="dk-check sug"><span class="t" data-tip="${esc(c.text)}" data-tip-sub="suggested by ${esc(c.suggested_by)} · Keep holds it">${esc(c.text)}</span><button type="button" class="dk-keep" data-a="check-keep" data-n="${x.id}" data-c="${c.id}" aria-label="Keep: ${esc(c.text)}">Keep</button>${x_}</span>`;
  return `<span class="dk-check"><span class="t" data-tip="${esc(c.text)}" data-tip-overflow>${esc(c.text)}</span>${x_}</span>`;
}

/** The card while the work is not out: what the reader will try, kept from
 *  the builder. Over the rows below, as the gate is. */
function checksPop(x, esc) {
  if (checksOpen !== x.id || atCheck(x) || x.gone) return "";
  const all = checksOf(x), held = heldOf(x).length;
  const sug = all.filter(c => c.suggested_by && !c.gone), by = sug[0]?.suggested_by;
  const box = held < CHECKS_MAX
    ? `<input class="dk-check-in" data-n="${x.id}" maxlength="${CHECK_CHARS}" placeholder="What will you try? Enter holds it" aria-label="A check you will try on ${esc(x.text)}" spellcheck="false">`
    : `<span class="dk-checks-f">a line holds ${CHECKS_MAX}</span>`;
  const foot = `${sug.length ? `${esc(/^claude/i.test(by) ? "Claude" : by)} suggested ${sug.length} · ` : ""}the builder sees only the count`;
  return `<span class="dk-checks pop" role="group" aria-label="Checks you hold on ${esc(x.text)}">` +
    `<span class="dk-checks-h">What you'll try</span>` +
    all.map(c => checkLine(x, c, esc)).join("") + box +
    `<span class="dk-checks-f">${foot}</span></span>` + errLine(`k${x.id}`, esc);
}

/** At check-it, in the row: each line with ✓ and ✗, and the row's answer
 *  under them -- works once every line is ✓, not yet… at any time. */
function checksRow(x, esc) {
  if (!atCheck(x)) return "";
  const held = heldOf(x), ok = held.every(c => c.result === "ok");
  const lines = held.map(c => {
    const on = r => c.result === r ? " on" : "";
    return `<span class="dk-check run${c.result ? ` ${c.result}` : ""}"><span class="t" data-tip="${esc(c.text)}" data-tip-overflow>${esc(c.text)}</span><span class="yn">` +
      `<button type="button" class="y${on("ok")}" data-a="check-ok" data-n="${x.id}" data-c="${c.id}" aria-pressed="${c.result === "ok"}" aria-label="It does: ${esc(c.text)}">✓</button>` +
      `<button type="button" class="n${on("fail")}" data-a="check-fail" data-n="${x.id}" data-c="${c.id}" aria-pressed="${c.result === "fail"}" aria-label="It does not: ${esc(c.text)}">✗</button></span></span>`;
  }).join("");
  const works = x.done ? "" : ok
    ? `<button type="button" class="dk-chk ok" data-a="note-works" data-n="${x.id}" data-tip="Every check passed" data-tip-sub="ticks it as yours" aria-label="It works: ${esc(x.text)}">✓ works</button>`
    : `<span class="dk-chk dim" data-tip="Works" data-tip-sub="when every line is ✓">works · when every line is ✓</span>`;
  const not = `<button type="button" class="dk-chk" data-a="note-broken" data-n="${x.id}" data-tip="Not yet" data-tip-sub="say what is still wrong; it reopens, and the next agent's brief leads with it" aria-label="Still broken: ${esc(x.text)}">not yet…</button>`;
  return `<span class="dk-checks inrow" role="group" aria-label="Your checks on ${esc(x.text)}">${lines}<span class="dk-checks-f">${works}${not}</span></span>` + errLine(`k${x.id}`, esc);
}

/** The card's box, put back after a redraw with what was typed in it. */
function checksFocus() {
  const inp = ctx.tocEl.querySelector(".dk-check-in");
  if (!inp) { checkFocused = false; return; }
  inp.value = checkDraft;
  inp.addEventListener("input", () => { checkDraft = inp.value; });
  inp.addEventListener("focus", () => { checkFocused = true; });
  inp.addEventListener("blur", () => { checkFocused = false; });
  inp.addEventListener("keydown", e => {
    // The desk gives every other key to the shell in the focused panel.
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); addCheck(+inp.dataset.n, inp.value); }
    else if (e.key === "Escape") { e.preventDefault(); checksOpen = 0; checkDraft = ""; rail(); }
  });
  if (checkFocused) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
}

async function addCheck(n, text) {
  const d = current(), t = text.replace(/\s+/g, " ").trim();
  if (!d || !t) return;
  checkDraft = ""; checkFocused = true;
  const list = noteChecks.get(n) || [], tmp = { id: -Date.now(), note: n, text: t.slice(0, CHECK_CHARS) };
  noteChecks.set(n, [...list.filter(c => !c.suggested_by), tmp, ...list.filter(c => c.suggested_by)]);
  rail();
  if (await told({ a: "check-open", n: String(n) }, `k${n}`, "Could not hold it", () => { noteChecks.set(n, (noteChecks.get(n) || []).filter(c => c !== tmp)); checkDraft = t; },
    () => ctx.api(`/api/desks/${d.id}/notes/${n}/checks`, { text: t }))) await getNotes(d.id, true);
}

/** The card's and the list's buttons. Any other press closes the card and
 *  goes on to what it was. */
async function checksAct(a, b, d) {
  if (!a?.startsWith("check-")) { if (a !== "note-broken") checksOpen = 0; return false; }
  const n = +b.dataset.n, x = noteList.find(y => y.id === n), c = checksOf({ id: n }).find(y => y.id === +b.dataset.c);
  const at = `/api/desks/${d.id}/notes/${n}/checks`;
  if (a === "check-open") {
    checksOpen = checksOpen === n ? 0 : n; gateOpen = 0; checkDraft = ""; checkFocused = !!checksOpen;
    rail();
    return true;
  }
  if (!x || !c) return true;
  if (a === "check-ok" || a === "check-fail") {
    const want = a === "check-ok" ? "ok" : "fail", was = c.result || "", to = was === want && want === "ok" ? "clear" : want;
    c.result = to === "clear" ? "" : to;
    // A ✗ is the row's not yet…, with the line it failed already said.
    if (to === "fail") { noteField = { kind: "broken", id: n }; noteDraft = `✗ ${c.text}: `; noteCaret = noteDraft.length; }
    rail();
    await told(b.dataset, `k${n}`, "Could not mark it", () => { c.result = was; }, () => ctx.api(`${at}/${c.id}`, { result: to }));
    return true;
  }
  if (a === "check-keep") {
    const by = c.suggested_by;
    c.suggested_by = "";
    rail();
    if (await told(b.dataset, `k${n}`, "Could not keep it", () => { c.suggested_by = by; }, () => ctx.api(`${at}/${c.id}/keep`, {}))) await getNotes(d.id, true);
    return true;
  }
  if (a === "check-x") {
    clearTimeout(checkTimer);
    const list = noteChecks.get(n) || [];
    checkGone = { note: n, c, i: list.indexOf(c) };
    c.gone = true;
    checkTimer = setTimeout(() => { if (checkGone?.c === c) { checkGone = null; noteChecks.set(n, (noteChecks.get(n) || []).filter(y => y !== c)); if (current()) rail(); } }, BACK_MS);
    rail();
    await told(b.dataset, `k${n}`, "Could not take it off", () => { delete c.gone; checkGone = null; }, () => ctx.api(`${at}/${c.id}/remove`, {}));
    return true;
  }
  if (a === "check-back") {
    clearTimeout(checkTimer);
    checkGone = null; delete c.gone;
    rail();
    if (await told(b.dataset, `k${n}`, "Could not put it back", () => { c.gone = true; }, () => ctx.api(`${at}/${c.id}/restore`, {}))) await getNotes(d.id, true);
    return true;
  }
  return true;
}

const CHECKS_CSS = `
/* The mark: quiet, as the row's other marks are; an agent's suggestions
   waiting are the accent, since they ask for Keep. */
.dk-meta .dk-marks > .dk-held { cursor: pointer; }
.dk-meta .dk-marks > .dk-held.sug { color: var(--accent); }
.dk-meta .dk-marks > .dk-held svg { width: 11px; height: 11px; }
/* The card, where the gate opens and over the rows below it. */
.dk-note > .dk-checks.pop { position: absolute; z-index: var(--z-pop, 30); top: calc(100% - 2px); left: 27px; right: 8px; display: grid; gap: 3px; padding: 8px 10px; border-radius: var(--r-sm); background: var(--bg-raise); box-shadow: var(--shadow-2, var(--shadow)); font-size: var(--fs-micro); color: var(--fg-2); }
.dk-checks-h { color: var(--fg); font-weight: 600; margin-bottom: 2px; }
.dk-checks-f { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; color: var(--fg-3); }
.dk-check { display: flex; align-items: flex-start; gap: 6px; min-height: 20px; min-width: 0; }
/* Two lines at most: the rail is narrow, and a check cut at twenty letters
   cannot be run from memory. The whole of it is the tip. */
.dk-check > .t { flex: 1 1 auto; min-width: 0; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; overflow-wrap: anywhere; line-height: 15px; color: var(--fg); }
.dk-check.sug > .t { color: var(--fg-3); font-style: italic; }
.dk-check.gone > .t { color: var(--fg-3); text-decoration: line-through; }
.dk-check-x { display: grid; place-items: center; flex: none; width: 18px; height: 18px; padding: 0; border: 0; border-radius: var(--r-xs); background: none; color: var(--fg-3); cursor: pointer; opacity: 0; }
.dk-check:is(:hover, :focus-within) > .dk-check-x, .dk-check.sug > .dk-check-x { opacity: 1; }
.dk-check-x:hover { background: var(--rule-2); color: var(--fg); }
.dk-check-in { box-sizing: border-box; width: 100%; height: 24px; margin-top: 2px; padding: 0 8px; border: 1px solid var(--rule-2); border-radius: var(--r-xs); background: var(--bg); font: inherit; color: var(--fg); }
.dk-check-in:focus { outline: none; border-color: var(--accent); }
/* At check-it, in the row: it grows once, under the marks, like a reply. */
.dk-checks.inrow { flex: 1 0 100%; box-sizing: border-box; display: grid; gap: 1px; padding: 2px 8px 4px 28px; font-size: var(--fs-micro); }
.dk-check.run > .t { color: var(--fg-2); }
.dk-check.run.ok > .t { color: var(--fg); }
.dk-check.run.fail > .t { color: var(--warn); }
.dk-check .yn { display: flex; gap: 2px; flex: none; margin-top: -1px; }
.dk-check .yn > button { width: 20px; height: 18px; padding: 0; border: 1px solid var(--rule-2); border-radius: var(--r-xs); background: none; font: inherit; line-height: 16px; color: var(--fg-3); cursor: pointer; }
.dk-check .yn > button:hover { color: var(--fg); border-color: var(--fg-3); }
.dk-check .yn > .y.on { color: var(--ok); border-color: var(--ok); font-weight: 600; }
.dk-check .yn > .n.on { color: var(--warn); border-color: var(--warn); font-weight: 600; }
.dk-checks.inrow .dk-checks-f { margin-top: 2px; }
.dk-checks .dk-chk { padding: 0; border: 0; background: none; font: inherit; color: var(--fg-2); cursor: pointer; }
.dk-checks .dk-chk:hover { text-decoration: underline; }
.dk-checks .dk-chk.ok { color: var(--accent); font-weight: 600; }
.dk-checks .dk-chk.dim { color: var(--fg-3); cursor: default; text-decoration: none; }
`;
