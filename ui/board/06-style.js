/** The board's CSS, put in once with the chunk: first paint pays nothing for
 *  it. Colours, sizes and durations are the design system's tokens. */
function style() {
  if (document.getElementById("bd-css")) return;
  const s = document.createElement("style");
  s.id = "bd-css";
  s.textContent = BOARD_CSS;
  document.head.append(s);
}

const BOARD_CSS = `
.bd { position: absolute; inset: 0; overflow: hidden; cursor: default; touch-action: none;
  background-color: var(--bg-side); background-image: radial-gradient(var(--rule-2) 1px, transparent 1px);
  background-size: 24px 24px; }
.bd:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--focus); }
.bd.bd-panning { cursor: grabbing; }
.bd-world { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
.bd-frame { position: absolute; }
.bd-label { position: absolute; left: 0; bottom: 100%; display: flex; gap: var(--sp-2); align-items: baseline;
  padding: 0 0 6px; white-space: nowrap; font-size: var(--fs-small); color: var(--fg-2);
  transform: scale(calc(1 / var(--bd-k, 1))); transform-origin: 0 100%; }
.bd-name { color: var(--fg); font-weight: 500; }
.bd-sheet { position: relative; background: var(--bg); box-shadow: var(--shadow-1); border-radius: var(--r-xs); overflow: hidden; }
.bd-sheet iframe { display: block; border: 0; pointer-events: none; background: var(--bg); }
.bd-on .bd-sheet { outline: calc(2px / var(--bd-k, 1)) solid var(--accent); outline-offset: calc(3px / var(--bd-k, 1)); }
.bd-new .bd-sheet { animation: bd-in var(--dur-move) var(--ease-out); }
@keyframes bd-in { from { opacity: 0; transform: scale(.98); } to { opacity: 1; transform: none; } }
.bd-empty { margin: 0; padding: var(--sp-5); color: var(--fg-3); font-size: var(--fs-ui); }
.bd-bar { position: absolute; left: var(--sp-4); bottom: var(--sp-4); max-width: calc(100% - 2 * var(--sp-4)); height: 32px;
  display: flex; gap: var(--sp-2); align-items: center; padding: 0 var(--sp-4); border-radius: var(--r-pill);
  background: var(--bg-raise); box-shadow: var(--shadow-1); font-size: var(--fs-ui); color: var(--fg-2);
  overflow: hidden; white-space: nowrap; text-overflow: ellipsis; z-index: var(--z-sticky); }
.bd-bar-k { color: var(--fg-3); }
.bd-bar-v { color: var(--fg); overflow: hidden; text-overflow: ellipsis; }
.bd-off { position: absolute; left: 50%; top: 40%; transform: translateX(-50%); margin: 0;
  color: var(--fg-2); font-size: var(--fs-ui); }
/* The board's one document, under the frames' boxes (02-frames.js). Light,
   as its page is: a scheme that differs paints the frame opaque. */
.bd-doc { position: absolute; border: 0; pointer-events: none; background: transparent; color-scheme: light; }
.bd-sec .bd-sheet { background: transparent; border-radius: 0; }
/* The empty board's intro (05-live.js): there only while the board is empty,
   over the canvas, so it coming and going moves nothing. */
.bd-intro { position: absolute; left: 50%; top: 42%; transform: translate(-50%, -50%); width: min(440px, calc(100% - 2 * var(--sp-5)));
  padding: calc(2 * var(--sp-4)); border-radius: var(--r-md); background: var(--bg-raise); box-shadow: var(--shadow-1);
  color: var(--fg-2); font-size: var(--fs-ui); visibility: hidden; }
.bd.bd-none .bd-intro { visibility: visible; }
.bd-intro h3 { margin: 0 0 var(--sp-2); color: var(--fg); font-size: var(--fs-body-s); font-weight: 600; }
.bd-intro p { margin: 0 0 var(--sp-3); line-height: 1.5; }
.bd-intro code { font-family: var(--mono); font-size: var(--fs-small); color: var(--fg); }
.bd-ask, .bd-bform { display: flex; gap: var(--sp-2); margin: 0; }
.bd-ask input, .bd-bform input { flex: 1; min-width: 0; height: 30px; padding: 0 var(--sp-3); border: 0; border-radius: var(--r-sm);
  background: var(--bg); box-shadow: inset 0 0 0 1px var(--rule-2); color: var(--fg); font: inherit; }
.bd-ask button, .bd-bform button { flex: none; height: 30px; padding: 0 var(--sp-3); border: 0; border-radius: var(--r-sm);
  background: var(--accent); color: var(--on-accent); font: inherit; font-weight: 500; cursor: pointer; }
.bd-intro .bd-ask-said { min-height: 1.5em; margin: var(--sp-2) 0 0; color: var(--fg-3); font-size: var(--fs-small); }
/* The board's own bar, top left (03-list.js): one row that never wraps, so
   the canvas under it does not move as frames come. */
.bd-list { position: absolute; left: var(--sp-3); top: var(--sp-3); right: var(--sp-3); z-index: var(--z-sticky);
  display: flex; gap: 4px; align-items: center; height: 30px; pointer-events: none; }
.bd-list > * { pointer-events: auto; }
.bd-title { flex: none; display: inline-flex; gap: 4px; align-items: center; height: 26px; margin-right: 4px; padding: 0 var(--sp-2); border: 0;
  border-radius: var(--r-pill); background: transparent; font: inherit; font-size: var(--fs-ui); font-weight: 600; color: var(--fg); cursor: pointer; }
.bd-title:hover, .bd-title[aria-expanded="true"] { background: var(--bg-raise); box-shadow: inset 0 0 0 1px var(--rule); }
.bd-title i { font-style: normal; font-weight: 400; color: var(--fg-3); font-size: var(--fs-small); }
.bd-boards { position: absolute; left: 0; top: 34px; width: min(280px, 100%); padding: var(--sp-2); border-radius: var(--r-md);
  background: var(--bg-raise); box-shadow: var(--shadow-1); display: flex; flex-direction: column; gap: 2px; }
.bd-boards hr { width: 100%; margin: var(--sp-1) 0; border: 0; border-top: 1px solid var(--rule); }
.bd-brow { display: flex; justify-content: space-between; gap: var(--sp-2); align-items: center; height: 28px; padding: 0 var(--sp-2);
  border: 0; border-radius: var(--r-sm); background: transparent; color: var(--fg-2); font: inherit; font-size: var(--fs-ui); text-align: left; cursor: pointer; }
.bd-brow:hover { background: var(--rule); color: var(--fg); }
.bd-brow.bd-on { color: var(--fg); font-weight: 500; }
.bd-bact { color: var(--fg-2); }
.bd-said { margin: 0; color: var(--fg-3); font-size: var(--fs-small); }
.bd-said:empty { display: none; }
.bd-chip { flex: none; max-width: 16ch; height: 26px; padding: 0 10px; border: 0; border-radius: var(--r-pill);
  background: var(--bg-raise); box-shadow: inset 0 0 0 1px var(--rule); color: var(--fg-2); font: inherit; font-size: var(--fs-small);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer; }
.bd-chip:hover { color: var(--fg); box-shadow: inset 0 0 0 1px var(--rule-2); }
.bd-chip.bd-on { color: var(--fg); box-shadow: inset 0 0 0 1.5px var(--accent); }
.bd-quiet { flex: none; padding: 0 var(--sp-2); color: var(--fg-3); font-size: var(--fs-small); }
.bd-look-b { flex: none; display: inline-flex; gap: 2px; align-items: center; height: 26px; margin-left: auto; padding: 0 8px; border: 0;
  border-radius: var(--r-pill); background: var(--bg-raise); box-shadow: inset 0 0 0 1px var(--rule); color: var(--fg-2); font: inherit; font-size: var(--fs-small); cursor: pointer; }
.bd-look-b[aria-expanded="true"], .bd-look-b:hover { box-shadow: inset 0 0 0 1px var(--rule-2); color: var(--fg); }
.bd-look { position: absolute; right: 0; top: 34px; width: min(300px, 100%); max-height: 60vh; overflow: auto; padding: var(--sp-3);
  border-radius: var(--r-md); background: var(--bg-raise); box-shadow: var(--shadow-1); }
.bd-toks { list-style: none; margin: 0; padding: 0; }
.bd-tok { display: flex; gap: var(--sp-2); align-items: center; padding: 2px 0; font-size: var(--fs-small); }
.bd-tok-v { margin-left: auto; color: var(--fg-3); font-family: var(--mono); }
.bd-sw { width: 14px; height: 14px; border-radius: var(--r-xs); box-shadow: inset 0 0 0 1px var(--rule-2); flex: none; }
.bd-design { margin: 0 0 var(--sp-3); color: var(--fg-2); font-size: var(--fs-small); }
@media (prefers-reduced-motion: reduce) { .bd-new .bd-sheet { animation: none; } }
`;
