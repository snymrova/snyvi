/* ui/turn.js: the one card (1.64, C1; audit e863bf93a5, mockups 9d356801e5).
 *
 * What an agent puts on the reader -- a question, a group of them, a try, a
 * merge, a key, a run, a do -- was drawn three ways: the desk's tray and its
 * risen card (desk.js), and the corner's tray and Home's box (corner.js
 * `turnRow`). Off the desk a merge card lost its PR, a key card its Add key,
 * a card of four questions became four rows with no Other…, and the order
 * was oldest first (U1, U3). This is the desk's card, moved here so both
 * draw it: one renderer, and each host hands it what only it knows (`env`).
 *
 * env, from the host:
 *   esc(s), ico(name) -> svg, rel(t) -> "4m"
 *   off            off a desk: the meta line names the desk, which is Go to
 *                  desk; what needs a live panel is a step to the desk
 *   deskName(w)
 *   panel(w)       { slot, name } of the panel that asked, or null if closed
 *   runsHere(w), sendsHere(w)   Run and Send now can type into its panel
 *   routine(w)     { name, ok } when its panel is a routine's
 *   anyway(w)      a routine's Run was refused for its Waits list
 *   steps(w)       a walk-through's card, on the desk (16-steps.js)
 *   sendable(w)    answered here, still to be sent
 *   field(w)       "other" | "change" | "not" | "": the field open on it
 *   open(id)       its question opened whole, in the tray
 *   clamp          the rows are the tray's: questions cut to their lines
 *   later(key)     "" | "menu" | "not": its Later menu open (`w12`, `g7`),
 *                  and Not mine's field in it
 *   changing(id)   its answer is being changed (C7)
 *   err(key)       the row's error line, or ""
 *
 * Every button says what it does in data-a ("tn-…") and which turn in
 * data-w (data-g for a card of questions); the host's click handler does it.
 * Nothing here posts.
 */

/** What a hand-over's buttons send, and what a button says when that is
 *  not the word it sends: "Merged" read as the PR's status (#168). A try
 *  that is not good has its own word, in the reader's (C3). */
const ANSWERS = { try: ["Looks good", "Something's off…"], merge: ["Merged"], key: ["Added"], due: ["Done", "Tomorrow 9"] };
const SAYS = { merge: { Merged: "I merged it" }, key: { Added: "I added it" }, due: { "Tomorrow 9": "Tomorrow 9:00" } };
/** What Done is for each errand once it went quiet (C3). */
export const DONE = { key: "Added", try: "Looks good", merge: "Merged" };

const hostOf = u => { try { return new URL(u).host.replace(/^www\./, ""); } catch { return ""; } };
const web = u => /^https?:\/\//.test(u || "");
const code = (t, esc) => esc(t).replace(/`([^`\n]+)`/g, "<code>$1</code>");
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** A question's own first sentence is its title when it is short enough to
 *  read whole on one line; the rest is the body. A stop inside "e.g." or
 *  "(see 2.1)" is no sentence's end. */
export function qParts(text) {
  const m = /^([^()]{6,56}?[:.?])\s+([A-Z`"“(][\s\S]*)$/.exec(text);
  if (m && !/\b(?:e\.g|i\.e|etc|vs)\.$/i.test(m[1])) return [m[1].replace(/[:.]$/, ""), m[2]];
  return text.length <= 48 ? [text, ""] : ["", text];
}

/** The question, its title bold, the rest under it; in the tray two lines
 *  of the rest, a click from the whole. */
function qHtml(env, w, text = w.text) {
  const { esc } = env, [head, body] = qParts(text || "");
  const open = env.open(w.id), more = env.clamp && body;
  const attrs = more ? ` data-a="tn-more" data-w="${w.id}" role="button" tabindex="0" aria-expanded="${open}"` : "";
  return `<div class="tn-q${open ? " open" : ""}"${attrs}>` + (head ? `<b class="tn-qh">${code(head, esc)}</b>` : "") +
    (body ? `<span class="tn-qb">${code(body, esc)}</span>` : "") + `</div>`;
}

/** Who asked, from which panel, on which desk off a desk -- the desk's name
 *  is Go to desk -- how long ago, and how often (C8). */
function byHtml(env, w, extra = "", lead = "") {
  const { esc } = env, p = env.panel(w);
  const who = /^claude/i.test(w.by || "") ? "Claude" : w.by || "an agent";
  const where = w.kind === "tell" ? "snyvi · after the merge · a panel drafts it: /snyvi:post"
    : w.kind === "due" ? "due" : `${who} · ${p ? p.name : "panel closed"}`;
  const desk = env.off ? ` · <button type="button" class="tn-dn" data-a="tn-desk" data-w="${w.id}" data-tip="Go to desk" data-tip-sub="${esc(env.deskName(w))}">${esc(env.deskName(w))}</button>` : "";
  const again = w.asked > 1 ? ` · asked ${w.asked} times` : "";
  const tip = `${w.kind === "decide" ? "A decision" : w.kind}${p ? ` · panel ${p.slot}` : ""}`;
  return `<p class="tn-by">${lead}<span data-tip="${esc(tip)}">${esc(where)}</span>${desk} · ${esc(env.rel(w.created_at))}${again}${extra}</p>`;
}

/** Under a card whose panel closed (C8): the answer is not lost with it. */
function orphan(env, w) {
  if (!w.pane || env.panel(w) || w.answered_at) return "";
  return `<p class="tn-by tn-orphan">Its panel closed: the next Claude on ${env.esc(env.deskName(w))} picks up your answer.</p>`;
}

/** The ✕, low but always there (C5): Not now got no press in fifteen days
 *  while it showed only on hover (U5). It opens Later beside the row; the
 *  row's own buttons stay. */
function xBtn(env, key, text, g = 0, kind = "") {
  const { esc } = env, open = env.later(key);
  const ds = g ? `data-g="${g}"` : `data-w="${key.slice(1)}"`;
  return `<button type="button" class="tn-x" data-a="tn-lt-open" data-k="${key}" ${ds} aria-haspopup="menu" aria-expanded="${!!open}" data-tip="Later" data-tip-sub="tomorrow, next week, already done, or not mine; nothing is deleted" aria-label="Later: ${esc(text)}">${env.ico("x")}</button>` +
    (open ? laterMenu(env, key, ds, g || kind === "decide", open === "not") : "");
}

/** Later, over the card beside its ✕: what a ✕ means said as its four
 *  answers, each told to the agent. Not mine takes a word, in its field. */
function laterMenu(env, key, ds, asked, not) {
  const done = asked ? "Answered in the chat" : "Already done";
  const item = (v, l, sub) => `<button type="button" role="menuitem" data-a="tn-lt" data-k="${key}" ${ds} data-v="${v}"><span>${l}</span><small>${sub}</small></button>`;
  const field = not
    ? `<input class="th-in tn-not" data-for="not" data-k="${key}" maxlength="120" placeholder="Not mine: why, in a word (Enter)" aria-label="Why it is not yours" spellcheck="false">` : "";
  return `<div class="tn-later" role="menu" aria-label="Later">` +
    item("tomorrow", "Tomorrow 9:00", "back on you then") + item("next week", "Next week", "Monday 9:00") +
    item("done", done, "settles it; Claude is told") +
    `<button type="button" role="menuitem" data-a="tn-lt-not" data-k="${key}" ${ds}><span>Not mine…</span><small>Claude hears your word in its brief</small></button>${field}</div>`;
}

/** A decide's options, the recommended one starred, and Other…. */
function picks(env, w) {
  const { esc } = env;
  return (w.options || []).map((o, i) => `<button type="button" class="tn-opt${i === w.recommended ? " rec" : ""}" data-a="tn-pick" data-w="${w.id}" data-v="${esc(o)}"${i === w.recommended ? ` aria-label="${esc(o)}, recommended" data-tip="Recommended" data-tip-sub="by ${esc(w.by || "the agent")}"><span class="tn-star" aria-hidden="true">★</span>` : ">"}${esc(o)}</button>`).join("") +
    (w.kind === "tell" ? "" : `<button type="button" class="tn-opt quiet" data-a="tn-other" data-w="${w.id}">Other…</button>`);
}

/** The field Other… or Something's off… opens under a turn. */
function fieldIn(env, w) {
  const f = env.field(w);
  if (f !== "other" && f !== "change") return "";
  return `<input class="th-in" data-for="${f}" data-w="${w.id}" placeholder="${f === "change" ? "Say it: what is off" : "Your answer"}" aria-label="Your answer" spellcheck="false">`;
}

/** A card gone quiet (C3): its panel was prompted since, so it may be done
 *  there. Dimmed, not amber, and it asks. */
function quietLine(env, w) {
  const p = env.panel(w), who = p ? p.name : "Its panel";
  const q = w.kind === "decide" ? "you may have answered it there." : "Did you do it there?";
  return `<p class="tn-by tn-quiet">${env.esc(who.replace(/^p/, "P"))} was prompted since. ${q}</p>`;
}

/** One card: a turn on its own, or a card of questions (`group`, its turns). */
export function card(env, w, group = null) {
  if (group && group.length > 1) return groupCard(env, group);
  if (w.answered_at) return saidRow(env, w);
  if (w.kind === "run") return runRow(env, w);
  const { esc } = env, quiet = w.quiet_at > 0 && w.kind !== "decide";
  const kind = w.kind === "decide" || w.kind === "tell" ? "" : w.kind;
  const answers = ANSWERS[kind] || ["Done"];
  let buttons = !kind ? picks(env, w) : answers.map(o => o.endsWith("…")
    ? `<button type="button" class="tn-opt quiet" data-a="tn-change" data-w="${w.id}">${esc(o)}</button>`
    : `<button type="button" class="tn-opt" data-a="tn-pick" data-w="${w.id}" data-v="${esc(o)}">${esc(SAYS[kind]?.[o] || o)}</button>`).join("");
  // A merge leads with its PR, merging is done there (#168); a key opens
  // its desk's keys (#114), off a desk on its desk.
  const openPr = w.kind === "merge" && web(w.link) ? `<button type="button" class="tn-opt rec" data-a="tn-link" data-u="${esc(w.link)}" data-tip="Open the PR ↗" data-tip-sub="${esc(w.link)}">Open PR ↗</button>` : "";
  const add = w.kind === "key" ? `<button type="button" class="tn-opt rec" data-a="tn-key" data-w="${w.id}" data-tip="Add key…" data-tip-sub="${env.off ? "On its desk's keys" : "This desk's keys: a panel started after has it"}">Add key…</button>` : "";
  const link = web(w.link) && !openPr ? ` · <button type="button" class="tn-host" data-a="tn-link" data-u="${esc(w.link)}" data-tip="Open ↗" data-tip-sub="${esc(w.link)}">${esc(hostOf(w.link) || "link")} ↗</button>` : w.link && !openPr && w.kind !== "due" ? ` · ${esc(w.link)}` : "";
  // A dated line's card carries its document: Open (1.54).
  const doc = w.kind === "due" && /^[0-9a-f]{6,64}$/.test(w.link || "") ? `<button type="button" class="tn-opt" data-a="tn-doc" data-u="${esc(w.link)}">Open</button>` : "";
  if (quiet) buttons = `<button type="button" class="tn-opt rec" data-a="tn-pick" data-w="${w.id}" data-v="${esc(DONE[w.kind] || "Done")}">Done</button><button type="button" class="tn-opt" data-a="tn-keep" data-w="${w.id}" data-tip="Still to do" data-tip-sub="back in amber, and it stays">Still to do</button>`;
  const q = w.quiet_at > 0 ? quietLine(env, w) : "";
  return `<li class="dk-turn${w.quiet_at > 0 ? " quiet" : ""}" data-w="${w.id}">${qHtml(env, w)}` + byHtml(env, w, link) + q + orphan(env, w) +
    `<div class="tn-acts">${quiet ? "" : add + openPr}${buttons}${doc}${xBtn(env, `w${w.id}`, w.text, 0, w.kind)}</div>` +
    fieldIn(env, w) + `</li>` + env.err(`w${w.id}`);
}

/** A command handed over (#95): whole, never cut, and Run. On the desk Run
 *  types it into the panel that asked; New panel runs it in a shell of its
 *  own. Off the desk its step is to the desk, the panel named. */
function runRow(env, w) {
  const { esc } = env;
  if (w.options && w.options.length) {
    const own = env.steps?.(w);
    if (own) return own;
    const n = w.options.filter(o => !o.startsWith("# ")).length;
    return `<li class="dk-turn" data-w="${w.id}">${qHtml(env, w)}` + byHtml(env, w) +
      `<p class="tn-by">${n} steps, run one at a time on the desk</p>` +
      `<div class="tn-acts"><button type="button" class="tn-opt" data-a="tn-desk" data-w="${w.id}">Run them on the desk ›</button>${xBtn(env, `w${w.id}`, w.text)}</div></li>`;
  }
  const quiet = w.quiet_at > 0, p = env.panel(w), rt = env.routine(w);
  const copy = `<button type="button" class="tn-opt quiet" data-a="tn-copy" data-w="${w.id}" data-c="${esc(w.cmd)}">Copy</button>`;
  let acts, extra = "";
  if (quiet) {
    acts = `<button type="button" class="tn-opt rec" data-a="tn-pick" data-w="${w.id}" data-v="Done">Done</button><button type="button" class="tn-opt" data-a="tn-keep" data-w="${w.id}" data-tip="Still to do" data-tip-sub="back in amber, and it stays">Still to do</button>` + copy;
  } else if (rt) {
    // A routine's card (1.50): Run starts it as its panel's process; one
    // click for a command on its Waits list, Run anyway for any other.
    const v = rt.ok || !env.anyway(w) ? "Run" : "Run anyway";
    extra = ` · ${esc(rt.name)} · ${rt.ok ? "✓ on your Waits list" : "not on your Waits list"}`;
    acts = `<button type="button" class="tn-opt" data-a="tn-pick" data-w="${w.id}" data-v="${v}" data-tip="${v} in ${esc(rt.name)}'s panel" data-tip-sub="As that panel's process, in the desk's folder with its keys">${v}</button>` + copy;
  } else if (env.off) {
    acts = `<button type="button" class="tn-opt" data-a="tn-desk" data-w="${w.id}" data-tip="${env.runsHere(w) ? "Run it there: typed into its prompt" : "A new panel there runs it"}">${env.runsHere(w) && p ? `Run in ${esc(p.name)} ›` : "New panel on its desk ›"}</button>` + copy;
  } else {
    const here = env.runsHere(w);
    if (!here) extra = " · Run needs that panel's Claude";
    acts = (here ? `<button type="button" class="tn-opt" data-a="tn-run" data-w="${w.id}" data-tip="Run it in panel ${p?.slot}" data-tip-sub="Typed into its prompt as a ! command, after anything typed there. Its output goes to the agent">Run in panel ${p?.slot}</button>` : "") +
      `<button type="button" class="tn-opt${here ? " quiet" : ""}" data-a="tn-newpanel" data-w="${w.id}" data-tip="Run it in a new panel" data-tip-sub="A shell of its own: the agent does not see the output">New panel</button>` + copy;
  }
  return `<li class="dk-turn${quiet ? " quiet" : ""}" data-w="${w.id}">${qHtml(env, w)}<code class="tn-cmd">${esc(w.cmd)}</code>` +
    byHtml(env, w, extra) + (quiet ? quietLine(env, w) : "") + orphan(env, w) +
    `<div class="tn-acts">${acts}${xBtn(env, `w${w.id}`, w.text)}</div></li>` + env.err(`w${w.id}`);
}

/** An answer given here, still to reach its panel: what was said, Send now
 *  while that panel is idle (on the desk), and Change until it is sent (C7). */
function saidRow(env, w) {
  const { esc } = env, p = env.panel(w), rt = env.routine(w);
  if (env.changing(w.id) && w.kind === "decide") return `<li class="dk-turn" data-w="${w.id}">${qHtml(env, w)}<div class="tn-acts">${picks(env, w)}</div>${fieldIn(env, w)}</li>`;
  const now = rt ? `<span class="tn-wait">starts ${esc(rt.name)}'s next run</span>` : !env.off && env.sendsHere(w)
    ? `<button type="button" class="tn-opt" data-a="tn-send" data-w="${w.id}" data-tip="Send now" data-tip-sub="Types it into panel ${p?.slot} and presses Enter">Send now</button>`
    : `<span class="tn-wait">${p ? `goes with your next message to ${esc(p.name)}` : "goes to the next panel that asks"}</span>`;
  const change = w.kind === "decide" && !rt ? `<button type="button" class="tn-opt quiet" data-a="tn-rechange" data-w="${w.id}" data-tip="Change" data-tip-sub="until it is sent">Change</button>` : "";
  return `<li class="dk-turn said" data-w="${w.id}">${qHtml(env, w)}<p class="tn-by">You said <b>${esc(w.answer)}</b></p>` +
    `<div class="tn-acts">${now}${change}${env.off ? "" : `<button type="button" class="tn-x tn-unsend" data-a="tn-unsend" data-w="${w.id}" data-tip="Leave it for the next message" aria-label="Leave it for the next message">${env.ico("x")}</button>`}</div></li>`;
}

/** Several questions asked at once (#110), as one card, in the order they
 *  were asked: an answered one folds where it is to "✓ Integers · …" with
 *  Change beside it, and does not jump to the card's foot (C7, U7). The
 *  head counts what is left; one ✕ for the card. */
function groupCard(env, ms) {
  const { esc } = env;
  ms = [...ms].sort((a, b) => a.id - b.id);
  const g = ms[0].ask_group, p = env.panel(ms[0]);
  const open = ms.filter(w => !w.answered_at).length;
  const rows = ms.map(w => {
    if (w.answered_at && !env.changing(w.id)) {
      const [head, body] = qParts(w.text || "");
      return `<div class="tn-gq said" data-w="${w.id}"><p class="tn-fold"><span class="tn-ok" aria-hidden="true">✓</span><b>${esc(w.answer)}</b><span class="tn-was" data-tip="${esc(w.text)}"> · ${code(head || body, esc)}</span>` +
        `<button type="button" class="tn-opt quiet" data-a="tn-rechange" data-w="${w.id}" data-tip="Change" data-tip-sub="until it is sent">Change</button></p></div>`;
    }
    return `<div class="tn-gq" data-w="${w.id}">${qHtml(env, w)}<div class="tn-acts">${picks(env, w)}</div>${fieldIn(env, w)}</div>` + env.err(`w${w.id}`);
  }).join("");
  const foot = open ? "" : `<div class="tn-acts tn-gfoot">` + (!env.off && env.sendsHere(ms[0])
    ? `<button type="button" class="tn-opt rec" data-a="tn-gsend" data-g="${g}" data-tip="Send answers" data-tip-sub="Types all ${ms.length} into panel ${p?.slot} as one message and presses Enter">Send answers</button>`
    : `<span class="tn-wait">${p ? `they go with your next message to ${esc(p.name)}` : "they go to the next panel that asks"}</span>`) +
    (env.off ? "" : `<button type="button" class="tn-x tn-unsend" data-a="tn-gunsend" data-g="${g}" data-tip="Leave them for the next message" aria-label="Leave them for the next message">${env.ico("x")}</button>`) + `</div>`;
  const count = open ? `${open} of ${plural(ms.length, "decision")} left · ` : `${plural(ms.length, "decision")} · `;
  const quiet = ms.every(w => w.answered_at || w.quiet_at > 0);
  return `<li class="dk-turn grp${open ? "" : " said"}${quiet && open ? " quiet" : ""}" data-g="${g}">${byHtml(env, { ...ms[0], kind: "decide" }, "", `<b>${count}</b>`)}` +
    (open ? xBtn(env, `g${g}`, ms[0].text, g) : "") + (quiet && open ? quietLine(env, ms[0]) : "") + orphan(env, ms[0]) + rows + foot + `</li>`;
}

/** An older card in the tray (#174): one line, its title, then where and
 *  when, a click from its whole card; a card of questions as its head (C4). */
export function olderLine(env, w, n = 1) {
  const { esc } = env, g = w.ask_group;
  const [head, body] = qParts(w.text || "");
  const what = (n > 1 ? `${n} decisions · ` : "") + (head || body);
  const p = env.panel(w), where = (p ? p.name : "panel closed") + (env.off ? ` · ${env.deskName(w)}` : "");
  return `<li class="cn-row"${g ? ` data-g="${g}"` : ` data-w="${w.id}"`}><span class="cn-b">` +
    `<span class="cn-tl"><button type="button" class="cn-t" data-a="tn-old" data-w="${g || w.id}" aria-expanded="false" data-tip="${esc(w.text)}"><span class="cn-tx">${code(what, esc)}</span></button></span>` +
    `<span class="cn-bl"><span class="cn-w">${esc(where)} · ${esc(w.kind === "decide" ? "decision" : w.kind)}</span><span class="cn-at">${esc(env.rel(w.created_at))}</span></span>` +
    `</span>${xBtn(env, g ? `g${g}` : `w${w.id}`, w.text, g)}</li>`;
}

let styled = false;
/** The card's look, once per page, whichever host drew first. */
export function style() {
  if (styled) return;
  styled = true;
  document.head.append(Object.assign(document.createElement("style"), { id: "turn-drawn", textContent: CSS }));
}

const CSS = `
.dk-turn-list { list-style: none; margin: 4px 0 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.dk-turn { position: relative; padding: 7px 8px 8px; border: 1px solid var(--rule); border-radius: var(--r-sm); background: var(--bg-raise); font-size: var(--fs-ui); }
.th-in { display: block; width: 100%; box-sizing: border-box; margin-top: 6px; padding: 3px 6px; border: 1px solid var(--accent); border-radius: var(--r-sm); background: var(--bg); color: var(--fg); font: inherit; font-size: var(--fs-micro); }
.tn-q { margin: 0; color: var(--fg); overflow-wrap: anywhere; }
.tn-qh, .tn-qb { display: block; }
.tn-qh { font-weight: 600; }
.tn-q code, .tn-fold code { padding: 0 3px; border-radius: var(--r-xs); background: var(--bg); font-family: var(--mono); font-size: .92em; }
/* In a tray a question is its title line and two lines of the rest, three
   with no title, and a click opens it where it is. */
.oy-tray .tn-q:not(.open) .tn-qh { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.oy-tray .tn-q:not(.open) .tn-qb { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
.oy-tray .tn-q:not(.open) .tn-qb:first-child { -webkit-line-clamp: 3; }
.tn-q[data-a] { cursor: pointer; }
.tn-q[data-a]:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: var(--r-xs); }
.tn-by { margin: 2px 0 0; font-size: var(--fs-micro); color: var(--fg-3); }
.tn-by b { font-weight: inherit; color: var(--fg-2); }
.tn-host, .tn-dn { padding: 0; border: 0; background: none; font: inherit; color: var(--fg-2); text-decoration: underline dotted; cursor: pointer; }
.tn-host:hover, .tn-dn:hover { color: var(--accent); }
.tn-acts { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; margin-top: 6px; }
.tn-opt { padding: 1px 7px; border: 1px solid var(--rule-2); border-radius: var(--r-sm); background: none; font: inherit; font-size: var(--fs-micro); color: var(--fg-2); cursor: pointer; }
.tn-opt:hover { color: var(--fg); border-color: var(--accent); }
.tn-opt.rec { border-color: var(--accent); color: var(--fg); }
.tn-opt.quiet { border-style: dashed; }
.tn-star { margin-right: 3px; color: var(--accent); font-size: .85em; }
.tn-wait { font-size: var(--fs-micro); color: var(--fg-3); }
/* The ✕ is the card's top-right corner, out of its buttons (U4), and it is
   always there, low (C5): only on hover, it was never pressed (U5). */
.tn-x { display: grid; place-items: center; width: 20px; height: 20px; margin-left: auto; border: 0; border-radius: var(--r-xs); background: none; color: var(--fg-3); opacity: .55; cursor: pointer; }
.tn-x:hover, .tn-x:focus-visible, .tn-x[aria-expanded="true"] { opacity: 1; background: var(--rule-2); color: var(--fg); }
.dk-turn .tn-x:not(.tn-unsend), .cn-row > .tn-x { position: absolute; top: 4px; right: 4px; margin: 0; }
.dk-turn > .tn-q, .tn-gq > .tn-q, .dk-turn.grp > .tn-by:first-child { padding-right: 22px; }
.cn-row > .tn-x { top: 6px; right: 0; }
/* Later, beside the ✕, over the card: nothing under it moves. */
.tn-later { position: absolute; top: 26px; right: 4px; z-index: 2; display: flex; flex-direction: column; min-width: 190px; padding: 4px; border: 1px solid var(--rule-2); border-radius: var(--r-sm); background: var(--bg-raise); box-shadow: var(--shadow); }
.tn-later > button { display: flex; flex-direction: column; align-items: flex-start; padding: 4px 8px; border: 0; border-radius: var(--r-xs); background: none; font: inherit; font-size: var(--fs-micro); color: var(--fg); text-align: left; cursor: pointer; }
.tn-later > button:hover, .tn-later > button:focus-visible { background: var(--rule); }
.tn-later small { color: var(--fg-3); font-size: inherit; }
.tn-later .th-in { margin: 4px 0 0; }
.dk-turn.said { border-style: dashed; }
/* Gone quiet (C3): no amber, no rise, a question to the reader. */
.dk-turn.quiet { opacity: .78; }
.dk-turn.quiet:is(:hover, :focus-within) { opacity: 1; }
.tn-quiet { color: var(--fg-2); }
.tn-orphan { font-style: italic; }
.tn-cmd { display: block; margin-top: 4px; padding: 2px 5px; border-radius: var(--r-xs); background: var(--bg); font-family: var(--mono); font-size: var(--fs-micro); color: var(--fg-2); white-space: pre-wrap; word-break: normal; overflow-wrap: break-word; max-height: 9em; overflow-y: auto; }
/* Questions asked together: one card, a row for each, ruled apart; one
   answered folds in its place (C7). */
.tn-gq { position: relative; padding: 6px 0 0; margin-top: 6px; border-top: 1px solid var(--rule); }
.tn-gq .tn-acts { margin-top: 4px; }
.tn-fold { display: flex; align-items: baseline; gap: 4px; margin: 0; font-size: var(--fs-micro); color: var(--fg-2); }
.tn-fold .tn-ok { color: var(--ok); }
.tn-fold .tn-was { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg-3); }
.tn-gfoot { padding-top: 6px; border-top: 1px solid var(--rule); }
/* In a tray a card is a row, ruled off from the next. */
.oy-tray .dk-turn-list { gap: 0; margin: 0; }
.oy-tray .dk-turn { padding: 8px 0; border: 0; border-radius: 0; background: none; }
.oy-tray .dk-turn-list > li + li { border-top: 1px solid var(--rule); }
.oy-tray .dk-turn > .tn-x { top: 6px; right: -4px; }
.oy-tray .tn-later { right: -4px; }
/* The corner's lists and Home's box draw the same card as a row too. */
.cn-list > .dk-turn { padding: 8px 0; border: 0; border-radius: 0; background: none; }
.cn-list > .dk-turn > .tn-x { top: 6px; right: -4px; }
.cn-list .tn-later { right: -4px; }
.oy-qh { display: flex; align-items: center; gap: 6px; margin: 8px 0 0; padding-top: 6px; border-top: 1px solid var(--rule); font-size: var(--fs-micro); color: var(--fg-3); }
.oy-qh button { padding: 0; border: 0; background: none; font: inherit; color: var(--fg-2); text-decoration: underline dotted; cursor: pointer; }
`;
