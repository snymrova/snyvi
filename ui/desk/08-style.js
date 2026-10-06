/* ui/desk/08-style.js: a part of desk.js, one module. build.rs joins ui/desk/*.js in name
 * order (src/strip.rs `source`); SNYVI_UI_DIR serves the same join. */
// ---------- style ----------

function style() {
  if (document.getElementById("desk-css")) return;
  const s = document.createElement("style");
  s.id = "desk-css";
  s.textContent = CSS + THREAD_CSS;
  document.head.append(s);
}

const CSS = `
@font-face { font-family: "snyvi symbols"; font-display: block; unicode-range: U+E000-F8FF;
  src: local("Symbols Nerd Font Mono"), local("SymbolsNerdFontMono-Regular"), url(/assets/fonts/symbols-nerd.woff2) format("woff2"); }
/* The terminal's sixteen, --t0 to --t15, are the theme's: each theme block
 * in app.css sets its own, so a shell is dressed with the page it sits in.
 * Only the aliases the panel reads are here. */
:root { --pn-bg: var(--bg-raise); --pn-fg: var(--fg); --pn-size: 12.5px; --pn-line: 16px;
  --pn-font: "JetBrains Mono", "snyvi symbols", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
:root[data-view="desk"] #main { overflow: hidden; }
:root[data-view="desk"] #doc { max-width: none; height: 100%; padding: 14px 16px 16px; display: flex; flex-direction: column; }
:root[data-view="desk"] #doc:has(.inbox-head) { display: block; padding: 56px 48px; max-width: calc(var(--measure) + 96px); overflow-y: auto; }
.dk { display: flex; flex-direction: column; height: 100%; min-height: 0; gap: 8px; }
.dk-head { display: flex; align-items: center; gap: 10px; flex: none; min-width: 0; }
/* The page's bar lays its buttons over this row (app.css, #chrome): the
 * rail's at the right, there only while that pane is folded, or a sheet.
 * The head makes room for it when it is showing; the window adds its own three (frame.js). The
 * sidebar folds to its rail rather than away, so it needs no button here. */
:root[data-rail="0"] .dk-head, #app:has(#rail.empty) .dk-head { padding-right: 30px; }
@media (max-width: 1100px) { .dk-head { padding-right: 30px; } }
.dk-name { font-weight: 600; }
/* Left off: the rest of the head's width, one line, cut with an ellipsis; its
   whole text is its tip. The slot is there with nothing said, so its coming
   moves nothing; empty, it shows only when the head is hovered or focused. */
.dk-left { flex: 1 1 0; min-width: 0; display: flex; align-items: center; gap: 6px; }
.dk-left-b { min-width: 0; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 2px 6px; border: 0; border-radius: var(--r-sm);
  background: none; font: inherit; font-size: var(--fs-small); color: var(--fg-2); text-align: left; cursor: text; }
button.dk-left-b:hover { background: var(--rule); color: var(--fg); }
.dk-left-k { color: var(--fg-3); }
.dk-left-b.none { color: var(--fg-3); opacity: 0; }
.dk-head:is(:hover, :focus-within) .dk-left-b.none { opacity: 1; }
.dk-left-in { flex: 1; min-width: 0; font: inherit; font-size: var(--fs-small); padding: 1px 6px; border: 1px solid var(--rule-2); border-radius: var(--r-sm); background: var(--bg); color: var(--fg); }
/* Keys: the slot after Left off, a key always there, dim until the desk has
   one and then with the count beside it; its sheet hangs under it, over the
   panes. A key just kept lights its row and the button once, in the
   background only, so nothing moves. */
.dk-keys { position: relative; flex: none; display: flex; align-items: center; }
.dk-keys-b { display: flex; align-items: center; gap: 3px; padding: 2px 5px; border: 0; border-radius: var(--r-sm); background: none; font: inherit; font-size: var(--fs-small); color: var(--fg-2); white-space: nowrap; cursor: pointer; }
.dk-keys-b:hover, .dk-keys-b[aria-expanded="true"] { background: var(--rule); color: var(--fg); }
.dk-keys-b .n { font-size: var(--fs-micro); font-variant-numeric: tabular-nums; }
.dk-keys-b.none { color: var(--fg-3); }
@keyframes dk-kept { 0%, 40% { background: color-mix(in srgb, var(--accent) 22%, transparent); } 100% { background: transparent; } }
.dk-keys-b.kept, .dk-key.new { animation: dk-kept calc(var(--dur-moment) * 2) ease-out; }
@media (prefers-reduced-motion: reduce) { .dk-keys-b.kept, .dk-key.new { animation: none; } }
.dk-keys-sheet { position: absolute; top: calc(100% + 6px); right: 0; z-index: var(--z-pop); width: min(460px, calc(100vw - 32px)); padding: 8px 10px 10px; background: var(--bg-raise); border: 1px solid var(--rule); border-radius: 8px; box-shadow: var(--shadow); font-size: var(--fs-small); color: var(--fg-2); text-align: left; white-space: normal; cursor: auto; }
.dk-keys-h { color: var(--fg-3); padding: 0 2px 6px; border-bottom: 1px solid var(--rule); margin-bottom: 2px; }
.dk-key { display: flex; align-items: center; gap: 8px; padding: 4px 2px; border-bottom: 1px solid var(--rule); }
.dk-key-n { flex: none; font-family: var(--mono); font-size: 12px; font-weight: 600; color: var(--fg); }
.dk-key-m { flex: 1; min-width: 0; color: var(--fg-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dk-key-x { flex: none; }
.dk-keys-none { margin: 6px 2px; color: var(--fg-3); }
.dk-keys-add { display: grid; gap: 6px; padding-top: 8px; }
.dk-keys-t { color: var(--fg-3); font-weight: 600; }
.dk-keys-add label { display: flex; align-items: center; gap: 8px; }
.dk-keys-add label > span { flex: 0 0 44px; color: var(--fg-3); }
.dk-keys-add input:not([type="radio"]) { flex: 1; min-width: 0; font: inherit; font-family: var(--mono); font-size: 12px; padding: 2px 6px; border: 1px solid var(--rule-2); border-radius: var(--r-sm); background: var(--bg); color: var(--fg); }
.dk-keys-w { display: flex; align-items: center; gap: 10px; }
.dk-keys-w > span { color: var(--fg-3); }
.dk-keys-w button { margin-left: auto; padding: 2px 10px; border: 1px solid var(--accent); border-radius: var(--r-sm); background: none; font: inherit; font-size: var(--fs-small); color: var(--accent); cursor: pointer; }
.dk-keys-w button:disabled { opacity: .5; cursor: default; }
.dk-keys-say { margin: 0; color: var(--fg-3); font-size: var(--fs-micro); }
/* An agent's suggestion: a ghost row, quieter than a line of the reader's,
   with its two answers always shown. */
.dk-sug .nm { color: var(--fg-3); font-style: italic; }
.dk-sug-tools { display: flex; gap: 2px; flex: none; }
.dk-keep { padding: 0 6px; border: 1px solid var(--rule-2); border-radius: var(--r-sm); background: none; font: inherit; font-size: var(--fs-micro); color: var(--fg-2); cursor: pointer; }
.dk-keep:hover { color: var(--fg); border-color: var(--accent); }
.dk-ev { padding: 0 4px; border: 0; background: none; font: inherit; font-size: var(--fs-micro); color: var(--accent); cursor: pointer; }
.dk-ev:hover { text-decoration: underline; }
.dk-root { color: var(--fg-3); font-family: var(--mono); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dk-tabs { display: flex; gap: 2px; margin-left: auto; }
.dk-tabs button { font-family: var(--mono); font-size: 11px; color: var(--fg-3); padding: 2px 5px; border-radius: 4px; }
.dk-tabs button.on { color: var(--accent); background: var(--accent-bg); }
/* A tab out of sight that is waiting on the reader is amber, as the rail is.
 * The one that is on wears the accent; the pane's own ⤡ says full view. */
.dk-tabs button.blk { color: var(--warn); font-weight: 600; }
/* And the window gives the pane everything: no sidebar, no rail, and none of
 * the buttons that would bring them back -- ⤡ or ⌃⌥Z is the way out. The
 * fold preferences are not touched, so coming back is exactly as it was. */
:root[data-full] #app { grid-template-columns: 0 minmax(0,1fr) 0 !important; }
:root[data-full] #side, :root[data-full] #rail { display: none !important; }
:root[data-full] #chrome #btn-rail { display: none !important; }
.pn-full:hover, .pn-ren:hover, .pn-x:hover { background: var(--rule-2); color: var(--fg); }
/* The pen, full view and ✕, on every panel, in the grid and in full view
   alike: three slots of their own at the head's end, quiet at rest and --fg
   under the pointer, so none comes and goes nor lands on the state beside it. */
:is(.pn-ren, .pn-full, .pn-x) { flex: none; align-self: center; width: 22px; height: 22px; margin: -4px 0; display: grid; place-items: center; border-radius: 4px; color: var(--fg-3); transition: background var(--t), color var(--t); }
.pn-ren { margin-left: -2px; }
.pn-x { margin-right: -4px; }
/* Armed, the ✕ asks "Close?" over the head's end, to its left, rather than
   growing and pushing the state along: nothing in the head moves. */
.pn-x { position: relative; }
.pn-x[data-armed], .pn-x[data-armed]:hover { color: var(--danger); background: color-mix(in srgb, var(--danger) 12%, var(--bg)); }
.pn-x[data-armed]::before { content: "Close?"; position: absolute; right: 100%; top: 0; bottom: 0; display: grid; place-items: center; padding: 0 5px; border-radius: 4px 0 0 4px; font-size: 11px; font-weight: 600; background: inherit; }
.pn-x[data-armed] { border-radius: 0 4px 4px 0; }
.pn-head .ren-in { flex: 1; min-width: 60px; font: inherit; color: var(--fg); background: var(--bg); border: 1px solid var(--accent); border-radius: 4px; padding: 0 4px; outline: none; }
.dk-head .icon:first-of-type { margin-left: auto; }
.dk-head .dk-tabs:not(:empty) + .icon, .dk-head .dk-cap + .icon { margin-left: 0; }
/* At the cap: the + at rest, and the count beside it in the tab strip's
 * hand, so 4/4 and the quiet + read as one thing. */
.dk-head .icon:disabled { opacity: .4; cursor: default; }
.dk-head .icon:disabled:hover { background: none; color: var(--fg-3); }
.dk-cap { font-family: var(--mono); font-size: 11px; color: var(--fg-3); margin-left: auto; padding: 2px 0 2px 5px; font-variant-numeric: tabular-nums; }
.dk-tabs:not(:empty) + .dk-cap { margin-left: 0; }
.dk-grid { flex: 1; min-height: 0; display: grid; gap: 6px; position: relative; }
.dk-none { color: var(--fg-3); padding: 24px; }
.dk-none button { color: var(--accent); }
.dk-div { position: absolute; z-index: 2; }
.dk-v { top: 0; bottom: 0; width: 8px; left: calc(var(--col) * 100% - 4px); cursor: col-resize; }
.dk-h { left: 0; right: 0; height: 8px; top: calc(var(--row) * 100% - 4px); cursor: row-resize; }
.dk-grid:not([data-cols="2"]) .dk-v, .dk-grid:not([data-rows="2"]) .dk-h { display: none; }
.dk-div:hover, .dk-div:focus-visible { background: var(--accent-bg); }
.pn { position: relative; display: flex; flex-direction: column; min-width: 0; min-height: 0; border: 1px solid var(--rule); border-radius: 6px; background: var(--pn-bg); overflow: hidden; }
.pn.on { border-color: var(--rule-2); box-shadow: 0 0 0 1px var(--accent-bg); }
/* A head carried onto another pane: the one carried goes faint, the one it
   would trade places with is outlined. */
.pn.pn-drag { opacity: .55; }
/* A link under the pointer with Ctrl held: underlined over the pane, and the
   pointer says it can be clicked. */
.pn-body.pn-on-link { cursor: pointer; }
.pn-ul { position: absolute; inset: 0; pointer-events: none; z-index: 2; }
.pn-ul i { position: absolute; height: 1px; background: var(--accent); }
.pn.pn-drop, .dk-tabs .pn-drop { outline: 2px solid var(--accent); outline-offset: -2px; }
.pn-head { display: flex; gap: 8px; align-items: baseline; padding: 4px 8px; font-size: 11.5px; color: var(--fg-3); border-bottom: 1px solid var(--rule); cursor: default; white-space: nowrap; flex: none; }
.pn-slot { font-family: var(--mono); color: var(--fg-2); }
.pn-start[hidden], .pn-connect[hidden] { display: none; }
.pn-cmd { color: var(--fg-2); overflow: hidden; text-overflow: ellipsis; }
.pn-git { font-family: var(--mono); color: var(--fg-3); overflow: hidden; text-overflow: ellipsis; max-width: 40%; flex: none; }
.pn-state { margin-left: auto; padding-left: 8px; }
/* The context window, before the state: quiet, warmer from 70%, the waiting
   amber from 85%. The rail's row and the meta's line wear the same three.
   Its kept room lies in the head's open middle, so the state sits against
   the tools and the figure coming in moves neither. */
.pn-ctx:not(.kept) { display: none; }
.pn-ctx.kept { min-width: 11ch; text-align: right; margin-left: auto; }
.pn-ctx.kept + .pn-state { margin-left: 0; }
.ctx { color: var(--fg-3); font-variant-numeric: tabular-nums; }
.ctx.warm { color: var(--fg-2); }
.ctx.hot { color: var(--warn); font-weight: 600; }
.dk-focus .ctx { margin-left: auto; padding-left: 6px; font-size: 11px; }
.pn.blk .pn-head { border-bottom: 2px solid var(--warn); }
.pn.blk .pn-state { color: var(--warn); font-weight: 600; animation: pn-need .8s ease-out; }
.pn.done .pn-state { color: var(--accent); }
@keyframes pn-need { 0%, 60% { background: color-mix(in srgb, var(--warn) 18%, transparent); } 100% { background: transparent; } }
@media (prefers-reduced-motion: reduce) { .pn.blk .pn-state { animation: none; } }
/* The scrollbar's room is kept whether or not there is one: a panel whose
 * output first overflowed grew a scrollbar, lost a column to it, was resized
 * and cleared, lost the overflow, gave the column back -- and a busy program
 * kept that going every frame. */
.pn-body { flex: 1; min-height: 0; overflow-y: auto; overflow-anchor: none; overflow-x: hidden; padding: 4px 6px; font-family: var(--pn-font); font-size: var(--pn-size); line-height: var(--pn-line); color: var(--pn-fg); outline: none; scrollbar-width: thin; scrollbar-gutter: stable; }
.pn-pg > div, .pn-scr > div { white-space: pre; height: var(--pn-line); overflow: hidden; }
.pn-pg > .gap { color: var(--fg-3); font-style: italic; }
/* A chunk of scrollback put away: no rows, the height they had. */
.pn-pg { contain: content; }
.pn-pg.held { height: calc(var(--n) * var(--pn-line)); contain: strict; }
.pn-old { color: var(--fg-3); }
/* The live screen on a layer of its own, and each row shut in on itself: a
 * spinner's frame repaints its row, not the pane or the panes beside it
 * (docs/DESK-PAINT.md, Phase 2). */
.pn-live { position: relative; will-change: transform; }
.pn-scr > div { contain: strict; }
/* Phase 3: the live rows are drawn on the canvas; the text over it is the same
 * rows, unstyled and unseen, for selection, copy and the caret's reading. */
.pn-cv { position: absolute; left: 0; top: 0; pointer-events: none; }
.pn-scr { position: relative; color: transparent; text-rendering: optimizeSpeed; font-variant-ligatures: none; }
/* A pane's text changing lays out the pane, not the desk's grid around it. */
.pn-body { contain: strict; }
.pn-scr ::selection { color: transparent; background: color-mix(in srgb, var(--accent) 32%, transparent); }
.pn.off .pn-cv { opacity: .55; }
.pn-caret { position: absolute; left: 0; top: 0; height: var(--pn-line); background: var(--fg); opacity: .35; pointer-events: none; }
.pn.on .pn-caret { opacity: .75; animation: pn-blink 1.1s steps(1) infinite; }
@keyframes pn-blink { 50% { opacity: .15; } }
.pn-body .b { font-weight: 650; } .pn-body .d { opacity: .6; } .pn-body .i { font-style: italic; }
.pn-body .u { text-decoration: underline; } .pn-body .s { text-decoration: line-through; } .pn-body .u.s { text-decoration: underline line-through; }
.pn-body .h { color: transparent !important; }
.pn-body span { display: inline-block; height: var(--pn-line); vertical-align: top; }
/* An icon is drawn a full em wide and a cell is 0.6 of one: set a size down,
 * centred in its cell, and over its neighbours rather than under them. */
.pn-body .nf { position: relative; font-size: 10px; }
.pn-body .g { position: relative; -webkit-text-fill-color: transparent; }
.pn-body .g::before { content: ""; position: absolute; inset: 0; background: currentColor; -webkit-mask: var(--g) 0 0 / 100% 100% no-repeat; mask: var(--g) 0 0 / 100% 100% no-repeat; }
.pn-body .x.r { width: calc(var(--r) * var(--cw)); }
.pn-body .g.r::before { -webkit-mask-size: var(--cw) 100%; mask-size: var(--cw) 100%; -webkit-mask-repeat: repeat-x; mask-repeat: repeat-x; }
/* The offer after an unplanned stop: over the top of the panel, in the
   waiting amber, out of the way of the prompt it would type into. */
.pn-offer { position: absolute; left: 12px; right: 12px; top: 8px; z-index: 3; display: flex; gap: 8px; align-items: center; padding: 6px 8px 6px 12px; font-size: 12px;
  background: color-mix(in srgb, var(--warn) 12%, var(--bg-raise)); color: var(--fg); border: 1px solid color-mix(in srgb, var(--warn) 40%, transparent); border-radius: 6px; box-shadow: var(--shadow); }
.pn-offer[hidden] { display: none; }
.pn-offer > span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pn-offer button { flex: none; padding: 3px 8px; border-radius: 4px; color: var(--fg-2); }
.pn-offer [data-offer="go"] { color: var(--accent); font-weight: 600; }
.pn-offer button:hover { background: var(--rule-2); color: var(--fg); }
.pn-start { position: absolute; left: 12px; right: 12px; bottom: 12px; display: flex; gap: 8px; align-items: center; padding: 8px; background: var(--bg-raise); border: 1px solid var(--rule-2); border-radius: 6px; box-shadow: var(--shadow); }
.pn-start button { color: var(--accent); font-weight: 600; flex: none; }
.pn-start .pn-resume { color: var(--fg); font-weight: 500; }
.pn-start .pn-resume[hidden] { display: none; }
.pn-connect { position: absolute; left: 12px; right: 12px; bottom: 60px; padding: 10px 12px; background: var(--bg-raise); border: 1px solid var(--rule-2); border-radius: 6px; box-shadow: var(--shadow); font-size: 12.5px; color: var(--fg-2); }
.pn-connect p { margin: 0 0 8px; line-height: 1.45; }
.pn-connect p:last-child { margin: 0; }
.pn-connect .ok { color: var(--ok); }
.pn-connect .w-btn { font: inherit; font-weight: 600; color: var(--on-accent); background: var(--accent); border: 0; border-radius: 6px; padding: 5px 12px; cursor: pointer; }
.dk-wait .dk-empty { display: flex; align-items: center; gap: 6px; }
.dk-ask { margin: 2px 8px 6px; font-size: 12px; line-height: 1.5; color: var(--fg-2); }
.dk-ask q { color: var(--fg); }
/* A few turns and then still: a desk can wait days for its first document,
 * and a ring that never stops turning cost the compositor 8% of a core the
 * whole time -- behind a document, and on another desk too. */
.dk-spin { flex: none; width: 8px; height: 8px; border-radius: 50%; border: 1.5px solid var(--fg-3); border-right-color: transparent; animation: dk-spin 1.2s linear 3; }
@keyframes dk-spin { to { transform: rotate(1turn); } }
@media (prefers-reduced-motion: reduce) { .dk-spin { animation: none; } }
.pn-start input { flex: 1; min-width: 0; font: 12.5px var(--mono); color: var(--fg); background: var(--bg); border: 1px solid var(--rule); border-radius: 4px; padding: 3px 6px; }
.pn-probe { position: absolute; visibility: hidden; white-space: pre; font-family: var(--pn-font); font-size: var(--pn-size); }
/* ---------- the rail ----------
 * Three lists and a label over each, drawn the way the sidebar draws its own
 * rows: a mark at the left, the name, and one fact at the right. */
.dk-lab { display: flex; align-items: baseline; padding-left: 8px; }
.dk-lab .n { margin-left: auto; font-family: var(--mono); font-size: 10px; letter-spacing: 0; text-transform: none; color: var(--fg-3); font-variant-numeric: tabular-nums; }
.dk-lab .n i { font-style: normal; }
.dk-lab .n b { font-weight: inherit; color: var(--accent); }
.dk-foot { display: flex; gap: 10px; margin-top: 2px; }
/* The rail's parts, one under the other, the same distance apart. */
.dk-rail > * + * { margin-top: 16px; }
/* #toc styles an outline -- a rule down the left, entries clamped to two
 * lines -- and these are rows, so both are undone at #toc's own weight. */
#toc .dk-rail ul { list-style: none; margin: 2px 0 0; padding: 0; border-left: 0; }
/* A pane's row is the row and its tools: the row focuses the pane, and the
 * tools -- shown when the row is under the cursor, or one of them has the
 * keyboard, the way a sidebar row's ✕ is -- act on it. They lie over the
 * row's right end and take no room in it: room given only under the pointer
 * reflowed the title beneath it, and the list jumped as the cursor passed. */
.dk-pane { display: flex; align-items: center; border-radius: 6px; color: var(--fg-2); transition: background var(--t), color var(--t); }
.dk-pane:hover { background: var(--rule); color: var(--fg); }
.dk-pane.on { background: var(--accent-bg); color: var(--accent); }
.dk-focus { display: flex; align-items: baseline; gap: 6px; flex: 1; min-width: 0; text-align: left; padding: 4px 8px; color: inherit; white-space: nowrap; overflow: hidden; }
.dk-tools { display: flex; align-items: center; gap: 1px; flex: none; margin-left: auto; }
:is(.dk-pane, .dk-doc:not(.on), .dk-row) { position: relative; }
/* Over the end of the title, on a ground that fades in from it: the hover
   ground (--rule, see-through in the dark themes) laid over the rail's own. */
:is(.dk-pane, .dk-doc:not(.on), .dk-row) > .dk-tools { position: absolute; top: 0; bottom: 0; right: 0; padding: 0 3px 0 14px; border-radius: 0 6px 6px 0; opacity: 0; pointer-events: none; transition: opacity var(--t);
  background: linear-gradient(90deg, transparent, var(--tools-bg, var(--rule)) 14px), linear-gradient(90deg, transparent, var(--bg-side) 14px); }
.dk-pane.on > .dk-tools { --tools-bg: var(--accent-bg); }
/* The desk's folder is the folder's own name, and a click opens it in the file manager. */
.dk-folder { min-width: 0; padding: 0; text-align: left; font: inherit; color: inherit; overflow-wrap: anywhere; border-radius: 3px; }
.dk-folder:hover { color: var(--accent); }
:is(.dk-pane, .dk-doc, .dk-row):is(:hover, :focus-within) > .dk-tools, .dk-tools:has([data-armed]) { opacity: 1; pointer-events: auto; }
.dk-tools button { display: grid; place-items: center; width: 20px; height: 20px; border-radius: 4px; color: var(--fg-3); transition: background var(--t), color var(--t); }
.dk-pane.on .dk-tools button { color: var(--accent); opacity: .8; }
.dk-tools button:hover { background: var(--rule-2); color: var(--fg); opacity: 1; }
.dk-sug-tools > button:not(.dk-keep) { display: grid; place-items: center; width: 20px; height: 20px; border-radius: 4px; color: var(--fg-3); }
.dk-sug-tools > button:not(.dk-keep):hover { background: var(--rule-2); color: var(--fg); }
.dk-tools button[data-armed] { width: auto; padding: 0 5px; font-size: 11px; font-weight: 600; color: var(--danger); }
.dk-tools button[data-armed]:hover { background: color-mix(in srgb, var(--danger) 12%, transparent); color: var(--danger); }
.dk-panes .dot { width: 8px; flex: none; text-align: center; font-size: 8px; color: var(--fg-3); align-self: center; }
.dk-panes .run .dot { color: var(--ok); }
.dk-panes .blk .dot { color: var(--warn); font-weight: 700; font-size: 11px; }
/* The documents section folds. Its head is the label, made a summary: the
 * chevron the sidebar's heads carry, shown under the cursor and while
 * folded. */
.dk-sec > summary { list-style: none; cursor: pointer; }
.dk-sec > summary::-webkit-details-marker { display: none; }
/* Shown the way the sidebar's are (app.css): under the cursor, and while
 * the section is folded. One chevron style across the app. */
.dk-sec .s-chev { align-self: center; margin-left: 6px; }
.dk-sec:not([open]) .s-chev { transform: rotate(-45deg); }
.dk-sec > summary:hover { color: var(--fg-2); }
.dk-panes .slot, .dk-docs .slot, .dk-slot { font-family: var(--mono); font-size: 10.5px; color: var(--fg-3); flex: none; font-variant-numeric: tabular-nums; }
.dk-panes .on .slot { color: inherit; }
.dk-panes .nm { overflow: hidden; text-overflow: ellipsis; }
.dk-new { display: block; color: var(--fg-3); padding: 3px 8px; font-size: 12px; border-radius: 6px; }
.dk-new:hover:not(:disabled, .dim) { color: var(--accent); }
.dk-new:is(:disabled, .dim) { opacity: .5; cursor: default; }
/* Said to a screen reader, not drawn: why a quiet control is quiet. */
.vh { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
/* The rest of the documents, as one row under the latest: the count is the
 * number the rail is not showing, so it changes as they arrive. */
.dk-more { margin-top: 2px; font-variant-numeric: tabular-nums; }
/* A long list's search, at its head: a field the width of a row. */
.dk-find { display: block; box-sizing: border-box; width: calc(100% - 16px); margin: 2px 8px 4px; padding: 2px 6px; border: 1px solid var(--rule-2); border-radius: var(--r-sm); background: var(--bg); font: inherit; font-size: var(--fs-small); color: var(--fg); }
.dk-find::placeholder { color: var(--fg-3); }
/* A document row: a page icon at the left, in the accent while the
 * document waits to be read, then the title, the pane it came from and its
 * age. */
#toc .dk-docs li a { display: flex; flex: 1; min-width: 0; align-items: baseline; gap: 6px; margin: 0; padding: 4px 8px; border: 0; border-radius: 6px; color: var(--fg-2); line-height: 1.5; white-space: normal; overflow: hidden; -webkit-line-clamp: unset; transition: color var(--t); }
.dk-docs a svg { flex: none; align-self: flex-start; margin-top: 3px; color: var(--fg-3); transition: color var(--t); }
.dk-docs .age { flex: none; font-family: var(--mono); font-size: 10px; color: var(--fg-3); font-variant-numeric: tabular-nums; }
.dk-docs a.new svg { color: var(--accent); }
.dk-docs a.new .title { color: var(--fg); font-weight: 550; }
/* The row, and not the link, carries the hover and the mark, so the copy
 * tool beside the link sits on the same ground. */
.dk-doc { display: flex; align-items: center; border-radius: 6px; transition: background var(--t); }
.dk-doc:hover { background: var(--rule); }
#toc .dk-docs li a:hover { color: var(--fg); text-decoration: none; }
.dk-doc.on { background: var(--accent-bg); }
#toc .dk-doc.on a, .dk-doc.on a svg, .dk-doc.on a .age { color: var(--accent); }
.dk-doc.on .age { display: none; }
.dk-doc.on .dk-tools { padding-right: 3px; }
/* A document row's tools are drawn as small keys, on their own ground: the
 * marked row shows them at rest, and two bare glyphs beside a title would
 * read as part of it. The age steps aside for them on that row. */
.dk-doc .dk-tools { gap: 3px; }
.dk-doc .dk-tools button { background: var(--bg-raise); box-shadow: 0 0 0 1px var(--rule-2); }
.dk-doc.on .dk-tools button { color: var(--accent); opacity: 1; box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 30%, transparent); }
.dk-doc .dk-tools button:hover { background: var(--accent); color: var(--on-accent); box-shadow: none; }
/* One line of title, and two on the row being read: a list is for finding
 * a row, and the one open is the one worth reading whole. */
.dk-docs .title { flex: 1; min-width: 0; display: -webkit-box; -webkit-line-clamp: 1; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
.dk-doc.on .title { -webkit-line-clamp: 2; }
/* What the reader removed from the list: named in a line, and opened under
 * it, each row with its Undo at rest. */
#toc .dk-offs-line { margin: 4px 8px 0; font-size: 11px; color: var(--fg-3); font-variant-numeric: tabular-nums; }
.dk-link { color: var(--fg-2); border-radius: 3px; }
.dk-link:hover { color: var(--accent); }
.dk-doc.off a { opacity: .7; }
.dk-doc.off .dk-undo { margin-right: 3px; }
.dk-panes .slot::before { content: "["; } .dk-panes .slot::after { content: "]"; }
.dk-docs .k { font-family: var(--mono); font-size: 10px; color: var(--fg-3); flex: none; min-width: 3ch; text-align: right; font-variant-numeric: tabular-nums; }
#toc .dk-empty { margin: 2px 8px 0; padding: 0; text-indent: 0; font-size: 12px; line-height: 1.5; color: var(--fg-3); }
/* The desk's name carries its two tools; the row is a little taller than
 * its neighbours so they have room, and the name stays on their baseline. */
#meta .dk-row { align-items: center; min-height: 22px; }
#meta .dk-row .dk-nm { flex: 1; }
#meta .dk-row .dk-tools { line-height: 1; }
/* The desk's repository on the web, under the panel's line: quiet until
 * pointed at, and cut short rather than wrapped. */
#meta .dk-repo-row { min-width: 0; }
#meta .dk-repo { display: inline-flex; align-items: center; gap: 6px; min-width: 0; color: var(--fg-3); text-decoration: none; }
#meta .dk-repo svg { flex: none; }
#meta .dk-repo span:first-of-type { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#meta .dk-repo .dk-out { flex: none; font-size: var(--fs-micro); }
#meta .dk-repo:hover, #meta .dk-repo:focus-visible { color: var(--accent); }
.dk-make { padding: 6px 12px; border-radius: 6px; background: var(--accent-bg); color: var(--accent); font-weight: 600; }
.dk-make:hover { background: var(--accent); color: var(--on-accent); }
/* ---------- the list ----------
 * A checklist, drawn on the same row grid as the panels and the documents
 * above it, so the three read as one rail and not as three widgets. The
 * circle is the one control that is always visible: it is the whole point of
 * the row, and a tick that had to be hunted for under a hover would not be
 * worth having. Everything else -- rewriting, taking it off -- waits for the
 * cursor, as every other row in this app does.
 *
 * A line wraps rather than being cut. A pane's title is a name and a name that
 * does not fit can be shortened; a note is a sentence, and half of it is not a
 * smaller version of it. */
.dk-note { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 0 6px; border-radius: 6px; transition: background var(--t); }
.dk-note:hover { background: var(--rule); }
.dk-note { position: relative; }
.dk-note > .nm { flex: 1; min-width: 0; text-align: left; margin: 4px 0; font-size: 12px; line-height: 1.5; color: var(--fg-2); white-space: normal; overflow-wrap: anywhere;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
/* The card a line is rewritten in: over the row's text, the same left edge,
   laid over the lines below rather than pushing them. */
.dk-note > .dk-note-over { position: absolute; z-index: var(--z-pop, 30); top: 1px; left: 30px; right: 4px; margin: 0; resize: none; overflow-y: auto; background: var(--bg-raise); box-shadow: var(--shadow-2, var(--shadow)); }
.dk-note.editing > .field-err { position: absolute; z-index: var(--z-pop, 30); top: 100%; left: 30px; right: 4px; }
.dk-note:hover > .nm { color: var(--fg); }
/* Done: said twice, because a strike alone is hard to see at 12px in a dim
   rail and a dim row alone reads as disabled rather than as finished. */
.dk-note.done > .nm { color: var(--fg-3); text-decoration: line-through; text-decoration-color: var(--fg-3); }
/* A line an agent ticked says which agent, and where the work went, on a
   line of its own under the text, lined up with it: the reader can untick
   it like any other. */
.dk-by { flex: 1 0 100%; display: flex; align-items: center; gap: 6px; min-width: 0; padding: 0 8px 4px 37px; margin-top: -2px; font-size: 10.5px; color: var(--fg-3); font-family: var(--mono); }
.dk-by > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dk-by button { font: inherit; color: var(--fg-3); border-radius: 3px; }
.dk-sha { padding: 0 3px; background: var(--rule); }
.dk-sha[data-said] { color: var(--ok); }
.dk-sent { display: grid; place-items: center; width: 16px; height: 16px; }
.dk-sent svg { width: 12px; height: 12px; }
.dk-by button:hover { color: var(--accent); }
/* The circle. A button rather than a checkbox input so it draws the same on
   every platform, with the role and the state a checkbox would have carried. */
.dk-tick { position: relative; flex: none; display: grid; place-items: center; width: 12px; height: 12px; margin: 7px 0 0 8px; border-radius: 50%; box-shadow: inset 0 0 0 1.5px var(--fg-3); color: transparent; transition: box-shadow var(--t), background var(--t), color var(--t); }
.dk-tick:hover { box-shadow: inset 0 0 0 1.5px var(--accent); }
/* Done is quiet: the accent is for what wants looking at, and a done note
   is the one thing on the rail that does not. */
.dk-tick[aria-checked="true"] { background: var(--fg-3); box-shadow: none; color: var(--bg); }
.dk-tick svg { width: 9px; height: 9px; }
/* Small to the eye and not to the hand: the press lands on 20 px. */
.dk-tick:not(.ghost)::before { content: ""; position: absolute; inset: -4px; border-radius: 50%; }
/* The field's own circle: the row keeps its shape while it is being written,
   so the text does not step left and back again as the field opens and shuts. */
.dk-tick.ghost { box-shadow: inset 0 0 0 1.5px var(--rule-2); }
/* A note's ✕ keeps its room whether it shows or not: the text wraps, and
   room given only under the pointer rewrapped it -- the row changed height
   under the hand that was reaching for it. */
.dk-note .dk-tools { align-self: flex-start; margin-top: 3px; width: auto; padding-right: 3px; opacity: 0; transition: opacity var(--t); }
.dk-note:is(:hover, :focus-within) .dk-tools, .dk-note .dk-tools:has([data-armed]) { opacity: 1; }
.dk-note-in { flex: 1; min-width: 0; margin: 2px 8px 2px 0; padding: 2px 6px; font: inherit; font-size: 12px; line-height: 1.5; color: var(--fg); background: var(--bg); border: 1px solid var(--accent); border-radius: 4px; }
.dk-note-in:focus { outline: none; }
.dk-note-in::placeholder { color: var(--fg-3); }
/* The bar at rest: the live field's size and border width, its colour quiet,
   so opening it changes a colour and nothing else. */
.dk-note-in.idle { border-color: var(--rule-2); background: transparent; cursor: text; }
.dk-note-in.idle:hover { border-color: var(--fg-3); }
/* A line just taken off, holding its own place in the list: the offer to put
   it back is where the ✕ was, which is where the eye already is. Nothing was
   deleted, so the row says the mildest true thing and says it quietly. */
.dk-note.gone { color: var(--fg-3); font-size: 12px; padding: 4px 8px; animation: dk-fade 140ms ease-out; }
/* A refusal, in the row that asked, with its Retry. */
.dk-err { list-style: none; display: flex; align-items: baseline; gap: 6px; padding: 2px 8px 4px 26px; font-size: 11.5px; color: var(--danger); }
.dk-pane.closing { opacity: .5; }
.dk-note.gone > .nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-decoration: line-through; }
.dk-undo { flex: none; font-size: 11px; line-height: 1; padding: 3px 7px; border-radius: 4px; color: var(--accent); }
.dk-undo:hover { background: color-mix(in srgb, var(--accent) 14%, transparent); }
/* The list's head carries its two actions over the right end of the
 * summary, in room the summary keeps for them, so nothing moves as they
 * come and go -- and Remove done notes' answer, with its Undo, in their place. */
.dk-notes-part { position: relative; }
.dk-notes > summary { padding-right: 52px; }
.dk-notes-part.undo .dk-notes > summary .n { visibility: hidden; }
.dk-sec-acts { position: absolute; top: 5px; right: 0; display: flex; align-items: center; gap: 2px; }
.dk-sec-acts > button { display: grid; place-items: center; width: 20px; height: 20px; border-radius: 4px; color: var(--fg-3); transition: background var(--t), color var(--t); }
.dk-sec-acts > button:hover { background: var(--rule-2); color: var(--fg); }
.dk-act-room { width: 20px; }
.dk-cleared { display: flex; align-items: center; gap: 4px; padding-left: 8px; font-size: 11px; color: var(--fg-3); background: var(--bg-side); animation: dk-fade 140ms ease-out; }
/* How far an agent has got: a slot every line keeps between its circle and
 * its text, 10 px, so a line that is picked up does not step right. Read is
 * a small ring, planned the plan's page (it opens it), working a dot that
 * breathes three times when the panel's agent takes it up -- each draw of the
 * rail is a new three, and nothing paints in between. Centred on the first line. */
.dk-stage { position: relative; flex: none; display: grid; place-items: center; width: 10px; height: 10px; margin: 8px -2px 0 -3px; padding: 0; color: var(--fg-3); }
.dk-stage.read::before { content: ""; width: 6px; height: 6px; border-radius: 50%; box-shadow: inset 0 0 0 1.25px var(--fg-3); }
.dk-stage.planned svg { width: 10px; height: 10px; }
.dk-stage.planned:hover { color: var(--accent); }
.dk-stage.planned::before { content: ""; position: absolute; inset: -4px; }
.dk-stage.working::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--accent); }
.dk-stage.working.busy::before { animation: dk-breathe calc(var(--dur-moment) * 2) ease-in-out 3; }
@keyframes dk-breathe { 50% { opacity: .35; } }
@media (prefers-reduced-motion: reduce) { .dk-stage.working::before { animation: none; } }
/* A line's pictures: one mark at the end of its text, with their count, that
 * opens them whole -- the row is the height of its text, pictures or not. A
 * fixed width, so the mark turning into the Undo of one just taken off, and
 * back, moves nothing. */
.dk-pic { flex: none; display: inline-flex; align-items: center; justify-content: center; gap: 1px; width: 24px; height: 18px; margin-top: 4px; padding: 0; border-radius: 4px; color: var(--fg-3); transition: background var(--t), color var(--t); }
.dk-pic svg { width: 12px; height: 12px; }
.dk-pic .c { font-family: var(--mono); font-size: 10px; line-height: 1; font-variant-numeric: tabular-nums; }
button.dk-pic:hover { background: var(--rule-2); color: var(--fg); }
.dk-pic.back { color: var(--accent); }
/* Pictures waiting on the new line: the same mark, in the field's row. */
.dk-pend { flex: none; display: flex; align-items: center; gap: 1px; margin: 2px 4px 2px -4px; color: var(--fg-2); }
.dk-pend .dk-pic { margin: 0; color: var(--fg-2); }
.dk-pend button { display: grid; place-items: center; width: 18px; height: 18px; border-radius: 4px; color: var(--fg-3); }
.dk-pend button:hover { background: var(--rule-2); color: var(--fg); }
/* The row a dragged picture would land on. */
.dk-note.drop { background: var(--accent-bg); box-shadow: inset 0 0 0 1px var(--accent); }
/* A picture whole, over the page. */
.dk-lb { position: fixed; inset: 0; z-index: var(--z-dialog); display: grid; place-items: center; padding: 32px; background: var(--scrim); animation: dk-fade 120ms ease-out; }
.dk-lb figure { margin: 0; max-width: 100%; max-height: 100%; display: flex; flex-direction: column; gap: 10px; min-height: 0; }
.dk-lb img { display: block; max-width: min(1400px, calc(100vw - 64px)); max-height: calc(100vh - 120px); object-fit: contain; border-radius: 6px; background: var(--bg-raise); box-shadow: var(--shadow); }
.dk-lb figcaption { display: flex; align-items: center; gap: 8px; min-width: 0; padding: 6px 8px 6px 12px; border-radius: 8px; background: var(--bg-raise); box-shadow: var(--shadow); font-size: 12px; color: var(--fg-2); }
.dk-lb figcaption .t { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg); }
.dk-lb figcaption .k { font-family: var(--mono); font-size: 11px; color: var(--fg-3); font-variant-numeric: tabular-nums; }
.dk-lb figcaption button { flex: none; padding: 3px 8px; border-radius: 4px; color: var(--fg-2); }
.dk-lb figcaption button:hover { background: var(--rule-2); color: var(--fg); }
.dk-lb figcaption .lb-gone { display: flex; align-items: center; gap: 4px; color: var(--fg-3); }
.dk-lb figcaption .lb-gone .dk-undo { color: var(--accent); }
/* The last picture taken off: the caption alone, holding its Undo. */
.dk-lb figure.none { min-width: min(420px, calc(100vw - 64px)); }
/* An empty list's line is the way to its first note. */
/* ---------- points ----------
 * The control by a selection: small, on the page's raised ground, where the
 * selection ends. And the kept points under the panels, on the list's own
 * row grid, a few lines each: a passage is quoted whole when it goes in, and
 * the rail only has to say which one it is. */
.dk-pick { position: fixed; z-index: 30; padding: 4px 10px; border-radius: 6px; font-size: 12px; line-height: 1.4; color: var(--accent); background: var(--bg-raise); box-shadow: 0 0 0 1px var(--rule-2), 0 4px 14px rgb(0 0 0 / .18); animation: dk-fade 120ms ease-out; }
.dk-pick:hover:not(:disabled) { background: var(--accent); color: var(--on-accent); }
.dk-pick:disabled { cursor: default; }
.dk-point > .nm { padding-left: 8px; border-left: 2px solid var(--rule-2); margin-left: 8px; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow: hidden; }
.dk-put { color: var(--accent); }
#toc .dk-said { margin-top: 4px; color: var(--fg-2); }
@keyframes dk-fade { from { opacity: 0; } to { opacity: 1; } }
`;
