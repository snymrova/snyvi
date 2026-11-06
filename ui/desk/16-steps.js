/* ui/desk/16-steps.js: a part of desk.js, one module. build.rs joins ui/desk/*.js in name
 * order (src/strip.rs `source`); SNYVI_UI_DIR serves the same join. */
// ---------- a run in steps (#164) ----------
/*
 * An agent that needs the reader to run a setup -- install a tool, plug in
 * a phone, check it is seen, pull a file -- used to write the commands into
 * its reply, for the reader to copy one by one. With hand_over's steps it
 * puts them on On you as one card instead: each command shown whole, and
 * each thing done by hand ticked with Done.
 *
 * A command runs in one of two places. Run types it into the agent's own
 * prompt as a `!` command, so its output goes back to the agent, which can
 * say what to do if it went wrong. But a `!` command has no terminal to ask
 * in, and `sudo` stops there; In a shell opens a shell panel for the walk
 * (#164's "small terminal"), types the step into it and puts the keys
 * there, so a password is asked and answered where the command runs. Once
 * the walk has its shell, each later step runs in it too.
 *
 * Only the step whose turn it is can be pressed: one click, one line, the
 * one shown. Running a step does not finish it -- it may have failed, or be
 * waiting on a password -- so it stays lit, with Again, until the reader
 * says Done; nothing runs because another finished. A step's text is typed
 * only as Run types a single command, refused at the door if it held a
 * control character (thread.rs `steps`), and into a shell only at its
 * prompt. When every step is done the card answers itself, saying which ran
 * where and which were done by hand, ready for Send now. What is done is
 * kept in this browser by the turn's id, so a reload does not start the
 * walk again; Not now forgets it.
 */

const STEPS_KEY = "snyvi.steps";
/** By turn id: the steps done; of those run, the ones in the agent's prompt
 *  and the ones in the walk's shell; and that shell's panel. */
const stepsState = (() => {
  try { return new Map(Object.entries(JSON.parse(localStorage.getItem(STEPS_KEY) || "{}")).map(([k, v]) => [+k, { done: new Set(v.d), ran: new Set(v.r), sh: new Set(v.s || []), shell: v.p || null }])); }
  catch { return new Map(); }
})();

function stepsKeep() {
  try { localStorage.setItem(STEPS_KEY, JSON.stringify(Object.fromEntries([...stepsState].map(([k, v]) => [k, { d: [...v.done], r: [...v.ran], s: [...v.sh], p: v.shell }])))); }
  catch { /* kept for this window only */ }
}

const stepsAt = id => stepsState.get(id) || stepsState.set(id, { done: new Set(), ran: new Set(), sh: new Set(), shell: null }).get(id);

/** Not now on a walk: what was done goes with it. */
function stepsForget(id) { if (stepsState.delete(id)) stepsKeep(); }

/** Turn `w`'s steps as its options keep them: `$ cmd` a command, `# words`
 *  the line over the command after it, the rest a step done by hand. */
function stepsOf(w) {
  const out = [];
  let say = "";
  for (const o of w.options || []) {
    if (o.startsWith("# ")) { say = o.slice(2); continue; }
    out.push(o.startsWith("$ ") ? { cmd: o.slice(2), say } : { say: o });
    say = "";
  }
  return out;
}

const stepsNext = w => { const done = stepsAt(w.id).done; return stepsOf(w).findIndex((s, i) => !done.has(i)); };

/** The walk's shell, while its panel is on the desk and running. */
const stepsShell = st => { const v = st.shell && views.get(st.shell); return v && v.status.running ? v : null; };

/** The card: the steps in order, the one whose turn it is lit. A command
 *  there has Run when the agent's panel has a Claude, In a shell (or Run in
 *  the walk's shell once it has one), Copy and Done; once run, Again. */
function stepsRow(d, w, n, from, esc) {
  const steps = stepsOf(w), st = stepsAt(w.id), next = stepsNext(w), here = runsHere(views.get(w.pane));
  const sv = stepsShell(st), m = sv && slotOf(d, sv.id);
  const btn = (a, i, label, tip, sub, quiet, to = "") => `<button type="button" class="tn-opt${quiet ? " quiet" : ""}" data-a="${a}" data-w="${w.id}" data-i="${i}"${to ? ` data-to="${to}"` : ""} data-tip="${tip}" data-tip-sub="${sub}">${label}</button>`;
  const runs = (s, i) => {
    const ran = st.ran.has(i) || st.sh.has(i);
    const inShell = sv ? btn("tn-step-run", i, ran ? "Again" : `Run in panel ${m}`, `Run it in panel ${m}`, "The walk's shell: a password is asked there. The agent does not see the output", ran, "shell")
      : btn("tn-step-run", i, "In a shell", "Run it in a shell", "A panel of its own for the walk, where a password can be asked. The agent does not see the output", here || ran, "shell");
    const inClaude = !sv && here ? btn("tn-step-run", i, ran ? "Again" : "Run", `Run it in panel ${n}`, "Typed into its prompt as a ! command. Its output goes to the agent", ran, "claude") : "";
    return inClaude + inShell +
      `<button type="button" class="tn-opt quiet" data-a="tn-copy" data-w="${w.id}" data-c="${esc(s.cmd)}">Copy</button>` +
      btn("tn-step-done", i, "Done", "Done", ran ? "It worked: on to the next" : "You ran it yourself", !ran);
  };
  const rows = steps.map((s, i) => {
    const ok = st.done.has(i), on = i === next;
    const act = ok ? `<span class="tn-step-ok">done</span>`
      : !on ? ""
      : s.cmd ? runs(s, i)
      : btn("tn-step-done", i, "Done", "Done", "You did this one by hand", false);
    return `<li class="tn-step${ok ? " ok" : on ? " on" : ""}"><span class="tn-step-n">${i + 1}</span>` +
      `<div class="tn-step-b">${s.say ? `<span class="tn-step-say">${esc(s.say)}</span>` : ""}${s.cmd ? `<code class="sg-cmd tn-cmd">${esc(s.cmd)}</code>` : ""}</div>` +
      `<span class="tn-step-a">${act}</span></li>`;
  }).join("");
  return `<li class="dk-turn tn-walk" data-w="${w.id}">${qHtml(w, esc)}<ol class="tn-steps">${rows}</ol>` +
    byHtml(w, d, esc, ` · ${st.done.size} of ${steps.length} done${sv ? ` · its shell is panel ${m}` : ""}`) +
    `<div class="tn-acts"><button type="button" class="tn-x" data-a="tn-x" data-w="${w.id}" data-tip="Not now" data-tip-sub="nothing is deleted" aria-label="Not now: ${esc(w.text)}">${ico("x")}</button></div>` +
    `</li>` + errLine(`w${w.id}`, esc);
}

/** Why a step was not typed, in the agent's panel row, for a moment. */
function stepSay(pane, text) {
  clearTimeout(rowTimer);
  rowSaid = { p: pane, text };
  rowTimer = setTimeout(() => { rowSaid = null; if (current()) rail(); }, 5000);
  rail();
}

/** Run, on step `i`: only the step whose turn it is, typed as Run types a
 *  single command -- into the agent's Claude, or `to` the walk's shell. It
 *  stays the step whose turn it is until Done. */
async function stepRun(d, w, i, to) {
  const s = stepsOf(w)[i], st = stepsAt(w.id);
  if (!s || !s.cmd || i !== stepsNext(w)) return;
  if (to === "shell") return stepShell(d, w, i, s.cmd);
  const v = views.get(w.pane);
  if (!runsHere(v)) return stepSay(w.pane, `Panel ${slotOf(d, w.pane) || "?"} has no Claude to run it in. In a shell runs it in a panel of its own.`);
  input(v, bracket(v, `! ${s.cmd}`));
  setTimeout(() => input(v, "\r"), 120);
  st.ran.add(i);
  stepsKeep();
  rail();
}

/** In a shell: the walk's shell panel, opened on the first such click as
 *  Open panel opens one, and the step typed there once it is at its prompt
 *  -- never into a command still running, or a password being asked. The
 *  keys go to it, for that password. */
async function stepShell(d, w, i, cmd) {
  const st = stepsAt(w.id);
  let v = stepsShell(st);
  if (!v) {
    const why = noNew(d);
    if (why) return ctx.toast("New panel", why);
    let p;
    try { p = await ctx.api(`/api/desks/${d.id}/panes`, d.grp ? { grp: d.grp } : {}); }
    catch (e) { rowErr = { k: `w${w.id}`, why: "Could not open a panel", raw: e.message, again: { a: "tn-step-run", w: String(w.id), i: String(i), to: "shell" } }; rail(); return; }
    st.shell = p.pane.id;
    stepsKeep();
    focused = p.pane.id;
    await ctx.refresh();
    v = views.get(p.pane.id);
    if (!v) return;
    await run(v, "");
    // A shell draws its prompt a moment after it starts; the step waits for
    // it, a few seconds at most.
    for (let k = 0; k < 40 && !(v.mode && v.mode[1]); k++) await new Promise(r => setTimeout(r, 100));
  }
  const m = slotOf(d, v.id) || "?";
  const why = !v.mode[1] ? `Panel ${m}'s shell isn't at its prompt, so nothing was typed. Run it again when it is.`
    : Date.now() - (v.typed || 0) < TYPED_MS ? `You are typing in panel ${m}.` : "";
  if (why) return stepSay(w.pane, why);
  input(v, bracket(v, cmd));
  setTimeout(() => input(v, "\r"), 120);
  st.sh.add(i);
  stepsKeep();
  focusPane(v.id);
  rail();
}

/** Step `i` done. The last one answers the card: which ran where, which were
 *  done by hand, so the agent knows what it can take as done -- and, as any
 *  answer, it waits for Send now or the reader's next message. */
async function stepDone(d, w, i) {
  // The last Done again, when its answer did not reach the daemon, is the
  // one way past the end: it answers again.
  const next = stepsNext(w);
  if (w.answered_at || (i !== next && next !== -1)) return;
  const st = stepsAt(w.id), steps = stepsOf(w);
  st.done.add(i);
  stepsKeep();
  if (st.done.size < steps.length) { rail(); return; }
  const n = slotOf(d, w.pane), m = st.shell && slotOf(d, st.shell), list = ks => ks.sort((a, b) => a - b).map(k => k + 1).join(", ");
  const ranIn = (ks, where) => ks.length ? `ran step${ks.length === 1 ? "" : "s"} ${list(ks)} ${where}` : "";
  const hand = steps.map((_, k) => k).filter(k => !st.ran.has(k) && !st.sh.has(k));
  const said = [ranIn([...st.ran], `in panel ${n}`), ranIn([...st.sh].filter(k => !st.ran.has(k)), `in a shell, panel ${m || "closed since"}; its output is there, not here`),
    hand.length ? `did ${list(hand)} myself` : ""].filter(Boolean).join("; ");
  await answer(d, w, `All ${steps.length} steps done: ${said}`, { a: "tn-step-done", w: String(w.id), i: String(i) });
  if (w.answered_at) stepsForget(w.id);
}

const STEPS_CSS = `
.tn-steps { list-style: none; margin: 6px 0 4px; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.tn-step { display: grid; grid-template-columns: 16px minmax(0, 1fr) auto; gap: 8px; align-items: start; padding: 4px 6px; border-radius: var(--r-sm); }
.tn-step.on { background: var(--accent-bg); }
.tn-step.ok { opacity: .6; }
.tn-step-n { font-family: var(--mono); font-size: var(--fs-micro); line-height: 22px; color: var(--fg-3); text-align: right; font-variant-numeric: tabular-nums; }
.tn-step.ok .tn-step-n { color: var(--ok); }
.tn-step-b { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.tn-step-say { font-size: var(--fs-small); line-height: 22px; color: var(--fg-2); }
.tn-step .tn-cmd { margin: 0; }
.tn-step-a { display: flex; gap: 4px; align-items: center; min-height: 22px; }
/* The step whose turn it is has its buttons on a line of their own, under
 * its words: beside them, in the corner's narrow tray, they left the command
 * no width at all. */
.tn-step.on .tn-step-a { grid-column: 2 / -1; flex-wrap: wrap; }
.tn-step-ok { font-size: var(--fs-micro); color: var(--ok); }
`;
