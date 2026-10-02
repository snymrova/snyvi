/* snyvi client. No framework; the server renders documents, this script navigates. */
/* ui/app/01-shell.js: a part of app.js. build.rs joins ui/app/*.js in name order inside
 * one function scope (src/strip.rs `source`); SNYVI_UI_DIR serves the same join. */
  const $ = (s, r = document) => r.querySelector(s);
  const boot = JSON.parse($("#boot").textContent || "{}");
  const root = document.documentElement;
  const main = $("#main"), docEl = $("#doc"), treeEl = $("#tree"), tocEl = $("#toc"), metaEl = $("#meta"), rail = $("#rail");
  const treesEl = $("#trees"), browseEl = $("#browse-nav"), inboxRowEl = $("#inbox-row"), queueEl = $("#queue"), queueBar = $("#queue-bar");

  const state = {
    tree: boot.tree || [],          // one row per project; what it holds is fetched when it is expanded
    sub: new Map(Object.entries(boot.sub || {})),   // project id -> its workflows, once filled
    view: boot.view || "inbox",
    doc: boot.doc || null,
    opening: null,              // the id of a document asked for and not here yet
    deskBehind: null,           // the desk whose rail stays while a document is read over it
    previous: boot.previous || null,
    versions: [],               // ids of every snapshot of the open document, newest first

    folder: boot.folder || null,   // where "Open terminal here" would open, if anywhere
    queue: boot.queue || [],    // the oldest of what arrived and has not been opened, in order
    waiting: boot.waiting != null ? boot.waiting : (boot.queue || []).length,   // how many in all
    cache: new Map(),           // id -> {doc, html, previous}
    split: (() => { try { return localStorage.getItem("snyvi.split") === "1"; } catch { return false; } })(),
    comparing: null,            // {a, b} while a comparison is shown
    browse: boot.browse || [],  // folders opened with `snyvi browse`
    browseRoot: boot.browseRoot || null,
    browsePath: boot.browsePath || "",
    preview: null,              // "html" | "pdf" when the open file can be shown as a page
    previewUrl: null,
    previewOn: false,
    previewKey: null,           // what previewOn belongs to, so a toggle survives a re-render
    online: boot.online || {},  // agent name -> how many of it hold a stream on the daemon now
    notes: boot.notes || [],    // the last few lines agents left, newest first
    desks: null,                // what /api/desks said, for a window; a tab never has any
    deskId: null,               // the desk on screen, or null for the list of them
  };

  // ---------- helpers ----------
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  /** A POST, with a JSON body when there is one. Null is the daemon saying
   *  nothing at all, which a refusal (a Response that is not ok) is not. */
  /** A list the daemon did not send, said where the list goes -- never as the
   *  list being empty -- with a Retry that loads it again (`data-retry`). */
  const noReach = (what, tag = "p") => `<${tag} class="no-reach" role="alert">Could not reach snyvi<button type="button" data-retry="${what}">Retry</button></${tag}>`;
  let treeOff = false, desksOff = false;
  const post = (u, b) => fetch(u, b ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) } : { method: "POST" }).catch(() => null);
  const rel = ts => {
    const d = Date.now() / 1000 - ts;
    if (d < 45) return "just now";
    if (d < 3600) return `${Math.round(d / 60)} min ago`;
    if (d < 86400) return `${Math.round(d / 3600)} h ago`;
    const dt = new Date(ts * 1000);
    if (d < 7 * 86400) return dt.toLocaleDateString(undefined, { weekday: "short" }) + " " + dt.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    return dt.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  };
  /** `rel` in the width a 264px sidebar has. The tree fits one fact at the
   *  end of a row, and age is worth more than kind: `md` sat on eighteen
   *  rows of twenty and told a reader nothing that told them apart. */
  const relShort = ts => {
    const d = Date.now() / 1000 - ts;
    if (d < 60) return "now";
    if (d < 3600) return `${Math.max(1, Math.round(d / 60))}m`;
    if (d < 86400) return `${Math.round(d / 3600)}h`;
    if (d < 7 * 86400) return `${Math.round(d / 86400)}d`;
    return new Date(ts * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  };
  /* A title's budget is pixels, not characters: "S23 · The Desk — session
   * plan" and "snyvi launch post" are 29 and 17 characters, 192 and 109
   * pixels. A canvas measures text without touching layout. */
  const ctx2d = () => { try { return document.createElement("canvas").getContext("2d"); } catch { return null; } };
  const fitCtx = ctx2d(), timeCtx = ctx2d();
  let fitFont = "", titleRoom = 154, recut = false;
  /* 12px of session indent, 20 + 8 of the row's padding, 6 of gap. */
  const roomIn = w => Math.max(60, w - 60);
  // Titles are measured at 550, the weight an unread row is set in
  // (`.t-doc a.new .title`), so a row does not change length when it is read.
  const wide = t => fitCtx.measureText(t).width;
  /** What is left for the title after the row's indent, padding, gap and the
   *  time at its end -- measured too, because "5m" and "Sep 12" are 24px
   *  apart, which is two words of a title. */
  const roomFor = ts => titleRoom - (timeCtx ? timeCtx.measureText(ts).width : 38);
  /** Cut in the middle, not the end: what tells one agent's document from
   *  the next is usually the end of its title, and four rows reading
   *  "Session panes: the…" tell a reader nothing. The head takes the word
   *  boundary nearest 60% of the budget, the tail as many whole words as the
   *  rest holds. The whole title is the row's tip, which only a cut row has
   *  (`cut`). */
  const mid = (t, px) => {
    t = String(t);
    if (!fitCtx || wide(t) <= px) return t;
    let head = 0;
    while (head < t.length && wide(t.slice(0, head + 1)) <= px * 0.6) head++;
    const back = t.lastIndexOf(" ", head);
    if (back > 0 && head - back < 8) head = back;
    const out = t.slice(0, head).trimEnd() + "…";
    let from = t.length;
    while (from > head && wide(out + t.slice(from - 1)) <= px) from--;
    const fwd = t.indexOf(" ", from - 1);
    if (fwd > 0 && fwd - from < 8) from = fwd + 1;
    return out + t.slice(from).trimStart();
  };
  /** A row's tip, only when its name had to be cut to fit (docs/DESIGN.md
   *  §8.1): the whole name, and when it came. */
  const cut = (d, shown) => shown === String(d.title) ? "" : ` data-tip="${esc(d.title)}" data-tip-sub="${fmt(d.received_at)}${waitingRow(d) ? " · waiting" : ""}"`;

  // One formatter, made once: `toLocaleString` with options builds a new one
  // per call, and the sidebar calls this for every row it draws.
  const dateFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const fmt = ts => dateFmt.format(new Date(ts * 1000));
  /** After the frame being built now is on screen: the frame callback runs
   *  before the paint, and the task it queues runs after it. */
  const afterPaint = fn => requestAnimationFrame(() => setTimeout(fn, 0));
  const kindTag = k => ({ markdown: "md", code: "code", diff: "diff", text: "txt", image: "img", binary: "bin", table: "csv" }[k] || k);
  const fmtSize = n => n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB";
  const store = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} }, del: k => { try { localStorage.removeItem(k); } catch {} } };
  /** The ids on the queue, for the rows that carry a mark. Rebuilt whenever
   *  the queue is drawn, which is after every change to it. */
  let queueIds = new Set(state.queue.map(d => d.id));
