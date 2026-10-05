/* ui/studio/09-style.js: a part of studio.js, one module. build.rs joins
 * ui/studio/*.js in name order (src/strip.rs `source`). */
// ---------- style ----------

/** The studio's rules, put in the page once, the first time any of it draws.
 *  Every colour and size is a token from app.css, so a theme dresses the
 *  studio as it dresses everything else. The rail's studio rows are the
 *  desk's to style (ui/desk/08-style.js): the rail draws before this loads. */
function style() {
  if (document.getElementById("studio-css")) return;
  document.head.append(Object.assign(document.createElement("style"), { id: "studio-css", textContent: CSS }));
}

const CSS = `
/* New studio desk, over the page. */
.st-over { position: fixed; inset: 0; z-index: var(--z-dialog); background: var(--scrim); display: grid; place-items: start center; padding-top: 12vh; }
.st-dlg { width: min(520px, calc(100vw - 32px)); max-height: 80vh; overflow-y: auto; padding: 18px 22px; background: var(--bg-raise); border-radius: var(--r-md); box-shadow: var(--shadow-3); display: grid; gap: 12px; }
.st-dlg-t { margin: 0; font-size: var(--fs-h3); font-weight: 600; letter-spacing: -.01em; color: var(--fg); }
.st-dlg-sub { margin: -6px 0 0; color: var(--fg-2); font-size: var(--fs-body-s); line-height: 1.45; }
.st-f { display: grid; grid-template-columns: 4.5em minmax(0, 1fr) auto; align-items: center; gap: 10px; font-size: var(--fs-ui); }
.st-f > span:first-child { color: var(--fg-2); }
.st-path { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--mono); font-size: var(--fs-small); }
.st-path.none { color: var(--fg-3); font-family: inherit; font-style: italic; }
.st-dlg-err { margin: 0; color: var(--danger); font-size: var(--fs-small); }
.st-dlg-err[hidden] { display: none; }
.st-dlg-act { display: flex; justify-content: flex-end; gap: 8px; }

/* Buttons and words. */
.st-b { padding: 4px 11px; border: 1px solid var(--rule-2); border-radius: var(--r-sm); background: var(--bg); font: inherit; font-size: var(--fs-ui); color: var(--fg); cursor: pointer; white-space: nowrap; }
.st-b:hover { border-color: var(--accent); }
.st-b.go { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
.st-b:disabled { opacity: .55; cursor: default; }
.st-link { padding: 0; border: 0; background: none; font: inherit; color: var(--accent); cursor: pointer; }
.st-link:hover { text-decoration: underline; }
.st-icon { min-width: 26px; height: 26px; padding: 0 5px; border: 0; border-radius: var(--r-sm); background: none; font: inherit; color: var(--fg-2); cursor: pointer; }
.st-icon:hover:not(:disabled) { background: var(--rule); color: var(--fg); }
.st-icon:disabled { opacity: .35; cursor: default; }
.st-quiet { color: var(--fg-3); font-size: var(--fs-small); line-height: 1.45; }
.st-meta { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg-3); font-size: var(--fs-micro); }

/* The viewer: all of the space over the panel, and nothing over it. */
.st { height: 100%; min-height: 0; font-size: var(--fs-ui); }
.st-main { position: relative; height: 100%; min-height: 0; min-width: 0; display: flex; flex-direction: column; }
.st-gallery { flex: 1; min-height: 0; overflow-y: auto; padding: 6px 4px 12px; }
.st-head { display: flex; align-items: baseline; gap: 10px; min-width: 0; margin: 0 0 10px; padding: 0 2px; font-size: var(--fs-small); }
.st-head b { font-weight: 600; color: var(--fg); white-space: nowrap; }
.st-head span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg-3); }

.st-subs { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 12px; }
.st-sub { display: inline-flex; align-items: baseline; gap: 7px; padding: 5px 11px; border: 1px solid var(--rule-2); border-radius: 999px; background: none; font: inherit; color: var(--fg-2); cursor: pointer; }
.st-sub:hover { border-color: var(--accent); color: var(--fg); }
.st-sub .n { font-family: var(--mono); font-size: var(--fs-micro); color: var(--fg-3); font-variant-numeric: tabular-nums; }

/* The grid. Every box is a fixed shape, so nothing moves when a picture
   arrives (no layout shift); its name and its ★ come under the pointer. */
.st-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(168px, 1fr)); gap: 12px; align-content: start; }
.st-tile { position: relative; margin: 0; border-radius: var(--r-md); cursor: zoom-in; content-visibility: auto; contain-intrinsic-size: auto 132px; }
.st-tile:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.st-tile.hid { opacity: .5; }
.st-pic { position: relative; aspect-ratio: 4 / 3; border-radius: var(--r-md); overflow: hidden; background: var(--code-bg); display: grid; place-items: center; }
.st-pic img, .st-pic video { width: 100%; height: 100%; object-fit: cover; display: block; transition: transform var(--t); }
.st-tile:hover .st-pic img, .st-tile:hover .st-pic video { transform: scale(1.025); }
.st-tile.picked .st-pic { box-shadow: 0 0 0 2px var(--warn); }
.st-glyph { font-size: var(--fs-h2); color: var(--fg-3); }
.st-play { position: absolute; right: 7px; bottom: 7px; padding: 1px 6px; border-radius: var(--r-sm); background: color-mix(in srgb, var(--bg) 80%, transparent); color: var(--fg); font-size: var(--fs-micro); }
.st-tile figcaption { position: absolute; left: 0; right: 0; bottom: 0; display: flex; flex-direction: column; min-width: 0; padding: 18px 9px 7px; border-radius: 0 0 var(--r-md) var(--r-md); background: linear-gradient(transparent, color-mix(in srgb, var(--bg) 88%, transparent) 55%); opacity: 0; transition: opacity var(--t); pointer-events: none; }
.st-tile:hover figcaption, .st-tile:focus-visible figcaption, .st-tile.k-audio figcaption, .st-tile.gone figcaption { opacity: 1; }
.st-tile.gone figcaption { pointer-events: auto; flex-direction: row; justify-content: space-between; gap: 8px; background: none; }
.st-tile .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs-small); color: var(--fg); }
.st-tile.gone { cursor: default; }
.st-tile.gone .st-pic { background: none; border: 1px dashed var(--rule-2); }
.st-tile.gone .nm { color: var(--fg-3); }
.st-star { position: absolute; top: 7px; left: 7px; width: 26px; height: 26px; display: grid; place-items: center; padding: 0; border: 0; border-radius: 50%; background: color-mix(in srgb, var(--bg) 82%, transparent); color: var(--fg-3); font-size: var(--fs-small); cursor: pointer; opacity: 0; transition: opacity var(--t); }
.st-star:hover { color: var(--warn); }
.st-star.on { opacity: 1; color: var(--warn); }
.st-tile:hover .st-star, .st-tile:focus-within .st-star { opacity: 1; }
.st-undo { position: absolute; top: 7px; right: 7px; padding: 2px 8px; border: 1px solid var(--rule-2); border-radius: var(--r-sm); background: var(--bg-raise); font: inherit; font-size: var(--fs-small); color: var(--accent); cursor: pointer; }
.st-empty { padding: 48px 16px; text-align: center; color: var(--fg-2); }
.st-empty p { margin: 0 0 6px; }
.st-empty code { font-size: var(--fs-small); }
.st-more, .st-hidden { text-align: center; margin: 14px 0 0; font-size: var(--fs-small); }

/* One file, large, in the viewer's own space; the panel stays below it. */
.st-view { position: absolute; inset: 0; z-index: 5; display: flex; flex-direction: column; gap: 6px; background: var(--bg); }
.st-view-body { flex: 1; min-height: 0; display: grid; place-items: center; overflow: hidden; border-radius: var(--r-md); background: var(--code-bg); }
.st-view-body img, .st-view-body video { max-width: 100%; max-height: 100%; object-fit: contain; display: block; }
.st-view-audio { display: grid; gap: 12px; place-items: center; }
.st-view-bar { position: relative; flex: none; display: flex; align-items: center; gap: 8px; min-width: 0; height: 32px; }
.st-view-bar .nm { min-width: 0; max-width: 32ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg-2); font-size: var(--fs-small); }
.st-keep.on { border-color: var(--warn); color: var(--warn); }
.st-gap { flex: 1; }
.st-view-n { color: var(--fg-3); font-size: var(--fs-small); font-variant-numeric: tabular-nums; }
.st-info summary { list-style: none; }
.st-info summary::-webkit-details-marker { display: none; }
.st-info[open] summary { border-color: var(--accent); }
.st-info-box { position: absolute; left: 0; bottom: calc(100% + 6px); z-index: 2; width: min(420px, 100%); max-height: 50vh; overflow-y: auto; padding: 12px 14px; background: var(--bg-raise); border-radius: var(--r-md); box-shadow: var(--shadow-3); font-size: var(--fs-small); }
.st-info-p { margin: 0 0 4px; color: var(--fg); line-height: 1.5; white-space: pre-wrap; }
.st-info-box dl { margin: 10px 0 0; display: grid; grid-template-columns: 6em minmax(0, 1fr); gap: 3px 8px; }
.st-info-box dt { color: var(--fg-3); }
.st-info-box dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
@media (max-width: 560px) { .st-view-bar .nm { display: none; } }
`;
