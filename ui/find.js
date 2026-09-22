/* Find in the document: the bar `/` opens, the marks it lays over the text,
 * and the walk between them.
 *
 * A chunk, like the desk view, the diagram driver, the game and the panels.
 * Searching inside a document is a thing a reader asks for, not a thing the
 * page does on the way to showing one, and until the key is pressed there is
 * no bar, no marks and nothing to clear -- which is why the page can call
 * `clear`, `refresh` and `close` on a module that was never fetched and mean
 * exactly what happens anyway: nothing.
 *
 * The page keeps `#find` itself, because whether the bar is up is a question
 * it answers before deciding to ask for any of this.
 */

let d = null;                       // what the page handed over, kept for the listeners
let marks = [], idx = -1, timer = null;

/* An HTML <mark> inside an <svg> lays out at 0x0, so wrapping a diagram's label
 * in one does not highlight it -- it erases it, and counts a match the reader
 * cannot be shown. Diagram text is skipped until there is a way to point at
 * it, which needs the zoom in phase 3 of docs/DIAGRAMS.md. The placeholder
 * label is chrome rather than document text, and would otherwise make every
 * search for "diagram" find one per diagram. */
const SKIP = "script,style,.copy,svg,.mmd-note";

/** Put the bar up, wiring it the first time. */
export function open(deps) {
  if (!d) { d = deps; wire(); }
  const { $ } = d;
  $("#find").hidden = false;
  const input = $("#find-input");
  input.focus(); input.select();
}

function wire() {
  const { $ } = d;
  const input = $("#find-input");
  input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => run(input.value), 80); });
  input.addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); goto(idx + (e.shiftKey ? -1 : 1)); }
    if (e.key === "Escape") { e.preventDefault(); close(); }
  });
  $("#find-next").addEventListener("click", () => goto(idx + 1));
  $("#find-prev").addEventListener("click", () => goto(idx - 1));
  $("#find-close").addEventListener("click", close);
}

/** Take the marks back out of the text. Safe before anything was ever found. */
export function clear() {
  if (!d) return;
  for (const m of marks) { const p = m.parentNode; if (!p) continue; p.replaceChild(document.createTextNode(m.textContent), m); p.normalize(); }
  marks = []; idx = -1; d.$("#find-count").textContent = "";
}

/** The document under the bar changed: lay the same search over the new text. */
export function refresh() {
  if (!d) return;
  const input = d.$("#find-input");
  if (!d.$("#find").hidden && input.value) run(input.value); else clear();
}

export function close() {
  if (!d) return;
  d.$("#find").hidden = true;
  clear();
  d.$("#find-input").value = "";
}

function run(q) {
  clear();
  if (!q) return;
  const { $, docEl } = d;
  const needle = q.toLowerCase();
  const walker = document.createTreeWalker(docEl, NodeFilter.SHOW_TEXT, { acceptNode: n => n.parentNode.closest(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
  const texts = []; let n; while ((n = walker.nextNode())) texts.push(n);
  for (const t of texts) {
    let text = t.nodeValue, lower = text.toLowerCase(), pos = lower.indexOf(needle);
    if (pos < 0) continue;
    const frag = document.createDocumentFragment(); let last = 0;
    while (pos >= 0 && marks.length < 2000) {
      frag.appendChild(document.createTextNode(text.slice(last, pos)));
      const m = document.createElement("mark"); m.className = "find"; m.textContent = text.slice(pos, pos + q.length);
      frag.appendChild(m); marks.push(m);
      last = pos + q.length; pos = lower.indexOf(needle, last);
    }
    frag.appendChild(document.createTextNode(text.slice(last)));
    t.parentNode.replaceChild(frag, t);
  }
  if (marks.length) goto(0); else $("#find-count").textContent = "No matches";
}

function goto(i) {
  if (!marks.length) return;
  const { $, docEl, bring } = d;
  if (idx >= 0) marks[idx].classList.remove("cur");
  idx = (i + marks.length) % marks.length;
  marks[idx].classList.add("cur");
  bring(() => docEl.querySelector("mark.find.cur"), "center");
  $("#find-count").textContent = `${idx + 1} / ${marks.length}`;
}
