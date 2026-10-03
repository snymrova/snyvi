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
 * boxes. What day is it? -- Today: the time and the month. And the trail --
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
 * and not a thing in the library, and so is the desk kept in Pick up. Nothing
 * here moves when something arrives: the status line is one line whatever it
 * says, and a widget with nothing to say says so rather than going away.
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
.hm .fact { font-family: var(--mono); font-size: var(--fs-micro); font-variant-numeric: tabular-nums; }
/* Pick up, the desks and the week on the left, the side column beside them. */
.hm-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(280px, 340px); grid-template-areas: "main side"; gap: 32px 48px; align-items: start; }
.hm-grid.no-side { grid-template-columns: minmax(0, 1fr); grid-template-areas: "main"; }
@container (max-width: 760px) {
  .hm-grid { grid-template-columns: minmax(0, 1fr); grid-template-areas: "main" "side"; }
  .hm-grid.no-side { grid-template-areas: "main"; }
}
.hm-main { grid-area: main; display: grid; gap: 32px; min-width: 0; }
.hm-side { grid-area: side; display: grid; gap: 32px; min-width: 0; }
/* A section: a label on a hairline, and space doing the rest. */
.hm-w { min-width: 0; }
.hm-wh { display: flex; align-items: center; gap: 8px; height: 28px; margin: 0 0 8px; border-bottom: 1px solid var(--rule); }
.hm-wh h2 { margin: 0; font-size: var(--fs-micro); font-weight: 600; color: var(--fg-3); }
.hm-wh h2 .n { margin-left: 6px; font-weight: 500; font-variant-numeric: tabular-nums; }
.hm-wh .hm-act { margin-left: auto; }
.hm-hide { flex: none; width: 20px; height: 20px; display: grid; place-items: center; padding: 0; border: 0; border-radius: var(--r-xs); background: none; color: var(--fg-3); cursor: pointer; opacity: 0; font-size: var(--fs-micro); }
.hm-wh .hm-act + .hm-hide { margin-left: 0; }
.hm-wh h2 + .hm-hide { margin-left: auto; }
.hm-w:is(:hover, :focus-within) .hm-hide { opacity: 1; }
.hm-hide:hover { background: var(--rule-2); color: var(--fg); }
.hm-quiet { margin: 0; color: var(--fg-3); font-size: var(--fs-small); line-height: 1.6; }
.hm-s { flex: none; color: var(--fg-3); font-size: var(--fs-small); }
.hm-t { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hm-list { list-style: none; margin: 0; padding: 0; }
.hm-kn { font-family: var(--mono); font-size: 12px; font-weight: 600; color: var(--fg); }
.hm-key .hm-t a { color: inherit; }
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
.hm-pick > h2 { margin: 0 0 4px; font-size: var(--fs-micro); font-weight: 600; color: var(--fg-3); }
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
.hm-pk-left .fact { color: var(--fg-3); margin-left: 4px; }
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
/* Today: the time, the date, and the month, Monday first. */
.hm-time { margin: 0; font-size: 40px; font-weight: 600; line-height: 1.1; letter-spacing: -.02em; font-variant-numeric: tabular-nums; color: var(--fg); }
.hm-date { margin: 4px 0 12px; font-size: var(--fs-small); color: var(--fg-2); }
.hm-cal { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 2px 0; font-size: var(--fs-micro); font-variant-numeric: tabular-nums; text-align: center; }
.hm-cal > * { height: 24px; line-height: 24px; color: var(--fg-2); }
.hm-cal > b { font-weight: 500; color: var(--fg-3); }
.hm-cal > .we { color: var(--fg-3); }
.hm-cal > .today { justify-self: center; width: 24px; border-radius: 50%; background: var(--accent); color: var(--bg); font-weight: 600; }
.hm-meta { margin: 10px 0 0; font-size: var(--fs-small); color: var(--fg-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hm-meta a { color: inherit; text-decoration: none; }
.hm-meta a:hover { color: var(--fg); text-decoration: underline; }
.hm-foot { margin-top: 32px; font-size: var(--fs-small); color: var(--fg-3); }
.hm-foot button { padding: 0; border: 0; background: none; font: inherit; color: var(--fg-2); cursor: pointer; }
.hm-foot button:hover { color: var(--fg); text-decoration: underline; }
/* The Inbox's foot: what was removed, and the way back. */
.inbox-removed { margin: 32px 0 0; }
.inbox-removed > .t-away { width: auto; padding-left: 14px; }
.inbox .rm { display: grid; grid-template-columns: 1fr auto; grid-template-areas: "title act" "sub act"; gap: 2px 16px; padding: 12px 14px; }
.inbox .rm > .t-undo { grid-area: act; align-self: center; }
`;

/** The widgets that can be hidden, in the order they stand. Pick up cannot:
 *  it is what the page is for. */
const WIDGETS = [
  ["desks", "Projects"],
  ["today", "Today"],
  ["keys", "Keys"],
  ["claude", "Claude"],
  ["snyvi", "snyvi"],
];

const DAY = 86400;
/** A desk this long without anything happening on it is asked, quietly,
 *  whether it is parked. */
const QUIET_DAYS = 10;

let c = null, last = null, soon = 0, reading = 0, sheet = null;
/** Parking in progress: the desk whose row holds the form, what is typed in
 *  it (kept across the redraws an event brings), and the one just parked,
 *  which keeps its row, with an Undo, for a moment. */
let parking = 0, parkDraft = "", parkFailed = false, justParked = 0, parkedT = 0;
/** What the week's button last said, in its own place, for a while. */
let weekSaid = null;
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
  tick();
  if (last) draw(last);
  await refresh();
}

/** Today's time, kept by itself: only its own text changes, so nothing the
 *  reader is in -- a field, a focus -- is touched by it. A new day draws the
 *  page again, for the calendar and the "today" words. */
let ticker = 0, drawnDay = 0;
function tick() {
  if (ticker) return;
  ticker = setInterval(() => {
    if (!c || c.view() !== "home") return;
    if (startOfDay(Date.now() / 1000) !== drawnDay && last) return draw(last);
    const t = c.docEl.querySelector(".hm-time");
    const now = hhmm();
    if (t && t.textContent !== now) t.textContent = now;
  }, 15000);
}
const hhmm = () => new Date().toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

/** Read Home again soon: many events in a burst are one read. */
export function soonRefresh() {
  clearTimeout(soon);
  soon = setTimeout(refresh, 250);
}

async function refresh() {
  if (!c || c.view() !== "home") return;
  const turn = ++reading;
  let j;
  try { j = c.capability ? await c.deskApi("/api/home") : await (await fetch("/api/home")).json(); }
  catch { if (!last) c.docEl.innerHTML = `<div class="inbox-head"><h1>Home</h1><p>snyvi did not answer. <button type="button" class="btn" data-hm="retry">Try again</button></p></div>`; return; }
  if (turn !== reading || c.view() !== "home") return;
  last = j;
  draw(j);
}

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
/** How long ago, in one short unit: "40 min", "5 h", "4 d", "6 wk". */
function age(t) {
  const s = Date.now() / 1000 - t;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min`;
  if (s < DAY) return `${Math.round(s / 3600)} h`;
  if (s < 14 * DAY) return `${Math.round(s / DAY)} d`;
  return `${Math.round(s / (7 * DAY))} wk`;
}
const ago = t => Date.now() / 1000 - t < 60 ? "just now" : `${age(t)} ago`;
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
    `<button type="button" class="hm-hide" data-hm="hide" data-k="${key}" data-tip="Hide ${esc(title)}" data-tip-sub="Show brings it back" aria-label="Hide ${esc(title)}">✕</button></div>${body}</section>`;
  drawnDay = startOfDay(Date.now() / 1000);
  const side = [
    w("today", "Today", today()),
    w("keys", "Keys", keys(j), keysOf(j).length ? ` <span class="n">${keysOf(j).length}</span>` : ""),
    w("claude", "Claude", claude(j)),
    w("snyvi", "snyvi", `<div class="hm-upd"></div>` + `<p class="hm-quiet hm-uptodate">snyvi ${esc(j.version || "")} · <button type="button" class="uc-link" data-hm="check">Check for updates</button></p>`),
  ].join("");
  const desks = j.desks ? w("desks", "Projects", desksList(j), pickOf(j).rest.length ? ` <span class="n">${pickOf(j).rest.length}</span>` : "") : "";
  const n = hid.length;
  const html = `<div class="hm"><header class="hm-head" data-part="home.head"><h1>Home</h1>${hid.includes("today") ? `<span class="hm-v">${new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}</span>` : ""}</header>` +
    status(j) +
    `<div class="hm-grid${!side ? " no-side" : ""}"><div class="hm-main">${bar(j)}${pick(j)}${desks}${week(j)}</div>${side ? `<div class="hm-side">${side}</div>` : ""}</div>` +
    (n ? `<p class="hm-foot">${plural(n, "widget")} hidden · <button type="button" data-hm="unhide">Show</button></p>` : "") + `</div>`;
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
  if (up) c.card().then(m => { if (m.card(up, j.update, c.updCtx())) { const q = c.docEl.querySelector(".hm-uptodate"); if (q) q.hidden = true; } }, () => {});
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
    if (asking.length) {
      ring = true;
      const [d, p] = asking[0];
      bits.push(`<a class="hm-ring" href="/desk/${d.id}" data-desk="${d.id}" data-slot="${p.slot}">${esc(d.name)} · ${esc(p.name || `panel ${p.slot}`)} ${p.agent === "needs_you" ? "is asking" : "rang"}${asking.length > 1 ? `, and ${asking.length - 1} more` : ""}</a>`);
    } else bits.push("Nothing needs you");
  }
  bits.push(j.waiting ? `<a href="/inbox" data-nav="inbox">${plural(j.waiting, "document")} to read</a>` : bits.length ? "nothing to read" : "Nothing to read");
  if (j.desks) {
    const n = j.desks.flatMap(d => d.panes).filter(p => p.agent === "working").length;
    bits.push(n ? `${plural(n, "Claude")} working` : "Claude idle");
  }
  const w = windowLeft(j.quota?.five_hour);
  if (w) bits.push(`<span data-tip="Claude's five-hour window" data-tip-sub="${esc(w.text)}">5 h window ${w.fresh ? "full" : `${w.left}% left`}</span>`);
  return `<p class="hm-status${ring ? " ring" : ""}" data-part="home.status">${bits.join(" · ")}</p>`;
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
  if (!j.desks.length) return box(`<h2>Pick up</h2><p class="hm-quiet">No desks yet. A desk is one project: its folder, and up to four panels in it.</p><div class="hm-pk-go"><button type="button" class="btn btn-primary" data-hm="newdesk">+ New desk</button></div>`);
  const { hero: d, rest, isKept } = pickOf(j);
  if (!d) return box(`<h2>Pick up</h2><p class="hm-quiet">Every desk is parked. Take one down in Projects when you are ready for it.</p>`);
  const l = d.left_off, x = d.last;
  const left = l
    ? `<p class="hm-pk-left"><b>Left off</b>${esc(l.text)}<span class="fact">${l.by ? `${esc(l.by)} · ` : ""}${ago(l.at)}</span></p>`
    : x
      ? `<p class="hm-pk-left hm-derived" data-tip="No one said where this was left" data-tip-sub="so this is the last thing that happened on it"><b>Last</b>${x.kind === "tick"
          ? `✓ ${esc(x.text)}${x.commit ? ` <code>${esc(x.commit.slice(0, 7))}</code>` : ""}`
          : `sent <a href="/d/${esc(x.id)}" data-id="${esc(x.id)}">${esc(x.text)}</a>`}<span class="fact">${ago(x.at)}</span></p>`
      : `<p class="hm-pk-left hm-quiet"><b>Left off</b>not said yet. A Claude on this desk says it at the end of a stretch, or write it in the desk's head.</p>`;
  // A list with nothing left open is a milestone said in numbers
  // (docs/DESIGN.md §3.2); a desk with no list yet is not.
  const next = notesOf(d, 5);
  const g = d.git;
  const git = g ? `<span class="hm-git" data-tip="What git says in ${esc(d.root || "the desk's folder")}" data-tip-sub="${g.last ? `last commit ${ago(g.last.at)}: ${esc(g.last.subject)}` : "no commits yet"}">${BRANCH}<span class="fact">${esc(g.branch || "no branch")}</span>` +
    `<span>${g.changed ? `${plural(g.changed, "file")} changed` : "clean"}${g.ahead ? ` · ${g.ahead} not pushed` : ""}${g.last ? ` · committed ${ago(g.last.at)}` : ""}</span></span>` + repoLink(g.remote) : "";
  const panels = d.panes.map(p =>
    `<a class="hm-panels" href="/desk/${d.id}" data-desk="${d.id}" data-slot="${p.slot}">${dot(p)}${esc(p.name || `panel ${p.slot}`)} <span class="hm-s">${paneWord(p)}</span></a>`).join("");
  const facts = git || panels ? `<p class="hm-facts">${git}${panels}</p>` : "";
  // The other desks, as chips, only while Projects below is hidden: it lists them.
  const chips = rest.length && hidden().includes("desks") ? `<p class="hm-chips"><span class="hm-s">or</span>${rest.map(o =>
    `<a class="hm-chip" href="/desk/${o.id}" data-desk="${o.id}" data-tip="${esc(o.name)} · ${o.touched ? touched(o.touched) : "not opened yet"}" data-tip-sub="${esc(o.panes.map(p => `${p.name || `panel ${p.slot}`} ${paneWord(p)}`).join(" · ") || "no panels")}">` +
    `${esc(o.name)}${liveDots(o)}<span class="fact">${o.touched ? age(o.touched) : "new"}</span></a>`).join("")}</p>` : "";
  return box(`<h2>Pick up</h2><div class="hm-pk-top"><a class="hm-pk-name" href="/desk/${d.id}" data-desk="${d.id}">${esc(d.name)}</a><span class="fact">${touched(d.touched)}</span>${spark(d.pulse)}</div>` +
    left + next + facts +
    `<div class="hm-pk-go"><a class="btn btn-primary" href="/desk/${d.id}" data-desk="${d.id}" data-hm-open>Open desk<kbd>↵</kbd></a>` +
    (rest.length || isKept ? `<button type="button" class="hm-link" data-hm="keep" data-k="${d.id}" data-tip="${isKept ? "Let Pick up follow the desk touched last" : "Keep this desk in Pick up"}" data-tip-sub="${isKept ? "instead of this one" : "instead of whichever was touched last"}">${isKept ? "Kept here · Follow the last touched" : "Keep here"}</button>` : "") +
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
    `<span class="hm-nt-t" data-tip="${esc(r.text)}" data-tip-overflow>${esc(r.text)}</span>${r.err ? `<span class="hm-s hm-err" role="alert">${esc(r.err)}</span>` : ""}</li>`).join("") +
    (more > 0 ? `<li class="hm-s hm-nt-more"><a href="/desk/${d.id}" data-desk="${d.id}">and ${more} more</a></li>` : "") + `</ul>`;
}
/** A line's stage, in the slot every line keeps: the server has already
 *  settled a `working` whose conversation ended. None once it is ticked. */
function stageMark(r) {
  const { esc } = c, by = esc(r.stage_by || "an agent");
  const st = r.done ? "" : r.stage || "";
  if (st === "planned" && r.stage_doc)
    return `<a class="hm-stage planned" href="/d/${esc(r.stage_doc)}" data-id="${esc(r.stage_doc)}" data-tip="Planned by ${by}" data-tip-sub="click to open the plan" aria-label="Open the plan for ${esc(r.text)}">${DOC}</a>`;
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

/** The bar's right end: Enter's key while the bar has the hand, then what the
 *  last Enter did, for a moment -- or, until the next key, why it did not. */
function saidHtml() {
  const { esc } = c, s = barSaid;
  if (!s) return `<kbd class="hm-nb-k" aria-hidden="true">↵</kbd>`;
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
    `<button type="button" class="hm-link" data-hm="unpark" data-k="${d.id}">Take down</button><span class="hm-age fact">${age(d.parked.at)}</span></li>`).join("")}</ul></div>` : "";
  if (!rest.length) return `<p class="hm-quiet">Your other projects show here, each with its open notes. One project, one desk.</p>` + shelved;
  const all = desksAll(), shown = all ? rest : rest.slice(0, DESKS_SHOWN - 1), more = rest.length - (DESKS_SHOWN - 1);
  const card = d => {
    const done = (j.days || []).filter(r => r.desk === d.id && r.kind === "tick" && r.at >= now - 7 * DAY).length;
    let left = d.left_off ? `<p class="hm-dk-left" data-tip="Left off" data-tip-sub="${esc(d.left_off.text)}"><b>Left off</b>${esc(d.left_off.text)}</p>` : "";
    let foot = done ? `<span class="hm-s" data-tip="${done} ${done === 1 ? "note" : "notes"} ticked in the last seven days">${done} done</span>` : "";
    if (d.id === justParked) foot = `<span class="hm-s">Parked</span><button type="button" class="hm-link hm-undo" data-hm="unpark" data-k="${d.id}">Undo</button>`;
    else if (parking === d.id) left = `<div class="hm-park"><input data-hm="next" data-k="${d.id}" maxlength="200" placeholder="The next step, for when you come back" aria-label="The next step on ${esc(d.name)}" value="${esc(parkDraft)}">` +
      `<button type="button" class="hm-link" data-hm="parkgo" data-k="${d.id}">Park</button><button type="button" class="hm-link" data-hm="parkno">Cancel</button>${parkFailed ? `<span class="hm-s">Could not park</span>` : ""}</div>`;
    else if (d.touched && now - d.touched > QUIET_DAYS * DAY)
      foot += `<button type="button" class="hm-link" data-hm="park" data-k="${d.id}" data-tip="Put it on the shelf" data-tip-sub="it leaves Pick up; nothing on it is closed">Park it?</button>`;
    const notes = notesOf(d, 3);
    return `<div class="hm-dk">` +
      `<div class="hm-dk-top"><a class="hm-dk-name" href="/desk/${d.id}" data-desk="${d.id}">${esc(d.name)}</a>${liveDots(d)}<span class="fact">${d.touched ? age(d.touched) : "new"}</span>${d.open ? `<span class="hm-s hm-dk-n">${d.open} open</span>` : ""}` +
      `<button type="button" class="hm-dk-add${d.open ? "" : " hm-dk-n"}" data-hm="addopen" data-k="${d.id}" data-tip="New note on ${esc(d.name)}" data-tip-sub="in the bar at the top" aria-label="A new note on ${esc(d.name)}">+</button></div>` +
      left + (notes || (left ? "" : `<p class="hm-quiet">Nothing open. The + adds a note.</p>`)) +
      `<div class="hm-dk-foot">${foot}${spark(d.pulse)}</div></div>`;
  };
  return `<div class="hm-dks">` + shown.map(card).join("") + `</div>` +
    (more > 0 ? `<button type="button" class="hm-link hm-dks-more" data-hm="desks" aria-expanded="${all}">${all ? "Show fewer desks" : `${more} more ${more === 1 ? "desk" : "desks"}`}</button>` : "") + shelved;
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

/** The time, the day, and this month with today ringed, Monday first. */
function today() {
  const now = new Date(), y = now.getFullYear(), m = now.getMonth();
  // 1 Jan 2024 was a Monday: the week's letters in the reader's own language.
  const heads = Array.from({ length: 7 }, (_, i) => `<b>${c.esc(new Date(2024, 0, 1 + i).toLocaleDateString(undefined, { weekday: "narrow" }))}</b>`);
  const lead = (new Date(y, m, 1).getDay() + 6) % 7, days = new Date(y, m + 1, 0).getDate();
  const cells = Array.from({ length: lead }, () => `<span></span>`);
  for (let n = 1; n <= days; n++) {
    const wd = (lead + n - 1) % 7;
    cells.push(`<span class="${n === now.getDate() ? "today" : wd > 4 ? "we" : ""}"${n === now.getDate() ? ` aria-current="date"` : ""}>${n}</span>`);
  }
  return `<p class="hm-time">${hhmm()}</p>` +
    `<p class="hm-date">${c.esc(now.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" }))}</p>` +
    `<div class="hm-cal" role="img" aria-label="${c.esc(now.toLocaleDateString(undefined, { month: "long", year: "numeric" }))}">${heads.join("")}${cells.join("")}</div>`;
}

/** Every key the desks hand their panels, one row per name: the provider,
 *  which desks have it (or every desk), and when a panel last started with
 *  it. Names only -- Home is never sent a value -- and nothing is added
 *  here: a key is a desk's, and goes in from that desk's head. */
function keysOf(j) {
  const by = new Map();
  for (const d of j.desks || []) for (const k of d.keys || []) {
    const r = by.get(k.name) || { name: k.name, provider: "", every: false, desks: [], used: 0 };
    if (k.desk_id) r.desks.push(d); else r.every = true;
    r.provider ||= k.provider || "";
    r.used = Math.max(r.used, k.used_at || 0);
    by.set(k.name, r);
  }
  return [...by.values()].sort((a, b) => a.name.localeCompare(b.name));
}
function keys(j) {
  const { esc } = c;
  if (!j.desks) return `<p class="hm-quiet">Open the window to see your keys.</p>`;
  const rows = keysOf(j);
  if (!rows.length) return `<p class="hm-quiet">None yet. A desk's head has a Keys slot: paste one there, and every panel on that desk starts with it in its environment.</p>`;
  return `<ul class="hm-list">${rows.map(r =>
    `<li class="hm-pj hm-key"><span class="hm-pw"><span class="hm-kn">${esc(r.name)}</span><span class="hm-t">${r.provider ? esc(r.provider) + " · " : ""}${r.every ? "every desk" : r.desks.map(d => `<a href="/desk/${d.id}" data-desk="${d.id}">${esc(d.name)}</a>`).join(", ")}</span></span>` +
    `<span class="hm-age fact" data-tip="${r.used ? "a panel last started with it" : "no panel has started with it yet"}">${r.used ? age(r.used) : "unused"}</span></li>`).join("")}</ul>`;
}

/** What is left of one rate-limit window, as a share from 0 to 100 and a
 *  line of words. Claude Code drops a window once its reset time passes, and
 *  the daemon keeps the last reading it was given, so a window past its reset
 *  is a full one again until a Claude answers and a new reading comes. */
function windowLeft(l) {
  if (!l) return null;
  if (l.resets_at <= Date.now() / 1000) return { left: 100, fresh: true, text: `full · reset ${age(l.resets_at)} ago` };
  const left = Math.round(100 - Math.max(0, Math.min(100, l.used)));
  return { left, hot: left <= 20, text: `${left}% left · resets ${resets(l.resets_at)}` };
}

/** What is left of the account's quota and when that was read, what the
 *  Claudes in panels are doing, and the fullest context window. The bar is
 *  what is left, and turns amber at a fifth. */
function claude(j) {
  const { esc, plural } = c;
  const q = j.quota, out = [];
  const bar = (label, l) => { const w = windowLeft(l); return w ? `<div><span class="hm-k">${label}</span><div class="hm-bar${w.hot ? " hot" : ""}"><i style="width:${w.left}%"></i></div><span class="fact">${w.text}</span></div>` : ""; };
  if (q && (q.five_hour || q.seven_day)) out.push(`<div class="hm-q">${bar("5 hours", q.five_hour)}${bar("7 days", q.seven_day)}</div>${q.at ? `<p class="hm-meta fact">As of ${age(q.at)} ago, from the last Claude that answered.</p>` : ""}`);
  if (j.desks) {
    const ps = j.desks.flatMap(d => d.panes.map(p => ({ ...p, desk: d.name, deskId: d.id })));
    const working = ps.filter(p => p.agent === "working").length, done = ps.filter(p => p.agent === "done").length;
    const hot = ps.filter(p => p.ctx_pct != null).sort((a, b) => b.ctx_pct - a.ctx_pct)[0];
    if (working || done) out.push(`<p class="hm-meta">${working ? `${plural(working, "Claude")} working` : ""}${working && done ? " · " : ""}${done ? `${done} done` : ""}</p>`);
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
    const b = e.target.closest("button[data-hm]");
    if (!b) return;
    const k = b.dataset.hm, id = +b.dataset.k || 0;
    if (k === "hide") { setHidden([...new Set([...hidden(), b.dataset.k])]); draw(last); c.docEl.querySelector("[data-hm=unhide]")?.focus({ preventScroll: true }); }
    else if (k === "unhide") { setHidden([]); draw(last); }
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
  });
  el.addEventListener("input", e => {
    if (e.target.dataset?.hm === "next") parkDraft = e.target.value;
    else if (e.target.dataset?.hm === "bar") { barDraft = e.target.value; if (barSaid?.err) { say(null); sayNow(); } hashMenu(e.target); }
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
  // The week stays as the reader left it, folded or open.
  el.addEventListener("toggle", e => { if (e.target.matches?.(".hm-week")) setWeekOpen(e.target.open); }, true);
  // The hand leaving the bar closes its list; what is typed in it waits, as typed.
  el.addEventListener("focusout", e => {
    if (drawing || !e.target.closest?.(".hm-nb")) return;
    if (e.target.dataset?.hm === "bar") e.target.placeholder = "Add a note";
    if (menu && !e.relatedTarget?.closest?.(".hm-nb")) { menu = null; drawMenu(); }
  });
  el.addEventListener("keydown", e => {
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
    else if ((await post(r.restore, r.kind === "aside" ? { ids: [Number(r.id)] } : null))?.ok) return void (b.textContent = "Back");
    b.disabled = false; b.textContent = "Retry";
    toast("Could not bring it back", { sub: r.title, at: b });
  });
  if (removedOpen) list();
  docEl.append(el);
}

/** The Inbox's own page, drawn here beside Home: what is waiting first,
 *  oldest first, then everything, newest first. */
export function inboxHtml(items, { state, esc, rel, plural, mascotHead, kindTag, waitingRow, noteKnown }) {
  const row = d => (noteKnown(d), `<li><a href="/d/${d.id}" class="${waitingRow(d) ? "new" : ""}" data-id="${d.id}"><span class="title">${esc(d.title)}</span><span class="time">${rel(d.received_at)}</span><span class="sub"><b>${esc(d.project)}</b> · ${esc(d.workflow_title)} · ${kindTag(d.kind)}</span></a></li>`);
  // The one empty state (docs/DESIGN.md §3.4): snyvi at rest, one
  // sentence, one button.
  if (!items.length) return `<div class="empty-state"><span class="hero">${mascotHead("rest")}</span><h1>Nothing in the Inbox yet</h1>` +
    `<p>What your agents write lands here, filed by project.</p><button type="button" class="btn btn-primary" data-nav="start">How snyvi works</button></div>`;
  // What is waiting comes first, oldest first, so the landing page answers
  // "what is new" before "what is there".
  const n = state.waiting;
  return `<div class="inbox-head"><h1>Inbox</h1><p>${n ? `${plural(n, "document")} waiting to be read, then everything else, newest first.` : "Newest first, across every project."}</p></div>` +
    (n ? `<h2 class="inbox-sec">Waiting<span class="n">${n}</span><button type="button" data-q="next">Open the first<kbd>n</kbd></button><button type="button" data-q="clear">Mark all read</button></h2><ul class="inbox waiting">${state.queue.map(row).join("")}</ul><h2 class="inbox-sec">Recent</h2>` : "") +
    `<ul class="inbox">${items.map(row).join("")}</ul>`;
}


// The retry on a Home that could not be read is outside `.hm`.
document.addEventListener("click", e => { if (c && e.target.closest("[data-hm=retry]")) refresh(); });
