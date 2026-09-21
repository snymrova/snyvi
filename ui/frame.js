/* The window's frame.
 *
 * In the native window the page is the frame: there is no title bar. The
 * header rows -- the sidebar's brand row, the rail's empty top, a desk's
 * header -- carry data-tauri-drag-region, which the window's own script
 * answers (a drag moves the window, a double-click maximises it), and this
 * draws the bar's three buttons at the window's top right corner, whatever
 * the panes are doing, and does what the bar's did. Shown only once the
 * window says the page may: a window older than this page refuses, and keeps
 * its own bar. Not on macOS, where the traffic lights stay the system's, over
 * the brand row, and the page only leaves them room.
 *
 * Fetched by app.js only where there is a window to ask -- a browser tab
 * never carries it. The same seam as desk.js, and bench/bytes.mjs prices it
 * on the deferred rows. `data-frame` on the root is what the stylesheet
 * below keys on, and nothing else sets it.
 */

const CSS = `
.win { display: flex; gap: 2px; pointer-events: auto; }
.win[hidden] { display: none; }
.wb { display: grid; place-items: center; width: 30px; height: 28px; border-radius: 6px; color: var(--fg-3); transition: background var(--t), color var(--t); }
.wb:hover { background: var(--rule); color: var(--fg); }
.wb-close:hover { background: #c0392b; color: #fff; }
.win .wb-restore, .win[data-max="1"] .wb-max { display: none; }
.win[data-max="1"] .wb-restore { display: block; }
:root[data-frame="page"] .rail-grip { display: block; position: absolute; top: 0; left: 0; right: 0; height: 60px; }
/* Room for the buttons when the rail is not beside the desk header to hold
   them: a desk with the rail folded, or with nothing in it. */
:root[data-frame="page"][data-view="desk"][data-rail="0"] .dk-head, :root[data-frame="page"][data-view="desk"]:has(#rail.empty) .dk-head { padding-right: 100px; }
:root[data-frame="mac"] .side-head { padding-left: 84px; }
.help-box dl + h2 { margin-top: 20px; }
.help-note { margin: 12px 0 0; font-size: 12.5px; color: var(--fg-3); }
@media (max-width: 1100px) {
  :root[data-frame="page"][data-view="desk"] .dk-head { padding-right: 136px; }
  :root[data-frame="page"] #find { padding-right: 156px; }
}
`;

const svg = (d, cls) => `<svg${cls ? ` class="${cls}"` : ""} viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round">${d}</svg>`;
const BUTTONS =
  `<button class="wb" data-win="min" title="Minimise" aria-label="Minimise window">${svg('<path d="M1.5 6.5h9"/>')}</button>` +
  `<button class="wb" data-win="max" title="Maximise" aria-label="Maximise window">${svg('<rect x="1.5" y="1.5" width="9" height="9" rx="1.2"/>', "wb-max")}${svg('<path d="M3.5 3.5V2.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H8.5"/><rect x="1.5" y="3.5" width="7" height="7" rx="1"/>', "wb-restore")}</button>` +
  `<button class="wb wb-close" data-win="close" title="Close" aria-label="Close window">${svg('<path d="M2 2l8 8M10 2l-8 8"/>')}</button>`;

/* The desk's keys, in the help box. A desk exists only in the window, so
 * the keys for one are the window's to tell of, in the box the `?` opens
 * everywhere -- ahead of the foot, which stays the box's own. */
const HELP =
  `<h2>On a desk</h2><dl>` +
  `<dt>⌃\`</dt><dd>the desk, or the reading view</dd>` +
  `<dt>⌃⌥1 – ⌃⌥4</dt><dd>focus a pane by its slot</dd>` +
  `<dt>⌃⌥Z</dt><dd>the focused pane alone, and back</dd>` +
  `<dt>ctrl shift C / V</dt><dd>copy the selection / paste</dd>` +
  `<dt>shift + wheel</dt><dd>scroll the pane's scrollback</dd>` +
  `</dl><p class="help-note">Every other key goes to the shell in the focused pane.</p>`;

/** `root` is the document element, `$` the page's querySelector. Asks the
 *  window first, and draws nothing until it answers yes. */
export function frame(root, $) {
  const tauri = window.__TAURI_INTERNALS__;
  if (!tauri) return;
  const win = cmd => tauri.invoke("plugin:window|" + cmd);
  return win("is_maximized").then(max => {
    const s = document.createElement("style");
    s.id = "frame-css";
    s.textContent = CSS;
    document.head.append(s);
    $("#help .help-foot").insertAdjacentHTML("beforebegin", HELP);
    const mac = /^Mac/.test(navigator.platform);
    root.dataset.frame = mac ? "mac" : "page";
    if (mac) return;
    const el = document.createElement("div");
    el.className = "win"; el.id = "win";
    el.innerHTML = BUTTONS;
    $("#chrome .chrome-r").append(el);
    const wb = w => el.querySelector(`[data-win=${w}]`), btn = wb("max");
    const show = m => { el.dataset.max = m ? "1" : "0"; btn.title = m ? "Restore" : "Maximise"; btn.setAttribute("aria-label", m ? "Restore window" : "Maximise window"); };
    const refresh = () => win("is_maximized").then(show, () => {});
    show(max);
    wb("min").addEventListener("click", () => win("minimize"));
    btn.addEventListener("click", () => win("toggle_maximize").then(refresh));
    wb("close").addEventListener("click", () => win("close"));
    window.addEventListener("resize", refresh);
  }, () => {});
}
