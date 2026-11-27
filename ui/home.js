/* Home: the page the mark opens, at `/`. The doorway to an evening's work.
 *
 * A page for running the work, so it says what every agent is doing now.
 * Who is stuck on me, and who is busy? -- the floor (1.67): every panel on
 * every desk by state, On you first and answered where it stands, then the
 * agents working, the ones finished, and a line for what is idle. Until
 * 1.67 this was Pick up, one desk large, and a card for every other desk
 * with its notes: a page of desks, where the reader opened each to find
 * the agent that had stopped. A thought for a desk? -- the note bar above
 * it, in view however far the page scrolls: a line on any desk's list,
 * without opening the desk. Does anything need me? -- one status line under the title,
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
 * and not a thing in the library, and so is the focus zone. Arrived
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
.hm-pill { display: inline-flex; align-items: baseline; gap: 8px; margin: 0 0 0 -10px; padding: 0 10px 2px; border: 0; border-radius: var(--r-pill); background: none; font: inherit; color: inherit; letter-spacing: inherit; cursor: pointer; }
.hm-pill:hover, .hm-pill[aria-expanded="true"] { background: var(--wash); }
.hm-pill i { font-style: normal; font-size: var(--fs-small); color: var(--fg-3); }
/* This week, in the head (1.56, audit B8): the only evidence log was a
   fold at the foot of a long page. One line after the date opens it. */
.hm-wkl { padding: 0; border: 0; background: none; font: inherit; cursor: pointer; }
.hm-wkl:hover { color: var(--fg); text-decoration: underline; }
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
/* 1.58: what a crash or a stop left on offer, first in the status line,
   which is one line whatever it says; Choose… opens over the page under
   it, as On you does, so neither moves anything. */
.hm-rs { color: var(--fg-2); }
.hm-rs.crash { color: var(--warn); font-weight: 600; }
.hm-rs-b { padding: 0; border: 0; background: none; font: inherit; color: var(--accent); font-weight: 600; cursor: pointer; }
.hm-rs-b.q { color: var(--fg-2); font-weight: 400; }
.hm-rs-b:hover { text-decoration: underline; }
.hm-rsp { position: absolute; top: 24px; left: 0; z-index: 5; width: min(460px, 100%); max-height: min(60vh, 520px); overflow: auto; padding: 12px 14px; background: var(--bg-raise); border: 1px solid var(--rule-2); border-radius: var(--r-md); box-shadow: var(--shadow-3); font-size: var(--fs-small); }
.hm-rsp h3 { margin: 10px 0 4px; font-size: var(--fs-small); font-weight: 600; color: var(--fg-2); }
.hm-rsp h3:first-of-type { margin-top: 0; }
.hm-rsp-t { display: flex; align-items: center; gap: 8px; width: 100%; padding: 3px 0; border: 0; background: none; font: inherit; color: var(--fg); text-align: left; cursor: pointer; }
.hm-rsp-t > i { flex: none; width: 13px; height: 13px; border: 1px solid var(--rule-2); border-radius: var(--r-xs); font-style: normal; font-size: var(--fs-micro); line-height: 12px; text-align: center; }
.hm-rsp-t[aria-checked="true"] > i { background: var(--accent); border-color: var(--accent); color: var(--bg); }
.hm-rsp-t[aria-checked="true"] > i::before { content: "✓"; }
.hm-rsp-f { display: flex; justify-content: flex-end; gap: 10px; margin: 12px 0 0; }
/* A desk's moving threads, a line each under its notes. */
.hm-upd { margin-top: 12px; max-width: 360px; }
.hm .fact { font-family: var(--mono); font-size: var(--fs-micro); font-variant-numeric: tabular-nums; }
/* The floor and the week on the left, the side column beside them. */
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
.hm-wh .hm-gap { flex: 1; }
.hm-wh h2 { margin: 0; font-size: var(--fs-ui); font-weight: 600; color: var(--fg-2); }
.hm-wh h2 .n { margin-left: 6px; font-weight: 500; font-variant-numeric: tabular-nums; }
.hm-wh .hm-wcl { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs-micro); color: var(--fg-2); }
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
/* ---------- the floor (1.67) ----------
 * One box: its head with the count and Focus, On you's list, then a quiet
 * head and rows per state. A row is one line: the panel (its desk in bold),
 * what it is doing, since when, and at most one button. */
.hm-floor { position: relative; padding: 14px 18px 12px; border: 1px solid var(--rule); border-radius: var(--r-md); background: var(--bg-raise, var(--bg)); box-shadow: var(--shadow-1, none); }
.hm-fl-h { position: relative; display: flex; align-items: center; gap: 12px; margin: 0 0 10px; }
.hm-fl-t { flex: 1; min-width: 0; margin: 0; font-size: var(--fs-body-s); font-weight: 600; color: var(--fg); }
.hm-fl-w { color: var(--warn); font-weight: 600; }
.hm-fl-f { flex: none; display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 10px; border: 1px solid var(--rule-2); border-radius: var(--r-pill); background: none; color: var(--fg-2); font: inherit; font-size: var(--fs-small); cursor: pointer; }
.hm-fl-f:hover, .hm-fl-f[aria-expanded="true"] { color: var(--fg); border-color: var(--accent); }
.hm-fl-f.on { color: var(--accent); border-color: var(--accent); }
.hm-floor > .hm-wait { margin: 0; padding: 0; border: 0; background: none; box-shadow: none; }
.hm-fl-g { margin: 14px 0 4px; font-size: var(--fs-micro); font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--fg-3); }
.hm-fl-l { list-style: none; margin: 0; padding: 0; }
.hm-fl-r { display: flex; align-items: center; gap: 10px; min-height: 28px; min-width: 0; border-top: 1px solid var(--rule); font-size: var(--fs-small); }
.hm-fl-l > .hm-fl-r:first-child { border-top: 0; }
.hm-fl-n { flex: none; display: inline-flex; align-items: center; gap: 7px; width: min(38%, 260px); min-width: 0; color: var(--fg); text-decoration: none; white-space: nowrap; overflow: hidden; }
.hm-fl-n b { font-weight: 600; flex: none; max-width: 60%; overflow: hidden; text-overflow: ellipsis; }
.hm-fl-n span { min-width: 0; overflow: hidden; text-overflow: ellipsis; color: var(--fg-2); }
.hm-fl-n:hover b { text-decoration: underline; }
.hm-fl-x { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg-2); }
.hm-fl-a { flex: none; color: var(--fg-3); }
.hm-fl-b { flex: none; padding: 1px 10px; border: 1px solid var(--rule-2); border-radius: var(--r-pill); color: var(--fg-2); font-size: var(--fs-micro); text-decoration: none; }
.hm-fl-b:hover { color: var(--fg); border-color: var(--accent); }
.hm-pk-n { margin: 0; font-size: var(--fs-h3); font-weight: 600; }
.hm-pk-g { margin: 2px 0 0; font-style: italic; color: var(--fg-2); font-size: var(--fs-ui); }
.hm-pk-f { list-style: none; margin: 12px 0 0; padding: 0; font-size: var(--fs-small); color: var(--fg); }
.hm-pk-f li { display: flex; gap: 8px; padding: 2px 0; }
.hm-pk-nx { margin: 12px 0 0; padding: 9px 12px; border-radius: var(--r-sm); background: var(--bg); font-size: var(--fs-ui); line-height: 1.45; }
.hm-pk-nx small { display: block; color: var(--fg-3); font-size: var(--fs-micro); }
.hm-pk-go { display: flex; flex-wrap: wrap; gap: 8px; margin: 14px 0 8px; }
.hm-pk-go a { text-decoration: none; }
.hm-nb.low { position: static; margin: 14px 0 0; padding: 0; background: none; }
.hm-pk-more { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 8px 12px; margin: 14px 0 0; padding: 10px 14px; border: 1.5px dashed var(--rule-2); border-radius: var(--r-md); font-size: var(--fs-small); color: var(--fg-2); }
.hm-pk-more b { color: var(--fg); }
.hm-foot-more { margin-top: 20px; }
.hm-fl-none, .hm-fl-idle { margin: 0; font-size: var(--fs-small); color: var(--fg-3); }
.hm-fl-idle a { color: var(--fg-2); text-decoration: none; }
.hm-fl-idle a:hover { color: var(--fg); text-decoration: underline; }
/* The focus list: under its button, over the floor, so opening it moves nothing. */
.hm-fz { position: absolute; top: 30px; right: 0; z-index: 5; width: min(340px, 100%); max-height: 60vh; overflow-y: auto; padding: 6px 0; border: 1px solid var(--rule-2); border-radius: var(--r-sm); background: var(--bg-raise, var(--bg)); box-shadow: var(--shadow); font-size: var(--fs-small); }
.hm-fz-h { display: flex; align-items: center; gap: 10px; padding: 4px 14px 8px; margin-bottom: 4px; border-bottom: 1px solid var(--rule); font-weight: 600; }
.hm-fz-h span { flex: 1; }
.hm-fz-r { display: flex; align-items: center; gap: 10px; width: 100%; padding: 5px 14px; border: 0; background: none; color: var(--fg); font: inherit; text-align: left; cursor: pointer; }
.hm-fz-r:hover, .hm-fz-r:focus-visible { background: var(--rule); }
.hm-fz-r.off { opacity: .55; }
.hm-fz-c { flex: none; width: 13px; height: 13px; border: 1px solid var(--rule-2); border-radius: 4px; background: var(--bg); }
.hm-fz-r[aria-checked="true"] .hm-fz-c { background: var(--accent); border-color: var(--accent); }
.hm-fz-n { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hm-fz-f { margin: 6px 0 0; padding: 8px 14px 2px; border-top: 1px solid var(--rule); color: var(--fg-3); font-size: var(--fs-micro); line-height: 1.45; }
/* The Inbox's filters (1.67, #236): chips under its head, the field at the row's end. */
.ib-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 12px 0 0; }
.ib-chip { display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 10px; border: 1px solid var(--rule-2); border-radius: var(--r-pill); background: none; color: var(--fg-2); font: inherit; font-size: var(--fs-small); cursor: pointer; }
.ib-chip:hover { color: var(--fg); border-color: var(--accent); }
.ib-chip[aria-pressed="true"] { color: var(--accent); border-color: var(--accent); background: var(--accent-bg); }
.ib-chip .n { font-weight: 600; color: var(--accent); }
.ib-q { flex: 1; min-width: 140px; max-width: 260px; margin-left: auto; height: 24px; padding: 0 8px; border: 1px solid var(--rule-2); border-radius: var(--r-xs); background: var(--bg); color: var(--fg); font: inherit; font-size: var(--fs-small); }
.ib-out { margin: 14px 0 0; font-size: var(--fs-small); color: var(--fg-3); }
.ib-out button { padding: 0; border: 0; background: none; color: var(--accent); font: inherit; cursor: pointer; }
.hm-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--fg-3); flex: none; }
.hm-dot.run, .hm-dot.work { background: var(--ok); }
.hm-dot.work { box-shadow: 0 0 0 2px color-mix(in srgb, var(--ok), transparent 75%); }
.hm-dot.need { background: var(--warn); }
/* Its byline in one piece: "claude-" over "code" read as two names. */
.hm-log code { font-family: var(--mono); font-size: var(--fs-micro); color: var(--fg-3); }
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
/* A link in a friend's line (linkedLine, below). */
a.hm-ln { color: var(--accent); text-decoration: underline; text-decoration-color: color-mix(in srgb, currentColor 40%, transparent); text-underline-offset: 2px; overflow-wrap: anywhere; }
a.hm-ln:hover { text-decoration-color: currentColor; }
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
.hm-age { flex: none; width: 4.5em; text-align: right; color: var(--fg-3); }
.hm-shelf .hm-t { color: var(--fg-3); font-size: var(--fs-small); }
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
/* On you's rows on Home are all of them, not the tray's seven: twenty on
   nine desks pushed the rest of Home off the page. Past the tray's own
   height they scroll under the box's head, which stays, as the tray's do.
   The padding keeps what a scroller would clip in view: the ✕ that hangs
   past a row's right, the new dot past its left, the focus band. */
.oy-home { max-height: 60vh; margin: -4px -10px; padding: 4px 10px; overflow-y: auto; overscroll-behavior: contain; }
.hm-wait .hm-sub { margin: 6px 0 0; font-size: var(--fs-micro); font-weight: 600; color: var(--fg-3); text-transform: uppercase; letter-spacing: .04em; }
.hm-wait .hm-wt-d { color: inherit; }
.hm-wait .hm-acts > .hm-s { flex: 1 1 auto; }
/* Four acts on a left-off row (1.48 added Park it): each one word-line,
   the by-line giving way first. */
.hm-acts > .hm-link { flex: none; white-space: nowrap; }
.hm-link.hm-ok { color: var(--accent); font-weight: 600; }
.hm-arr-all a { color: var(--fg-2); text-decoration: none; }
.hm-arr-all a:hover { color: var(--fg); text-decoration: underline; }
/* A friend: their name (their page), then Note… and ⋯ (Mute, Remove);
   under it, always, one line of what last passed between you, so the row
   is the same height whatever it says (F9). */
.hm-friend { position: relative; gap: 2px 10px; flex-wrap: wrap; padding: 2px 0; }
.hm-friend > .hm-fn { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; color: var(--fg); padding: 0; border: 0; background: none; font: inherit; font-weight: 500; text-align: left; cursor: pointer; }
.hm-friend > .hm-fn:hover { text-decoration: underline; }
.hm-friend > .hm-fsub { order: 9; flex-basis: 100%; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg-3); font-size: var(--fs-small); }
/* A friend's line on Home keeps two lines of its words, never one cut
   short; a promise is theirs, said as one (F4, F18). */
.hm-arrived .hm-ab > .hm-t { white-space: normal; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow-wrap: anywhere; }
.hm-arrived .hm-pr { color: var(--fg-3); }
.hm-kept { color: var(--ok); font-weight: 600; white-space: nowrap; }
@media (max-width: 480px) { .hm-arrived .hm-acts { flex-wrap: wrap; } .hm-arrived .hm-acts > .hm-s { flex-basis: 100%; } }
.hm-friend > .hm-ren { flex: 1; min-width: 0; font: inherit; font-weight: 500; line-height: inherit; padding: 0 4px; margin: 0 0 0 -5px; border: 1px solid var(--rule-2); border-radius: var(--r-sm); background: var(--bg); color: var(--fg); }
/* Keys, folded like the week. */
.hm-meta { margin: 10px 0 0; font-size: var(--fs-small); color: var(--fg-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* The quota's "As of…" line wraps: cut, it lost its own sentence (1.56, audit B9). */
.hm-meta.wrap { white-space: normal; }
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

/** The sections that can be hidden, in the order they stand. The floor
 *  cannot: it is what the page is for. Threads and Keys were sections until
 *  1.32; a reader who hid them has nothing left to show. */
const WIDGETS = [
  // 1.59: the wall (ui/wall.js), fetched after Home draws.
  ["wall", "What people are building"],
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
let parkFailed = false, justParked = 0, parkedT = 0;
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
/** The note bar: the desk chosen on its chip (0 is the one touched last), what is typed
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
/** True while the page's HTML is being replaced: a field losing the focus
 *  that way is not the reader leaving it. */
let drawing = false;
/** The log shows its first few days and a desk's first few lines; these are
 *  what the reader opened past that. */
const DAYS_FIRST = 3, LINES_FIRST = 4;
let allDays = false;
const opened = new Set();

function style() {
  if (!sheet) { sheet = Object.assign(document.createElement("style"), { id: "home-drawn", textContent: CSS }); document.head.append(sheet); }
}

const KNOWN = WIDGETS.map(w => w[0]);
/** Home's own pill (1.70, plan 94e0a0f735 P5): the path's first part, as
 *  it stands on a desk, its menu the desks. Only with two or more desks and
 *  in the window: with one, Home is that desk's card. */
const homePill = j => c.capability && j.desks && j.desks.filter(d => !d.parked).length > 1
  ? `<button type="button" class="hm-pill" data-path="home-desks" aria-haspopup="menu" aria-expanded="false" data-tip="Every desk" data-tip-sub="the one asking first · ⌃⌥H comes back here">Home<i aria-hidden="true">▾</i></button>` : "Home";
/** Whether a one-desk Home shows every block (the foot's Show): this
 *  viewer's, as the hidden widgets are. */
const MORE = "snyvi.home.more";
const moreShown = () => { try { return localStorage.getItem(MORE) === "1"; } catch { return false; } };
const oneDesk = j => !!j.desks && j.desks.length === 1 && !j.desks[0].parked;
const hidden = () => { try { return JSON.parse(localStorage.getItem("snyvi.home.hidden") || "[]").filter(k => KNOWN.includes(k)); } catch { return []; } };
const setHidden = xs => { try { localStorage.setItem("snyvi.home.hidden", JSON.stringify(xs)); } catch {} };
const weekOpen = () => { try { return localStorage.getItem("snyvi.home.week") === "1"; } catch { return false; } };
const setWeekOpen = on => { try { localStorage.setItem("snyvi.home.week", on ? "1" : "0"); } catch {} };

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
  // And On you's box is the corner's ranked rows (1.54), Lately or not.
  if (!cornerMod) c.corner?.().then(m => { cornerMod = m; redraw(); }, () => {});
  if (last) draw(last);
  await refresh();
}

/** The corner's Lately or On you moved: those two sections drawn again from
 *  what Home already holds, and nothing else -- a burst of asides is not a
 *  burst of Home redrawn under the pointer. On you's box is the corner's
 *  since 1.54, and the corner's list comes after Home's first draw: without
 *  this, a fresh Home kept the old Waiting box until something else moved. */
export function redraw() {
  // The side column, not Lately's section: with Lately hidden and nothing
  // arrived there is no such section, and the box was never drawn again.
  const side = c && c.view() === "home" && last && c.docEl.querySelector(".hm-side");
  if (!side) return;
  swap(side, ".hm-wait", waitBox(last));
  swap(side, ".hm-arrived", arrived(last), side.querySelector(":scope > .hm-wait"));
}

/** One section of Home's side swapped for its fresh markup when that
 *  differs, the focus kept on the button it was on; put in at the top, or
 *  after `after`, when it was not there, taken out when it draws nothing. */
function swap(side, cls, html, after = null) {
  const sec = side.querySelector(`:scope > ${cls}`);
  const t = document.createElement("template");
  t.innerHTML = html;
  const fresh = t.content.firstElementChild;
  if (!fresh) return void sec?.remove();
  if (!sec) return void (after ? after.after(fresh) : side.prepend(fresh));
  if (sec.innerHTML === fresh.innerHTML) return;
  const was = sec.contains(document.activeElement) ? document.activeElement.dataset : null;
  sec.replaceWith(fresh);
  const sel = was && (was.a ? `[data-a="${window.CSS.escape(was.a)}"]` : was.hm ? `[data-hm="${window.CSS.escape(was.hm)}"]` : "");
  if (sel) fresh.querySelector(`${sel}${was.r ? `[data-r="${window.CSS.escape(was.r)}"]` : was.k ? `[data-k="${window.CSS.escape(was.k)}"]` : ""}`)?.focus({ preventScroll: true });
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

/** The wall's section (ui/wall.js): imported once Home has drawn, filled
 *  in its place after every draw. Hidden, it is never fetched. */
let wallMod = null, wallLoading = null;
function wallFill() {
  if (hidden().includes("wall")) return;
  const el = () => c.docEl.querySelector("[data-wall]");
  if (wallMod) { wallMod.fill(el(), c); return; }
  let v = "";
  try { v = JSON.parse(document.getElementById("boot").textContent || "{}").v || ""; } catch { /* unversioned */ }
  wallLoading ||= import(`/assets/wall.js${v ? `?v=${v}` : ""}`).then(m => {
    wallMod = m;
    const at = el();
    if (at) { at.outerHTML = m.html(c); m.fill(el(), c); }
  }, () => { wallLoading = null; });
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
  // 1.67: On you is the floor's first group, in the main column.
  // One desk (1.70): the pick-up card is the page, and what a floor of
  // agents needs -- the quota, the week, the wall -- waits behind one line
  // at the foot until the reader asks for it or a second desk comes.
  const one = !!j.desks && j.desks.length === 1 && !j.desks[0].parked && !moreShown();
  const side = one ? arrived(j) : arrived(j) + w("claude", "Claude", claude(j)) +
    (anyFriend ? w("friends", "Friends", friends(j), fr.length ? ` <span class="n">${fr.length}</span>` : "") : "");
  const desks = parkedShelf(j);
  // Last in the main column, and one height whatever it holds (ui/wall.js's
  // WALL_H), so its cards filling in move nothing: not the foot, and not the
  // side column under it at one column.
  const wall = w("wall", "What people are building", wallMod ? wallMod.html(c) : `<div class="wl" data-wall style="height:178px"></div>`);
  const n = hid.filter(k => k !== "friends" || anyFriend).length;
  const html = `<div class="hm"><header class="hm-head" data-part="home.head"><h1>${homePill(j)}</h1><span class="hm-v">${esc(new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" }))}</span>${weekLine(j)}</header>` +
    `<div class="hm-st">${status(j)}${rsSheet()}</div>` +
    `<div class="hm-grid"><div class="hm-main">${one || oneDesk(j) ? "" : bar(j)}${one ? "" : yourWeek(j)}${floor(j)}${desks}${one ? "" : week(j) + wall}</div><div class="hm-side">${side}</div></div>` +
    (one ? `<p class="hm-foot hm-foot-more">More on Home: Claude's quota · This week · What people are building · <button type="button" data-hm="more-home">Show</button></p>` : "") +
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
  wallFill();
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
  const rs = rsLine(j);
  if (rs) bits.push(rs);
  if (j.desks) {
    const asking = [];
    for (const d of j.desks) for (const p of d.panes) if (p.blocked || p.agent === "needs_you") asking.push([d, p]);
    // Only what is fresh counts, and in amber: an older turn -- its panel
    // closed, asked over half an hour ago, or its panel prompted since --
    // is said apart, in the line's own ink (src/thread.rs `mark_stale`). Six
    // turns days old read "6 things are on you" in amber, while every desk's
    // pill called them older (audit e0a854b732, X2).
    const ts = (j.turns || []).filter(w => w.via !== "dialog");
    // Since 1.54 one list says what is on the reader (`crate::onyou`), older
    // cards, due lines and left-offs in it: its count is the line's, so the
    // line under the title and the box beside it say the same number.
    const oy = j.onyou, on = oy ? oy.left : ts.filter(w => !w.stale).length, old = oy ? 0 : ts.length - on;
    if (asking.length) {
      ring = true;
      const [d, p] = asking[0];
      bits.push(`<a class="hm-ring" href="/desk/${d.id}" data-desk="${d.id}" data-slot="${p.slot}"${p.grp ? ` data-grp="${p.grp}"` : ""}>${esc(d.name)} · ${esc(p.name || `panel ${p.slot}`)} needs you${asking.length > 1 ? `, and ${asking.length - 1} more` : ""}</a>`);
    }
    // On you opens the corner's tray, the one every page has, so its coming
    // moves nothing (audit 67d008cb6f, plan b0bca0a11f).
    // With the ranked list, the box beside it says it, once (1.64, C2).
    if (on && !oy) bits.push(`<button type="button" class="hm-onyou" data-hm="turns" aria-haspopup="dialog" data-key="ctrl+alt+y">${on === 1 ? "One thing is" : `${on} things are`} on you ›</button>`);
    // Lines due by tonight, and what has waited on the reader (1.47): the
    // box at the head of the side column has them.
    const due = oy ? 0 : (j.due || []).length, wt = oy ? 0 : (j.wait || []).length;
    if (due) bits.push(`<span class="hm-due now">${due} due today</span>`);
    if (wt) bits.push(`<span class="hm-due late">${wt} waiting on you</span>`);
    if (!asking.length && !on && !due && !wt) bits.push("Nothing needs you");
    if (!on && old) bits.push(`<button type="button" class="hm-onyou old" data-hm="turns" aria-haspopup="dialog" data-tip="Older" data-tip-sub="Panels since closed, or asked over half an hour ago. A question waits in its desk's Decisions after a day, anything else goes by itself after three, and can come back">${old} older ›</button>`);
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

/* ---------- bringing them back (1.58, plan 4b492bec68) ----------
 *
 * What a crash or a stop left on offer (`restore_run`): first in the status
 * line, "snyvi closed unexpectedly · 31 conversations on 20 desks · Restore
 * all · Choose… · ✕", and while they come back, "12 of 31 back · Stop". The
 * daemon starts them two at a time, fewer when memory is short. Nothing is
 * started without a press here, on a desk's strip, or in Choose…. */

/** Choose…'s list once read (`?panes=1`), and the panes unticked in it. */
let rsPicks = null, rsOff = new Set();

function rsLine(j) {
  const r = j.restore, { plural } = c;
  if (!r || r.hidden) return "";
  if (r.queued) return `<span class="hm-rs">${r.back} of ${r.total} back</span> <button type="button" class="hm-rs-b q" data-hm="rs-stop" data-tip="Stop" data-tip-sub="the ones starting now finish">Stop</button>`;
  if (!r.left) return "";
  const desks = Object.keys(r.desks || {}).length;
  const what = `${plural(r.left, "conversation")}${desks > 1 ? ` on ${desks} desks` : ""}`;
  return `<span class="hm-rs${r.crashed ? " crash" : ""}">${r.crashed ? "snyvi closed unexpectedly" : "Claude was open when snyvi stopped"} · ${what}</span> ` +
    `<button type="button" class="hm-rs-b" data-hm="rs-all" data-tip="Restore all" data-tip-sub="two at a time, this desk first">Restore all</button> ` +
    `<button type="button" class="hm-rs-b q" data-hm="rs-pick" aria-haspopup="dialog" aria-expanded="${!!rsPicks}">Choose…</button> ` +
    `<button type="button" class="hm-rs-b q" data-hm="rs-x" data-tip="Not now" data-tip-sub="each panel still offers its own" aria-label="Not now">✕</button>`;
}

/** Choose…: every one on offer, by desk, all ticked, and one Restore. */
function rsSheet() {
  if (!rsPicks) return "";
  const { esc } = c, by = new Map();
  for (const p of rsPicks) { if (!by.has(p.desk)) by.set(p.desk, { name: p.desk_name, ps: [] }); by.get(p.desk).ps.push(p); }
  const n = rsPicks.filter(p => !rsOff.has(p.id)).length;
  return `<div class="hm-rsp" role="dialog" aria-label="Choose what to restore">` +
    [...by.values()].map(g => `<h3>${esc(g.name)}</h3>` + g.ps.map(p =>
      `<button type="button" class="hm-rsp-t" role="checkbox" aria-checked="${!rsOff.has(p.id)}" data-hm="rs-tick" data-r="${esc(p.id)}"><i aria-hidden="true"></i>${esc(p.name || `Panel ${p.slot}`)}</button>`).join("")).join("") +
    `<p class="hm-rsp-f"><button type="button" class="btn" data-hm="rs-close">Cancel</button><button type="button" class="btn btn-primary" data-hm="rs-go"${n ? "" : " disabled"}>Restore ${n}</button></p></div>`;
}

/** Choose… closes on Escape, the focus back on what opened it. */
function rsKeys(el) {
  el.addEventListener("keydown", e => {
    if (e.key !== "Escape" || !rsPicks || !e.target.closest?.(".hm-rsp")) return;
    e.preventDefault(); e.stopPropagation();
    rsPicks = null; draw(last); c.docEl.querySelector("[data-hm=rs-pick]")?.focus({ preventScroll: true });
  });
}

async function rsClick(k, b) {
  const api = (body, path = "/api/restore") => c.deskApi(path, body);
  try {
    if (k === "rs-pick") {
      if (rsPicks) { rsPicks = null; draw(last); return; }
      const j = await api(undefined, "/api/restore?panes=1");
      rsPicks = j.panes || []; rsOff = new Set();
      draw(last);
      c.docEl.querySelector(".hm-rsp-t")?.focus({ preventScroll: true });
      return;
    }
    if (k === "rs-tick") {
      const id = b.dataset.r;
      rsOff.has(id) ? rsOff.delete(id) : rsOff.add(id);
      draw(last);
      c.docEl.querySelector(`.hm-rsp-t[data-r="${window.CSS.escape(id)}"]`)?.focus({ preventScroll: true });
      return;
    }
    if (k === "rs-close") { rsPicks = null; draw(last); c.docEl.querySelector("[data-hm=rs-pick]")?.focus({ preventScroll: true }); return; }
    b.disabled = true;
    if (k === "rs-all") await api({ all: true });
    else if (k === "rs-go") { await api({ ids: rsPicks.filter(p => !rsOff.has(p.id)).map(p => p.id) }); rsPicks = null; }
    else if (k === "rs-stop") await api({ stop: true });
    else if (k === "rs-x") { rsPicks = null; await api({ hide: true }); }
    soonRefresh("restore");
  } catch (e) { b.disabled = false; c.peerCtx.toast("Could not restore", { sub: c.peerCtx.sayErr(e).why }); }
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

/** A branch, drawn as git's own mark: two commits and the line between. */
const BRANCH = `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="4" cy="3.5" r="1.8"/><circle cx="4" cy="12.5" r="1.8"/><circle cx="12" cy="5.5" r="1.8"/><path d="M4 5.3v5.4M12 7.3c0 3-4 2.5-7.2 4"/></svg>`;

function dot(p) {
  const cls = p.blocked || p.agent === "needs_you" ? "need" : p.agent === "working" ? "work" : p.running ? "run" : "";
  return `<i class="hm-dot ${cls}" aria-hidden="true"></i>`;
}

/* ---------- the floor (1.67, plan f586a9fe09) ----------
 *
 * Home was one desk large (Pick up) and the rest as cards: to learn which
 * agent was stuck, on which desk, the reader opened each. The floor is
 * every panel on every desk, by what it is doing: what needs the reader
 * first -- On you's own list, answered where it stands, and the daemon
 * types the press into the panel that asked (stage 1) -- then the agents
 * working, the ones finished, and one line for what is idle. A row opens
 * its desk on its panel.
 *
 * The focus zone (#241): the desks the reader is on today. Chosen in the
 * floor's head, kept in this window (`snyvi.focus`), and read by the
 * sidebar, the Inbox and On you as well. An agent stuck outside it is still
 * counted, in one line, so a focus hides nothing that waits. */
const FOCUS_KEY = "snyvi.focus";
let focusOpen = false;
/** The desks in focus, or none for all of them. A desk closed or parked
 *  since is no longer one. */
function focusIds(j) {
  let v = [];
  try { v = JSON.parse(localStorage.getItem(FOCUS_KEY) || "[]"); } catch {}
  if (!Array.isArray(v)) return [];
  const live = new Set((j?.desks || []).filter(d => !d.parked).map(d => d.id));
  return j?.desks ? v.filter(id => live.has(id)) : v;
}
function setFocus(ids) {
  try { if (ids.length) localStorage.setItem(FOCUS_KEY, JSON.stringify(ids)); else localStorage.removeItem(FOCUS_KEY); } catch {}
  // The sidebar and the corner read it too (ui/app/08-desks.js, ui/corner.js).
  dispatchEvent(new Event("snyvi-focus"));
}
// Changed anywhere (the corner's "All desks"), Home is drawn again.
addEventListener("snyvi-focus", () => { if (c && last && c.view() === "home") draw(last); });

/** What a panel is doing, as the floor groups it. The agent's own word
 *  first: one that finished rang its bell too, and is not stuck. */
const paneState = p => p.agent === "needs_you" ? "need" : p.agent === "working" ? "work" : p.agent === "done" ? "done" : p.blocked ? "need" : "idle";
/** A desk in a word or two, for the focus list. */
function deskWord(d) {
  const n = s => d.panes.filter(p => paneState(p) === s).length;
  const need = n("need"), work = n("work"), done = n("done");
  return need ? [`${need} ${need === 1 ? "asks" : "ask"} you`, true] : [work ? `${work} working` : done ? `${done} finished` : "", false];
}
/** The one thread moving on a desk, as its PR and CI, when it has one. */
function threadFact(j, d) {
  const ts = (j.threads || []).filter(t => t.desk_id === d.id && isMoving(t));
  return ts.length === 1 && ts[0].pr ? `PR ${ts[0].pr}${ts[0].ci ? ` ${ts[0].ci}` : ""}` : "";
}
const FLOOR_FIRST = 5;

function floor(j) {
  const { esc, plural } = c;
  const box = body => `<section class="hm-floor" aria-label="Every agent, by what it is doing" data-part="home.floor">${body}</section>`;
  if (!j.desks) return box(`<p class="hm-quiet">Desks are in the snyvi window; a browser tab cannot see them. Everything your agents sent is in <a href="/inbox" data-nav="inbox">the Inbox</a>.</p>`);
  // No desk at all: Welcome's question again, as Zed's Welcome comes back
  // when the centre is empty (R12), with Welcome's two ways in (about.js).
  if (!j.desks.length) return box(`<div class="welcome hm-ask"><h2 class="w-q">What are you working on?</h2><div class="w-ask"><div class="w-btns"><button type="button" class="w-btn w-pick" data-w="pick">Choose its folder…</button><button type="button" class="btn" data-w="w-new">Start something new</button></div></div></div>`);
  const live = byOrder(j.desks.filter(d => !d.parked || d.id === justParked));
  if (!live.length) return box(`<p class="hm-quiet">Every desk is parked. Unpark one below when you are ready for it.</p>`);
  // One desk (1.70, plan 980648bb8b): Home is that desk -- where it stands,
  // and one press to carry on. What is on the reader stays first, in its box.
  if (live.length === 1 && j.desks.length === 1) return box((waitBox(j) || "") + pickCard(j, live[0]));
  const foc = focusIds(j), shown = live.filter(d => !foc.length || foc.includes(d.id));
  const all = shown.flatMap(d => d.panes.map(p => ({ d, p, s: paneState(p) })));
  const of = s => all.filter(x => x.s === s);
  const agents = all.filter(x => x.p.agent), cnt = cornerMod?.counts?.();
  const need = cnt ? cnt.left : new Set(of("need").map(x => x.p.id)).size;
  const says = agents.length ? `${plural(agents.length, "agent")} on ${plural(new Set(agents.map(x => x.d.id)).size, "desk")}` : `${plural(shown.length, "desk")}, no agent running`;
  const head = `<div class="hm-fl-h"><h2 class="hm-fl-t">${says}${need ? ` · <b class="hm-fl-w">${need} ${need === 1 ? "needs" : "need"} you</b>` : ""}</h2>` +
    `<button type="button" class="hm-fl-f${foc.length ? " on" : ""}" data-hm="focus" aria-haspopup="menu" aria-expanded="${focusOpen}" data-tip="Focus" data-tip-sub="pick the desks you are on today; the rest leave the sidebar, the Inbox and this list">Focus: ${foc.length ? plural(foc.length, "desk") : "all desks"}${CHEV}</button>` +
    (focusOpen ? focusMenu(live, foc) : "") + `</div>`;
  const name = x => `<a class="hm-fl-n" href="/desk/${x.d.id}" data-desk="${x.d.id}" data-slot="${x.p.slot}"${x.p.grp ? ` data-grp="${x.p.grp}"` : ""} data-tip="Go to panel" data-tip-sub="${esc(x.d.name)} · ${esc(x.p.name || `panel ${x.p.slot}`)}">${dot(x.p)}<b>${esc(x.d.name)}</b><span>· ${esc(x.p.name || `panel ${x.p.slot}`)}</span></a>`;
  const row = (x, text, end = "") => `<li class="hm-fl-r">${name(x)}<span class="hm-fl-x">${text}</span>${end}</li>`;
  const since = x => x.p.agent_since ? `<span class="hm-fl-a fact">${live2(x.p.agent_since)}</span>` : "";
  const group = (key, label, xs, draw1) => {
    if (!xs.length) return "";
    const open = opened.has(`fl-${key}`), cut = open ? xs : xs.slice(0, FLOOR_FIRST), more = xs.length - FLOOR_FIRST;
    return `<h3 class="hm-fl-g">${label} · ${xs.length}</h3><ul class="hm-fl-l">${cut.map(draw1).join("")}` +
      (more > 0 ? `<li class="hm-fl-r"><button type="button" class="hm-link" data-hm="more" data-k="fl-${key}" aria-expanded="${open}">${open ? "Show fewer" : `${more} more ${label.toLowerCase()}`}</button></li>` : "") + `</ul>`;
  };
  // What needs the reader is On you's own list, with its tabs: one list, answered here.
  // A shell that rang is not an agent and not on that list, so it is a row.
  const rang = of("need").filter(x => x.p.agent !== "needs_you");
  const onyou = waitBox(j) || `<h3 class="hm-fl-g">On you · 0</h3><p class="hm-fl-none">No agent is waiting on you.</p>`;
  // Where you left off (1.70): a row for every desk no agent is working on
  // and none is asking from, with its next step in the agent's own words.
  // Finished and Idle were groups of panels, where the reader opened each to
  // find what it had stopped on; a desk says that itself, in one line.
  const busy = new Set([...of("work"), ...of("need")].map(x => x.d.id));
  const rest = shown.filter(d => !busy.has(d.id)).sort((a, b) => (b.touched || 0) - (a.touched || 0));
  const restRow = d => {
    const p = carryPane(d), at = d.left_off ? d.left_off.at : d.touched;
    return `<li class="hm-fl-r"><a class="hm-fl-n" href="/desk/${d.id}" data-desk="${d.id}" data-tip="Open its desk"><b>${esc(d.name)}</b></a>` +
      `<span class="hm-fl-x"${d.left_off ? ` data-tip="${esc(d.left_off.text)}" data-tip-overflow` : ""}>${d.left_off ? esc(d.left_off.text) : d.panes.length ? "" : "No panels yet"}</span>` +
      (at ? `<span class="hm-fl-a fact">${age(at)}</span>` : "") +
      `<a class="hm-fl-b" href="/desk/${d.id}" data-desk="${d.id}"${p ? ` data-slot="${p.slot}"${p.grp ? ` data-grp="${p.grp}"` : ""} data-carry="${esc(p.id)}"` : ""} data-tip="Carry on" data-tip-sub="opens the desk${p ? ", and brings its last conversation back" : ""}">Carry on</a></li>`;
  };
  return box(head + onyou +
    (rang.length ? `<ul class="hm-fl-l">${rang.map(x => row(x, "rang for you", `<a class="hm-fl-b" href="/desk/${x.d.id}" data-desk="${x.d.id}" data-slot="${x.p.slot}"${x.p.grp ? ` data-grp="${x.p.grp}"` : ""}>Go to panel</a>`)).join("")}</ul>` : "") +
    (rest.length ? group("rest", "Where you left off", rest, restRow) : "") +
    group("work", "Working", of("work"), x => row(x, [esc((x.p.title || "").trim()) || "working", threadFact(j, x.d)].filter(Boolean).join(" · "), since(x))));
}

/** The panel Carry on goes back to: the one an agent was in last. */
const carryPane = d => [...d.panes].filter(p => p.agent || p.agent_since).sort((a, b) => (b.agent_since || 0) - (a.agent_since || 0))[0] || d.panes[0] || null;

/** Home with one desk: the desk itself, as a card. Its goal, the last page
 *  its agent sent and the last answer given, the agent's own next step, and
 *  Carry on. Built from what `/api/home` already says of the desk. */
function pickCard(j, d) {
  const { esc } = c, p = carryPane(d), l = d.left_off;
  const state = d.panes.map(paneState), need = state.includes("need"), work = state.includes("work");
  const to = `href="/desk/${d.id}" data-desk="${d.id}"${p ? ` data-slot="${p.slot}"${p.grp ? ` data-grp="${p.grp}"` : ""}` : ""}`;
  const facts = [
    d.last && d.last.kind === "doc" && !d.last.from ? `<li><span class="hm-g ok">✓</span><span>Its last page: <a href="/d/${esc(d.last.id)}" data-id="${esc(d.last.id)}">${esc(d.last.text)}</a> <span class="fact">· ${age(d.last.at)}</span></span></li>` : "",
    d.answered ? `<li><span class="hm-g ok">✓</span><span>You answered: ${esc(d.answered.answer)}</span></li>` : "",
  ].join("");
  const next = work ? `<p class="hm-pk-nx"><small>Now</small>An agent is working on this desk.</p>`
    : need ? `<p class="hm-pk-nx"><small>Now</small>An agent on this desk is waiting for you.</p>`
    : l ? `<p class="hm-pk-nx"><small>${l.by ? "Its agent" : "You"} left off, ${ago(l.at)}</small>${esc(l.text)}</p>` : "";
  const go = work || need ? `<a class="btn btn-primary" ${to}>Go to its desk →</a>`
    : `<a class="btn btn-primary" ${to}${p ? ` data-carry="${esc(p.id)}"` : ""}>Carry on →</a><a class="btn" href="/desk/${d.id}" data-desk="${d.id}">Just open the desk</a>`;
  return `<div class="hm-pk" data-part="home.pick"><h2 class="hm-pk-n">${esc(d.name)}</h2>` +
    (d.goal ? `<p class="hm-pk-g">${esc(d.goal)}</p>` : "") +
    (facts ? `<ul class="hm-pk-f">${facts}</ul>` : "") + next +
    `<p class="hm-pk-go">${go}</p>` +
    (work || need || !p ? "" : `<p class="hm-quiet">Carry on opens the desk and brings its last conversation back in its panel.</p>`) + `</div>` +
    bar(j).replace('class="hm-nb"', 'class="hm-nb low"') +
    `<div class="hm-pk-more"><span><b>Another project?</b> It gets its own desk.</span><div class="welcome hm-ask"><div class="w-ask"><div class="w-btns"><button type="button" class="btn w-pick" data-w="pick" data-another="1">Choose its folder…</button><button type="button" class="btn" data-w="w-new">Start something new</button></div></div></div></div>`;
}

/** How long an agent has been at it: "18 min", kept current by the minute's pass. */
const live2 = t => `<span class="hm-live" data-t="${t}">${ago(t)}</span>`;

/** The focus zone's list, under its button: a check per desk, and what the
 *  desk is doing. None checked is every desk. */
function focusMenu(live, foc) {
  const { esc } = c;
  return `<div class="hm-fz" role="menu" aria-label="Focus"><div class="hm-fz-h"><span>${foc.length ? `Focus · ${foc.length} of ${live.length} desks` : `Focus · all ${live.length} desks`}</span>` +
    (foc.length ? `<button type="button" class="hm-link" data-hm="fzall">All desks</button>` : "") + `</div>` +
    live.map(d => {
      const on = foc.includes(d.id), [word, warn] = deskWord(d);
      return `<button type="button" role="menuitemcheckbox" aria-checked="${on}" class="hm-fz-r${foc.length && !on ? " off" : ""}" data-hm="fz" data-k="${d.id}"><i class="hm-fz-c" aria-hidden="true"></i><span class="hm-fz-n">${esc(d.name)}</span><span class="hm-s${warn ? " hm-fl-w" : ""}">${word}</span></button>`;
    }).join("") +
    `<p class="hm-fz-f">The sidebar, the Inbox, On you and this list show only the desks you pick. An agent stuck on another is still counted.</p></div>`;
}

/** The parked desks, under the floor: each with its next step and Unpark. */
function parkedShelf(j) {
  const { esc } = c;
  const shelf = (j.desks || []).filter(d => d.parked && d.id !== justParked).sort((a, b) => b.parked.at - a.parked.at);
  if (!shelf.length) return "";
  return `<section class="hm-w" data-part="home.parked" aria-label="Parked"><div class="hm-wh"><h2>Parked <span class="n">${shelf.length}</span></h2></div><ul class="hm-list hm-shelf">${shelf.map(d =>
    `<li class="hm-pj"><span class="hm-pw"><a class="hm-pn" href="/desk/${d.id}" data-desk="${d.id}">${esc(d.name)}</a><span class="hm-t">${d.parked.next ? `next: ${esc(d.parked.next)}` : ""}</span></span>` +
    `<button type="button" class="hm-link" data-hm="unpark" data-k="${d.id}">Unpark</button><span class="hm-age fact">${age(d.parked.at)}</span></li>`).join("")}</ul></section>`;
}

const DOC = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.5 1.5H4.5a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V4.5z"/><path d="M9.5 1.5v3h3M6 8h4M6 10.5h4"/></svg>`;
const TICK = `<svg viewBox="0 0 16 16" width="9" height="9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7"/></svg>`;

/* ---------- the note bar ----------
 *
 * One place on Home to put a line on any desk's list: a field at the head of
 * the left column, in view however far the page has scrolled, with the desk
 * it goes on as a chip at its left -- the desk touched last, until another is chosen from
 * the chip's list or by typing `#` and the start of its name, then Tab. Enter
 * keeps the line and leaves the field open for the next, as the desk's own
 * field does, and a screenshot pasted or dropped on it waits on the line until
 * then. What the Enter did is said in the bar's own row -- "Added to snyvi ·
 * Undo" -- where the hand already is.
 */

/** The desk the bar writes to: the one chosen, else the one touched last. */
function barDesk(j) {
  const ds = j?.desks || [];
  return ds.find(d => d.id === barTo) || byOrder(ds.filter(d => !d.parked))[0] || ds[0] || null;
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
    `<input data-hm="bar" class="hm-nb-t" placeholder="Add a note" aria-label="A new note on ${esc(d.name)}" value="${esc(barDraft)}" spellcheck="false" autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="${menu?.by === "hash"}" aria-controls="hm-nb-opts">` +
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

/* Your week (1.48, src/week.rs): from Sunday 20:00 to Tuesday 06:00, one
 * box above the floor, there only while the daemon sends `week` -- what
 * shipped and whether it was told, what waits on you, three numbers, and
 * three fields that become dated lines. File it, Not this week, or Hide for
 * good. Its coming moves the floor down once, on a Sunday evening the page is
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
    // A desk's routines (1.50): what ran by itself, and what it asked of you.
    n.routine_runs ? `routines ran ${plural(n.routine_runs, "time")}${n.routine_waits ? `, ${n.routine_waits} waited on you` : ""}` : "",
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
/** This week in one line in the head, counted the way the log counts: a
 *  commit an agent named when it ticked a line is that line's. Nothing yet
 *  says so, so the head keeps its one line. A click opens the log. */
function weekLine(j) {
  if (!j.desks || !j.days) return "";
  const { plural } = c, names = new Set((j.desks || []).map(d => d.id));
  const rs = j.days.filter(r => names.has(r.desk));
  const named = rs.filter(r => r.kind === "tick").map(t => t.commit).filter(Boolean);
  const ticked = rs.filter(r => r.kind === "tick").length;
  const commits = rs.filter(r => r.kind === "commit" && !named.some(h => h.startsWith(r.hash) || r.hash.startsWith(h))).length;
  const sent = new Set(rs.filter(r => r.kind === "doc").map(r => r.text)).size;
  const bits = [ticked ? `${ticked} ticked` : "", commits ? plural(commits, "commit") : "", sent ? `${sent} sent` : ""].filter(Boolean);
  return `<button type="button" class="hm-v hm-wkl" data-hm="weekline" data-tip="This week" data-tip-sub="${bits.length ? "opens the log at the foot of the page" : "notes ticked, commits and documents on your desks, day by day"}">This week · ${bits.length ? bits.join(" · ") : "nothing yet"}</button>`;
}

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
  // What still waits to go says so in the row, with Retry; what became of
  // the last thing that went is the line under it, which is always there.
  return `<li class="hm-pj hm-friend" data-peer="${f.id}"><button type="button" class="hm-fn" data-hm="fopen" data-k="${f.id}" data-tip="Everything with ${esc(f.name)}" data-tip-sub="${esc(heard)}">${esc(f.name)}${f.muted ? ` <span class="hm-s">muted</span>` : ""}</button>${outbox(f)}${where}` +
    (more
      ? `<button type="button" class="hm-link" data-hm="fren" data-k="${f.id}" data-tip="The one name they have here" data-tip-sub="their row in the sidebar follows">Rename…</button>` +
        `<button type="button" class="hm-link" data-hm="fmute" data-k="${f.id}" data-tip="${f.muted ? "What they send lights up again" : "What they send arrives read"}">${f.muted ? "Unmute" : "Mute"}</button>` +
        `<button type="button" class="hm-link" data-hm="freceipts" data-k="${f.id}" data-tip="${f.read_receipts ? `${esc(f.name)} is told when you open what they sent` : `${esc(f.name)} hears only that it arrived`}">${f.read_receipts ? "Stop telling reads" : "Tell them when read"}</button>` +
        `<button type="button" class="hm-link" data-hm="fremove" data-k="${f.id}" data-tip="Remove ${esc(f.name)}" data-tip-sub="keys kept; Restore brings them back">Remove</button>`
      : `<button type="button" class="hm-link" data-hm="fnote" data-k="${f.id}" data-tip="A line for their notes">Note…</button>`) +
    `<button type="button" class="hm-link" data-hm="fmore" data-k="${f.id}" aria-expanded="${more}" aria-label="${more ? "Fewer" : "More"} for ${esc(f.name)}" data-tip="${more ? "Back" : "Rename, mute, read receipts or remove"}">⋯</button>${list}${friendSub(f)}</li>`;
}

/** The line under a friend's name: what last went to them and how far it
 *  got -- "you sent Seed list · arrived 3 min ago" -- or that they are
 *  away, or when you last heard from them. Yours, said as yours: the word
 *  beside their name read as theirs (audit 6f451571c6, F9). */
function friendSub(f) {
  const { esc } = c, last = (peers?.sent || []).find(x => x.peer_id === f.id);
  let t = last ? `you sent ${last.promise ? "a promise, " : ""}“${esc(last.what)}” · ${esc(sentWord(last))}${sentAt(last) ? ` ${ago(sentAt(last))}` : ""}${sentWhere(last)}`
    : f.last_from ? `last heard from ${ago(f.last_from)}` : `paired ${ago(f.paired_at)}`;
  if (f.away) t = `away now; what you send waits for them · ${t}`;
  return `<span class="hm-fsub">${t}</span>`;
}
const sentAt = x => x.done_at || x.read_at || x.arrived_at || x.held_at || x.sent_at;
/** What became of a thing that went: kept or done, read, arrived, held
 *  while they are away, or sent. */
const sentWord = x => x.done_at ? `${x.promise ? "kept" : "done"} ✓${x.done_commit ? ` · ${x.done_commit.slice(0, 7)}` : ""}` : x.read_at ? "read" : x.arrived_at ? "arrived" : x.held_at ? "held, they’re away" : "sent";
/** Where a line that arrived waits for them, so "where do I see it?" has
 *  its answer on this side too (#196): their On you, until they keep it. */
const sentWhere = x => !x.doc_id && !x.promise && x.arrived_at && !x.done_at ? " · in their On you" : "";

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
 *  its Keep on, then the corner's Lately drawn large -- documents,
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

const deskName = (j, id) => (j.desks || []).find(d => d.id === id)?.name || "a desk";

function waitBox(j) {
  // On you, ranked (1.54, `crate::onyou`): every row, through the corner's
  // own drawing so a row reads and answers the same in both places; a quiet
  // desk's Park it stays Home's.
  if (cornerMod?.onyou?.()) return onyouBox(j);
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
      ? `<button type="button" class="hm-link hm-ok" data-hm="wplan" data-k="${x.desk}" data-n="${esc(x.doc)}" data-tip="Approve the plan" data-tip-sub="typed into its panel when its Claude is at its prompt">Approve ${x.notes.map(n => `#${n}`).join(", ")}</button>`
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

/** On you's box: its head with the count and the ⋯ (whether the tray
 *  opens itself on arrival), the rows grouped by desk past four desks, then
 *  the quiet desks with Park it. Nothing when nothing is on the reader. */
function onyouBox(j) {
  const { esc, plural } = c, o = cornerMod.onyou();
  const old = Date.now() / 1000 - QUIET_DAYS * DAY;
  const quiet = (j.desks || []).filter(d => !d.parked && d.open && d.touched && d.touched < old && !o.rows.some(r => r.desk === d.id));
  const quietRows = quiet.map(d => `<li><span class="hm-ab"><span class="hm-t">Quiet since ${new Date(d.touched * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short" })}, ${plural(d.open, "line")} open</span><span class="hm-acts">` +
    (arrSaid.get(`q${d.id}:`) ? saidRow(arrSaid.get(`q${d.id}:`)) : `<a class="hm-t hm-wt-d" href="/desk/${d.id}" data-desk="${d.id}">${esc(d.name)}</a><button type="button" class="hm-link" data-hm="wpark" data-k="${d.id}" data-tip="Park it" data-tip-sub="the desk goes on the shelf; nothing on it is closed">Park it</button>`) + `</span></span></li>`).join("");
  const rows = cornerMod.onyouHtml(true);
  if (!o.left && !o.todo && !(o.news || []).length && !quietRows && !o.ran_quiet && !o.older && !cornerMod.said?.()) return "";
  // 1.66: the tray no longer opens by itself, so the box has no ⋯ for it.
  const more = "";
  // The count once, and the sentence's clauses beside it, not again under it (C2).
  // Under a focus (#241) the count is the focus's, and the clauses, which
  // name every desk's, are left to the rows.
  const cn = cornerMod.counts?.(), left = cn?.focus ? cn.left : o.left;
  const cl = left && o.clauses && !cn?.focus ? `<span class="hm-wcl" data-tip-overflow data-tip="${esc(o.clauses)}">· ${esc(o.clauses)}</span>` : "";
  return `<section class="hm-w hm-wait" data-part="home.wait" aria-label="On you"><div class="hm-wh"><h2>On you${left ? ` <span class="n">${left}</span> waiting` : ""}</h2>${cl}<span class="hm-gap"></span>${more}</div>` +
    `<div class="oy-home">${rows}${quietRows ? `<ul class="hm-arr">${quietRows}</ul>` : ""}</div></section>`;
}

/** The box's buttons, and On me. True when the click was one of them. */
async function waitClick(k, id, b) {
  if (k === "arrive") {
    b.disabled = true;
    try { await c.deskApi("/api/home/week", { hide: `arrive-${b.dataset.n}` }); } catch (e) { b.disabled = false; c.peerCtx.toast("Could not change it", { sub: c.peerCtx.sayErr(e).why }); return true; }
    cornerMod?.refresh?.();
    soonRefresh();
    return true;
  }
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
    else if (k === "wplan") { const j = await api(`/api/desks/${id}/plans/${encodeURIComponent(n)}/approve`, {}); sayRow(key, { id, text }, j && j.sent === "typed" ? "Approved · the go-ahead is typed into its panel" : `Approved · ${(j && j.why) || "its panel is not at its prompt"}, so nothing was typed: the next agent on the line sees it approved`); }
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

/** A friend's line, escaped, with its web links as links out to the
 *  desktop's browser: the rail's `webLinks`/`linked` (ui/desk/06-rail.js),
 *  copied since chunks cannot import each other -- the same rules, http or
 *  https, never this machine, bidi controls off, nothing fetched. Here the
 *  text is no button, so a link is an `<a>`, which the window hands out. */
function linkedLine(text, esc) {
  text = text.replace(/[‪-‮⁦-⁩]/g, "");
  let html = "", from = 0;
  for (const m of text.matchAll(/https?:\/\/[^\s<>"'`]+/g)) {
    let s = m[0].replace(/[.,;:!?'"]+$/, "");
    while (s.endsWith(")") && s.split(")").length > s.split("(").length) s = s.slice(0, -1);
    let u;
    try { u = new URL(s); } catch { continue; }
    if (!u.hostname || /^(localhost|127\.|0\.0\.0\.0|\[::1?\])/i.test(u.hostname)) continue;
    const host = u.host.replace(/^www\./, ""), rest = (u.pathname === "/" ? "" : u.pathname) + u.search + u.hash;
    html += esc(text.slice(from, m.index)) + `<a class="hm-ln" href="${esc(s)}" target="_blank" rel="noopener noreferrer" data-tip="Open ${esc(host)}" data-tip-sub="${esc(s)}">${esc(host + (rest.length > 28 ? rest.slice(0, 28) + "…" : rest))}</a>`;
    from = m.index + s.length;
  }
  return html + esc(text.slice(from));
}

/** A friend's line: Keep on ▾ puts it on a desk in one click, with their
 *  name on it; ✕ puts it away. Keep on is the window's, where the desks are.
 *  Their words stay as they wrote them, a date in them its chip (F7). A
 *  promise is theirs, not the reader's to do: "Sunny promised you", its
 *  date, kept ✓ once they keep it, and only ✕ (F4). */
function lineRow(n, j) {
  const { esc } = c, s = arrSaid.get("n" + n.id), ds = j.desks || [];
  const desks = [...ds.filter(d => !d.parked), ...ds.filter(d => d.parked)];
  const list = keepOpen === n.id && !s ? `<div class="hm-keepl" role="menu" aria-label="Keep it on">${desks.map(d =>
    `<button type="button" role="menuitem" class="hm-nb-o" data-hm="akeepto" data-k="${n.id}" data-n="${d.id}"><span class="hm-t">${esc(d.name)}</span>${d.parked ? `<span class="fact">parked</span>` : ""}</button>`).join("")}</div>` : "";
  const date = n.kept_at ? `<span class="hm-kept" data-tip="Kept ${esc(new Date(n.kept_at * 1000).toLocaleString())}"${n.kept_commit ? ` data-tip-sub="in ${esc(n.kept_commit.slice(0, 7))}"` : ""}>kept ✓</span>` : n.due_at ? dueChip(n.due_at) : "";
  const keep = n.promise || !desks.length ? "" : `<button type="button" class="hm-link" data-hm="akeep" data-k="${n.id}" aria-haspopup="menu" aria-expanded="${keepOpen === n.id}" data-tip="Keep it on a desk" data-tip-sub="a note there, from ${esc(n.from)}">Keep on ▾</button>`;
  const words = n.promise ? `<span class="hm-pr">${esc(n.from)} promised you:</span> ${linkedLine(n.text, esc)}` : linkedLine(n.text, esc);
  return `<li data-part="home.arrived.line"><span class="hm-ag">${c.who(n.from)}</span><span class="hm-ab"><span class="hm-t">${words}</span><span class="hm-acts">` +
    (s ? saidRow(s) : `<span class="hm-s">from ${esc(n.from)} · ${live(n.arrived_at)}</span>${date}${keep}` +
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
  for (const q of qs) out.push(`${qs.length > 1 ? `<p class="hm-meta">${esc(q.label || "your login")}</p>` : ""}<div class="hm-q">${bar("5 hours", q.five_hour)}${bar("7 days", q.seven_day)}</div>${q.at ? `<p class="hm-meta fact wrap">As of ${ago(q.at)}, from the last Claude that answered${qs.length > 1 ? " as it" : ""}.</p>` : ""}`);
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

/** 1.57: a link to a tab of a desk -- a card's chip, the ring on a panel
 *  in a tab -- says which tab before the desk opens, in capture so it is
 *  said before the page's own handler shows the desk (desk/23-groups.js). */
function tabLinks(el) {
  el.addEventListener("click", e => {
    const t = e.target.closest("a[data-desk][data-grp]");
    if (t && +t.dataset.grp) try { sessionStorage.setItem("snyvi.tabNext", `${t.dataset.desk}:${t.dataset.grp}`); } catch {}
  }, true);
}

function wire() {
  const el = c.docEl.querySelector(".hm");
  if (!el || el.dataset.wired) return;
  el.dataset.wired = "1"; tabLinks(el); rsKeys(el);
  el.addEventListener("click", async e => {
    // Home's pill: every desk, in the desk menu's one order (menu.js).
    if (e.target.closest('[data-path="home-desks"]')) { e.preventDefault(); c.newDesk(e.target.closest('[data-path="home-desks"]')); return; }
    // Lately's rows are the corner's, and so are their buttons.
    const cn = e.target.closest("button[data-a^='cn-'], [data-a^='cn-tn-']");
    if (cn && cornerMod?.act(cn.dataset.a, cn)) return;
    // A click anywhere else closes a Keep on list.
    if ((keepOpen || deskOpen) && !e.target.closest(".hm-keepl, [data-hm=akeep], [data-hm=fdesk]")) { keepOpen = deskOpen = 0; draw(last); }
    // And the focus list, which stays open while its desks are checked.
    if (focusOpen && !e.target.closest(".hm-fz, [data-hm=focus]")) { focusOpen = false; draw(last); }
    // Carry on: the desk opens by the link's own address, and is told which
    // panel's conversation to bring back (ui/desk/20-first.js `carryOn`).
    const ca = e.target.closest("a[data-carry]");
    if (ca) try { sessionStorage.setItem("snyvi.carry", ca.dataset.carry); } catch { /* it opens the desk all the same */ }
    const b = e.target.closest("button[data-hm]");
    if (!b) return;
    const k = b.dataset.hm, id = +b.dataset.k || 0; if (k.startsWith("rs-")) return void rsClick(k, b);
    // The ✕ in a folded widget's head hides it; it does not fold it.
    if (k === "hide") { e.preventDefault(); setHidden([...new Set([...hidden(), b.dataset.k])]); draw(last); c.docEl.querySelector("[data-hm=unhide]")?.focus({ preventScroll: true }); }
    else if (k === "unhide") { setHidden([]); draw(last); }
    else if (k === "more-home") { try { localStorage.setItem(MORE, "1"); } catch {} draw(last); }
    else if (k === "turns") c.corner().then(m => m.open(), () => {});
    else if (k === "check") c.checkUpdates(b);
    else if (k === "newdesk") c.newDesk(b);
    else if (k === "focus") { focusOpen = !focusOpen; draw(last); c.docEl.querySelector(focusOpen ? "[data-hm=fz]" : "[data-hm=focus]")?.focus({ preventScroll: true }); }
    else if (k === "fz") { const f = focusIds(last); setFocus(f.includes(id) ? f.filter(x => x !== id) : [...f, id]); c.docEl.querySelector(`[data-hm=fz][data-k="${id}"]`)?.focus({ preventScroll: true }); }
    else if (k === "fzall") { setFocus([]); c.docEl.querySelector("[data-hm=fz]")?.focus({ preventScroll: true }); }
    else if (k === "week") sendWeek(b);
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
    else if (k === "days") { allDays = !allDays; draw(last); c.docEl.querySelector("[data-hm=days]")?.focus({ preventScroll: true }); }
    // The head's This week line: the log open, and in view.
    else if (k === "weekline") { const w = c.docEl.querySelector(".hm-week"); if (w) { w.open = true; setWeekOpen(true); w.scrollIntoView({ block: "start", behavior: "smooth" }); } }
    else if (k === "more") { const key = b.dataset.k; opened.has(key) ? opened.delete(key) : opened.add(key); draw(last); }
    else if (k === "unpark") {
      b.disabled = true;
      if (!(await park(id, null))) return;
      if (justParked === id) { justParked = 0; clearTimeout(parkedT); }
      soonRefresh();
    }
    else if (!(await waitClick(k, id, b)) && !(await weekClick(k, b))) friendClick(k, id, b);
  });
  el.addEventListener("input", e => {
    if (e.target.dataset?.hm === "wkf" && wkDraft) wkDraft[e.target.dataset.k] = e.target.value;
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
    if (e.key === "Escape" && focusOpen) { e.preventDefault(); e.stopPropagation(); focusOpen = false; draw(last); c.docEl.querySelector("[data-hm=focus]")?.focus({ preventScroll: true }); return; }
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
  else if (k === "fopen") c.peerCtx.friend(id);
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
  // A desk keeps 200 characters of a line (`desk::NOTE_CHARS`): longer is
  // said here, with the bar as it was, rather than cut by the daemon.
  const n = [...text].length;
  if (n > 200) { say({ err: `${n} characters; a note holds 200` }); sayNow(); return; }
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

/* The Inbox's filters (1.67, #236). The desk's rail listed its documents
 * and the Inbox listed everyone's, with no way to see one desk's here: two
 * lists, and the one with every document had no control at all. Now the
 * rail's list is gone and the Inbox has a chip per desk, a field that finds
 * by title, and the focus zone (#241), which leaves out other desks'
 * documents and says how many. Kept while the window lives; a desk's
 * "Documents" row comes here on its chip (`snyvi.inbox.desk`, read once). */
let ibDesk = 0, ibFind = "", ibAll = false, ibFull = null;
const IB_MORE = 500;

/** The Inbox's own page, drawn here beside Home: what is waiting first,
 *  then the rest, both newest first, each document once. `/inbox` and the
 *  sidebar's Recent (`/inbox?recent`) are this one page under their own
 *  names: they were two, one listing what waits twice, the other saying
 *  "Unread" (the audit of 1.46.2). */
export function inboxHtml(items, { state, esc, rel, plural, mascotHead, kindTag, waitingRow, noteKnown, recent, ghost }) {
  style();
  try { const d = +sessionStorage.getItem("snyvi.inbox.desk"); if (d) { sessionStorage.removeItem("snyvi.inbox.desk"); if (d !== ibDesk) { ibDesk = d; ibFull = null; ibMore(); } } } catch {}
  const find = ibFind.trim().toLowerCase(), miss = d => find && !d.title.toLowerCase().includes(find);
  const row = d => (noteKnown(d), `<li${miss(d) ? " hidden" : ""}><a href="/d/${d.id}" class="${waitingRow(d) ? "new" : ""}" data-id="${d.id}"><span class="title">${esc(d.title)}</span><span class="time">${rel(d.received_at)}</span><span class="sub"><b>${esc(d.project)}</b> · ${esc(d.workflow_title)} · ${kindTag(d.kind)}</span></a></li>`);
  // A document just removed here stands as its ghost where its row was
  // (app.js's ghostRow, at the row's height) until its Undo is over.
  const list = (sec, ds) => { const h = ds.map(row); if (ghost?.sec === sec) h.splice(ghost.at, 0, ghost.html); return h.join(""); };
  // The one empty state (docs/DESIGN.md §3.4): snyvi at rest, one
  // sentence, one button.
  if (!items.length && !ghost) return `<div class="empty-state"><span class="hero">${mascotHead("rest")}</span><h1>Nothing in the Inbox yet</h1>` +
    `<p>What your agents write lands here, filed by project.</p><button type="button" class="btn btn-primary" data-nav="start">How snyvi works</button></div>`;
  // One desk's, from further back than the newest sixty once that is read.
  const seen = new Set(items.map(d => d.id)), pool = ibDesk && ibFull ? items.concat(ibFull.filter(d => !seen.has(d.id))) : items;
  let foc = []; try { const v = JSON.parse(localStorage.getItem(FOCUS_KEY) || "[]"); if (Array.isArray(v)) foc = v; } catch {}
  const live = (state.desks?.desks || []).map(d => d.id);
  foc = foc.filter(id => !live.length || live.includes(id));
  const zone = !ibDesk && !ibAll && foc.length > 0;
  const keep = d => ibDesk ? d.desk?.id === ibDesk : !zone || !d.desk || foc.includes(d.desk.id);
  // A chip per desk that has a document here, the ones with something
  // waiting first; under a focus, its desks only.
  const desks = new Map();
  for (const d of [...state.queue, ...pool]) if (d.desk && (!zone || foc.includes(d.desk.id) || d.desk.id === ibDesk)) desks.set(d.desk.id, d.desk.name);
  const waits = id => state.queue.filter(d => d.desk?.id === id).length;
  const chips = [...desks].sort((a, b) => waits(b[0]) - waits(a[0])).map(([id, name]) =>
    `<button type="button" class="ib-chip" data-ib="desk" data-k="${id}" aria-pressed="${ibDesk === id}">${esc(name)}${waits(id) ? `<span class="n">${waits(id)}</span>` : ""}</button>`).join("");
  const bar = `<div class="ib-bar" role="group" aria-label="Show"><button type="button" class="ib-chip" data-ib="desk" data-k="0" aria-pressed="${!ibDesk}">${zone ? "Your focus" : "All"}</button>${chips}` +
    `<input type="search" class="ib-q" data-ib="find" spellcheck="false" autocomplete="off" placeholder="Find by title" aria-label="Find a document by its title" value="${esc(ibFind)}"></div>`;
  const out = zone ? pool.filter(d => !keep(d)).length : 0;
  const outLine = out ? `<p class="ib-out">${plural(out, "document")} from desks outside your focus · <button type="button" data-ib="all">Show</button></p>`
    : ibAll && foc.length ? `<p class="ib-out">Every desk's, not only your focus · <button type="button" data-ib="zone">Only my focus</button></p>` : "";
  // What is waiting comes first, so Monday's plan is not under ten
  // documents read since. Its head stands while the ghost of the last one
  // waiting does, so the list under it does not move up.
  const filtered = ibDesk || zone, queue = state.queue.filter(keep), rest = pool.filter(keep);
  const n = filtered ? queue.length : state.waiting, w = n || ghost?.sec === "waiting", held = new Set(queue.map(d => d.id));
  const says = ibDesk ? `From ${esc(desks.get(ibDesk) || "this desk")}${n ? `: ${plural(n, "document")} waiting, then the rest` : ", newest first"}.`
    : n ? `${plural(n, "document")} waiting, then the rest, newest first.` : zone ? "Newest first, from the desks in your focus." : "Newest first, across every project.";
  // Open the newest and Mark all read are every desk's, so they are offered
  // on the whole list only.
  return `<div class="inbox-head"><h1>${recent ? "Recent" : "Inbox"}</h1><p>${says}</p>${bar}</div>` +
    (w ? `<h2 class="inbox-sec">Waiting${n ? `<span class="n">${n}</span>${filtered ? "" : `<button type="button" data-q="next">Open the newest<kbd class="lk">n</kbd></button><button type="button" data-q="clear">Mark all read</button>`}` : ""}</h2><ul class="inbox waiting">${list("waiting", queue)}</ul><h2 class="inbox-sec">Earlier</h2>` : "") +
    `<ul class="inbox">${list("rest", rest.filter(d => !held.has(d.id)))}</ul>` +
    (rest.length ? "" : `<p class="ib-out">${ibDesk ? "Nothing from this desk yet." : "Nothing from the desks in your focus yet."}</p>`) + outLine;
}

/** A desk's documents from before the newest sixty, read once it is chosen. */
function ibMore() {
  const want = ibDesk;
  fetch(`/api/inbox?limit=${IB_MORE}`).then(r => r.ok ? r.json() : null).then(xs => {
    if (!Array.isArray(xs) || ibDesk !== want) return;
    ibFull = xs; ibRedraw();
  }, () => {});
}
/** The Inbox drawn again where it stands: the page's own redraw, which the
 *  focus's event asks for (ui/app/09-answers.js). */
const ibRedraw = () => dispatchEvent(new Event("snyvi-focus"));

document.addEventListener("click", e => {
  const b = e.target.closest?.("[data-ib]");
  if (!b || b.dataset.ib === "find") return;
  if (b.dataset.ib === "desk") { const id = +b.dataset.k || 0; ibDesk = ibDesk === id ? 0 : id; ibFull = null; if (ibDesk) ibMore(); else ibAll = false; }
  else if (b.dataset.ib === "all") ibAll = true;
  else if (b.dataset.ib === "zone") ibAll = false;
  ibRedraw();
});
// The field narrows the rows on the page, in place: a redraw would take the
// hand out of it.
document.addEventListener("input", e => {
  const i = e.target.closest?.("input[data-ib=find]");
  if (!i) return;
  ibFind = i.value;
  const q = ibFind.trim().toLowerCase();
  for (const li of document.querySelectorAll("#doc ul.inbox > li")) { const t = li.querySelector(".title"); if (t) li.hidden = !!q && !t.textContent.toLowerCase().includes(q); }
});


// The retry on a Home that could not be read is outside `.hm`.
document.addEventListener("click", e => { if (c && e.target.closest("[data-hm=retry]")) refresh(); });
