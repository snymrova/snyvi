/* ui/desk/20-first.js: a part of desk.js, one module. build.rs joins ui/desk/*.js in name
 * order (src/strip.rs `source`); SNYVI_UI_DIR serves the same join. */
// ---------- a first desk's three steps (#191) ----------
/*
 * A maker's first desk rings its three moments in turn -- Connect, Ask
 * Claude, read Claude's page and answer -- with a card that says which of
 * three it is and Skip. Only the first desk: by a second one the loop is
 * known, and a ring there would be noise. What it rings and when it is done
 * are ui/guide.js's, a chunk of its own, fetched with the first desk opened;
 * it asks the daemon whether the steps are done or skipped (`/api/guide`)
 * before it draws anything.
 */
let guideMod = null;

function firstSteps() {
  firstStop();
  quietOpen();
  const ds = ctx.desks && ctx.desks.desks;
  const first = ds && ds.length === 1 && deskId != null;
  // The dots on new controls start here too (#191): an update's controls
  // are a desk's, mostly, and first paint pays nothing for them. `dots`
  // asks once and is quiet with no fresh What's new page.
  if (guideMod && !first) return;
  let v = "";
  try { v = JSON.parse(document.getElementById("boot").textContent || "{}").v || ""; } catch { /* unversioned */ }
  import(`/assets/guide.js${v ? `?v=${v}` : ""}`).then(m => {
    guideMod = m;
    m.dots();
    // Not on the quiet first desk (1.70): its strip and its stage card say
    // the same three moments where they happen, so a ring there says it twice.
    if (first && deskId != null && !isQuiet(current())) m.steps({ api: ctx.api, say: (t, sub) => ctx.toast(t, sub) });
  }).catch(() => {});
}

function firstStop() { if (guideMod) guideMod.stop(); }

/** Home's Carry on (1.70, ui/home.js): the desk was opened by its link, and
 *  the panel it names gets its last conversation back -- the rail's own
 *  Resume conversation, pressed for the reader, whose press Carry on was.
 *  A panel with nothing to resume is only opened. */
function carryOn() {
  const id = qGet(sessionStorage, "snyvi.carry");
  if (!id) return;
  qSet(sessionStorage, "snyvi.carry", null);
  setTimeout(() => {
    const v = views.get(id);
    if (!v || v.status.agent_in) return;
    const why = resumeHere(v, true);
    if (why) ctx.toast("Could not carry on by itself", why);
  }, 600);
}

// ---------- the quiet first desk (1.70, plan 980648bb8b) ----------
/*
 * A maker's first desk, made from Welcome, shows three things: the panel,
 * the goal they typed, and where the first page lands. No sidebar, no view
 * switcher, no Notes or Routines: each of those is for a second loop, and
 * the first has not closed yet. The rail keeps its whole width, so what
 * arrives later fills room already held and nothing moves.
 *
 * Which desk is quiet is this window's to know (`snyvi.quiet`, the desk's
 * id, set by Welcome): a preference about a page, not a thing in the
 * library. It ends by itself on the first visit after a page has landed --
 * decided when the desk opens, before anything is drawn, so the full desk
 * is never swapped in under the reader -- or at once with a second desk,
 * or with Show everything.
 */
const QUIET = "snyvi.quiet", QUIET_GOT = "snyvi.quiet.got", QUIET_HERE = "snyvi.quiet.here";
const qGet = (st, k) => { try { return st.getItem(k); } catch { return null; } };
const qSet = (st, k, v) => { try { v == null ? st.removeItem(k) : st.setItem(k, v); } catch { /* private mode: every desk is the full one */ } };

/** Whether `d` is the first desk, still quiet. */
const isQuiet = d => !!d && +qGet(localStorage, QUIET) === d.id && ctx.desks.desks.length === 1;

/** The desk opens: a visit after the one a page landed in is the full desk's. */
function quietOpen() {
  const id = +qGet(localStorage, QUIET);
  if (id && qGet(sessionStorage, QUIET_HERE) !== `${id}`) {
    if (qGet(localStorage, QUIET_GOT)) quietEnd(false);
    else qSet(sessionStorage, QUIET_HERE, `${id}`);
  }
  quietMark();
}
/** The page's own mark, which the CSS reads: the sidebar and the head's
 *  controls are out of sight while it is set. */
function quietMark() {
  const on = !!ctx && isQuiet(current());
  if (on) ctx.root.dataset.quiet = "1"; else if (ctx) delete ctx.root.dataset.quiet;
  return on;
}
/** A page landed on the quiet desk: the next visit is the full one. */
const quietGot = () => qSet(localStorage, QUIET_GOT, "1");
const quietHasPage = () => !!qGet(localStorage, QUIET_GOT);
function quietEnd(draw = true) {
  qSet(localStorage, QUIET, null); qSet(localStorage, QUIET_GOT, null); qSet(sessionStorage, QUIET_HERE, null);
  if (!draw) return;
  quietMark();
  for (const v of views.values()) { const st = v.el.querySelector(".pn-connect"); if (st) { st.hidden = true; st.onclick = null; ready(v, false); } claudeStrip(v, !!v.pane.held); }
  rail();
  firstSteps();
}

/** The quiet rail's own button. True when the click was it. */
function firstAct(a) { if (a !== "quiet-end") return false; quietEnd(); return true; }
/** The rail asks whether it is the quiet one: the page is marked, a page
 *  that landed is remembered for the next visit, and the goal is read --
 *  it comes with the notes, which a rail with no Notes section never asks for. */
function quietRail(d, pages) {
  const quiet = quietMark();
  if (quiet && pages) quietGot();
  if (quiet && notesAt !== d.id && notesOff !== d.id) getNotes(d.id);
  return quiet;
}
/** The quiet rail, whole: the goal, where the page lands, Notes once one
 *  has, and the foot. */
const quietBody = (d, docs) => lineSec(d, true) + docs + (quietHasPage() ? quietNotes(d) : "") + quietFoot();
/** The foot of the quiet rail: what else lives here, and the way to it now. */
const quietFoot = () => `<p class="dk-q-foot">Notes, routines and reminders show up here when there is something for them to hold. ` +
  `<button type="button" class="dk-link" data-a="quiet-end" data-tip="The whole desk" data-tip-sub="the sidebar, the views and every section, now">Show everything</button></p>`;

/* The stage card (plan part 4): where the first page will land, what is
 * happening meanwhile, in a box of one size whatever it says. snyvi is told
 * when Claude takes the prompt and when the page arrives; it is not told
 * what Claude reads on the way, so no stage claims that. */
let stageClock = 0;
const mmss = ms => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
function stageCard(d, vs, since) {
  const working = vs.some(v => paneSt(v) === "working"), done = vs.some(v => paneSt(v) === "done");
  const st = (k, text) => `<li class="dk-st ${k}"><b aria-hidden="true">${k === "ok" ? "✓" : k === "now" ? "●" : "○"}</b><span>${text}</span></li>`;
  clearInterval(stageClock);
  stageClock = setInterval(() => {
    const el = ctx.tocEl.querySelector(".dk-st-t");
    if (!el) return void clearInterval(stageClock);
    el.textContent = mmss(Date.now() - since);
  }, 1000);
  const took = working || done;
  return `<div class="dk-wait dk-firstpage"><ol class="dk-sts" aria-label="Your first page">` +
    st(took ? "ok" : "now", took ? `${agentName()} has your question` : `Starting ${agentName()}`) +
    st(working ? "now" : done ? "ok" : "no", `Working on your first page${working ? ` · <span class="dk-st-t fact">${mmss(Date.now() - since)}</span>` : ""}`) +
    st(done ? "now" : "no", done ? `${agentName()} stopped without a page. Ask it in the panel to send one to snyvi` : "It lands here") + `</ol>` +
    `<p class="dk-empty">Usually under two minutes. You can leave this window; the page waits for you.</p></div>`;
}

/* Notes arrives (plan part 6): once the first page is in, the quiet rail
 * grows by the one section a second loop needs, with a line from snyvi over
 * it. The line is this visit's: the next one has the whole desk. */
const quietNotes = d => `<p class="dk-q-say"><span class="dk-q-face" aria-hidden="true">${ctx.mascot ? ctx.mascot("rest") : ""}</span>Something else on your mind for this project? Leave it as a note. ${agentName()} plans it, you say yes.</p>` + noteSec(d);

/* ---------- the first panel's strip (plan part 3; board screens 2a, 7, 8b) ----------
 *
 * One strip, one red button, whatever is in the way of the first page:
 *
 *   no agent here      Install Claude Code here   -- Claude's own installer,
 *                                                    typed into this panel
 *   here, not connected   Connect                 -- snyvi's init, as ever
 *   connected          Ask Claude to begin        -- the fixed question
 *
 * and the same three for Codex when it alone is on the machine. The install
 * line is fixed text of snyvi's own, one per system, as Claude's setup page
 * gives them (code.claude.com/docs/en/setup); it is typed on the reader's
 * press and nothing an agent or a document said is ever near it. snyvi does
 * not know whether Claude Code is signed in: Claude asks that itself, in the
 * panel, the first time it runs.
 */
const INSTALL_SH = "curl -fsSL https://claude.ai/install.sh | bash";
const INSTALL_PS = "irm https://claude.ai/install.ps1 | iex";
const INSTALL_CMD = "curl -fsSL https://claude.ai/install.cmd -o install.cmd && install.cmd && del install.cmd";
const QUIET_ASKED = "snyvi.quiet.asked", QUIET_INST = "snyvi.quiet.inst";
let instClock = 0, instShown = false, stripSaid = "", quietBare = 0;

const codexState = a => { const r = a && a.codex_on_path && a.rows.find(x => x.id === "codex"); return !r ? "" : r.state === "connected" ? "connected" : "unconnected"; };
/** Which agent the first desk speaks to: Claude when it is here or nothing
 *  is, Codex when it alone is on the machine. */
const quietCodex = () => claudeIs === "missing" && !!codexState(agentsNow) && !qGet(sessionStorage, QUIET_INST);
const agentName = () => quietCodex() ? "Codex" : "Claude";
const quietAsked = d => qGet(sessionStorage, QUIET_ASKED) === `${d.id}`;
/** The installer's line for this panel's shell. */
const installLine = v => !agentsNow || agentsNow.os !== "windows" ? INSTALL_SH : /pwsh|powershell/i.test(v.status.cmd || v.pane.cmd || "") ? INSTALL_PS : INSTALL_CMD;

/** A line put at the panel's prompt and entered, on the reader's press: the
 *  panel is started with it when nothing runs there. Why not, when it did not go. */
function quietType(v, line, once = true) {
  if (!v.status.running) { run(v, line, false, false, once); return ""; }
  if (!(v.mode && v.mode[1])) return `Panel ${v.pane.slot} isn't at its prompt, so nothing was typed. Try again in a moment.`;
  input(v, bracket(v, line));
  setTimeout(() => input(v, "\r"), 120);
  focusPane(v.id);
  return "";
}

/** Draws the strip for the quiet desk's first panel; false when this panel
 *  is not that one, and the everyday strip is drawn. */
function quietStrip(v, strip) {
  const d = current();
  if (!isQuiet(d) || !d.panes[0] || d.panes[0].id !== v.id) return false;
  claudeNow();
  if (claudeIs == null) return true;
  const { esc } = ctx, a = agentsNow, codex = quietCodex(), who = codex ? "Codex" : "Claude";
  const state = codex ? codexState(a) : claudeIs, inst = !!qGet(sessionStorage, QUIET_INST);
  const name = esc(v.pane.cwd.split(/[\\/]/).filter(Boolean).pop() || "this");
  const said = stripSaid ? `<p class="pn-fine" role="status">${esc(stripSaid)}</p>` : "";
  const n = k => inst ? `<p class="pn-n"><b>${k}</b> of 3</p>` : "";
  const show = html => { strip.innerHTML = html; strip.hidden = false; ready(v, true); };
  const focus = () => requestAnimationFrame(() => requestAnimationFrame(() => { if (!strip.hidden && !v.el.contains(document.activeElement)) strip.querySelector(".w-btn")?.focus(); }));
  // Begun, or an agent already at work here: the panel is the reader's.
  if (quietAsked(d) || quietBare === d.id || v.status.agent_in || paneSt(v)) { strip.hidden = true; ready(v, false); clearInterval(instClock); return true; }
  if (state === "missing" && instClock) {
    strip.innerHTML = `<p class="pn-n"><b>1</b> of 3</p><p class="pn-ready">Installing Claude Code in this panel.</p><p>The installer shows no progress while it downloads. This strip moves on when Claude Code is here.</p>` +
      `<p><button type="button" class="text" data-q="wait-no">Stop waiting</button></p>`;
    strip.hidden = false; ready(v, false);
  } else if (state === "missing") {
    const line = installLine(v);
    show(`<p class="pn-n"><b>1</b> of 3 · about three minutes in all</p><p class="pn-ready">First, this desk needs an agent.</p>` +
      `<p>An agent is a program that reads your folder and does the work with you. snyvi can put Claude Code on this machine now, and you will see it happen in this panel.</p>` +
      `<div class="w-connect"><button type="button" class="w-btn" data-q="install">Install Claude Code here</button><button type="button" class="text" data-q="line" aria-expanded="${instShown}">Show me what it runs</button></div>` +
      (instShown ? `<p class="pn-line"><code>${esc(line)}</code></p><p class="pn-fine">Claude's own installer, from its setup page. snyvi types this line into the panel and nothing else.</p>` : "") + said +
      `<p class="pn-fine">Needs a Claude account. <a href="/connect" data-nav="connect">I use a different agent</a> · <button type="button" class="text" data-q="self">I'll do it myself ↗</button></p>`);
    focus();
  } else if (state === "unconnected") {
    const file = codex ? esc((a.rows.find(x => x.id === "codex") || {}).file || "its settings") : "";
    show(n(2) + `<p class="pn-ready">${who}${codex ? "" : " Code"} is here. Let it send its pages to snyvi.</p>` +
      (codex ? `<p>snyvi adds itself to Codex on this machine: its server in <code>${file}</code>, and its hooks. Codex asks you to look at the hooks once.</p>` +
        `<div class="w-connect"><button type="button" class="w-btn" data-q="codex">Connect Codex</button></div>`
        : `<div class="w-connect"><button type="button" class="w-btn" data-q="connect">Connect</button></div>`) + said);
    focus();
  } else {
    show(n(3) + `<p class="pn-ready">${who} is ready, in ${name}'s folder.</p>` +
      `<p>It reads ${lineOf(d).goal ? "your sentence and this folder" : "this folder"}, then sends you a short page: where to begin, and three first steps to choose from.</p>` +
      `<div class="w-connect"><button type="button" class="w-btn" data-q="begin">Ask ${who} to begin</button><button type="button" class="text" data-q="bare">or just start ${who}</button></div>` + said +
      `<p class="pn-fine">If ${who} asks whether you trust this folder, choose <b>Yes</b>.${inst ? ` The first time, ${who} also asks you to sign in: your browser opens, and you approve there.` : ""}</p>`);
    focus();
  }
  strip.onclick = e => {
    const b = e.target.closest("[data-q]");
    if (!b) return;
    const q = b.dataset.q, bin = codex ? "codex" : a.claude_at && a.claude_at !== "claude" ? `"${a.claude_at}"` : "claude";
    const typed = (line, once) => { stripSaid = quietType(v, line, once); return !stripSaid; };
    stripSaid = "";
    if (q === "line") instShown = !instShown;
    else if (q === "self") return void openLink(GET_CLAUDE);
    else if (q === "connect") return void connectFrom(b);
    else if (q === "wait-no") { clearInterval(instClock); instClock = 0; }
    else if (q === "install") {
      if (typed(installLine(v))) {
        qSet(sessionStorage, QUIET_INST, "1");
        // Claude is looked for every few seconds until it is here, for ten minutes.
        const till = Date.now() + 600e3;
        clearInterval(instClock);
        instClock = setInterval(() => { if (claudeIs !== "missing" || Date.now() > till) { clearInterval(instClock); instClock = 0; quietStrip(v, strip); } else claudeNow(true); }, 3000);
      }
    } else if (q === "codex") {
      b.disabled = true;
      return void ctx.api("/api/agents/codex/connect", {}).then(j => { if (!j.ok) stripSaid = "Codex was not connected. The Agents page says how to do it by hand."; }, e => { stripSaid = ctx.sayErr(e).why; })
        .then(() => claudeNow(true)).then(() => quietStrip(v, strip));
    } else if (q === "begin" || q === "bare") {
      // The question is run once; a bare start is the panel's own command from then on.
      if (typed(q === "begin" ? `${bin} "${ASK_BEGIN}"` : bin, q === "begin")) {
        // Only the question is waited on: a bare start promises no page.
        if (q === "begin") { qSet(sessionStorage, QUIET_ASKED, `${d.id}`); waitSince.set(d.id, Date.now()); } else quietBare = d.id;
        rail();
      }
    }
    quietStrip(v, strip);
  };
  return true;
}

const FIRST_CSS = `
/* The quiet first desk: no sidebar, and a head of the name and the folder.
   The rail keeps its column, so what arrives later moves nothing. */
:root[data-quiet] { --side-c: 0px; }
:root[data-quiet] #side { display: none; }
:root[data-quiet] .dk-head > :not(.dk-path, .dk-root), :root[data-quiet] .dk-path > :not(.dk-pp-desk), :root[data-quiet] .dk-pp-d .dk-pp-v { display: none; }
.dk-root { display: none; }
:root[data-quiet] .dk-root { display: block; margin-left: auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg-3); font-size: var(--fs-small); }
:root[data-quiet] .dk-head { padding-left: 14px; padding-right: 14px; }
.dk-quiet .dk-ln-goal { white-space: normal; font-size: var(--fs-ui); font-style: italic; color: var(--fg); line-height: 1.45; }
/* Where the first page lands: one box, the same size before the press and
   through every stage after it. Not `.dk-stage`: that is every note and
   thread chip's class (06-rail.js, 22-change.js), and in 1.70.0 these rules
   drew each chip as a 132px bordered box over the rail. */
.dk-land, .dk-firstpage { box-sizing: border-box; min-height: 132px; margin: 2px 8px 0; padding: 12px; border-radius: var(--r-md); }
.dk-land { display: flex; flex-direction: column; justify-content: center; gap: 2px; border: 1.5px dashed var(--rule-2); text-align: center; color: var(--fg-3); font-size: var(--fs-small); }
.dk-land p { margin: 0; }
.dk-firstpage { border: 1px solid var(--rule); background: var(--bg-raise); }
.dk-sts { list-style: none; margin: 0 0 8px; padding: 0; }
.dk-st { display: flex; gap: 8px; padding: 3px 0; font-size: var(--fs-small); color: var(--fg); }
.dk-st b { flex: none; width: 14px; text-align: center; color: var(--ok); }
.dk-st.now b { color: var(--accent); }
.dk-st.no, .dk-st.no b { color: var(--fg-3); }
#toc .dk-firstpage .dk-empty { margin: 0; }
.dk-q-foot { margin: 18px 8px 0; font-size: var(--fs-small); line-height: 1.5; color: var(--fg-3); }
.dk-q-say { display: flex; gap: 8px; align-items: flex-start; margin: 14px 8px 2px; font-size: var(--fs-small); line-height: 1.45; color: var(--fg-2); }
.dk-q-face { flex: none; }
.dk-q-face .mk { width: 22px; height: 22px; display: block; }
/* The first panel's strip: its step, and the line it would type. */
.pn-connect .w-connect { display: flex; flex-wrap: wrap; gap: 6px 12px; align-items: center; }
.pn-connect .pn-n { color: var(--fg-3); font-size: var(--fs-micro); }
.pn-connect .pn-n b { color: var(--accent); }
.pn-connect .pn-line { padding: 6px 8px; border-radius: var(--r-xs); background: var(--bg); overflow-wrap: anywhere; }
.pn-connect .pn-line code { font-size: var(--fs-micro); }
`;
