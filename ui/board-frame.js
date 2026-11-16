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
 *   {snyvi:"board", t:"css", css}  the board's shared CSS (1.67, board.css),
 *       put before every section's own
 *   {snyvi:"board", t:"shot", id, n}  a picture of one section, asked for
 * What goes out, to the parent: {snyvi:"board", t:"ready"} once,
 * {snyvi:"board", t:"sizes", sizes:{id: height}} when a section's height
 * moves, and {snyvi:"board", t:"shot", n, id, png} for a picture asked: a
 * PNG data URL, or "" when this engine would not draw one.
 */

(() => {
  const shells = new Map(); // id -> {el, root, hash}
  let said = {};
  let pending = 0;
  /** The board's shared CSS, before each section's own. */
  let shared = "";

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
      sh.html = s.html;
      fill(sh);
    }
  }

  /** A section's root from its HTML: the base, the board's shared CSS, then
   *  its own. innerHTML never runs a script, and the nonce refuses any
   *  handler. */
  function fill(sh) {
    sh.root.innerHTML = `<style>${BASE}</style>` + sectionHtml((shared ? `<style>${shared}</style>` : "") + (sh.html || ""));
    sh.live = "";
  }

  /** A picture of one section: its root's markup in an SVG foreignObject,
   *  drawn on a canvas, read back as a PNG. The section is drawn as it is
   *  here, less what it loads from the network (a picture, a web font):
   *  an image holds none of that. An engine that will not read such a
   *  canvas back answers "", and the page says so. */
  async function shot(id, n) {
    let png = "";
    try {
      const sh = shells.get(id);
      const w = sh.el.offsetWidth, h = sh.el.offsetHeight;
      const rs = document.documentElement.style;
      let vars = "";
      for (let i = 0; i < rs.length; i++) if (rs[i].startsWith("--")) vars += `${rs[i]}:${rs.getPropertyValue(rs[i])};`;
      const box = document.createElement("div");
      box.className = "snyvi-host";
      box.setAttribute("style", `${vars}width:${w}px;height:${h}px`);
      box.innerHTML = sh.root.innerHTML.replace(/:host(?![\w-])/g, ".snyvi-host");
      const xml = new XMLSerializer().serializeToString(box);
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><foreignObject width="100%" height="100%">${xml}</foreignObject></svg>`;
      const img = new Image();
      await new Promise((ok, no) => { img.onload = ok; img.onerror = no; img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg); });
      // Twice the size where that stays small: text in a picture read by an
      // agent, or pasted into a document, is read at more than one zoom.
      const k = Math.min(2, 2400 / Math.max(w, 1), 6000 / Math.max(h, 1));
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      png = c.toDataURL("image/png");
    } catch { png = ""; }
    tell({ t: "shot", n, id, png });
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
    } else if (m.t === "css") {
      const css = typeof m.css === "string" ? m.css : "";
      if (css !== shared) { shared = css; for (const sh of shells.values()) fill(sh); }
    } else if (m.t === "shot") {
      shot(m.id, m.n);
    }
  });

  tell({ t: "ready" });
})();
