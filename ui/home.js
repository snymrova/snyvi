/* Home: the page the mark opens, at `/`. The doorway to an evening's work.
 *
 * A page for planning, so it looks ahead and not back: the desks, and what is
 * open on each. Which project tonight, and where was I? -- the Pick up card:
 * the desk touched last (or the one the reader keeps there), where it was
 * left, its open notes, what git says, one button with Enter on it. A thought
 * for one of them? -- the note bar above it, in view however far the page
 * scrolls: a line on any desk's list, without opening the desk. What is
 * open everywhere else? -- Projects: a card for every other desk, with where
 * it was left, its first open notes, each tickable where it stands, a + that
 * puts the desk on the note bar, and its last eight weeks, quietly, with
 * "Park it?" for one that has gone quiet. One project, one card: nothing is
 * listed twice. Does anything need me? -- one status line under the title,
 * which the rail and the sidebar answer too, so it is a line and not three
 * boxes. What came? -- Arrived, at the head of the side column: an agent's
 * offer, a friend's line, the newest documents not yet read, each with its
 * actions in its row. The date is in the head. And the trail --
 * what was ticked, sent, left off and committed, day by day -- is This week,
 * folded at the foot, with the week as a document on a button: kept, and no
 * longer what the page leads with. No streaks, no red, no scores: a hobby is
 * not a KPI.
 *
 * One call (`GET /api/home`), drawn whole, and drawn again when the daemon
 * says something it shows has moved -- panes, a panel's context, the desks, a
 * desk's notes, a document, the update. Debounced, so a burst of events is
 * one read.
 *
 * A chunk: a reader who goes straight to a document never fetches it. The
 * Inbox moved to `/inbox`, and `i` still opens it; its foot, "N removed ·
 * Show", is drawn from here too (`removedLine`), as the other page that lists.
 *
 * The side widgets can be hidden and shown again ("2 hidden · Show"): the list
 * is this viewer's, in localStorage, since it is a preference about a page
 * and not a thing in the library, and so is the desk kept in Pick up. Arrived
 * cannot be hidden: what arrives is never put out of sight by a preference.
 * Friends shows once there is a friend, and Check for updates and Pair with
 * a friend… are the foot's, with an update's card under it. The version is
 * the sidebar's foot's and About's to say, not a third place's.
 * Nothing here moves when something arrives: the status line is one line
 * whatever it says, On you opens over the page from it, and a widget
 * with nothing to say says so rather than going away (audit 67d008cb6f).
 */

const CSS = `
.hm { max-width: 1440px; margin: 0 auto; padding: 8px 0 48px; container-type: inline-size; }
.hm-head { display: flex; align-items: baseline; gap: 12px; margin: 0 0 4px; }
.hm-head h1 { margin: 0; font-size: var(--fs-h2); font-weight: 650; letter-spacing: -.02em; }
.hm-head .hm-v { color: var(--fg-3); font-size: var(--fs-small); }
.hm-status { margin: 0 0 24px; height: 20px; line-height: 20px; font-size: var(--fs-body-s); color: var(--fg-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hm-status a { color: var(--fg-2); text-decoration: none; }
.hm-status a:hover { color: var(--fg); text-decoration: underline; }
.hm-status.ring .hm-ring { color: var(--warn); font-weight: 600; }
/* On you: a button in the status line, and a sheet over the page under
   it -- the desk's "On you" corner's, so its coming moves nothing. */
.hm-st { position: relative; }
.hm .hm-ask { max-width: none; padding: 0; margin: 0; }
.hm-ask .w-q { font-size: var(--fs-h3); font-weight: 600; margin: 0 0 12px; }
.hm-ask .w-btns { display: flex; flex-wrap: wrap; gap: 10px; }
.hm-onyou { padding: 0; border: 0; background: none; font: inherit; font-weight: 600; color: var(--warn); cursor: pointer; }
.hm-onyou:hover, .hm-onyou[aria-expanded="true"] { text-decoration: underline; }
.hm-onyou.old { font-weight: 400; color: var(--fg-2); }
/* A desk's moving threads, a line each under its notes. */
.hm-th { list-style: none; margin: 8px 0 0; padding: 0; display: grid; gap: 2px; }
.hm-th li { display: flex; align-items: center; gap: 6px; min-width: 0; font-size: var(--fs-small); color: var(--fg-3); }
.hm-th svg { flex: none; }
.hm-th-n { flex: none; max-width: 60%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg-2); font-weight: 500; }
.hm-th .hm-t { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hm-upd { margin-top: 12px; max-width: 360px; }
.hm .fact { font-family: var(--mono); font-size: var(--fs-micro); font-variant-numeric: tabular-nums; }
/* Pick up, the desks and the week on the left, the side column beside them. */
.hm-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(280px, 340px); grid-template-areas: "main side"; gap: 32px 48px; align-items: start; }
.hm-main { grid-area: main; display: grid; gap: 32px; min-width: 0; }
.hm-side { grid-area: side; display: grid; gap: 32px; min-width: 0; }
@container (max-width: 760px) {
  /* One column, and what arrived under the bar rather than under the week:
     the columns step aside so their sections share one order. After the
     columns' own rules, which would otherwise keep them boxes in areas that
     are gone: three tracks, and the bar drawn over the Claude box. */
  .hm-grid { grid-template-columns: minmax(0, 1fr); grid-template-areas: none; }
  .hm-main, .hm-side { display: contents; }
  .hm-nb { order: -2; }
  .hm-arrived { order: -1; }
  .hm-wait { order: -1; }
}
/* A section: a label on a hairline, and space doing the rest. */
.hm-w { min-width: 0; }
.hm-wh { display: flex; align-items: center; gap: 8px; height: 28px; margin: 0 0 8px; border-bottom: 1px solid var(--rule); }
/* A head reads as the head of what is under it: the rows' size, a step
   brighter than their facts (audit 67d008cb6f; it was 11 px under 13). */
.hm-wh h2 { margin: 0; font-size: var(--fs-ui); font-weight: 600; color: var(--fg-2); }
.hm-wh h2 .n { margin-left: 6px; font-weight: 500; font-variant-numeric: tabular-nums; }
.hm-wh .hm-act { margin-left: auto; }
/* Hide, said: the ✕ that was here meant "remove" everywhere else on the page,
   and showed only under the pointer. */
.hm-hide { flex: none; height: 20px; padding: 0 6px; border: 0; border-radius: var(--r-xs); background: none; color: var(--fg-3); cursor: pointer; font: inherit; font-size: var(--fs-micro); }
.hm-wh .hm-act + .hm-hide { margin-left: 0; }
.hm-wh h2 + .hm-hide { margin-left: auto; }
.hm-hide:hover { background: var(--rule-2); color: var(--fg); }
.hm-quiet { margin: 0; color: var(--fg-3); font-size: var(--fs-small); line-height: 1.6; }
.hm-s { flex: none; color: var(--fg-3); font-size: var(--fs-small); }
.hm-t { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hm-list { list-style: none; margin: 0; padding: 0; }
.hm-opt { padding: 1px 8px; border: 1px solid var(--rule-2); border-radius: var(--r-sm); background: none; font: inherit; font-size: var(--fs-micro); color: var(--fg-2); cursor: pointer; }
.hm-opt:hover { color: var(--fg); border-color: var(--accent); }
.hm-opt.rec { border-color: var(--accent); color: var(--fg); }
.hm-link { padding: 0; border: 0; background: none; font: inherit; font-size: var(--fs-small); color: var(--fg-2); cursor: pointer; }
.hm-link:hover { color: var(--fg); text-decoration: underline; }
.hm-link.hm-undo { color: var(--accent); }
.hm-dots { display: inline-flex; gap: 3px; }
.hm-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--fg-3); flex: none; }
.hm-dot.run, .hm-dot.work { background: var(--ok); }
.hm-dot.work { box-shadow: 0 0 0 2px color-mix(in srgb, var(--ok), transparent 75%); }
.hm-dot.need { background: var(--warn); }
/* Pick up: the one card on the page. */
.hm-pick { padding: 18px 20px 16px; border: 1px solid var(--rule); border-radius: var(--r-md); background: var(--bg-raise, var(--bg)); box-shadow: var(--shadow-1); min-width: 0; }
.hm-pick > h2 { margin: 0 0 4px; font-size: var(--fs-ui); font-weight: 600; color: var(--fg-2); }
.hm-pk-top { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; margin: 0 0 12px; }
.hm-pk-name { font-size: var(--fs-h3); font-weight: 650; letter-spacing: -.01em; color: var(--fg); text-decoration: none; }
.hm-pk-name:hover { text-decoration: underline; }
.hm-pk-top .fact { color: var(--fg-3); }
.hm-pk-top .hm-spark { margin-left: auto; align-self: center; }
.hm-pk-left { margin: 0 0 12px; font-size: var(--fs-body-s); line-height: 1.55; color: var(--fg); }
.hm-pk-left b { font-weight: 500; color: var(--fg-3); margin-right: 6px; }
.hm-pk-left.hm-derived { color: var(--fg-2); }
.hm-pk-left a { color: var(--fg); text-decoration: underline; text-decoration-color: var(--rule-2); text-underline-offset: 3px; }
.hm-pk-left a:hover { text-decoration-color: currentColor; }
/* Its byline in one piece: "claude-" over "code" read as two names. */
.hm-pk-left .fact { color: var(--fg-3); margin-left: 4px; white-space: nowrap; }
.hm-pk-left code, .hm-log code { font-family: var(--mono); font-size: var(--fs-micro); color: var(--fg-3); }
/* A desk's open notes, each with the circle that ticks it where it stands. */
.hm-next { list-style: none; margin: 0 0 8px; padding: 0; font-size: var(--fs-ui); }
.hm-next li { display: flex; align-items: center; gap: 8px; min-height: 24px; min-width: 0; }
.hm-nt-t { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hm-nt.done .hm-nt-t { color: var(--fg-3); text-decoration: line-through; }
.hm-next .hm-s a { color: inherit; }
.hm-next .hm-s a:hover { color: var(--fg); }
.hm-tick { position: relative; flex: none; display: grid; place-items: center; width: 12px; height: 12px; padding: 0; border: 0; border-radius: 50%; background: none; box-shadow: inset 0 0 0 1.5px var(--fg-3); color: transparent; cursor: pointer; transition: box-shadow var(--t), background var(--t); }
.hm-tick::before { content: ""; position: absolute; inset: -4px; border-radius: 50%; }
.hm-tick:hover { box-shadow: inset 0 0 0 1.5px var(--accent); }
.hm-tick[aria-checked="true"] { background: var(--fg-3); box-shadow: none; color: var(--bg); }
.hm-tick svg { width: 9px; height: 9px; }
.hm-err { color: var(--danger); }
/* The note bar: one field for a line on any desk, held under the page's head
   as the page scrolls, on a strip of the page's own ground so what goes under
   it goes out of sight. One height whatever it says: what the last Enter did
   is said in its own row, and the desk list opens over the page. */
.hm-nb { position: sticky; top: var(--head-h); z-index: calc(var(--z-sticky) - 1); margin: -8px 0; padding: 8px 0; background: var(--bg); }
.hm-nb-in { display: flex; align-items: center; gap: 8px; height: 40px; padding: 0 10px 0 6px; border: 1px solid var(--rule-2); border-radius: var(--r-md); background: var(--bg-raise, var(--bg)); box-shadow: var(--shadow-1); transition: border-color var(--t), background var(--t); }
/* The field's focus is the bar's: its border, not a ring inside it. */
.hm-nb-in:focus-within, .hm-nb.drop .hm-nb-in, .hm-nb-t:focus { outline: none; border-color: var(--accent); }
.hm-nb.drop .hm-nb-in { background: color-mix(in srgb, var(--accent), var(--bg) 94%); }
.hm-nb.lit .hm-nb-in { animation: hm-lit calc(var(--dur-moment) * 2) ease-out; }
@keyframes hm-lit { 0% { box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent), transparent 70%); } }
@media (prefers-reduced-motion: reduce) { .hm-nb.lit .hm-nb-in { animation: none; } }
.hm-nb-to { flex: none; display: inline-flex; align-items: center; gap: 4px; max-width: 40%; height: 28px; padding: 0 8px 0 10px; border: 0; border-radius: var(--r-pill); background: var(--rule); color: var(--fg); font: inherit; font-size: var(--fs-small); font-weight: 500; cursor: pointer; transition: background var(--t); }
.hm-nb-to > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hm-nb-to svg { flex: none; color: var(--fg-3); }
.hm-nb-to:hover, .hm-nb-to[aria-expanded="true"] { background: var(--rule-2); }
.hm-nb-t { flex: 1; min-width: 0; height: 100%; padding: 0 4px; border: 0; background: none; font: inherit; font-size: var(--fs-ui); color: var(--fg); }
.hm-nb-t::placeholder { color: var(--fg-3); }
.hm-nb-pend { flex: none; display: flex; align-items: center; gap: 1px; color: var(--fg-2); }
.hm-nb-pic { display: inline-flex; align-items: center; gap: 1px; }
.hm-nb-pic .c { font-size: var(--fs-micro); font-variant-numeric: tabular-nums; }
.hm-nb-pend button { display: grid; place-items: center; width: 18px; height: 18px; padding: 0; border: 0; border-radius: var(--r-xs); background: none; color: var(--fg-3); cursor: pointer; }
.hm-nb-pend button:hover { background: var(--rule-2); color: var(--fg); }
.hm-nb-say { flex: none; display: inline-flex; align-items: center; gap: 6px; max-width: 50%; min-width: 0; font-size: var(--fs-small); color: var(--fg-2); white-space: nowrap; }
.hm-nb-say > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.hm-nb-say a { color: var(--fg); text-decoration: underline; text-decoration-color: var(--rule-2); text-underline-offset: 3px; }
.hm-nb-say a:hover { text-decoration-color: currentColor; }
.hm-nb-k { visibility: hidden; }
.hm-nb-in:focus-within .hm-nb-k { visibility: visible; }
.hm-nb-list { position: absolute; left: 0; top: calc(100% - 4px); z-index: 1; display: flex; flex-direction: column; width: min(320px, 100%); max-height: 340px; padding: 4px; border: 1px solid var(--rule-2); border-radius: var(--r-md); background: var(--bg-raise, var(--bg)); box-shadow: var(--shadow); }
.hm-nb-list[hidden] { display: none; }
.hm-nb-find { flex: none; margin: 0 0 4px; padding: 5px 8px; font: inherit; font-size: var(--fs-ui); border: 1px solid var(--rule-2); border-radius: var(--r-sm); background: var(--bg); color: var(--fg); }
.hm-nb-find:focus { outline: none; border-color: var(--accent); }
.hm-nb-opts { position: relative; min-height: 0; overflow-y: auto; }
.hm-nb-opts .hm-quiet { padding: 4px 8px; }
.hm-nb-o { display: flex; align-items: center; gap: 8px; width: 100%; height: 30px; padding: 0 8px; border: 0; border-radius: var(--r-sm); background: none; font: inherit; font-size: var(--fs-ui); color: var(--fg); text-align: left; cursor: pointer; }
.hm-nb-o:hover, .hm-nb-o.at { background: var(--rule); }
.hm-nb-o .fact { flex: none; color: var(--fg-3); }
.hm-nb-on { flex: none; display: grid; place-items: center; width: 12px; color: var(--accent); }
.hm-next .hm-nt-more { padding-left: 31px; }
/* How far an agent has got with a line, as the desk's rail draws it: a slot
   every line keeps, a ring for read, the plan's page (it opens the plan), a
   breathing dot while a panel's agent is at it. */
.hm-stage { position: relative; flex: none; display: grid; place-items: center; width: 10px; height: 10px; margin: 0 -3px 0 -4px; color: var(--fg-3); }
.hm-stage.read::before { content: ""; width: 6px; height: 6px; border-radius: 50%; box-shadow: inset 0 0 0 1.25px var(--fg-3); }
.hm-stage.planned::before { content: ""; position: absolute; inset: -4px; }
.hm-stage.planned:hover { color: var(--accent); }
.hm-stage svg { width: 10px; height: 10px; }
.hm-stage.working::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--accent); }
.hm-stage.landed::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--ok); }
.hm-stage.reopened::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--warn); }
.hm-stage.working.busy::before { animation: hm-breathe calc(var(--dur-moment) * 2) ease-in-out infinite; }
@keyframes hm-breathe { 50% { opacity: .35; } }
@media (prefers-reduced-motion: reduce) { .hm-stage.working::before { animation: none; } }
.hm-dks-more { margin-top: 12px; }
/* Projects: every other desk, a card each, as many across as fit. */
.hm-dks { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 250px), 1fr)); gap: 16px; }
.hm-dk { min-width: 0; display: flex; flex-direction: column; padding: 12px 14px 10px; border: 1px solid var(--rule); border-radius: var(--r-md); }
.hm-dk-top { display: flex; align-items: baseline; gap: 10px; min-width: 0; margin: 0 0 6px; }
.hm-dk-add { flex: none; align-self: center; width: 20px; height: 20px; display: grid; place-items: center; padding: 0; border: 0; border-radius: var(--r-xs); background: none; color: var(--fg-3); font-size: var(--fs-body-s); line-height: 1; cursor: pointer; }
.hm-dk-add:hover { background: var(--rule-2); color: var(--fg); }
.hm-dk-foot { display: flex; align-items: center; gap: 10px; min-height: 22px; margin-top: auto; padding-top: 8px; }
.hm-dk-foot .hm-spark { margin-left: auto; }
.hm-dk .hm-park { padding: 0 0 6px; }
.hm-shelf-w { margin-top: 16px; }
.hm-dk-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs-body-s); font-weight: 600; color: var(--fg); text-decoration: none; }
.hm-dk-name:hover { text-decoration: underline; }
.hm-dk-top .hm-dots { align-self: center; }
.hm-dk-top .fact { color: var(--fg-3); }
.hm-dk-top .hm-dk-n { margin-left: auto; }
.hm-dk-left { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; margin: 0 0 6px; font-size: var(--fs-small); line-height: 1.55; color: var(--fg-2); overflow: hidden; }
.hm-dk-left b { font-weight: 500; color: var(--fg-3); margin-right: 6px; }
.hm-dk .hm-next { margin: 0; }
/* This week: the log, folded under the desks until it is asked for. */
.hm-week > summary { list-style: none; cursor: pointer; }
.hm-wk-n { margin: 6px 0 10px; color: var(--fg-2); font-size: var(--fs-small); }
.hm-wk-f { display: grid; grid-template-columns: 9em 1fr auto; align-items: center; gap: 8px; margin: 0 0 6px; font-size: var(--fs-small); }
.hm-wk-k { color: var(--fg-2); }
.hm-wk-f input { min-width: 0; padding: 3px 6px; border: 1px solid var(--rule-2); border-radius: var(--r-sm); background: var(--bg); color: var(--fg); font: inherit; }
.hm-wk-acts { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin: 10px 0 0; }
.hm-week > summary::-webkit-details-marker { display: none; }
.hm-week > summary > .s-chev { margin-left: 2px; }
.hm-week:not([open]) > summary { margin-bottom: 0; }
.hm-week-act { margin: 0 0 12px; }
.hm-facts { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 20px; margin: 0; font-size: var(--fs-small); color: var(--fg-2); }
.hm-facts .fact { color: var(--fg); }
.hm-git { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
.hm-git svg { flex: none; color: var(--fg-3); }
a.hm-repo { color: var(--fg-2); text-decoration: none; }
a.hm-repo:hover, a.hm-repo:focus-visible { color: var(--accent); }
a.hm-panels { display: inline-flex; align-items: center; gap: 6px; color: var(--fg-2); text-decoration: none; }
a.hm-panels:hover { color: var(--fg); }
.hm-pk-go { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; margin-top: 16px; }
.hm-pk-go .btn kbd { min-width: 0; margin-left: 2px; padding: 0; border: 0; background: none; color: inherit; opacity: .75; }
.hm-chips { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 16px 0 0; padding-top: 14px; border-top: 1px solid var(--rule); }
.hm-chips > .hm-s { margin-right: 4px; }
.hm-chip { display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 10px; border: 1px solid var(--rule); border-radius: var(--r-pill); font-size: var(--fs-small); color: var(--fg); text-decoration: none; }
.hm-chip:hover { border-color: var(--rule-2); background: var(--rule); }
.hm-chip .fact { color: var(--fg-3); }
/* Your days: a day, then a desk in the gutter and what happened on it. */
.hm-day { margin: 0 0 20px; }
.hm-day h3 { display: flex; align-items: baseline; gap: 8px; margin: 0 0 4px; font-size: var(--fs-small); font-weight: 600; color: var(--fg); }
.hm-day h3 .fact { font-weight: 400; color: var(--fg-3); }
.hm-entry { display: grid; grid-template-columns: 9em minmax(0, 1fr); gap: 0 16px; padding: 2px 0; }
.hm-en { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; line-height: 24px; font-size: var(--fs-small); color: var(--fg-2); text-decoration: none; }
.hm-en:hover { color: var(--fg); }
@container (max-width: 520px) { .hm-entry { grid-template-columns: minmax(0, 1fr); } }
.hm-log { list-style: none; margin: 0; padding: 0; min-width: 0; }
.hm-log li { display: flex; gap: 8px; align-items: baseline; line-height: 24px; font-size: var(--fs-ui); min-width: 0; }
.hm-g { flex: none; width: 1em; text-align: center; color: var(--fg-3); font-size: var(--fs-small); }
.hm-g.ok { color: var(--ok); }
.hm-log a { flex: none; color: var(--fg-2); text-decoration: none; font-size: var(--fs-small); }
.hm-log a.hm-t { flex: 1; color: var(--fg); font-size: inherit; }
.hm-log a:hover { text-decoration: underline; }
.hm-log .hm-c { color: var(--fg-2); }
.hm-log .fact { flex: none; color: var(--fg-3); }
.hm-log .hm-more { padding-left: calc(1em + 8px); }
.hm-earlier { margin: 4px 0 0; }
/* Projects: a name, eight weeks, how long since. */
.hm-pj { display: flex; align-items: center; gap: 12px; min-height: 28px; font-size: var(--fs-ui); min-width: 0; }
.hm-pw { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 8px; }
.hm-pn { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg); font-weight: 500; text-decoration: none; }
.hm-pn:hover { text-decoration: underline; }
.hm-spark { flex: none; display: inline-flex; align-items: flex-end; gap: 2px; height: 16px; }
.hm-spark i { width: 5px; border-radius: 1px; background: var(--fg-3); }
.hm-spark i.now { background: var(--accent); }
.hm-spark i.z { height: 2px; background: var(--rule-2); }
.hm-age { flex: none; width: 4.5em; text-align: right; color: var(--fg-3); }
.hm-shelf .hm-t { color: var(--fg-3); font-size: var(--fs-small); }
.hm-park { display: flex; align-items: center; gap: 10px; padding: 2px 0 8px; }
.hm-park input { flex: 1; min-width: 0; font: inherit; font-size: var(--fs-small); padding: 4px 8px; border: 1px solid var(--rule-2); border-radius: var(--r-sm); background: var(--bg); color: var(--fg); }
.hm-sub { margin: 16px 0 2px; font-size: var(--fs-micro); font-weight: 600; color: var(--fg-3); }
/* Claude. */
.hm-q { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.hm-bar { height: 4px; border-radius: 2px; background: var(--rule); overflow: hidden; margin: 6px 0 4px; }
.hm-bar i { display: block; height: 100%; background: var(--fg-2); }
.hm-bar.hot i { background: var(--warn); }
.hm-k { font-size: var(--fs-small); color: var(--fg-2); }
.hm-q .fact { display: block; color: var(--fg-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
/* Arrived: what came, the questions first, every action in its row. */
.hm-arr { list-style: none; margin: 0; padding: 0; }
.hm-arr > li { position: relative; display: flex; align-items: flex-start; gap: 8px; padding: 6px 0; min-width: 0; font-size: var(--fs-ui); }
.hm-arr > li + li { border-top: 1px solid var(--rule); }
.hm-ag { flex: none; width: 1em; line-height: 20px; text-align: center; color: var(--fg-3); }
.hm-ag.ask { color: var(--accent); font-weight: 600; }
.hm-ag > .r-who { display: inline-grid; width: 14px; height: 14px; vertical-align: -2px; }
.hm-ab { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.hm-ab > .hm-t { line-height: 20px; color: var(--fg); text-decoration: none; }
.hm-ab > a.hm-t:hover { text-decoration: underline; }
.hm-acts { display: flex; align-items: center; gap: 10px; min-height: 18px; min-width: 0; }
.hm-acts > .hm-s { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hm-keepl { position: absolute; right: 0; top: calc(100% - 4px); z-index: 2; display: flex; flex-direction: column; min-width: 180px; max-height: 260px; overflow-y: auto; padding: 4px; border: 1px solid var(--rule-2); border-radius: var(--r-md); background: var(--bg-raise, var(--bg)); box-shadow: var(--shadow); }
.hm-arr-all { margin: 8px 0 0; font-size: var(--fs-small); }
.hm-due { flex: none; font-size: var(--fs-small); color: var(--fg-3); white-space: nowrap; }
.hm-due.now { color: var(--accent); font-weight: 600; }
.hm-due.late { color: var(--warn); font-weight: 600; }
.hm-nt > .hm-due { margin-left: 6px; font-size: var(--fs-micro); }
.hm-wait .hm-sub { margin: 6px 0 0; font-size: var(--fs-micro); font-weight: 600; color: var(--fg-3); text-transform: uppercase; letter-spacing: .04em; }
.hm-wait .hm-wt-d { color: inherit; }
.hm-wait .hm-acts > .hm-s { flex: 1 1 auto; }
/* Four acts on a left-off row (1.48 added Park it): each one word-line,
   the by-line giving way first. */
.hm-acts > .hm-link { flex: none; white-space: nowrap; }
.hm-link.hm-ok { color: var(--accent); font-weight: 600; }
.hm-link.hm-mine { color: var(--accent); }
.hm-stage.planned.ok { color: var(--ok); }
.hm-arr-all a { color: var(--fg-2); text-decoration: none; }
.hm-arr-all a:hover { color: var(--fg); text-decoration: underline; }
/* A friend, one line: their name, then Note… and ⋯ (Mute, Remove). */
.hm-friend { position: relative; gap: 10px; }
.hm-friend > .hm-fn { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; color: var(--fg); }
.hm-friend > .hm-ren { flex: 1; min-width: 0; font: inherit; font-weight: 500; line-height: inherit; padding: 0 4px; margin: 0 0 0 -5px; border: 1px solid var(--rule-2); border-radius: var(--r-sm); background: var(--bg); color: var(--fg); }
/* Keys, folded like the week. */
.hm-meta { margin: 10px 0 0; font-size: var(--fs-small); color: var(--fg-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hm-meta a { color: inherit; text-decoration: none; }
.hm-meta a:hover { color: var(--fg); text-decoration: underline; }
.hm-foot { margin-top: 32px; font-size: var(--fs-small); color: var(--fg-3); line-height: 1.6; }
.hm-foot button { padding: 0; border: 0; background: none; font: inherit; color: var(--fg-2); cursor: pointer; }
.hm-foot button:hover { color: var(--fg); text-decoration: underline; }
/* The Inbox's foot: what was removed, and the way back. */
.inbox-removed { margin: 32px 0 0; }
.inbox-removed > .t-away { width: auto; padding-left: 14px; }
.inbox .rm { display: grid; grid-template-columns: 1fr auto; grid-template-areas: "title act" "sub act"; gap: 2px 16px; padding: 12px 14px; }
.inbox .rm > .t-undo { grid-area: act; align-self: center; }
/* A row removed here: the sidebar's ghost (app.css .t-ghost) at this row's
   height, which app.js puts on its li, with this row's padding and rule. */
.inbox > .t-gone > .t-ghost { height: 100%; align-items: center; padding: 0 14px; margin: 0 -14px; font-size: var(--fs-body-s); border-radius: 0; border-bottom: 1px solid var(--rule); }
/* The Inbox's list and its empty state: app.css's until 1.32. */
.inbox { list-style: none; margin: 0; padding: 0; }
.inbox li a { display: grid; grid-template-columns: 1fr auto; grid-template-areas: "title time" "sub sub"; gap: 2px 16px; padding: 12px 14px; margin: 0 -14px; border-radius: var(--r-md); color: inherit; border-bottom: 1px solid var(--rule); transition: background var(--t); }
.inbox li a:hover { background: var(--bg-side); text-decoration: none; }
.inbox .title { grid-area: title; font-weight: 600; font-size: var(--fs-body-s); letter-spacing: -.005em; }
.inbox .time { grid-area: time; font-size: var(--fs-small); color: var(--fg-3); font-variant-numeric: tabular-nums; }
.inbox .sub { grid-area: sub; font-size: var(--fs-small); color: var(--fg-3); }
.inbox .sub b { font-weight: 500; color: var(--fg-2); }
.inbox a.new .title::before { content: ""; display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--accent); margin: 0 9px 2px 0; vertical-align: middle; }
.inbox-sec { display: flex; align-items: center; gap: 10px; font-size: var(--fs-micro); color: var(--fg-3); font-weight: 600; margin: 32px 0 4px; }
/* Waiting's head is as tall without its buttons as with them (24 px, a
   button's): it stands while the ghost of the last one waiting does, and
   shorter, the list under it moved up 7 px. */
.inbox-head + .inbox-sec { min-height: 24px; }
.inbox-sec .n { background: var(--accent); color: var(--on-accent); border-radius: var(--r-pill); padding: 0 7px; line-height: 17px; font-variant-numeric: tabular-nums; font-size: var(--fs-micro); }
.inbox-sec button { margin-left: auto; font-weight: 500; font-size: var(--fs-small); color: var(--fg-2); padding: 3px 8px; border-radius: var(--r-sm); }
.inbox-sec button + button { margin-left: 0; }
.inbox-sec button:hover { background: var(--rule); color: var(--fg); }
.inbox.waiting { margin-bottom: 8px; }
.empty-state { margin: 20vh auto 0; max-width: 46ch; text-align: center; color: var(--fg-2); }
.empty-state h1 { font-size: var(--fs-h3); font-weight: 600; letter-spacing: -.015em; margin: 0 0 8px; color: var(--fg); }
.empty-state p { margin: 0 0 18px; font-size: var(--fs-body-s); }
.empty-state .hero .mk { display: block; width: 44px; height: 44px; margin: 0 auto 16px; }
.empty-state pre { text-align: left; font-family: var(--mono); font-size: var(--fs-ui); background: var(--code-bg); padding: 12px 16px; border-radius: var(--r-sm); display: inline-block; margin: 0; }
`;

/** The sections that can be hidden, in the order they stand. Pick up
 *  cannot: it is what the page is for. Threads and Keys were sections until
 *  1.32; a reader who hid them has nothing left to show. */
const WIDGETS = [
  ["desks", "Other desks"],
  ["claude", "Claude"],
  ["friends", "Friends"],
];

const DAY = 86400;
/** A desk this long without anything happening on it is asked, quietly,
 *  whether it is parked. */
const QUIET_DAYS = 10;

let c = null, last = null, soon = 0, reading = 0, sheet = null;
/** Where Claude Code stands here, asked once a visit to Home (/api/agents
 *  reads the agents' own files, too much for every refresh): "missing",
 *  "unconnected" or "connected"; null until it answers. The status line says
 *  nothing of a Claude at rest: the Claude box says that in a sentence. */
let claudeIs = null;
function claudeAsk() {
  fetch("/api/agents").then(r => r.json()).then(a => {
    const row = a.rows.find(r => r.id === "claude");
    const was = claudeIs;
    claudeIs = row && row.state === "connected" ? "connected" : a.claude_on_path ? "unconnected" : "missing";
    if (was !== claudeIs && last && c.view() === "home") drawUnlessTyping();
  }, () => {});
}
/** Parking in progress: the desk whose row holds the form, what is typed in
 *  it (kept across the redraws an event brings), and the one just parked,
 *  which keeps its row, with an Undo, for a moment. */
let parking = 0, parkDraft = "", parkFailed = false, justParked = 0, parkedT = 0;
/** What the week's button last said, in its own place, for a while. */
let weekSaid = null;
/** Friends (docs/PEER.md): the last /api/peers answer, drawn beside the
 *  desks; the friend just removed, who keeps a row with an Undo for a
 *  moment; the friend whose ⋯ is open (Mute, Remove); and the friend's line
 *  whose Keep on… list is open. */
let peers = null, justRemoved = 0, removedT = 0, friendMore = 0, keepOpen = 0, deskOpen = 0;
/** What an Arrived row's button did, said in the row for SAID_MS with its
 *  Undo, by row ("o12" an offer, "n5" a line): the item as it was, so the
 *  row keeps its place after the daemon has stopped listing it. */
const arrSaid = new Map();
/** The note bar: the desk chosen on its chip (0 is Pick up's), what is typed
 *  in it and the pictures waiting on that line (both kept across the redraws
 *  an event brings), and what the last Enter did, said in the bar's own row. */
let barTo = 0, barDraft = "", barPics = [], barSaid = null, barT = 0;
/** The bar's desk list while it is open: opened by the chip, with a field of
 *  its own, or by a `#` typed in the bar, from `from` to the caret at `to`.
 *  `q` narrows it, `at` is the row Enter takes. */
let menu = null;
/** How long a said line, and its Undo, stands: six seconds, everywhere (docs/DESIGN.md Q2). */
const SAID_MS = 6000;
/** Last touched first, taken once each time Home is shown: which desk Pick
 *  up offers. A line added or ticked here touches its desk, and Home must not
 *  reshuffle under the reader's hand for it. A desk new since then goes at
 *  the end. Everything else lists the desks in the reader's own order, which
 *  is the daemon's. */
let order = null;
function byOrder(xs) {
  if (!order) order = [...xs].sort((a, b) => b.touched - a.touched || b.id - a.id).map(d => d.id);
  const at = id => { const i = order.indexOf(id); return i < 0 ? order.length : i; };
  return [...xs].sort((a, b) => at(a.id) - at(b.id) || b.id - a.id);
}
/** Lines ticked (or unticked) from Home, by note id: { desk, text, i, done,
 *  err, timer }. Each keeps its row, struck through, for TICK_MS -- long enough
 *  to untick a slip -- through the reads that no longer list it. */
const ticked = new Map();
const TICK_MS = 6000;
/** True while the page's HTML is being replaced: a field losing the focus
 *  that way is not the reader leaving it. */
let drawing = false;
/** The log shows its first few days and a desk's first few lines; these are
 *  what the reader opened past that. */
const DAYS_FIRST = 3, LINES_FIRST = 4;
let allDays = false;
const opened = new Set();
/** Home shows this many desks at most, Pick up's among them, most recently
 *  touched first, so two rows of three cards; "N more desks" opens the rest in place, and stays open or
 *  shut as the reader left it. Content, not height: a page cut at a height
 *  would cut a desk's notes off wherever the window ended. */
const DESKS_SHOWN = 7;
const desksAll = () => { try { return localStorage.getItem("snyvi.home.desks") === "1"; } catch { return false; } };
const setDesksAll = on => { try { localStorage.setItem("snyvi.home.desks", on ? "1" : "0"); } catch {} };

function style() {
  if (!sheet) { sheet = Object.assign(document.createElement("style"), { id: "home-drawn", textContent: CSS }); document.head.append(sheet); }
}

const KNOWN = WIDGETS.map(w => w[0]);
const hidden = () => { try { return JSON.parse(localStorage.getItem("snyvi.home.hidden") || "[]").filter(k => KNOWN.includes(k)); } catch { return []; } };
const setHidden = xs => { try { localStorage.setItem("snyvi.home.hidden", JSON.stringify(xs)); } catch {} };
const kept = () => { try { return +localStorage.getItem("snyvi.home.pick") || 0; } catch { return 0; } };
const weekOpen = () => { try { return localStorage.getItem("snyvi.home.week") === "1"; } catch { return false; } };
const setWeekOpen = on => { try { localStorage.setItem("snyvi.home.week", on ? "1" : "0"); } catch {} };
const keep = id => { try { if (id) localStorage.setItem("snyvi.home.pick", id); else localStorage.removeItem("snyvi.home.pick"); } catch {} };

/** Draw Home into the page. `ctx` is the page's: esc, rel, relShort, plural,
 *  capability, deskApi, docEl, card (about.js's update card, as a promise),
 *  updCtx, checkUpdates, newDesk. */
export async function show(ctx) {
  c = ctx;
  style();
  order = null;
  peersDirty = true;
  tick();
  claudeAsk();
  // Lately is the corner's, drawn large here (ui/corner.js), when it is shown.
  if (!cornerMod && c.lately) c.corner?.().then(m => { cornerMod = m; redraw(); }, () => {});
  if (last) draw(last);
  await refresh();
}

/** The corner's Lately moved: its section drawn again from what Home
 *  already holds, and nothing else -- a burst of asides is not a burst of
 *  Home redrawn under the pointer. */
export function redraw() {
  const sec = c && c.view() === "home" && last && c.docEl.querySelector(".hm-arrived");
  if (!sec) return;
  const t = document.createElement("template");
  t.innerHTML = arrived(last);
  const fresh = t.content.firstElementChild;
  if (!fresh || sec.innerHTML === fresh.innerHTML) return;
  const was = sec.contains(document.activeElement) ? document.activeElement.dataset : null;
  sec.replaceWith(fresh);
  if (was?.a) fresh.querySelector(`[data-a="${window.CSS.escape(was.a)}"]${was.r ? `[data-r="${window.CSS.escape(was.r)}"]` : ""}`)?.focus({ preventScroll: true });
}
let cornerMod = null;

/** A new day draws the page again, for the date in the head and the
 *  "today" words. Between days, the minute's pass moves only the relative
 *  times ("2 min ago" to "3 min ago") in place: a read that changed nothing
 *  draws nothing (`refresh`), so the times no longer ride on the redraws. */
let ticker = 0, drawnDay = 0;
function tick() {
  if (ticker) return;
  ticker = setInterval(() => {
    if (!c || c.view() !== "home" || document.hidden || !last) return;
    if (startOfDay(Date.now() / 1000) !== drawnDay) { drawUnlessTyping(); return; }
    for (const el of c.docEl.querySelectorAll(".hm-live")) {
      const t = ago(+el.dataset.t);
      if (el.textContent !== t) el.textContent = t;
    }
  }, 60000);
}

/** The events that change the friends widget: only these fetch /api/peers
 *  again. Everything else Home shows is in /api/home. */
const PEER_EVENTS = new Set(["peers", "peernotes", "peeroffers", "pairing"]);
/** What the last read gave, as text: a read that says the same draws
 *  nothing, so a burst of events on a page that did not change leaves the
 *  row under the pointer, and the hand in the bar, where they are. */
let lastText = "", peersText = "", peersDirty = true;
/** Home went dark (another tab, the window hidden) while events came: read
 *  once when it is seen again, not once per event meanwhile. */
let dirty = false;
/** A read landed while a line was being typed in the bar: drawn when the
 *  hand leaves it, never under it. */
let held = false, composing = false;

/** Read Home again soon: many events in a burst are one read. `why` is the
 *  event's name; without one (a click on this page) the friends are read too. */
export function soonRefresh(why) {
  if (why === undefined || PEER_EVENTS.has(why)) peersDirty = true;
  clearTimeout(soon);
  soon = setTimeout(refresh, 250);
}

async function refresh() {
  if (!c || c.view() !== "home") return;
  if (document.hidden) { dirty = true; return; }
  const turn = ++reading;
  let j;
  const friends = peersDirty ? fetch("/api/peers").then(r => r.ok ? r.json() : null, () => null) : null;
  try { j = c.capability ? await c.deskApi("/api/home") : await (await fetch("/api/home")).json(); }
  catch { if (!last) c.docEl.innerHTML = `<div class="inbox-head"><h1>Home</h1><p>snyvi did not answer. <button type="button" class="btn" data-hm="retry">Try again</button></p></div>`; return; }
  const fr = friends ? await friends : null;
  if (turn !== reading || c.view() !== "home") return;
  let changed = !last;
  if (fr) {
    peersDirty = false;
    const t = JSON.stringify(fr);
    if (t !== peersText) { peersText = t; peers = fr; changed = true; }
  }
  const text = JSON.stringify(j);
  if (text !== lastText) { lastText = text; changed = true; }
  last = j;
  if (changed) drawUnlessTyping();
  // A friend's code in the address (snyvi://pair/<code>): the sheet, once.
  const code = new URLSearchParams(location.search).get("pair");
  if (code) { history.replaceState(history.state, "", "/"); c.peerCtx.peer().then(m => m.pair(c.peerCtx, code), () => {}); }
}

/** The bar has the hand and a line half typed, or a composition is open. */
function typing() {
  const a = document.activeElement;
  return composing || (a?.dataset?.hm === "bar" && c.docEl.contains(a) && a.value !== "");
}
/** Draw what was read -- unless the reader is typing in the bar, in which
 *  case it waits for the hand to leave (`focusout`, `compositionend`). */
function drawUnlessTyping() {
  if (typing()) { held = true; return; }
  held = false;
  draw(last);
}
function drawHeld() { if (held && last && c?.view() === "home") drawUnlessTyping(); }
document.addEventListener("visibilitychange", () => { if (!document.hidden && dirty && c?.view() === "home") { dirty = false; refresh(); } });

// ---------- time, in the reader's own days ----------

const startOfDay = t => { const d = new Date(t * 1000); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 1000; };
const dayKey = t => startOfDay(t);
/** "Today", "Yesterday", "Sunday", then "Mon 14 Sep". */
function dayName(t) {
  const n = Math.round((startOfDay(Date.now() / 1000) - startOfDay(t)) / DAY);
  if (n <= 0) return "Today";
  if (n === 1) return "Yesterday";
  const d = new Date(t * 1000);
  return n < 7 ? d.toLocaleDateString(undefined, { weekday: "long" }) : d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}
const clock = t => new Date(t * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
/** How long ago, in the page's own two forms, so Home and the sidebar keep
 *  one clock (the audit of 1.46.2 found four): "6 min ago" where there is
 *  room, "6m" where there is not (app.js `rel`, `relShort`). */
const ago = t => c.rel(t), age = t => c.relShort(t);
/** A relative time in the page's text, marked so the minute's pass can move
 *  it in place (`tick`). */
const live = t => `<span class="hm-live" data-t="${t}">${ago(t)}</span>`;
/** "touched 40 min ago", "touched yesterday 23:40", "touched 12 d ago". */
function touched(t) {
  if (!t) return "not opened yet";
  const n = dayName(t);
  if (Date.now() / 1000 - t < 6 * 3600 || n !== "Yesterday") return `touched ${ago(t)}`;
  return `touched yesterday ${clock(t)}`;
}

function resets(t) {
  const s = t - Date.now() / 1000;
  if (s <= 0) return "now";
  if (s < 3600) return `in ${Math.max(1, Math.round(s / 60))} min`;
  if (s < DAY) return `in ${Math.round(s / 3600)} h`;
  return new Date(t * 1000).toLocaleDateString(undefined, { weekday: "short" });
}

function group(xs, key) {
  const m = new Map();
  for (const x of xs) { const k = key(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); }
  return m;
}

// ---------- the page ----------

function draw(j) {
  const { esc, plural } = c, hid = hidden();
  const w = (key, title, body, extra = "", act = "") => hid.includes(key) ? "" :
    `<section class="hm-w" data-w="${key}" data-part="home.${key}" aria-label="${esc(title)}"><div class="hm-wh"><h2>${esc(title)}${extra}</h2>${act}` +
    `<button type="button" class="hm-hide" data-hm="hide" data-k="${key}" data-tip="Hide ${esc(title)}" data-tip-sub="the foot's Show brings it back" aria-label="Hide ${esc(title)}">Hide</button></div>${body}</section>`;
  drawnDay = startOfDay(Date.now() / 1000);
  // Friends only once there is one, or one removed to bring back.
  const anyFriend = !!(peers?.friends || []).length, fr = friendsOf();
  // Seven blocks, none that comes and goes above another (audit 67d008cb6f):
  // On you is the corner's tray, from the status line, a thread is a line on
  // its desk, the update card is under the foot, and keys are the desks' own.
  const side = waitBox(j) + arrived(j) + w("claude", "Claude", claude(j)) +
    (anyFriend ? w("friends", "Friends", friends(j), fr.length ? ` <span class="n">${fr.length}</span>` : "") : "");
  const desks = j.desks ? w("desks", "Other desks", desksList(j)) : "";
  const n = hid.filter(k => k !== "friends" || anyFriend).length;
  const html = `<div class="hm"><header class="hm-head" data-part="home.head"><h1>Home</h1><span class="hm-v">${esc(new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" }))}</span></header>` +
    `<div class="hm-st">${status(j)}</div>` +
    `<div class="hm-grid"><div class="hm-main">${bar(j)}${yourWeek(j)}${pick(j)}${desks}${week(j)}</div><div class="hm-side">${side}</div></div>` +
    `<p class="hm-foot" data-part="home.foot"><button type="button" data-hm="check">Check for updates</button> · ` +
    `<button type="button" data-hm="pair" data-tip="Pair with a friend" data-tip-sub="three words said over a call">Pair with a friend…</button>` +
    (n ? ` · ${plural(n, "section")} hidden · <button type="button" data-hm="unhide">Show</button>` : "") + `</p>` +
    // The update's card under the foot, where its coming moves nothing: the
    // sidebar's card and the version's dot are where it is seen first.
    `<div class="hm-upd" hidden></div></div>`;
  const a = document.activeElement;
  const key = b => b.dataset.hm + (b.dataset.k || "") + (b.dataset.n ? `:${b.dataset.n}` : "");
  const had = c.docEl.contains(a) && a.dataset.hm ? key(a) : null;
  // A caret in the middle of a line stays where it was.
  const sel = a?.tagName === "INPUT" ? [a.selectionStart, a.selectionEnd] : null;
  // WebKitGTK puts the page back at the top when its HTML is replaced, and
  // then glides to the focus: Home is drawn whole for a click, so it keeps
  // its place itself.
  const sc = c.docEl.closest("#main"), y = sc?.scrollTop || 0;
  drawing = true;
  c.docEl.innerHTML = html;
  drawing = false;
  if (sc && sc.scrollTop !== y) sc.scrollTo({ top: y, behavior: "instant" });
  if (had) {
    const el = [...c.docEl.querySelectorAll("[data-hm]")].find(b => key(b) === had);
    el?.focus({ preventScroll: true });
    if (el?.tagName === "INPUT") { const n = el.value.length; el.setSelectionRange(Math.min(sel?.[0] ?? n, n), Math.min(sel?.[1] ?? n, n)); }
  }
  wire();
  // The hand put back in the bar came before its listeners did.
  if (document.activeElement?.dataset?.hm === "bar") asks(document.activeElement);
  const up = c.docEl.querySelector(".hm-upd");
  if (up && j.update) c.card().then(m => m.card(up, j.update, c.updCtx()), () => {});
}

/** One line under the title, the same height whatever it says: what needs
 *  the reader, what is waiting to be read, what Claude is doing, and what is
 *  left of the account's five-hour window. Amber when a panel rang or Claude
 *  is asking. */
function status(j) {
  const { esc, plural } = c, bits = [];
  let ring = false;
  if (j.desks) {
    const asking = [];
    for (const d of j.desks) for (const p of d.panes) if (p.blocked || p.agent === "needs_you") asking.push([d, p]);
    // Only what is fresh counts, and in amber: an older turn -- its panel
    // closed, asked over half an hour ago, or its panel prompted since --
    // is said apart, in the line's own ink (src/thread.rs `mark_stale`). Six
    // turns days old read "6 things are on you" in amber, while every desk's
    // pill called them older (audit e0a854b732, X2).
    const ts = (j.turns || []).filter(w => w.via !== "dialog"), on = ts.filter(w => !w.stale).length, old = ts.length - on;
    if (asking.length) {
      ring = true;
      const [d, p] = asking[0];
      bits.push(`<a class="hm-ring" href="/desk/${d.id}" data-desk="${d.id}" data-slot="${p.slot}">${esc(d.name)} · ${esc(p.name || `panel ${p.slot}`)} needs you${asking.length > 1 ? `, and ${asking.length - 1} more` : ""}</a>`);
    }
    // On you opens the corner's tray, the one every page has, so its coming
    // moves nothing (audit 67d008cb6f, plan b0bca0a11f).
    if (on) bits.push(`<button type="button" class="hm-onyou" data-hm="turns" aria-haspopup="dialog" data-key="ctrl+alt+y">${on === 1 ? "One thing is" : `${on} things are`} on you ›</button>`);
    // Lines due by tonight, and what has waited on the reader (1.47): the
    // box at the head of the side column has them.
    const due = (j.due || []).length, wt = (j.wait || []).length;
    if (due) bits.push(`<span class="hm-due now">${due} due today</span>`);
    if (wt) bits.push(`<span class="hm-due late">${wt} waiting on you</span>`);
    if (!asking.length && !on && !due && !wt) bits.push("Nothing needs you");
    if (!on && old) bits.push(`<button type="button" class="hm-onyou old" data-hm="turns" aria-haspopup="dialog" data-tip="Older" data-tip-sub="Panels since closed, or asked over half an hour ago. They go by themselves after three days, and can come back">${old} older ›</button>`);
  }
  bits.push(j.waiting ? `<a href="/inbox" data-nav="inbox">${j.waiting} waiting</a>` : bits.length ? "nothing waiting" : "Nothing waiting");
  if (j.desks) {
    const n = j.desks.flatMap(d => d.panes).filter(p => p.agent === "working").length;
    bits.push(n ? `${plural(n, "Claude")} working` : claudeIs === "missing" ? "Claude Code not installed"
      : claudeIs === "unconnected" ? `<a href="/connect" data-nav="connect">Claude not connected</a>` : "");
  }
  // With more than one account, the one with the least left, by its name.
  const qs = quotasOf(j), lq = leastOf(qs, "five_hour"), w = windowLeft(lq?.five_hour);
  if (w) bits.push(`<span data-tip="Claude's five-hour window${qs.length > 1 ? `, as ${esc(lq.label)}` : ""}" data-tip-sub="${esc(w.text)}">${qs.length > 1 ? `${esc(lq.label)}: ` : ""}5 h window ${w.fresh ? "full" : `${w.left}% left`}</span>`);
  return `<p class="hm-status${ring ? " ring" : ""}" data-part="home.status">${bits.filter(Boolean).join(" · ")}</p>`;
}

/* ---------- On you and Threads (#90) ----------
 *
 * What agents filed on the desks (src/thread.rs): what only the reader can
 * do, across every desk, answered here; and the threads by stage. The answer
 * reaches the panel that asked with the reader's next message there, or at
 * once when the snyvi mod in that panel is holding the question. */

/** A thread a panel is moving: not shipped. One no panel is moving --
 *  parked, its panel closed, or its panel took up another -- the daemon
 *  lists nowhere (#109). */
const isMoving = t => t.stage !== "shipped" && !t.rest;

/** A desk's threads that are moving, one line each under its notes: where
 *  each is, its PR and how its checks went. The Threads block said these
 *  apart from their desks, and counted them twice (audit 67d008cb6f). */
function threadLines(j, d) {
  const { esc } = c, ts = (j.threads || []).filter(t => t.desk_id === d.id && isMoving(t));
  if (!ts.length) return "";
  return `<ul class="hm-th" aria-label="Threads on ${esc(d.name)}">` + ts.slice(0, 2).map(t =>
    `<li>${BRANCH}<span class="hm-th-n">${esc(t.name)}</span><span class="hm-t">${[t.pr ? `PR ${t.pr}${t.ci ? ` ${t.ci}` : ""}` : t.branch, t.stage].filter(Boolean).map(esc).join(" · ")}</span></li>`).join("") +
    (ts.length > 2 ? `<li class="hm-s"><a href="/desk/${d.id}" data-desk="${d.id}">and ${ts.length - 2} more</a></li>` : "") + `</ul>`;
}

/** A branch, drawn as git's own mark: two commits and the line between. */
const BRANCH = `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="4" cy="3.5" r="1.8"/><circle cx="4" cy="12.5" r="1.8"/><circle cx="12" cy="5.5" r="1.8"/><path d="M4 5.3v5.4M12 7.3c0 3-4 2.5-7.2 4"/></svg>`;

/** The dots of the panels that are doing something; a stopped panel has none. */
const liveDots = d => { const ps = d.panes.filter(p => p.running || p.blocked || p.agent === "working" || p.agent === "needs_you"); return ps.length ? `<span class="hm-dots">${ps.map(dot).join("")}</span>` : ""; };

const paneWord = p => p.blocked ? "rang" : p.agent === "needs_you" ? "Claude is asking" : p.agent === "working" ? "Claude working"
  : p.agent === "done" ? "Claude done" : p.running ? "running" : "stopped";

function dot(p) {
  const cls = p.blocked || p.agent === "needs_you" ? "need" : p.agent === "working" ? "work" : p.running ? "run" : "";
  return `<i class="hm-dot ${cls}" aria-hidden="true"></i>`;
}

/** The desk Pick up offers: the one the reader keeps there, else the one
 *  touched last. The rest, in the reader's order, are the cards. Parked
 *  desks are on the shelf, not here. */
function pickOf(j) {
  const live = (j.desks || []).filter(d => !d.parked || d.id === justParked);
  const k = kept(), hero = live.find(d => d.id === k) || byOrder(live)[0];
  return { hero, rest: live.filter(d => d !== hero), isKept: !!hero && hero.id === k };
}

function pick(j) {
  const { esc, plural } = c;
  const box = body => `<section class="hm-pick" aria-label="Pick up" data-part="home.pick">${body}</section>`;
  if (!j.desks) return box(`<p class="hm-quiet">Desks are in the snyvi window; a browser tab cannot see them. Everything your agents sent is in <a href="/inbox" data-nav="inbox">the Inbox</a>.</p>`);
  // No desk at all: Welcome's question again, as Zed's Welcome comes back
  // when the centre is empty (R12), with Welcome's two ways in (about.js).
  if (!j.desks.length) return box(`<div class="welcome hm-ask"><h2 class="w-q">What are you working on?</h2><div class="w-ask"><div class="w-btns"><button type="button" class="w-btn w-pick" data-w="pick">Choose its folder…</button><button type="button" class="btn" data-w="w-new">Start something new</button></div></div></div>`);
  const { hero: d, rest, isKept } = pickOf(j);
  if (!d) return box(`<h2>Pick up</h2><p class="hm-quiet">Every desk is parked. Unpark one under Other desks when you are ready for it.</p>`);
  const l = d.left_off, x = d.last;
  const left = l
    ? `<p class="hm-pk-left"><b>Left off</b>${esc(l.text)}<span class="fact">${l.by ? `${esc(l.by)} · ` : ""}${live(l.at)}</span>${onMe(d.id, l)}</p>`
    : x
      ? `<p class="hm-pk-left hm-derived" data-tip="No one said where this was left" data-tip-sub="so this is the last thing that happened on it"><b>Last</b>${x.kind === "tick"
          ? `✓ ${esc(x.text)}${x.commit ? ` <code>${esc(x.commit.slice(0, 7))}</code>` : ""}`
          : `sent <a href="/d/${esc(x.id)}" data-id="${esc(x.id)}">${esc(x.text)}</a>`}<span class="fact">${live(x.at)}</span></p>`
      // A new desk, nothing on it yet: the next step, not an empty field.
      : `<p class="hm-pk-left hm-quiet"><b>Next</b>ask Claude where you left off: the desk's panel has the button.</p>`;
  // A list with nothing left open is a milestone said in numbers
  // (docs/DESIGN.md §3.2); a desk with no list yet is not.
  const next = notesOf(d, 5);
  const g = d.git;
  const git = g ? `<span class="hm-git" data-tip="What git says in ${esc(d.root || "the desk's folder")}" data-tip-sub="${g.last ? `last commit ${ago(g.last.at)}: ${esc(g.last.subject)}` : "no commits yet"}">${BRANCH}<span class="fact">${esc(g.branch || "no branch")}</span>` +
    `<span>${g.changed ? `${plural(g.changed, "file")} changed` : "clean"}${g.ahead ? ` · ${g.ahead} not pushed` : ""}${g.last ? ` · committed ${live(g.last.at)}` : ""}</span></span>` + repoLink(g.remote) : "";
  // Panels that say the same are said once, "4 panels running", and one
  // that differs by its name: four "running" in a row read as a list to
  // scan for the one that is not (the audit of 1.46.2).
  const said = new Map();
  for (const p of d.panes) said.set(paneWord(p), [...(said.get(paneWord(p)) || []), p]);
  const panels = [...said].map(([w, [p, ...more]]) => more.length
    ? `<a class="hm-panels" href="/desk/${d.id}" data-desk="${d.id}">${dot(p)}${plural(more.length + 1, "panel")} <span class="hm-s">${w}</span></a>`
    : `<a class="hm-panels" href="/desk/${d.id}" data-desk="${d.id}" data-slot="${p.slot}">${dot(p)}${esc(p.name || `panel ${p.slot}`)} <span class="hm-s">${w}</span></a>`).join("");
  const facts = git || panels ? `<p class="hm-facts">${git}${panels}</p>` : "";
  // The other desks, as chips, only while Other desks below is hidden: it lists them.
  const chips = rest.length && hidden().includes("desks") ? `<p class="hm-chips"><span class="hm-s">or</span>${rest.map(o =>
    `<a class="hm-chip" href="/desk/${o.id}" data-desk="${o.id}" data-tip="${esc(o.name)} · ${o.touched ? touched(o.touched) : "not opened yet"}" data-tip-sub="${esc(o.panes.map(p => `${p.name || `panel ${p.slot}`} ${paneWord(p)}`).join(" · ") || "no panels")}">` +
    `${esc(o.name)}${liveDots(o)}<span class="fact">${o.touched ? age(o.touched) : "new"}</span></a>`).join("")}</p>` : "";
  return box(`<h2>Pick up</h2><div class="hm-pk-top"><a class="hm-pk-name" href="/desk/${d.id}" data-desk="${d.id}">${esc(d.name)}</a><span class="fact">${touched(d.touched)}</span>${spark(d.pulse)}</div>` +
    left + next + threadLines(j, d) + facts +
    `<div class="hm-pk-go"><a class="btn btn-primary" href="/desk/${d.id}" data-desk="${d.id}" data-hm-open>Open desk<kbd>↵</kbd></a>` +
    (rest.length || isKept ? `<button type="button" class="hm-link" data-hm="keep" data-k="${d.id}" data-tip="${isKept ? "Let Pick up follow the desk touched last" : "Pin this desk in Pick up"}" data-tip-sub="${isKept ? "instead of this one" : "instead of whichever was touched last"}">${isKept ? "Unpin" : "Pin here"}</button>` : "") +
    `</div>` + chips);
}

/** Where a desk's repository lives on the web, as `owner/repo ↗`: the same
 *  link the desk's rail has. Nothing for a folder with no remote. */
const FORGES = { "github.com": "GitHub", "gitlab.com": "GitLab", "codeberg.org": "Codeberg", "bitbucket.org": "Bitbucket" };
function repoLink(url) {
  const { esc } = c;
  let u;
  try { u = url && new URL(url); } catch { return ""; }
  const path = u && u.pathname.replace(/^\/+/, "");
  if (!path) return "";
  return `<a class="hm-repo" href="${esc(url)}" target="_blank" rel="noopener" data-tip="Open on ${esc(FORGES[u.hostname] || u.host)}" data-tip-sub="${esc(url)}">${esc(path)} ↗</a>`;
}

/** A desk's first open notes, each with the circle that ticks it, then "and
 *  N more" into the desk; a list with nothing left open says so in numbers
 *  (docs/DESIGN.md §3.2). A line ticked here keeps its row for a moment. */
function notesOf(d, max) {
  const { esc } = c;
  const rows = d.next.slice(0, max).map(n => ({ ...n, done: false, err: "" }));
  for (const [id, t] of ticked) {
    if (t.desk !== d.id) continue;
    const r = rows.find(x => x.id === id);
    if (r) { r.done = t.done; r.err = t.err; }
    else rows.splice(Math.min(t.i, rows.length), 0, { id, text: t.text, done: t.done, err: t.err });
  }
  // A ticked line keeping its row holds its place: the next one waits for it
  // to go rather than growing the list by a line, then shrinking it again.
  for (let k = rows.length - 1; rows.length > max && k >= 0; k--) if (!ticked.has(rows[k].id)) rows.splice(k, 1);
  const listed = rows.filter(r => d.next.some(n => n.id === r.id)).length;
  const more = d.open - listed;
  if (!rows.length) return d.done ? `<p class="hm-s hm-done">Notes done · ${d.done} of ${d.done}</p>` : "";
  return `<ul class="hm-next" aria-label="Open notes on ${esc(d.name)}">` + rows.map(r =>
    `<li class="hm-nt${r.done ? " done" : ""}"><button type="button" class="hm-tick" role="checkbox" aria-checked="${r.done}" data-hm="tick" data-k="${d.id}" data-n="${r.id}" aria-label="${r.done ? "Done" : "Not done"}: ${esc(r.text)}">${r.done ? TICK : ""}</button>${stageMark(r)}` +
    `<span class="hm-nt-t" data-tip="${esc(r.text)}"${r.reply ? ` data-tip-sub="${esc(`${r.reply_by || "you"}: ${r.reply}`)}"` : " data-tip-overflow"}>${esc(r.text)}</span>${!r.done && r.due_at ? dueChip(r.due_at) : ""}${r.err ? `<span class="hm-s hm-err" role="alert">${esc(r.err)}</span>` : ""}</li>`).join("") +
    (more > 0 ? `<li class="hm-s hm-nt-more"><a href="/desk/${d.id}" data-desk="${d.id}">and ${more} more</a></li>` : "") + `</ul>`;
}
/** A line's stage, in the slot every line keeps: the server has already
 *  settled a `working` whose conversation ended. None once it is ticked. */
function stageMark(r) {
  const { esc } = c, by = esc(r.stage_by || "an agent");
  const st = r.done ? "" : r.stage || "";
  // Out on main by a commit that names it, waiting for the reader's check
  // on its desk; or reopened, the reader having said it is still broken.
  if (!r.done && r.landed_commit)
    return `<span class="hm-stage landed" role="img" data-tip="Shipped in ${esc(r.landed_commit.slice(0, 7))}" data-tip-sub="check it on its desk: works, or not yet" aria-label="Shipped, waiting for your check"></span>`;
  if (st === "reopened") return `<span class="hm-stage reopened" role="img" data-tip="Reopened" data-tip-sub="you said it is still broken" aria-label="Reopened"></span>`;
  if (st === "planned" && r.stage_doc)
    return `<a class="hm-stage planned${r.ok_at ? " ok" : ""}" href="/d/${esc(r.stage_doc)}" data-id="${esc(r.stage_doc)}" data-tip="Planned by ${by}${r.ok_at ? ", approved by you" : ""}" data-tip-sub="${r.ok_at ? "its panel goes ahead · " : ""}click to open the plan${r.ok_at ? "" : ", and Approve it there"}" aria-label="Open the plan for ${esc(r.text)}">${DOC}</a>`;
  if (st === "working") {
    // Breathing only while the agent is at it, as on the desk's rail.
    const at = r.stage_panel ? ` in ${esc(r.stage_panel)}` : "";
    const say = r.stage_busy ? `${by} is working on it${at}` : `${by} has it${at}`;
    return `<span class="hm-stage working${r.stage_busy ? " busy" : ""}" role="img" data-tip="${say}"${r.stage_busy ? "" : ` data-tip-sub="between turns"`} aria-label="${say}"></span>`;
  }
  if (st === "read" || st === "planned") return `<span class="hm-stage read" role="img" data-tip="Read by ${by}" data-tip-sub="picked up, not planned yet" aria-label="Read by ${by}"></span>`;
  return `<span class="hm-stage" aria-hidden="true"></span>`;
}
const DOC = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.5 1.5H4.5a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V4.5z"/><path d="M9.5 1.5v3h3M6 8h4M6 10.5h4"/></svg>`;
const TICK = `<svg viewBox="0 0 16 16" width="9" height="9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7"/></svg>`;

/* ---------- the note bar ----------
 *
 * One place on Home to put a line on any desk's list: a field at the head of
 * the left column, in view however far the page has scrolled, with the desk
 * it goes on as a chip at its left -- Pick up's, until another is chosen from
 * the chip's list or by typing `#` and the start of its name, then Tab. Enter
 * keeps the line and leaves the field open for the next, as the desk's own
 * field does, and a screenshot pasted or dropped on it waits on the line until
 * then. What the Enter did is said in the bar's own row -- "Added to snyvi ·
 * Undo" -- where the hand already is. A card's + puts its desk on the chip and
 * the hand in the bar: one place to type, and no card grows a field.
 */

/** The desk the bar writes to: the one chosen, else Pick up's. */
function barDesk(j) {
  const ds = j?.desks || [];
  return ds.find(d => d.id === barTo) || (ds.length ? pickOf(j).hero : null) || ds[0] || null;
}

/** The desks the list offers, in the reader's order with the parked last;
 *  narrowed, the names that start with what was typed come first. */
function menuDesks(j) {
  const ds = j?.desks || [], q = (menu?.q || "").toLowerCase();
  const all = [...ds.filter(d => !d.parked), ...ds.filter(d => d.parked)];
  if (!q) return all;
  const starts = all.filter(d => d.name.toLowerCase().startsWith(q));
  return [...starts, ...all.filter(d => !starts.includes(d) && d.name.toLowerCase().includes(q))];
}

function bar(j) {
  const { esc, plural } = c;
  const d = barDesk(j);
  if (!d) return "";
  const n = barPics.length;
  const pend = n ? `<span class="hm-nb-pend" role="status" aria-label="${plural(n, "picture")} with this line"><span class="hm-nb-pic">${PIC}${n > 1 ? `<span class="c">${n}</span>` : ""}</span>` +
    `<button type="button" data-hm="pendx" data-tip="Leave the pictures out" aria-label="Leave the pictures out">${X}</button></span>` : "";
  return `<div class="hm-nb" data-part="home.bar"><div class="hm-nb-in">` +
    `<button type="button" class="hm-nb-to" data-hm="to" aria-haspopup="listbox" aria-expanded="${menu?.by === "chip"}" aria-controls="hm-nb-opts" data-tip="The desk this note goes on" data-tip-sub="or type # and its name in the note" aria-label="On ${esc(d.name)} · choose another desk"><span>${esc(d.name)}</span>${CHEV}</button>` +
    `<input data-hm="bar" class="hm-nb-t" maxlength="500" placeholder="Add a note" aria-label="A new note on ${esc(d.name)}" value="${esc(barDraft)}" spellcheck="false" autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="${menu?.by === "hash"}" aria-controls="hm-nb-opts">` +
    pend + `<span class="hm-nb-say">${saidHtml()}</span></div>` +
    `<div class="hm-nb-list"${menu ? "" : " hidden"}>${menu ? menuHtml(j) : ""}</div></div>`;
}

/* A date caught at the end of a line being typed (1.48): the desk's mirror
 * of the daemon's grammar (ui/desk/06-rail.js), only to show it was seen. */
const DUE_TAIL = /(?:^|[\s,·;-])((?:by|on|at|due)\s+)?((?:today|tonight|tomorrow|(?:next\s+)?(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*|weekend|next\s+week|in\s+\d+\s*(?:m|mins?|minutes?|h|hrs?|hours?|d|days?|w|weeks?)|\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*)(?:\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?|\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*$/i;
function dueGuess(t) {
  const m = DUE_TAIL.exec(t || "");
  if (!m || m.index === 0 && !m[1]) return "";
  const bare = !m[1] && !/[,·;-]\s*$/.test(t.slice(0, m.index + 1));
  if (bare && (/^\d{1,2}(:\d{2})?\s*(am|pm)?$/i.test(m[2]) || /^(mon|tue|wed|thu|fri|sat|sun|weekend|next\s+week)/i.test(m[2]))) return "";
  return m[2].trim();
}

/** The bar's right end: Enter's key while the bar has the hand, then what the
 *  last Enter did, for a moment -- or, until the next key, why it did not. */
function saidHtml() {
  const { esc } = c, s = barSaid;
  // A date caught at the line's end shows beside Enter (1.48), as on a desk.
  const g = dueGuess(barDraft);
  if (!s) return `${g ? `<span class="hm-due">due ${esc(g)}</span>` : ""}<kbd class="hm-nb-k" aria-hidden="true">↵</kbd>`;
  if (s.err) return `<span class="hm-err" role="alert">${esc(s.err)}</span>`;
  return `<span role="status">Added to <a href="/desk/${s.desk}" data-desk="${s.desk}">${esc(s.name)}</a> ·</span><button type="button" class="hm-link hm-undo" data-hm="barundo">Undo</button>`;
}

function menuHtml(j) {
  const find = menu.by === "chip" ? `<input data-hm="find" class="hm-nb-find" placeholder="Find a desk" aria-label="Find a desk" value="${c.esc(menu.q)}" spellcheck="false" autocomplete="off">` : "";
  return find + `<div class="hm-nb-opts" id="hm-nb-opts" role="listbox" aria-label="Desks">${optsHtml(j)}</div>`;
}

function optsHtml(j) {
  const { esc } = c, xs = menuDesks(j), on = barDesk(j);
  if (!xs.length) return `<p class="hm-quiet">No desk is called that.</p>`;
  menu.at = Math.min(Math.max(0, menu.at), xs.length - 1);
  return xs.map((d, i) => `<button type="button" role="option" tabindex="-1" class="hm-nb-o${i === menu.at ? " at" : ""}" aria-selected="${d.id === on?.id}" data-hm="pickto" data-k="${d.id}">` +
    `<span class="hm-nb-on">${d.id === on?.id ? TICK : ""}</span><span class="hm-t">${esc(d.name)}</span><span class="fact">${d.parked ? "parked" : d.touched ? age(d.touched) : "new"}</span></button>`).join("");
}

/** Draw the list alone, as it opens, narrows and moves: the rest of the page,
 *  and the field being typed in, are left as they are. */
function drawMenu() {
  const box = c.docEl.querySelector(".hm-nb-list");
  if (!box) return;
  c.docEl.querySelector("[data-hm=to]")?.setAttribute("aria-expanded", String(menu?.by === "chip"));
  c.docEl.querySelector("input[data-hm=bar]")?.setAttribute("aria-expanded", String(menu?.by === "hash"));
  box.hidden = !menu;
  if (!menu) { box.innerHTML = ""; return; }
  const opts = box.querySelector(".hm-nb-opts");
  if (opts && (menu.by === "chip") === !!box.querySelector("[data-hm=find]")) opts.innerHTML = optsHtml(last);
  else box.innerHTML = menuHtml(last);
  // The marked row in view, by the list's own scroll and no other.
  const at = box.querySelector(".hm-nb-o.at"), o = box.querySelector(".hm-nb-opts");
  if (at && o) {
    if (at.offsetTop < o.scrollTop) o.scrollTop = at.offsetTop;
    else if (at.offsetTop + at.offsetHeight > o.scrollTop + o.clientHeight) o.scrollTop = at.offsetTop + at.offsetHeight - o.clientHeight;
  }
}

/** A `#` and the start of a name, just before the caret, opens the list
 *  narrowed to it; a `#` nothing answers to is left as text -- "#77" is a
 *  note's own words, not a desk. */
function hashMenu(el) {
  const at = el.selectionStart ?? el.value.length, m = /(^|\s)#([^\s#]*)$/.exec(el.value.slice(0, at));
  const was = menu?.by === "hash";
  if (m) {
    const q = m[2];
    menu = { by: "hash", q, at: was && menu.q === q ? menu.at : 0, from: at - q.length - 1, to: at };
    if (!menuDesks(last).length) menu = null;
  } else if (was) menu = null;
  else return;
  drawMenu();
}

/** The desk chosen, from either list: on the chip, and the hand back in the
 *  bar. Chosen by `#`, the `#name` comes out of the line. */
function chooseDesk(id) {
  let caret = null;
  if (menu?.by === "hash") {
    const a = barDraft.slice(0, menu.from).replace(/\s+$/, ""), b = barDraft.slice(menu.to).replace(/^\s+/, "");
    barDraft = (a ? a + " " : "") + b;
    caret = a ? a.length + 1 : 0;
  }
  menu = null; barTo = id;
  draw(last);
  focusBar(caret);
}

/** The hand in the bar, without moving the page: it is in view wherever the
 *  page is. True when there is a bar to be in. */
export function focusBar(caret = null) {
  const el = c?.view() === "home" ? c.docEl.querySelector("input[data-hm=bar]") : null;
  if (!el) return false;
  el.focus({ preventScroll: true });
  const n = caret ?? el.value.length;
  el.setSelectionRange(n, n);
  return true;
}

/** The bar's right end, drawn alone: a timer running out must not redraw
 *  the field being typed in. */
function say(s) {
  clearTimeout(barT);
  barSaid = s;
  if (s && !s.err) barT = setTimeout(() => { if (barSaid === s) { barSaid = null; sayNow(); } }, SAID_MS);
}
function sayNow() { const el = c?.docEl.querySelector(".hm-nb-say"); if (el) el.innerHTML = saidHtml(); }

/** What the bar asks for while it has the hand: the line, or what a picture
 *  waiting on it shows -- the desk's own field's words. */
const asks = el => { el.placeholder = barPics.length ? "What it shows" : "What has to happen"; };

/** The pictures in a paste or a drop, of the four kinds the daemon keeps --
 *  the desk rail's own test, which lives in a chunk Home does not load. */
const images = dt => [...(dt?.files || [])].filter(f => /^image\/(png|jpeg|gif|webp)$/.test(f.type));

function addPics(fs) {
  if (!fs.length) return;
  barPics = [...barPics, ...fs];
  draw(last);
  focusBar();
}

const PIC = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="1.5"/><circle cx="5.75" cy="6.25" r="1.1"/><path d="M2.5 11.5l3.5-3.5 2.5 2.5 2-2 3 3"/></svg>`;
const X = `<svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>`;
const CHEV = `<svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 6.5L8 10l3.5-3.5"/></svg>`;

/** Every desk but the one in Pick up, most recently touched first, a card
 *  each: where it was left, what is open on it, a + to add a line, and its
 *  last eight weeks with "Park it?" once it has gone quiet. Parked desks are
 *  on the shelf under the cards. */
function desksList(j) {
  const { esc } = c;
  const { rest } = pickOf(j);
  const now = Date.now() / 1000;
  const shelf = j.desks.filter(d => d.parked && d.id !== justParked).sort((a, b) => b.parked.at - a.parked.at);
  const shelved = shelf.length ? `<div class="hm-shelf-w"><h3 class="hm-sub">Parked</h3><ul class="hm-list hm-shelf">${shelf.map(d =>
    `<li class="hm-pj"><span class="hm-pw"><a class="hm-pn" href="/desk/${d.id}" data-desk="${d.id}">${esc(d.name)}</a><span class="hm-t">${d.parked.next ? `next: ${esc(d.parked.next)}` : ""}</span></span>` +
    `<button type="button" class="hm-link" data-hm="unpark" data-k="${d.id}">Unpark</button><span class="hm-age fact">${age(d.parked.at)}</span></li>`).join("")}</ul></div>` : "";
  if (!rest.length) return `<p class="hm-quiet">Your other desks show here, each with its open notes. One project, one desk.</p>` + shelved;
  const all = desksAll(), shown = all ? rest : rest.slice(0, DESKS_SHOWN - 1), more = rest.length - (DESKS_SHOWN - 1);
  const card = d => {
    // A card says where the desk is, not how it went: its notes ticked are
    // the week's, and its eight weeks are Pick up's (audit 67d008cb6f).
    let left = d.left_off ? `<p class="hm-dk-left" data-tip="Left off" data-tip-sub="${esc(d.left_off.text)}"><b>Left off</b>${esc(d.left_off.text)}</p>` : "";
    let foot = "";
    if (d.id === justParked) foot = `<span class="hm-s">Parked</span><button type="button" class="hm-link hm-undo" data-hm="unpark" data-k="${d.id}">Undo</button>`;
    else if (parking === d.id) left = `<div class="hm-park"><input data-hm="next" data-k="${d.id}" maxlength="200" placeholder="The next step, for when you come back" aria-label="The next step on ${esc(d.name)}" value="${esc(parkDraft)}">` +
      `<button type="button" class="hm-link" data-hm="parkgo" data-k="${d.id}">Park</button><button type="button" class="hm-link" data-hm="parkno">Cancel</button>${parkFailed ? `<span class="hm-s">Could not park</span>` : ""}</div>`;
    else if (d.touched && now - d.touched > QUIET_DAYS * DAY)
      foot += `<button type="button" class="hm-link" data-hm="park" data-k="${d.id}" data-tip="Put it on the shelf" data-tip-sub="it leaves Pick up; nothing on it is closed">Park it?</button>`;
    const notes = notesOf(d, 3);
    return `<div class="hm-dk">` +
      `<div class="hm-dk-top"><a class="hm-dk-name" href="/desk/${d.id}" data-desk="${d.id}">${esc(d.name)}</a>${liveDots(d)}<span class="fact">${d.touched ? ago(d.touched) : "new"}</span>${d.open ? `<span class="hm-s hm-dk-n">${d.open} open</span>` : ""}` +
      `<button type="button" class="hm-dk-add${d.open ? "" : " hm-dk-n"}" data-hm="addopen" data-k="${d.id}" data-tip="New note on ${esc(d.name)}" data-tip-sub="in the bar at the top" aria-label="A new note on ${esc(d.name)}">+</button></div>` +
      left + (notes || (left ? "" : `<p class="hm-quiet">Nothing open. The + adds a note.</p>`)) + threadLines(j, d) +
      (foot ? `<div class="hm-dk-foot">${foot}</div>` : "") + `</div>`;
  };
  return `<div class="hm-dks">` + shown.map(card).join("") + `</div>` +
    (more > 0 ? `<button type="button" class="hm-link hm-dks-more" data-hm="desks" aria-expanded="${all}">${all ? "Show fewer desks" : `${more} more ${more === 1 ? "desk" : "desks"}`}</button>` : "") + shelved;
}

/* Your week (1.48, src/week.rs): from Sunday 20:00 to Tuesday 06:00, one
 * box above Pick up, there only while the daemon sends `week` -- what
 * shipped and whether it was told, what waits on you, three numbers, and
 * three fields that become dated lines. File it, Not this week, or Hide for
 * good. Its coming moves Pick up down once, on a Sunday evening the page is
 * drawn for; nothing in it comes and goes while it is up. */
let wkDraft = null, wkSaid = "";
function yourWeek(j) {
  const w = j.week;
  if (!w) return "";
  const { esc, plural } = c;
  const name = id => esc(deskName(j, id));
  const d = wkDraft && wkDraft.at === w.at ? wkDraft
    : (wkDraft = { at: w.at, ship: w.ship?.text || "", tell: w.tell?.text || "", drop: w.drop?.text || "" });
  const shipped = w.shipped.length ? `<ul class="hm-log">${w.shipped.map(t => `<li><span class="hm-g ok"${t.told_at ? "" : ` data-tip="Not told yet"`}>${t.told_at ? "✓" : "○"}</span><span class="hm-t">${esc(t.name)}</span>` +
    `<span class="fact">${name(t.desk)}${t.told_url ? ` · <a href="${esc(t.told_url)}" target="_blank" rel="noopener" data-tip="${esc(t.told_url)}">told ↗</a>` : t.told_at ? " · told" : " · not told"}</span></li>`).join("")}</ul>`
    : `<p class="hm-quiet">Nothing shipped this week.</p>`;
  const n = w.numbers;
  const nums = [
    n.ticked ? `${n.without_you} of ${plural(n.ticked, "line")} ticked with nothing asked of you` : "",
    n.median_s ? `a line to its tick: ${n.median_s < 86400 ? `${Math.max(1, Math.round(n.median_s / 3600))} h` : `${Math.round(n.median_s / 86400)} d`}, the median` : "",
    n.shipped ? `told ${n.told} of ${n.shipped} shipped in thirty days` : "",
    w.waited ? `${plural(w.waited, "thing")} waiting on you` : "",
  ].filter(Boolean);
  const field = (k, label, ph, p, sub) => p ? `<label class="hm-wk-f"><span class="hm-wk-k">${label}</span><input data-hm="wkf" data-k="${k}" maxlength="200" placeholder="${ph}" value="${esc(d[k])}" aria-label="${label}"><span class="fact" data-tip="${esc(sub)}">${name(p.desk)}</span></label>` : "";
  const fields = field("ship", "Next week I ship", "what goes out", w.ship, "a line there, due Friday 17:00") +
    field("tell", "I tell", "who hears of what", w.tell, "a line there, due Monday 10:00") +
    field("drop", "I drop", "leave empty to keep it", w.drop, "clears that desk's Left off; Undo on the desk");
  return `<section class="hm-w hm-wk" data-part="home.yourweek" aria-label="Your week"><div class="hm-wh"><h2>Your week</h2>` +
    `<button type="button" class="hm-hide" data-hm="wkoff" data-tip="Hide Your week" data-tip-sub="for good; the foot's Show brings it back">Hide</button></div>` +
    shipped + (nums.length ? `<p class="hm-wk-n">${nums.map(esc).join(" · ")}</p>` : "") + fields +
    `<p class="hm-wk-acts">${fields ? `<button type="button" class="hm-link hm-ok" data-hm="wkgo">File it</button>` : ""}<button type="button" class="hm-link" data-hm="wkskip">${fields ? "Not this week" : "Done"}</button>${weekButton(j)}${wkSaid ? `<span class="hm-s" role="status">${esc(wkSaid)}</span>` : ""}</p></section>`;
}

/** The box's buttons. True when the click was one of them. */
async function weekClick(k, b) {
  if (!["wkgo", "wkskip", "wkoff"].includes(k)) return false;
  const w = last?.week, d = wkDraft, api = c.deskApi;
  if (!w) return true;
  b.disabled = true;
  try {
    if (k === "wkgo") {
      const f = (p, text) => p && text.trim() ? { text: text.trim(), desk: p.desk, thread: p.thread } : null;
      await api("/api/home/week", { ship: f(w.ship, d.ship), tell: f(w.tell, d.tell) });
      // Drop is the Left off's own, as Waiting on you's Drop is.
      if (w.drop && d.drop.trim()) await api(`/api/desks/${w.drop.desk}/leftoff`, { text: "" });
    } else await api("/api/home/week", { hide: k === "wkoff" ? "off" : "week" });
    wkSaid = "";
  } catch (e) { b.disabled = false; wkSaid = "Could not do that · Try again"; draw(last); return true; }
  soonRefresh();
  return true;
}

/** The log, folded at the foot of the page until it is opened, and kept
 *  open or shut as the reader left it. */
function week(j) {
  if (!j.desks || !j.days) return "";
  const act = weekButton(j);
  return `<details class="hm-w hm-week" data-w="days" data-part="home.week"${weekOpen() ? " open" : ""}><summary class="hm-wh"><h2>This week</h2><span class="s-chev" aria-hidden="true"></span></summary>` +
    (act ? `<p class="hm-week-act">${act}</p>` : "") + yourDays(j) + `</details>`;
}

/** What happened, day by day and desk by desk: lines ticked (with the commit
 *  and the evidence the agent gave), documents sent, commits in the desk's
 *  folder, and where the work was left. The last three days with anything in
 *  them, and the rest of the week on a button; a desk's day shows its first
 *  few lines and says how many more. */
function yourDays(j) {
  const { esc } = c;
  if (!j.days) return `<p class="hm-quiet">The log of your days is in the snyvi window, beside the desks it comes from.</p>`;
  const names = new Map((j.desks || []).map(d => [d.id, d.name]));
  const rows = j.days.filter(r => names.has(r.desk));
  if (!rows.length) return `<p class="hm-quiet">Nothing yet this week. Notes ticked, documents sent, Left off lines and commits on your desks show up here, day by day.</p>`;
  const days = [...group(rows, r => dayKey(r.at)).values()].reverse();
  const shown = allDays ? days : days.slice(0, DAYS_FIRST);
  return shown.map(rs => {
    const k = dayKey(rs[0].at), n = dayName(rs[0].at);
    // "Mon 14 Sep" says its date already; the near days get it beside them.
    const date = /\d/.test(n) ? "" : new Date(rs[0].at * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short" });
    const desks = [...group(rs, r => r.desk)].sort((a, b) => b[1].at(-1).at - a[1].at(-1).at);
    return `<div class="hm-day"><h3>${n}${date ? `<span class="fact">${esc(date)}</span>` : ""}</h3>${desks.map(([id, xs]) => entry(k, id, names.get(id), xs)).join("")}</div>`;
  }).join("") +
    (days.length > DAYS_FIRST ? `<p class="hm-earlier"><button type="button" class="hm-link" data-hm="days">${allDays ? "Show fewer days" : `${days.length - DAYS_FIRST} earlier ${days.length - DAYS_FIRST === 1 ? "day" : "days"} · Show`}</button></p>` : "");
}

/** The week as a document, on the log's own heading. */
function weekButton(j) {
  const { esc } = c;
  if (!j.days?.length) return "";
  const said = weekSaid && weekSaid.until > Date.now() ? weekSaid.text : "";
  return `<button type="button" class="hm-link" data-hm="week" data-tip="A document for each desk, in its own project" data-tip-sub="the last seven days, as they are here">${said ? esc(said) : "Send this week as a doc"}</button>`;
}

/** One desk's rows on one day, newest first. A commit the agent named when it
 *  ticked a line is that line's, and is not listed again. */
function entry(day, id, name, rs) {
  const { esc, plural } = c;
  const ticks = rs.filter(r => r.kind === "tick");
  const named = ticks.map(t => t.commit).filter(Boolean);
  const commits = rs.filter(r => r.kind === "commit" && !named.some(h => h.startsWith(r.hash) || r.hash.startsWith(h)));
  const seen = new Set(), docs = rs.filter(r => r.kind === "doc" && !seen.has(r.text) && seen.add(r.text));
  const left = rs.filter(r => r.kind === "left").pop();
  const li = [];
  const at = t => `<span class="fact">${clock(t)}</span>`;
  if (left) li.push([left.at, `<li><span class="hm-g">✎</span><span class="hm-t hm-c" data-tip="Left off" data-tip-sub="${esc(left.text)}">Left off: ${esc(left.text)}</span>${at(left.at)}</li>`]);
  for (const t of ticks) li.push([t.at, `<li><span class="hm-g ok">✓</span><span class="hm-t" data-tip="${esc(t.text)}" data-tip-sub="${t.by ? `ticked by ${esc(t.by)}` : "ticked"}">${esc(t.text)}</span>` +
    `${t.commit ? `<code>${esc(t.commit.slice(0, 7))}</code>` : ""}${t.doc ? `<a href="/d/${esc(t.doc)}" data-id="${esc(t.doc)}">doc</a>` : ""}${t.evidence ? `<a href="${esc(t.evidence)}" target="_blank" rel="noopener" data-tip="${esc(t.evidence)}">see it ↗</a>` : ""}${at(t.at)}</li>`]);
  for (const x of docs) li.push([x.at, `<li><span class="hm-g"></span><a class="hm-t" href="/d/${esc(x.id)}" data-id="${esc(x.id)}">${esc(x.text)}</a>${at(x.at)}</li>`]);
  if (commits.length) {
    const newest = commits.slice(-3).reverse();
    li.push([newest[0].at, `<li><span class="hm-g">${BRANCH}</span><span class="hm-t hm-c" data-tip="${plural(commits.length, "commit")}" data-tip-sub="${esc(newest.map(x => x.text).join(" · "))}">${plural(commits.length, "commit")} · ${esc(newest[0].text)}</span>${at(newest[0].at)}</li>`]);
  }
  li.sort((a, b) => b[0] - a[0]);
  const key = `${day}:${id}`, open = opened.has(key), more = li.length - LINES_FIRST;
  const lines = (open || more <= 1 ? li : li.slice(0, LINES_FIRST)).map(x => x[1]);
  if (more > 1) lines.push(`<li class="hm-more"><button type="button" class="hm-link" data-hm="more" data-k="${esc(key)}">${open ? "Show fewer" : `${more} more`}</button></li>`);
  return `<div class="hm-entry"><a class="hm-en" href="/desk/${id}" data-desk="${id}">${esc(name)}</a><ul class="hm-log">${lines.join("")}</ul></div>`;
}

/** The last seven days of one desk, as markdown, oldest day first. */
function weekMd(name, title, rs) {
  const line = r => r.kind === "tick" ? `- ✓ ${r.text}${r.commit ? ` (\`${r.commit.slice(0, 7)}\`)` : ""}${r.evidence ? ` · [see it](${r.evidence})` : ""}`
    : r.kind === "doc" ? `- Sent [${r.text}](/d/${r.id})`
    : r.kind === "commit" ? `- Commit \`${r.hash}\` ${r.text}`
    : `- Left off: ${r.text}`;
  const out = [`# ${name} · ${title}`, ""];
  for (const day of group(rs, r => dayKey(r.at)).values())
    out.push(`## ${new Date(day[0].at * 1000).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}`, "", ...day.map(line), "");
  return out.join("\n");
}

async function sendWeek(b) {
  const j = last;
  if (!j?.days || b.disabled) return;
  const names = new Map(j.desks.map(d => [d.id, d.name]));
  const since = startOfDay(Date.now() / 1000) - 6 * DAY;
  const per = group(j.days.filter(r => r.at >= since && names.has(r.desk)), r => r.desk);
  const title = `the week to ${new Date().toLocaleDateString(undefined, { day: "numeric", month: "long" })}`;
  b.disabled = true; b.textContent = "Sending…";
  const sent = [];
  for (const [id, rs] of per) {
    try { await c.deskApi(`/api/desks/${id}/week`, { title: `${names.get(id)} · ${title}`, content: weekMd(names.get(id), title, rs) }); sent.push(names.get(id)); } catch {}
  }
  weekSaid = { text: !per.size ? "Nothing this week to send" : sent.length ? `Sent: ${sent.join(", ")}` : "Could not send · Try again", until: Date.now() + 6000 };
  draw(last);
  setTimeout(() => { if (weekSaid && weekSaid.until <= Date.now() && last && c.view() === "home") draw(last); }, 6100);
}

/** Eight weeks of a desk, a bar a week, as tall as the days with anything in
 *  them: a rhythm, not a streak. This week's bar is the current one. */
function spark(pulse = []) {
  const end = startOfDay(Date.now() / 1000) + DAY, weeks = Array.from({ length: 8 }, () => new Set());
  for (const t of pulse) { const w = Math.floor((end - t) / (7 * DAY)); if (w >= 0 && w < 8) weeks[7 - w].add(dayKey(t)); }
  const n = weeks.map(s => s.size);
  return `<span class="hm-spark" role="img" aria-label="Days with work in each of the last eight weeks: ${n.join(", ")}" data-tip="Days with work, a week a bar" data-tip-sub="eight weeks ago to this week: ${n.join(" · ")}">` +
    n.map((v, i) => v ? `<i${i === 7 ? ` class="now"` : ""} style="height:${2 + v * 2}px"></i>` : `<i class="z"></i>`).join("") + `</span>`;
}

/** Every key the desks hand their panels, one row per name: the provider,
 *  which desks have it (or every desk), and when a panel last started with
 *  it. Names only -- Home is never sent a value -- and nothing is added
 *  here: a key is a desk's, and goes in from that desk's head. */
/* ---------- friends (docs/PEER.md) ---------- */

const friendsOf = () => (peers?.friends || []).filter(f => !f.removed_at);

/** The friends, one line each: the name (when paired, when last heard from,
 *  in its tip), where their things land (→ a desk, or their own row; the
 *  window's, where the desks are), Note…, and ⋯, which opens Mute and
 *  Remove in the row. The
 *  one just removed keeps its row with an Undo; the ones removed before are
 *  a Restore away. Lines and offers are Arrived's. */
function friends(j) {
  const { esc } = c;
  if (!peers) return `<p class="hm-quiet">Could not read the friends.</p>`;
  const rows = peers.friends || [], live = rows.filter(f => !f.removed_at || f.id === justRemoved), gone = rows.filter(f => f.removed_at && f.id !== justRemoved);
  let out = live.length ? `<ul class="hm-list">${live.map(f => f.id === justRemoved
    ? `<li class="hm-pj"><span class="hm-pw"><span class="hm-t">${esc(f.name)}</span></span><span class="hm-s">Removed</span><button type="button" class="hm-link hm-undo" data-hm="frestore" data-k="${f.id}">Undo</button></li>`
    : friendRow(f, j)).join("")}</ul>` : "";
  if (gone.length) out += `<p class="hm-quiet">Removed: ${gone.map(f => `${esc(f.name)} <button type="button" class="hm-link" data-hm="frestore" data-k="${f.id}">Restore</button>`).join(" · ")}</p>`;
  return out;
}

function friendRow(f, j) {
  const { esc } = c, more = friendMore === f.id, ds = j?.desks || [];
  const at = ds.find(d => d.id === f.desk_id);
  const list = deskOpen === f.id ? `<div class="hm-keepl" role="menu" aria-label="Where ${esc(f.name)}'s things land">` +
    [{ id: 0, name: "Their own row" }, ...ds.filter(d => !d.parked)].map(d => `<button type="button" role="menuitemradio" aria-checked="${(at?.id || 0) === d.id}" class="hm-nb-o" data-hm="fdeskto" data-k="${f.id}" data-n="${d.id}"><span class="hm-nb-on">${(at?.id || 0) === d.id ? TICK : ""}</span><span class="hm-t">${esc(d.name)}</span></button>`).join("") + `</div>` : "";
  const where = ds.length && !more ? `<button type="button" class="hm-link" data-hm="fdesk" data-k="${f.id}" aria-haspopup="menu" aria-expanded="${deskOpen === f.id}" data-tip="Where their things land" data-tip-sub="${at ? `documents on ${esc(at.name)}, lines as its suggestions` : `From ${esc(f.name)} in the sidebar, lines in Arrived`}">→ ${esc(at ? at.name : "own row")} ▾</button>` : "";
  const heard = `paired ${ago(f.paired_at)}${f.last_from ? ` · from them ${ago(f.last_from)}` : ""}${f.last_to ? ` · sent ${ago(f.last_to)}` : ""}`;
  // One state at a time: what is still waiting to go says so in place of
  // what became of the last thing that went.
  return `<li class="hm-pj hm-friend" data-peer="${f.id}"><span class="hm-fn" data-tip="${esc(f.name)}" data-tip-sub="${esc(heard)}">${esc(f.name)}${f.muted ? ` <span class="hm-s">muted</span>` : ""}</span>${outbox(f) || sentLine(f)}${where}` +
    (more
      ? `<button type="button" class="hm-link" data-hm="fren" data-k="${f.id}" data-tip="The one name they have here" data-tip-sub="their row in the sidebar follows">Rename…</button>` +
        `<button type="button" class="hm-link" data-hm="fmute" data-k="${f.id}" data-tip="${f.muted ? "What they send lights up again" : "What they send arrives read"}">${f.muted ? "Unmute" : "Mute"}</button>` +
        `<button type="button" class="hm-link" data-hm="freceipts" data-k="${f.id}" data-tip="${f.read_receipts ? `${esc(f.name)} is told when you open what they sent` : `${esc(f.name)} hears only that it arrived`}">${f.read_receipts ? "Stop telling reads" : "Tell them when read"}</button>` +
        `<button type="button" class="hm-link" data-hm="fremove" data-k="${f.id}" data-tip="Remove ${esc(f.name)}" data-tip-sub="keys kept; Restore brings them back">Remove</button>`
      : `<button type="button" class="hm-link" data-hm="fnote" data-k="${f.id}" data-tip="A line for their notes">Note…</button>`) +
    `<button type="button" class="hm-link" data-hm="fmore" data-k="${f.id}" aria-expanded="${more}" aria-label="${more ? "Fewer" : "More"} for ${esc(f.name)}" data-tip="${more ? "Back" : "Rename, mute, read receipts or remove"}">⋯</button>${list}</li>`;
}

/** What became of the last thing that went to a friend, in their row: sent,
 *  arrived, read (when they allow it), or a line of yours they ticked and
 *  told you of. The rest of the last few are in its tip. */
const sentWord = x => x.done_at ? `✓ done${x.done_commit ? ` · ${x.done_commit.slice(0, 7)}` : ""}` : x.read_at ? "read" : x.arrived_at ? "arrived" : "sent";
function sentLine(f) {
  const { esc } = c, mine = (peers?.sent || []).filter(x => x.peer_id === f.id);
  if (!mine.length) return "";
  const [last, ...rest] = mine;
  return `<span class="hm-s" data-tip="${esc(last.what)} · ${esc(sentWord(last))}" data-tip-sub="${esc(rest.map(x => `${x.what}: ${sentWord(x)}`).join("; ") || `sent ${ago(last.sent_at)}`)}">${esc(sentWord(last))}</span>`;
}

/** What has not gone to a friend yet, in their row: one that stopped trying
 *  says why, with Retry; the rest are a count, the oldest's reason in its
 *  tip. Nothing when all went. */
function outbox(f) {
  const { esc } = c, mine = (peers?.outbox || []).filter(o => o.peer_id === f.id);
  if (!mine.length) return "";
  const stopped = mine.find(o => o.stopped);
  if (stopped) return `<span class="hm-s" data-tip="${esc(stopped.what || "A frame")} did not go" data-tip-sub="${esc(stopped.error || "it stopped trying")}">${mine.filter(o => o.stopped).length} stopped</span><button type="button" class="hm-link" data-hm="fretry" data-k="${f.id}" data-f="${esc(stopped.id)}">Retry</button>`;
  const why = mine[0].error || "it goes when they or the relay can be reached";
  return `<span class="hm-s" data-tip="${esc(mine[0].what || "A frame")} is waiting to go" data-tip-sub="${esc(why.replace(/^they are offline; /, ""))}">${mine.length} waiting ${/^they are offline/.test(why) ? "(offline)" : "to go"}</span>`;
}

/* ---------- Lately ---------- */

/** What came, in one place: a friend's line still waiting for a desk, with
 *  its Add to a desk…, then the corner's Lately drawn large -- documents,
 *  asides, friends' words, kept, with the rows and buttons the corner's
 *  tray has (ui/corner.js, plan b0bca0a11f). An agent's offer is On you's,
 *  in the corner. Nothing that arrives is put out of sight. */
/* ---------- what waits on the reader (1.47) ----------
 *
 * At the head of the side column, only while it has rows, as Arrived: the
 * lines due by tonight across the desks, by the dates the reader gave them
 * (src/due.rs), and what has waited on them -- a left-off that says the next
 * step is theirs, two days on, and a plan sent for notes that no one
 * approved, a day on (src/waiting.rs). Each row has its answer in it, and
 * none starts anything: Approve is a line its panel reads at its next prompt.
 */

/** A line's date in one word, and its tone: today in the accent, overdue in
 *  the warn colour, never red (the desk rail's `dueWord`). */
function dueWord(at) {
  const now = Date.now() / 1000, d = new Date(at * 1000);
  if (at <= now) { const h = (now - at) / 3600; return { w: h < 1 ? "due now" : h < 24 ? `overdue ${h | 0} h` : `overdue ${h / 24 | 0} d`, tone: " late" }; }
  const days = Math.round((startOfDay(at) - startOfDay(now)) / DAY);
  return days === 0 ? { w: `today ${clock(at)}`, tone: " now" } : days === 1 ? { w: `tomorrow ${clock(at)}`, tone: "" }
    : { w: `due ${d.toLocaleDateString(undefined, days < 7 ? { weekday: "short" } : { day: "numeric", month: "short" })}`, tone: "" };
}
const dueChip = at => { const { w, tone } = dueWord(at); return `<span class="hm-due${tone}" data-tip="Due ${c.esc(new Date(at * 1000).toLocaleString(undefined, { weekday: "long", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }))}">${c.esc(w)}</span>`; };

/** On me, on a left-off an agent said: the reader marks the next step as
 *  theirs, which `leave_off needs` says from 1.47 on and sentences from
 *  before it never did. Pressed again, it is not. */
function onMe(id, l) {
  if (!l.by || l.ok_at >= l.at && l.ok_at) return "";
  const mine = l.needs === "you";
  return ` <button type="button" class="hm-link${mine ? " hm-mine" : ""}" data-hm="onme" data-k="${id}" data-n="${mine ? "" : "you"}" aria-pressed="${mine}" data-tip="${mine ? "On you" : "On me"}" data-tip-sub="${mine ? "the next step is yours; after two days it waits on you here · click if it is not" : "the next step is yours: after two days it waits on you at the top of Home"}">${mine ? "on you" : "On me"}</button>`;
}

const deskName = (j, id) => (j.desks || []).find(d => d.id === id)?.name || "a desk";

function waitBox(j) {
  const { esc, plural } = c, due = j.due || [];
  // A desk quiet ten days with lines still open waits on you too, with Park
  // it (1.48): the desk card's own Park it?, said where the waiting is.
  const old = Date.now() / 1000 - QUIET_DAYS * DAY;
  const quiet = (j.desks || []).filter(d => !d.parked && d.open && d.touched && d.touched < old && !(j.wait || []).some(w => w.desk === d.id))
    .map(d => ({ kind: "quiet", desk: d.id, doc: "", text: `Quiet since ${new Date(d.touched * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short" })}, ${plural(d.open, "line")} open`, at: d.touched }));
  const wt = [...(j.wait || []), ...quiet];
  // A row answered here keeps its place while its words stand, with its
  // Undo, after the read that no longer has it.
  const keyOf = x => `${x.kind === "plan" ? "p" : x.kind === "quiet" ? "q" : "l"}${x.desk}:${x.doc}`;
  const present = new Set([...due.map(n => `u${n.id}`), ...wt.map(keyOf)]);
  const ghosts = [...arrSaid].filter(([k]) => /^[ulpq]/.test(k) && !present.has(k))
    .map(([, s]) => `<li><span class="hm-ab"><span class="hm-t">${esc(s.item.text || "")}</span><span class="hm-acts">${saidRow(s)}</span></span></li>`).join("");
  if (!due.length && !wt.length && !ghosts) return "";
  const where = id => `<a class="hm-t hm-wt-d" href="/desk/${id}" data-desk="${id}">${esc(deskName(j, id))}</a>`;
  const said = k => { const s = arrSaid.get(k); return s ? saidRow(s) : ""; };
  const dueRows = due.map(n => `<li><span class="hm-ab"><span class="hm-t">${esc(n.text)}</span><span class="hm-acts">` +
    (said(`u${n.id}`) || `${dueChip(n.due_at)}<span class="hm-s">${where(n.desk)}</span>` +
      `<button type="button" class="hm-link" data-hm="udone" data-k="${n.desk}" data-n="${n.id}" aria-label="Done: ${esc(n.text)}">Done</button>` +
      `<button type="button" class="hm-link" data-hm="ulater" data-k="${n.desk}" data-n="${n.id}" data-tip="Tomorrow at 9" data-tip-sub="it rings again then" aria-label="Tomorrow: ${esc(n.text)}">Tomorrow</button>`) +
    `</span></span></li>`).join("");
  const waitRows = wt.map(x => {
    const key = keyOf(x);
    const head = x.kind === "plan"
      ? `<span class="hm-t">Plan <a href="/d/${esc(x.doc)}" data-id="${esc(x.doc)}">${esc(x.text)}</a> for ${x.notes.map(n => `#${n}`).join(" ")}</span>`
      : `<span class="hm-t">${esc(x.text)}</span>`;
    const park = `<button type="button" class="hm-link" data-hm="wpark" data-k="${x.desk}" data-tip="Park it" data-tip-sub="the desk goes on the shelf; nothing on it is closed">Park it</button>`;
    const acts = x.kind === "quiet" ? park : x.kind === "plan"
      ? `<button type="button" class="hm-link hm-ok" data-hm="wplan" data-k="${x.desk}" data-n="${esc(x.doc)}" data-tip="Approve the plan" data-tip-sub="its panel hears it at its next prompt">Approve</button>`
      : `<button type="button" class="hm-link hm-ok" data-hm="wok" data-k="${x.desk}" data-tip="Approve" data-tip-sub="the next step is the agent's now; its panel hears it at its next prompt">Approve</button>` +
        `<button type="button" class="hm-link" data-hm="wlater" data-k="${x.desk}" data-tip="Tomorrow" data-tip-sub="a note on its desk, due tomorrow at 9; the left-off stays">Tomorrow</button>` +
        `<button type="button" class="hm-link" data-hm="wdrop" data-k="${x.desk}" data-tip="Drop it" data-tip-sub="clears the left-off; Undo brings it back">Drop</button>` + park;
    return `<li><span class="hm-ab">${head}<span class="hm-acts">` +
      (said(key) || `<span class="hm-s">${where(x.desk)} · ${x.by ? `${esc(x.by)} · ` : ""}${live(x.at, age)}</span>${acts}`) + `</span></span></li>`;
  }).join("");
  const sub = (t, rows) => rows && due.length && wt.length ? `<h3 class="hm-sub">${t}</h3>` : "";
  return `<section class="hm-w hm-wait" data-part="home.wait" aria-label="Waiting on you"><div class="hm-wh"><h2>${due.length && !wt.length ? "Due today" : "Waiting on you"}${due.length + wt.length ? ` <span class="n">${due.length + wt.length}</span>` : ""}</h2></div>` +
    (dueRows ? `${sub("Due today", dueRows)}<ul class="hm-arr">${dueRows}</ul>` : "") +
    (waitRows ? `${sub(plural(wt.length, "thing") + " waiting", waitRows)}<ul class="hm-arr">${waitRows}</ul>` : "") +
    (ghosts ? `<ul class="hm-arr">${ghosts}</ul>` : "") + `</section>`;
}

/** The box's buttons, and On me. True when the click was one of them. */
async function waitClick(k, id, b) {
  if (!["udone", "ulater", "wplan", "wok", "wlater", "wdrop", "wundo", "onme", "wpark", "wunpark"].includes(k)) return false;
  const n = b.dataset.n || "", api = c.deskApi;
  const x = (last?.wait || []).find(w => w.desk === id && (k !== "wplan" || w.doc === n));
  const text = k[0] === "u" ? (last?.due || []).find(d => String(d.id) === n)?.text : x?.text;
  const quiet = !x && (k === "wpark" || k === "wunpark");
  const key = k[0] === "u" ? `u${n}` : `${k === "wplan" ? "p" : quiet ? "q" : "l"}${id}:${x?.doc || ""}`;
  b.disabled = true;
  try {
    if (k === "udone") { await api(`/api/desks/${id}/notes/${n}`, { done: true }); sayRow(key, { id, text }, "Ticked"); }
    else if (k === "ulater") { await api(`/api/desks/${id}/notes/${n}`, { due: "tomorrow 9" }); sayRow(key, { id, text }, "Moved to tomorrow, 9:00"); }
    else if (k === "wplan") { await api(`/api/desks/${id}/plans/${encodeURIComponent(n)}/approve`, {}); sayRow(key, { id, text }, "Approved: its panel hears it next"); }
    else if (k === "wok") { await api(`/api/desks/${id}/leftoff`, { approve: true }); sayRow(key, { id, text }, "Approved: its panel hears it next"); }
    else if (k === "onme") await api(`/api/desks/${id}/leftoff`, { mark: n });
    else if (k === "wlater" && x) {
      const r = await api(`/api/desks/${id}/notes`, { text: x.text });
      if (r.note?.id) await api(`/api/desks/${id}/notes/${r.note.id}`, { due: "tomorrow 9" });
      await api(`/api/desks/${id}/leftoff`, { mark: "" });
      sayRow(key, { id, text }, `A note on ${deskName(last, id)}, due tomorrow at 9`);
    } else if (k === "wdrop") {
      const r = await api(`/api/desks/${id}/leftoff`, { text: "" });
      sayRow(key, { id, text, was: r.was }, "Dropped", "wundo");
    } else if (k === "wpark") {
      if (!(await park(id, ""))) return true;
      sayRow(key, { id, text: text || deskName(last, id) }, `Parked ${deskName(last, id)}`, "wunpark");
    } else if (k === "wunpark") {
      await park(id, null);
      for (const [kk, v] of arrSaid) if (v.undo === "wunpark" && v.item.id === id) { clearTimeout(v.t); arrSaid.delete(kk); }
    } else if (k === "wundo") {
      const s = [...arrSaid.values()].find(v => v.undo === "wundo" && v.item.id === id);
      if (s?.item.was) await api(`/api/desks/${id}/leftoff`, s.item.was);
      for (const [kk, v] of arrSaid) if (v === s) { clearTimeout(v.t); arrSaid.delete(kk); }
    }
  } catch (e) { b.disabled = false; c.peerCtx.toast("Could not do that", { sub: c.peerCtx.sayErr(e).why }); return true; }
  soonRefresh();
  return true;
}

function arrived(j) {
  const { plural } = c;
  // A row that was answered keeps its place while its words stand.
  const ids = new Set((peers?.notes || []).map(x => x.id));
  const lines = [...(peers?.notes || []), ...[...arrSaid].filter(([k]) => k[0] === "n" && !ids.has(+k.slice(1))).map(([, v]) => v.item)].sort((a, b) => a.id - b.id);
  // A waiting line is drawn above with its buttons, not again in the log.
  const waiting = new Set(lines.map(n => `${n.from}\n${n.text}`));
  const rows = lines.length ? `<ul class="hm-arr">${lines.map(n => lineRow(n, j)).join("")}</ul>` : "";
  // Lately hidden (app.js LATELY_SHOWN): what waits on a word from the
  // reader stays, under the section's old name, and the log goes.
  if (!c.lately) return rows ? `<section class="hm-w hm-arrived" data-w="arrived" data-part="home.arrived" aria-label="Arrived"><div class="hm-wh"><h2>Arrived</h2></div>${rows}</section>` : "";
  const lately = cornerMod ? cornerMod.trayHtml(true, r => r.kind === "line" && waiting.has(`${r.who}\n${r.text}`)) : `<p class="hm-quiet">…</p>`;
  const all = j.waiting ? `<p class="hm-arr-all"><a href="/inbox" data-nav="inbox">${plural(j.waiting, "document")} waiting in the Inbox →</a></p>` : "";
  const dot = cornerMod?.dot() ? ` <span class="cn-dot" aria-label="something new"></span>` : "";
  return `<section class="hm-w hm-arrived" data-w="arrived" data-part="home.arrived" aria-label="Lately"><div class="hm-wh"><h2>Lately${dot}</h2></div>${rows}${lately}${all}</section>`;
}

/** What a row's button did, in the row, with its Undo. */
function saidRow(s) {
  return `<span class="hm-s" role="status">${c.esc(s.say)}</span>` +
    (s.undo ? `<button type="button" class="hm-link hm-undo" data-hm="${s.undo}" data-k="${s.item.id}">Undo</button>` : "");
}

/** A friend's line: Keep on… puts it on a desk in one click, with their
 *  name on it; ✕ puts it away. Keep on… is the window's, where the desks are. */
function lineRow(n, j) {
  const { esc } = c, s = arrSaid.get("n" + n.id), ds = j.desks || [];
  const desks = [...ds.filter(d => !d.parked), ...ds.filter(d => d.parked)];
  const list = keepOpen === n.id && !s ? `<div class="hm-keepl" role="menu" aria-label="Keep it on">${desks.map(d =>
    `<button type="button" role="menuitem" class="hm-nb-o" data-hm="akeepto" data-k="${n.id}" data-n="${d.id}"><span class="hm-t">${esc(d.name)}</span>${d.parked ? `<span class="fact">parked</span>` : ""}</button>`).join("")}</div>` : "";
  return `<li data-part="home.arrived.line"><span class="hm-ag">${c.who(n.from)}</span><span class="hm-ab"><span class="hm-t">${esc(n.text)}</span><span class="hm-acts">` +
    (s ? saidRow(s) : `<span class="hm-s">from ${esc(n.from)} · ${live(n.arrived_at)}</span>` +
      (desks.length ? `<button type="button" class="hm-link" data-hm="akeep" data-k="${n.id}" aria-haspopup="menu" aria-expanded="${keepOpen === n.id}" data-tip="Add it to a desk" data-tip-sub="a note there, from ${esc(n.from)}">Add to a desk… ▾</button>` : "") +
      `<button type="button" class="hm-link" data-hm="fdrop" data-k="${n.id}" aria-label="Remove the line from ${esc(n.from)}" data-tip="Remove" data-tip-sub="Undo brings it back">✕</button>`) +
    `</span></span>${list}</li>`;
}

/** Say what a row's button did, in the row, for SAID_MS. */
function sayRow(key, item, say, undo = "") {
  clearTimeout(arrSaid.get(key)?.t);
  const v = { item, say, undo, t: 0 };
  v.t = setTimeout(() => { if (arrSaid.get(key) === v) { arrSaid.delete(key); if (c?.view() === "home" && last) draw(last); } }, SAID_MS);
  arrSaid.set(key, v);
  if (last) draw(last);
}

async function postJson(url, body) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
  let j = null; try { j = r && r.status !== 204 ? await r.json() : {}; } catch { j = {}; }
  if (!r?.ok) throw new Error(j?.error || (r ? `snyvi answered ${r.status}` : "snyvi did not answer"));
  return j;
}

/** Arrived's buttons. True when the click was one of them. */
async function arrivedClick(k, id, b) {
  if (k === "akeep") {
    keepOpen = keepOpen === id ? 0 : id; draw(last);
    c.docEl.querySelector(keepOpen ? ".hm-keepl button" : `[data-hm=akeep][data-k="${id}"]`)?.focus({ preventScroll: true });
  } else if (k === "akeepto") keepLine(id, +b.dataset.n);
  else if (k === "akundo") undoKeep(id);
  else if (k === "fdrop" || k === "fundrop") {
    const n = (peers?.notes || []).find(x => x.id === id) || arrSaid.get("n" + id)?.item;
    b.disabled = true;
    try { await postJson(`/api/peers/notes/${id}`, { what: k === "fdrop" ? "remove" : "restore" }); }
    catch (e) { b.disabled = false; c.peerCtx.toast("Could not do that", { sub: c.peerCtx.sayErr(e).why }); return true; }
    if (k === "fdrop" && n) sayRow("n" + id, n, "Removed", "fundrop");
    else { clearTimeout(arrSaid.get("n" + id)?.t); arrSaid.delete("n" + id); }
    soonRefresh();
  } else return false;
  return true;
}

/** Keep on… → a desk: the line is that desk's, from the friend, at once. */
async function keepLine(id, desk) {
  const n = (peers?.notes || []).find(x => x.id === id);
  keepOpen = 0;
  if (!n) { draw(last); return; }
  let r;
  try { r = await c.deskApi(`/api/peers/notes/${id}`, { what: "keep", desk }); }
  catch (e) { sayRow("n" + id, n, e?.message || "Could not keep it"); return; }
  sayRow("n" + id, { ...n, desk, note: r.note?.id }, `Kept on ${r.name}`, "akundo");
  c.docEl.querySelector(`[data-hm=akundo][data-k="${id}"]`)?.focus({ preventScroll: true });
  soonRefresh();
}

/** Its Undo: off the desk the ✕'s way, so nothing is deleted, and waiting again. */
async function undoKeep(id) {
  const s = arrSaid.get("n" + id);
  if (!s?.item.note) return;
  try {
    await c.deskApi(`/api/desks/${s.item.desk}/notes/${s.item.note}/remove`, {});
    await postJson(`/api/peers/notes/${id}`, { what: "restore" });
  } catch (e) { c.peerCtx.toast("Could not take it back", { sub: c.peerCtx.sayErr(e).why }); return; }
  clearTimeout(s.t); arrSaid.delete("n" + id); soonRefresh();
}

async function friendAct(k, id) {
  const r = await fetch(`/api/peers/${id}/${k}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).catch(() => null);
  if (!r || !r.ok) { c.peerCtx.toast(`Could not ${k} the friend`, { sub: r ? `snyvi answered ${r.status}` : "snyvi did not answer" }); return false; }
  return true;
}

/** What is left of one rate-limit window, as a share from 0 to 100 and a
 *  line of words. Claude Code drops a window once its reset time passes, and
 *  the daemon keeps the last reading it was given, so a window past its reset
 *  is a full one again until a Claude answers and a new reading comes. */
function windowLeft(l) {
  if (!l) return null;
  if (l.resets_at <= Date.now() / 1000) return { left: 100, fresh: true, text: `full · reset ${ago(l.resets_at)}` };
  const left = Math.round(100 - Math.max(0, Math.min(100, l.used)));
  return { left, hot: left <= 20, text: `${left}% left · resets ${resets(l.resets_at)}` };
}

/** Every Claude account's windows, as the daemon heard them, by account
 *  (`api_accounts::Usage`); the one `quota` an older daemon sent. */
const quotasOf = j => (j.quotas && j.quotas.length ? j.quotas : j.quota ? [j.quota] : []).filter(q => q.five_hour || q.seven_day);
/** The account with the least left in window `k`. */
const leastOf = (qs, k) => qs.reduce((b, q) => (!b || (windowLeft(q[k])?.left ?? 101) < (windowLeft(b[k])?.left ?? 101) ? q : b), null);

/** What is left of each account's quota and when that was read, what the
 *  Claudes in panels are doing, and the fullest context window. The bar is
 *  what is left, and turns amber at a fifth. With one account its bars are
 *  unnamed, as they always were. */
function claude(j) {
  const { esc, plural } = c;
  const qs = quotasOf(j), out = [];
  const bar = (label, l) => { const w = windowLeft(l); return w ? `<div><span class="hm-k">${label}</span><div class="hm-bar${w.hot ? " hot" : ""}"><i style="width:${w.left}%"></i></div><span class="fact">${w.text}</span></div>` : ""; };
  for (const q of qs) out.push(`${qs.length > 1 ? `<p class="hm-meta">${esc(q.label || "your login")}</p>` : ""}<div class="hm-q">${bar("5 hours", q.five_hour)}${bar("7 days", q.seven_day)}</div>${q.at ? `<p class="hm-meta fact">As of ${ago(q.at)}, from the last Claude that answered${qs.length > 1 ? " as it" : ""}.</p>` : ""}`);
  if (j.desks) {
    const ps = j.desks.flatMap(d => d.panes.map(p => ({ ...p, desk: d.name, deskId: d.id })));
    const working = ps.filter(p => p.agent === "working").length, done = ps.filter(p => p.agent === "done").length;
    const hot = ps.filter(p => p.ctx_pct != null).sort((a, b) => b.ctx_pct - a.ctx_pct)[0];
    if (working || done) out.push(`<p class="hm-meta">${working ? `${plural(working, "Claude")} working` : ""}${working && done ? " · " : ""}${done ? `${done} idle` : ""}</p>`);
    if (hot) out.push(`<p class="hm-meta"><a href="/desk/${hot.deskId}" data-desk="${hot.deskId}" data-slot="${hot.slot}">Fullest context: ${esc(hot.desk)} · ${esc(hot.name || `panel ${hot.slot}`)} at ${hot.ctx_pct}%${hot.model ? ` (${esc(hot.model)})` : ""}</a></p>`);
  }
  if (!out.length) return `<p class="hm-quiet">No Claude at work. The quota shows here once one in a panel has answered.</p>`;
  return out.join("");
}

async function park(id, next) {
  try { await c.deskApi(`/api/desks/${id}/park`, next == null ? {} : { next }); }
  catch { parkFailed = true; draw(last); return false; }
  return true;
}

function wire() {
  const el = c.docEl.querySelector(".hm");
  if (!el || el.dataset.wired) return;
  el.dataset.wired = "1";
  el.addEventListener("click", async e => {
    // Lately's rows are the corner's, and so are their buttons.
    const cn = e.target.closest("button[data-a^='cn-']");
    if (cn && cornerMod?.act(cn.dataset.a, cn)) return;
    // A click anywhere else closes an Add to a desk… list.
    if ((keepOpen || deskOpen) && !e.target.closest(".hm-keepl, [data-hm=akeep], [data-hm=fdesk]")) { keepOpen = deskOpen = 0; draw(last); }
    const b = e.target.closest("button[data-hm]");
    if (!b) return;
    const k = b.dataset.hm, id = +b.dataset.k || 0;
    // The ✕ in a folded widget's head hides it; it does not fold it.
    if (k === "hide") { e.preventDefault(); setHidden([...new Set([...hidden(), b.dataset.k])]); draw(last); c.docEl.querySelector("[data-hm=unhide]")?.focus({ preventScroll: true }); }
    else if (k === "unhide") { setHidden([]); draw(last); }
    else if (k === "turns") c.corner().then(m => m.open(), () => {});
    else if (k === "check") c.checkUpdates(b);
    else if (k === "newdesk") c.newDesk(b);
    else if (k === "keep") { keep(kept() === id ? 0 : id); draw(last); c.docEl.querySelector("[data-hm=keep]")?.focus({ preventScroll: true }); }
    else if (k === "week") sendWeek(b);
    else if (k === "tick") tickNote(id, +b.dataset.n);
    // A card's +: its desk on the chip, and the hand in the bar, which is in
    // view wherever the page is; the bar lights for a moment to say where.
    else if (k === "addopen") { barTo = id; menu = null; draw(last); focusBar(); lit(); }
    else if (k === "to") {
      if (menu?.by === "chip") { menu = null; drawMenu(); focusBar(); return; }
      const xs = menuDesks(last), on = barDesk(last);
      menu = { by: "chip", q: "", at: Math.max(0, xs.findIndex(d => d.id === on?.id)) };
      drawMenu();
      c.docEl.querySelector("input[data-hm=find]")?.focus({ preventScroll: true });
    }
    else if (k === "pickto") chooseDesk(id);
    else if (k === "pendx") { barPics = []; draw(last); focusBar(); }
    else if (k === "barundo") undoAdd();
    else if (k === "desks") { setDesksAll(!desksAll()); draw(last); c.docEl.querySelector("[data-hm=desks]")?.focus({ preventScroll: true }); }
    else if (k === "days") { allDays = !allDays; draw(last); c.docEl.querySelector("[data-hm=days]")?.focus({ preventScroll: true }); }
    else if (k === "more") { const key = b.dataset.k; opened.has(key) ? opened.delete(key) : opened.add(key); draw(last); }
    else if (k === "park") { parking = id; parkDraft = ""; parkFailed = false; draw(last); c.docEl.querySelector("input[data-hm=next]")?.focus(); }
    else if (k === "parkno") { parking = 0; parkFailed = false; draw(last); }
    else if (k === "parkgo") parkNow(id);
    else if (k === "unpark") {
      b.disabled = true;
      if (!(await park(id, null))) return;
      if (justParked === id) { justParked = 0; clearTimeout(parkedT); }
      soonRefresh();
    }
    else if (!(await waitClick(k, id, b)) && !(await weekClick(k, b))) friendClick(k, id, b);
  });
  el.addEventListener("input", e => {
    if (e.target.dataset?.hm === "next") parkDraft = e.target.value;
    else if (e.target.dataset?.hm === "wkf" && wkDraft) wkDraft[e.target.dataset.k] = e.target.value;
    else if (e.target.dataset?.hm === "bar") { barDraft = e.target.value; if (barSaid?.err) say(null); sayNow(); hashMenu(e.target); }
    else if (e.target.dataset?.hm === "find" && menu) { menu.q = e.target.value; menu.at = 0; drawMenu(); }
  });
  // The list's rows take a click without taking the hand from the field, and
  // so does the ✕ that leaves the pictures out.
  el.addEventListener("mousedown", e => { if (e.target.closest?.("[data-hm=pickto], [data-hm=pendx]")) e.preventDefault(); });
  // A screenshot pasted into the bar, or dropped on it, waits on the line.
  el.addEventListener("paste", e => {
    if (e.target.dataset?.hm !== "bar") return;
    const fs = images(e.clipboardData);
    if (fs.length) { e.preventDefault(); addPics(fs); }
  });
  el.addEventListener("dragover", e => {
    const nb = e.target.closest?.(".hm-nb");
    if (!nb || ![...(e.dataTransfer?.types || [])].includes("Files")) return;
    e.preventDefault(); nb.classList.add("drop");
  });
  el.addEventListener("dragleave", e => { const nb = e.target.closest?.(".hm-nb"); if (nb && !nb.contains(e.relatedTarget)) nb.classList.remove("drop"); });
  el.addEventListener("drop", e => {
    const nb = e.target.closest?.(".hm-nb");
    if (!nb) return;
    e.preventDefault(); nb.classList.remove("drop");
    addPics(images(e.dataTransfer));
  });
  el.addEventListener("focusin", e => { if (e.target.dataset?.hm === "bar") asks(e.target); });
  // A read that came while a line was being composed is drawn once it is.
  el.addEventListener("compositionstart", () => { composing = true; });
  el.addEventListener("compositionend", () => { composing = false; setTimeout(drawHeld, 0); });
  // The week stays as the reader left it, folded or open.
  el.addEventListener("toggle", e => { if (e.target.matches?.(".hm-week")) setWeekOpen(e.target.open); }, true);
  // The hand leaving the bar closes its list; what is typed in it waits, as typed.
  el.addEventListener("focusout", e => {
    if (drawing || !e.target.closest?.(".hm-nb")) return;
    if (e.target.dataset?.hm === "bar") e.target.placeholder = "Add a note";
    if (menu && !e.relatedTarget?.closest?.(".hm-nb")) { menu = null; drawMenu(); }
    // What was read while the line was being typed, drawn now the hand is
    // out of the bar -- after the focus has moved, so the draw sees where.
    if (held) setTimeout(drawHeld, 0);
  });
  el.addEventListener("keydown", e => {
    if (e.key === "Escape" && (keepOpen || deskOpen)) { e.preventDefault(); e.stopPropagation(); const back = keepOpen ? `[data-hm=akeep][data-k="${keepOpen}"]` : `[data-hm=fdesk][data-k="${deskOpen}"]`; keepOpen = deskOpen = 0; draw(last); c.docEl.querySelector(back)?.focus({ preventScroll: true }); return; }
    const f = e.target.dataset?.hm;
    if (f === "bar" || f === "find") {
      const xs = menu ? menuDesks(last) : [];
      if (menu && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
        e.preventDefault();
        if (xs.length) { menu.at = (menu.at + (e.key === "ArrowDown" ? 1 : -1) + xs.length) % xs.length; drawMenu(); }
      }
      // Enter on an open list takes the marked desk; so does Tab after a `#`.
      else if (menu && (e.key === "Enter" || (e.key === "Tab" && !e.shiftKey && menu.by === "hash"))) {
        if (xs[menu.at]) { e.preventDefault(); chooseDesk(xs[menu.at].id); }
        else if (e.key === "Enter") e.preventDefault();
      }
      else if (e.key === "Escape") {
        e.preventDefault(); e.stopPropagation();
        if (menu) { const by = menu.by; menu = null; drawMenu(); if (by === "chip") focusBar(); }
        else e.target.blur();
      }
      else if (f === "bar" && e.key === "Enter") { e.preventDefault(); addNote(); }
      return;
    }
    if (e.target.dataset?.hm !== "next") return;
    if (e.key === "Enter") { e.preventDefault(); parkNow(+e.target.dataset.k); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); parking = 0; draw(last); }
  });
}

/** Rename… in a friend's ⋯: the name becomes a field in its place, Enter
 *  keeps it, Escape gives up. Their one name: the sidebar's From row and
 *  every head follow (src/server/api_peer.rs `peer_row_follows`). */
function friendRename(id) {
  const f = friendsOf().find(x => x.id === id), nm = c.docEl.querySelector(`.hm-friend[data-peer="${id}"] > .hm-fn`);
  if (!f || !nm) return;
  const input = Object.assign(document.createElement("input"), { className: "hm-ren", value: f.name, maxLength: 60, spellcheck: false, autocomplete: "off" });
  input.setAttribute("aria-label", `Name for ${f.name}`);
  nm.replaceWith(input); input.focus(); input.select();
  let done = false;
  const finish = async keep => {
    if (done) return;
    done = true;
    const next = input.value.trim();
    if (keep && next && next !== f.name) {
      const r = await fetch(`/api/peers/${id}/rename`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: next }) }).catch(() => null);
      if (r?.ok) f.name = next; else c.peerCtx.toast(`Could not rename ${f.name}`);
    }
    friendMore = 0; draw(last);
    c.docEl.querySelector(`[data-hm=fmore][data-k="${id}"]`)?.focus({ preventScroll: true });
  };
  input.addEventListener("keydown", e => {
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); finish(true); } else if (e.key === "Escape") { e.preventDefault(); finish(false); }
  });
  input.addEventListener("blur", () => finish(true));
}

/** Friends and Arrived: the sheets are peer.js's; the rows' own actions are
 *  here. Out of `wire` so that stays a screen (bench/size.mjs). */
async function friendClick(k, id, b) {
  if (await arrivedClick(k, id, b)) return;
  if (k === "pair") c.peerCtx.peer().then(m => m.pair(c.peerCtx), () => c.peerCtx.toast("Could not open the pairing sheet"));
  else if (k === "fnote") { const f = friendsOf().find(x => x.id === id); if (f) c.peerCtx.peer().then(m => m.note(c.peerCtx, id, f.name), () => {}); }
  else if (k === "fren") friendRename(id);
  else if (k === "fmore") { friendMore = friendMore === id ? 0 : id; draw(last); c.docEl.querySelector(`[data-hm=fmore][data-k="${id}"]`)?.focus({ preventScroll: true }); }
  else if (k === "fdesk") { deskOpen = deskOpen === id ? 0 : id; draw(last); c.docEl.querySelector(deskOpen ? `[data-hm=fdeskto][data-k="${id}"][aria-checked=true]` : `[data-hm=fdesk][data-k="${id}"]`)?.focus({ preventScroll: true }); }
  else if (k === "fdeskto") {
    deskOpen = 0;
    try { await c.deskApi(`/api/peers/${id}/desk`, { desk: +b.dataset.n }); }
    catch (e) { c.peerCtx.toast("Could not change that", { sub: c.peerCtx.sayErr(e).why }); draw(last); return; }
    const f = friendsOf().find(x => x.id === id);
    if (f) f.desk_id = +b.dataset.n;
    draw(last); c.docEl.querySelector(`[data-hm=fdesk][data-k="${id}"]`)?.focus({ preventScroll: true });
    soonRefresh();
  }
  else if (k === "fretry") {
    b.disabled = true;
    const r = await fetch(`/api/peers/outbox/${encodeURIComponent(b.dataset.f)}/retry`, { method: "POST" }).catch(() => null);
    if (!r?.ok) { b.disabled = false; c.peerCtx.toast("Could not try again"); } else soonRefresh();
  }
  else if (k === "freceipts") {
    const f = friendsOf().find(x => x.id === id);
    const r = await fetch(`/api/peers/${id}/receipts`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ on: !f?.read_receipts }) }).catch(() => null);
    if (!r?.ok) c.peerCtx.toast("Could not change that"); else soonRefresh();
  }
  else if (k === "fmute") {
    const f = friendsOf().find(x => x.id === id);
    const r = await fetch(`/api/peers/${id}/mute`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ muted: !f?.muted }) }).catch(() => null);
    if (!r?.ok) c.peerCtx.toast("Could not change that"); else soonRefresh();
  }
  else if (k === "fremove") {
    b.disabled = true;
    if (!(await friendAct("remove", id))) return;
    friendMore = 0; justRemoved = id; clearTimeout(removedT);
    removedT = setTimeout(() => { justRemoved = 0; if (c?.view() === "home") draw(last); }, SAID_MS);
    soonRefresh();
  }
  else if (k === "frestore") {
    b.disabled = true;
    if (!(await friendAct("restore", id))) return;
    if (justRemoved === id) { justRemoved = 0; clearTimeout(removedT); }
    soonRefresh();
  }
}

/** Tick a line where it stands, or untick one just ticked. The circle fills
 *  at once and the daemon is told after; the row keeps its place, struck
 *  through, for TICK_MS, and a no puts the circle back and says so in the row. */
async function tickNote(desk, n) {
  const d = last?.desks?.find(x => x.id === desk);
  if (!d || !n) return;
  const was = ticked.get(n), i = d.next.findIndex(x => x.id === n);
  const text = was ? was.text : d.next[i]?.text;
  if (text == null) return;
  clearTimeout(was?.timer);
  const rec = { desk, text, i: was ? was.i : Math.max(0, i), done: !(was && was.done), err: "", timer: 0 };
  ticked.set(n, rec);
  draw(last);
  try { await c.deskApi(`/api/desks/${desk}/notes/${n}`, { done: rec.done }); }
  catch { rec.done = !rec.done; rec.err = rec.done ? "Could not untick it" : "Could not tick it"; }
  rec.timer = setTimeout(() => { if (ticked.get(n) === rec) { ticked.delete(n); if (last && c.view() === "home") draw(last); } }, TICK_MS);
  if (last && c.view() === "home") draw(last);
  soonRefresh();
}

/** Keep the line in the bar on the chip's desk. The bar empties at once and
 *  keeps the hand, for the next: a list is written in a run. The line shows
 *  in its desk's card, and the bar says where it went, with an Undo; a no
 *  puts what was typed back, and says why where the Enter was. */
async function addNote() {
  const d = barDesk(last), pics = barPics;
  // A line that is only a picture still needs words to be a line: these,
  // until the reader writes their own -- as on the desk.
  const text = barDraft.trim() || (pics.length ? "A picture" : "");
  if (!d || !text) return;
  barDraft = ""; barPics = []; menu = null; say(null);
  draw(last); focusBar();
  let r;
  try { r = await c.deskApi(`/api/desks/${d.id}/notes`, { text }); }
  catch (e) {
    // What was typed is not lost to a no, unless the next line is already being written.
    if (!barDraft.trim() && !barPics.length) { barDraft = pics.length && text === "A picture" ? "" : text; barPics = pics; barTo = d.id; }
    say({ err: `Could not add the note${/keeps \d+ notes/.test(e?.message || "") ? ` · ${d.name} is full` : ""}` });
    if (c.view() === "home") { draw(last); focusBar(); }
    return;
  }
  let lost = 0;
  if (r?.note) for (const f of pics) { try { await c.deskApi(`/api/desks/${d.id}/notes/${r.note.id}/image`, f, f.type); } catch { lost++; } }
  if (r?.note) { if (d.next.length < 5) d.next.push({ id: r.note.id, text: r.note.text }); d.open += 1; }
  say(lost ? { err: `Added to ${d.name}, without ${lost === 1 ? "the picture" : c.plural(lost, "picture")}` } : { desk: d.id, name: d.name, id: r?.note?.id, text });
  if (c.view() === "home") draw(last);
  soonRefresh();
}

/** The bar's Undo: the line comes off its desk -- the ✕'s way, so nothing is
 *  deleted -- and back into the bar, on its desk, to be put right. */
async function undoAdd() {
  const s = barSaid;
  if (!s || s.err || !s.id) return;
  say(null); sayNow();
  try { await c.deskApi(`/api/desks/${s.desk}/notes/${s.id}/remove`, {}); }
  catch { say({ err: "Could not take it back" }); sayNow(); return; }
  const d = last?.desks?.find(x => x.id === s.desk);
  if (d) { d.next = d.next.filter(n => n.id !== s.id); d.open = Math.max(0, d.open - 1); }
  if (!barDraft.trim()) { barDraft = s.text === "A picture" ? "" : s.text; barTo = s.desk; }
  draw(last); focusBar(); soonRefresh();
}

/** The bar lights for a moment, so a + at the foot of the page says where
 *  the hand went. */
function lit() {
  const nb = c.docEl.querySelector(".hm-nb");
  if (!nb) return;
  nb.classList.remove("lit"); void nb.offsetWidth; nb.classList.add("lit");
}

/** A picture the Linux window read off the clipboard itself, on Ctrl+V: its
 *  engine gives the paste event nothing for an image (src/bin/app.rs). Taken
 *  when the bar has the hand. */
addEventListener("snyvi-paste-image", e => {
  const at = document.activeElement;
  if (!c || c.view() !== "home" || at?.dataset?.hm !== "bar" || !c.docEl.contains(at) || typeof e.detail !== "string") return;
  const bin = atob(e.detail.slice(e.detail.indexOf(",") + 1)), buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  addPics([new File([buf], "pasted.png", { type: "image/png" })]);
});

/** Park the desk with what was typed: the row keeps its place and says so,
 *  with an Undo, for four seconds, and then goes up on the shelf. */
async function parkNow(id) {
  parkFailed = false;
  if (!(await park(id, parkDraft.trim()))) return;
  parking = 0; parkDraft = ""; justParked = id;
  draw(last);
  clearTimeout(parkedT);
  parkedT = setTimeout(() => { justParked = 0; if (last && c.view() === "home") draw(last); }, SAID_MS);
  soonRefresh();
}

// Enter opens the desk Pick up offers, from anywhere on Home that is not
// itself something to type in or press.
document.addEventListener("keydown", e => {
  if (e.key !== "Enter" || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || !c || c.view() !== "home") return;
  if (e.target.closest?.("input, textarea, select, button, a, summary, [contenteditable]") || document.querySelector("dialog[open]")) return;
  const a = c.docEl.querySelector("[data-hm-open]");
  if (a) { e.preventDefault(); a.click(); }
});

/* After the Undo has gone: "N removed · Show" at the foot of the Inbox,
 * and the list it opens, an Undo on each row, until prune takes them
 * (docs/DESIGN.md §4.4). Documents, asides and closed desks; a desk's
 * notes and panels are its rail's to show. The list stays open through the redraw its own
 * Undo brings, and closes when the reader leaves the Inbox. */
let removedOpen = false;
export async function removedLine(fresh, { view, capability, deskApi, docEl, esc, rel, post, loadDesks, toast }) {
  if (fresh) removedOpen = false;
  let items;
  try { items = (capability ? await deskApi("/api/removed") : await (await fetch("/api/removed")).json()).items.filter(r => r.kind !== "note" && r.kind !== "panel"); } catch { return; }
  if (!items?.length || view() !== "inbox" || docEl.querySelector(".inbox-removed")) return;
  style();
  const el = document.createElement("div");
  el.className = "inbox-removed";
  const list = () => {
    removedOpen = true;
    el.innerHTML = `<h2 class="inbox-sec">Removed</h2><ul class="inbox">${items.map((r, i) =>
      `<li><div class="rm"><span class="title">${esc(r.title)}</span><span class="sub">${esc(r.from || r.kind)} · removed ${rel(r.at)}${r.versions > 1 ? ` · ${r.versions} versions` : ""}</span><button type="button" class="t-undo" data-i="${i}">Undo</button></div></li>`).join("")}</ul>`;
  };
  el.innerHTML = `<button type="button" class="t-away">${items.length} removed · Show</button>`;
  el.addEventListener("click", async e => {
    if (e.target.closest(".t-away")) { list(); el.querySelector("[data-i]")?.focus({ preventScroll: true }); return; }
    const b = e.target.closest("[data-i]");
    if (!b || b.disabled) return;
    const r = items[b.dataset.i];
    b.disabled = true;
    // Back: the row says so; a document's "restored" redraws the Inbox with it in.
    if (r.kind === "desk") { try { await deskApi(r.restore, {}); await loadDesks(); return void (b.textContent = "Back"); } catch {} }
    else if ((await post(r.restore, r.kind === "aside" || r.kind === "lately" ? { ids: [Number(r.id)] } : null))?.ok) return void (b.textContent = "Back");
    b.disabled = false; b.textContent = "Retry";
    toast("Could not bring it back", { sub: r.title, at: b });
  });
  if (removedOpen) list();
  docEl.append(el);
}

/** The Inbox's own page, drawn here beside Home: what is waiting first,
 *  then the rest, both newest first, each document once. `/inbox` and the
 *  sidebar's Recent (`/inbox?recent`) are this one page under their own
 *  names: they were two, one listing what waits twice, the other saying
 *  "Unread" (the audit of 1.46.2). */
export function inboxHtml(items, { state, esc, rel, plural, mascotHead, kindTag, waitingRow, noteKnown, recent, ghost }) {
  style();
  const row = d => (noteKnown(d), `<li><a href="/d/${d.id}" class="${waitingRow(d) ? "new" : ""}" data-id="${d.id}"><span class="title">${esc(d.title)}</span><span class="time">${rel(d.received_at)}</span><span class="sub"><b>${esc(d.project)}</b> · ${esc(d.workflow_title)} · ${kindTag(d.kind)}</span></a></li>`);
  // A document just removed here stands as its ghost where its row was
  // (app.js's ghostRow, at the row's height) until its Undo is over.
  const list = (sec, ds) => { const h = ds.map(row); if (ghost?.sec === sec) h.splice(ghost.at, 0, ghost.html); return h.join(""); };
  // The one empty state (docs/DESIGN.md §3.4): snyvi at rest, one
  // sentence, one button.
  if (!items.length && !ghost) return `<div class="empty-state"><span class="hero">${mascotHead("rest")}</span><h1>Nothing in the Inbox yet</h1>` +
    `<p>What your agents write lands here, filed by project.</p><button type="button" class="btn btn-primary" data-nav="start">How snyvi works</button></div>`;
  // What is waiting comes first, so Monday's plan is not under ten
  // documents read since. Its head stands while the ghost of the last one
  // waiting does, so the list under it does not move up.
  const n = state.waiting, w = n || ghost?.sec === "waiting", held = new Set(state.queue.map(d => d.id));
  return `<div class="inbox-head"><h1>${recent ? "Recent" : "Inbox"}</h1><p>${n ? `${plural(n, "document")} waiting, then the rest, newest first.` : "Newest first, across every project."}</p></div>` +
    (w ? `<h2 class="inbox-sec">Waiting${n ? `<span class="n">${n}</span><button type="button" data-q="next">Open the newest<kbd class="lk">n</kbd></button><button type="button" data-q="clear">Mark all read</button>` : ""}</h2><ul class="inbox waiting">${list("waiting", state.queue)}</ul><h2 class="inbox-sec">Earlier</h2>` : "") +
    `<ul class="inbox">${list("rest", items.filter(d => !held.has(d.id)))}</ul>`;
}


// The retry on a Home that could not be read is outside `.hm`.
document.addEventListener("click", e => { if (c && e.target.closest("[data-hm=retry]")) refresh(); });
