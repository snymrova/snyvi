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
.bd-off, .bd-hint { position: absolute; left: 50%; top: 40%; transform: translateX(-50%); margin: 0;
  color: var(--fg-2); font-size: var(--fs-ui); }
.bd-hint { visibility: hidden; }
.bd.bd-none .bd-hint { visibility: visible; }
.bd-rail h3 { margin: 0 0 var(--sp-2); font-size: var(--fs-ui); }
.bd-rail h4 { margin: var(--sp-4) 0 var(--sp-2); font-size: var(--fs-small); color: var(--fg-2); font-weight: 500; }
.bd-rows, .bd-toks { list-style: none; margin: 0; padding: 0; }
.bd-row { display: flex; width: 100%; gap: var(--sp-2); justify-content: space-between; padding: 4px var(--sp-2);
  border: 0; border-radius: var(--r-sm); background: none; color: var(--fg); font: inherit; font-size: var(--fs-ui); text-align: left; cursor: pointer; }
.bd-row:hover { background: var(--wash); }
.bd-row.bd-on { background: var(--wash-on); }
.bd-row-m { color: var(--fg-3); font-size: var(--fs-small); }
.bd-tok { display: flex; gap: var(--sp-2); align-items: center; padding: 2px var(--sp-2); font-size: var(--fs-small); }
.bd-sw { width: 14px; height: 14px; border-radius: var(--r-xs); box-shadow: inset 0 0 0 1px var(--rule-2); flex: none; }
.bd-design, .bd-quiet { margin: var(--sp-2) 0 0; color: var(--fg-2); font-size: var(--fs-small); }
@media (prefers-reduced-motion: reduce) { .bd-new .bd-sheet { animation: none; } }
`;
