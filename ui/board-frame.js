/* The runtime inside a board's one document (1.62, docs/BOARD.md).
 *
 * A board was one iframe per frame: a document, a script realm and a
 * compositor layer each, at a size the agent had to guess, since a
 * sandboxed frame cannot be measured from outside. Now the board's sections
 * are drawn in ONE document, this one, served by `/board-frame` with only
 * this script allowed to run (a nonce made for that answer), in an iframe
 * sandboxed without allow-same-origin: an opaque origin, nothing of the
 * page's. Each section is a shadow root, so one section's CSS cannot reach
 * another's, and is as tall as its content unless the agent gave a height.
 *
 * The iframe sits in the board's world like a frame did, at the sections'
 * bounding box, so the page's pan and zoom move it with everything else and
 * nothing is synced on a pan. It takes no pointer: the page's own frame
 * boxes above it are what the reader picks.
 *
 * What comes in, from the parent only (`event.source === parent`):
 *   {snyvi:"board", t:"tokens", vars:[[name, value]...]}  design/tokens.css
 *   {snyvi:"board", t:"sections", ox, oy, list:[{id, hash, x, y, w, h, html?}]}
 *       every section shown, placed less (ox, oy); html only when the page
 *       has not sent that hash before. A section not in the list goes.
 *   {snyvi:"board", t:"live", id, data}  numbers for its [data-live] slots
 * What goes out, to the parent: {snyvi:"board", t:"ready"} once, and
 * {snyvi:"board", t:"sizes", sizes:{id: height}} when a section's height
 * moves.
 */

(() => {
  const shells = new Map(); // id -> {el, root, hash}
  let said = {};
  let pending = 0;

  // A section is a page of its own to whoever wrote it: what they gave
  // `body` or `html` is the section's box (the server rewrites the same for
  // an export, src/board.rs `host_selectors`). The defaults are a page's.
  const BASE = ":host{display:block;box-sizing:border-box;overflow:hidden;background:#fff;color:#000;contain:layout paint style}";

  // Light, as the iframe element is (06-style.js): a scheme that differs
  // from its element's paints the frame opaque, over the board.
  document.documentElement.style.cssText = "margin:0;background:transparent;overflow:hidden;color-scheme:light";
  // No overflow on the body: its children are all placed, so its height is
  // 0, and a body that clipped would clip every section.
  document.body.style.cssText = "margin:0;position:relative";

  /** `html`, `body` and `:root` in a selector mean the section itself; a
   *  word edge on each side, so `.body-text` and `htmlish` stay. */
  const hostSel = sel => sel
    .replace(/(^|[\s,>+~(])(?::root|html|body)(?![\w-])/g, "$1:host")
    .replace(/:host\s*>?\s*:host/g, ":host");

  /** Each rule's selector in `css` through `hostSel`; @-rules' preludes
   *  (`@media (...)`) left as they are, their bodies walked. */
  function cssHost(css) {
    let out = "", i = 0;
    while (i < css.length) {
      const open = css.indexOf("{", i), close = css.indexOf("}", i);
      if (open < 0 && close < 0) { out += css.slice(i); break; }
      if (close >= 0 && (open < 0 || close < open)) { out += css.slice(i, close + 1); i = close + 1; continue; }
      const pre = css.slice(i, open);
      out += pre.trim().startsWith("@") ? pre : hostSel(pre);
      out += "{";
      i = open + 1;
    }
    return out;
  }

  function sectionHtml(html) {
    return html.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (_, a, css, b) => a + cssHost(css) + b);
  }

  function tell(msg) { parent.postMessage({ snyvi: "board", ...msg }, "*"); }

  /** Heights, once a frame: what a section's content measures, for the
   *  page to size its box and the iframe by. */
  const ro = new ResizeObserver(entries => {
    for (const e of entries) {
      const id = e.target.dataset.id;
      const h = Math.ceil(e.target.offsetHeight);
      if (id && said[id] !== h) { said[id] = h; pending++; }
    }
    if (pending) {
      pending = 0;
      tell({ t: "sizes", sizes: { ...said } });
    }
  });

  function put(s, ox, oy) {
    let sh = shells.get(s.id);
    if (!sh) {
      const el = document.createElement("div");
      el.dataset.id = s.id;
      const root = el.attachShadow({ mode: "closed" });
      sh = { el, root, hash: "" };
      shells.set(s.id, sh);
      document.body.append(el);
      ro.observe(el);
    }
    const st = sh.el.style;
    st.position = "absolute";
    st.left = `${s.x - ox}px`;
    st.top = `${s.y - oy}px`;
    st.width = `${s.w}px`;
    st.height = s.h ? `${s.h}px` : "";
    if (typeof s.html === "string" && s.hash !== sh.hash) {
      sh.hash = s.hash;
      // innerHTML never runs a script, and the nonce refuses any handler.
      sh.root.innerHTML = `<style>${BASE}</style>` + sectionHtml(s.html);
      sh.live = "";
    }
  }

  /** `a.b` in `data`, or undefined. */
  const at = (data, path) => path.split(".").reduce((v, k) => (v == null ? v : v[k]), data);

  function live(id, data) {
    const sh = shells.get(id);
    if (!sh) return;
    for (const el of sh.root.querySelectorAll("[data-live]")) {
      const v = at(data, el.dataset.live);
      if (v != null && typeof v !== "object") el.textContent = String(v);
    }
  }

  addEventListener("message", e => {
    if (e.source !== parent) return;
    const m = e.data;
    if (!m || m.snyvi !== "board") return;
    if (m.t === "tokens") {
      const root = document.documentElement.style;
      for (const [k, v] of m.vars || []) if (/^--[\w-]+$/.test(k)) root.setProperty(k, String(v));
    } else if (m.t === "sections") {
      const want = new Set();
      for (const s of m.list || []) { want.add(s.id); put(s, m.ox || 0, m.oy || 0); }
      for (const [id, sh] of shells) {
        if (want.has(id)) continue;
        ro.unobserve(sh.el);
        sh.el.remove();
        shells.delete(id);
        delete said[id];
      }
    } else if (m.t === "live") {
      live(m.id, m.data || {});
    }
  });

  tell({ t: "ready" });
})();
