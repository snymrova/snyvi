/* Two versions compared, and a diff read split: fetched the first time
 * either is asked for (`c`, the Versions box, `s` on a diff), with the
 * split's look. Out of first paint since 1.8: most pages are neither. */

const CSS = `
.split { display: grid; grid-template-columns: 1fr 1fr; font-family: var(--mono); font-size: var(--fs-ui); line-height: 1.6; border: 1px solid var(--rule); border-radius: var(--r-sm); overflow-x: auto; }
.split > div { padding: 0 10px; white-space: pre; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.split .l { border-right: 1px solid var(--rule); }
.split .full { grid-column: 1 / -1; }
.split .meta { color: var(--fg-3); padding-top: .4em; }
.split .hunk { color: var(--s-number); background: var(--code-bg); margin: .4em 0 .2em; }
.split .add { background: var(--add); color: var(--add-fg); }
.split .del { background: var(--del); color: var(--del-fg); }
.split .add mark { background: color-mix(in srgb, var(--add-fg) 30%, transparent); color: inherit; border-radius: var(--r-xs); }
.split .del mark { background: color-mix(in srgb, var(--del-fg) 30%, transparent); color: inherit; border-radius: var(--r-xs); }
.split .empty { background: repeating-linear-gradient(45deg, transparent 0 6px, var(--rule) 6px 7px); }
#doc:has(.split) { max-width: none; padding-left: 40px; padding-right: 40px; }
`;
let styled = false;
function style() {
  if (styled) return;
  styled = true;
  document.head.append(Object.assign(document.createElement("style"), { id: "diff-drawn", textContent: CSS }));
}

export async function compare(c, aId, bId) {
  const { state, docEl, main, esc, fmt, toast, swapIn, buildToc, renderMeta, enhanceCode } = c;
  style();
  const cur = state.doc;
  const a = aId || state.previous, b = bId || (cur && cur.id);
  if (!cur || !a) { toast("No previous version", { sub: "nothing was sent for this one before", face: null }); return; }
  let j;
  try { j = await (await fetch(`/api/compare/${a}/${b}${state.split ? "?view=split" : ""}`)).json(); } catch (e) { toast("Could not compare the versions", { sub: e }); return; }
  state.comparing = { a, b };
  docEl.innerHTML = `<header class="doc-head"><h1 class="doc-title">${esc(cur.title)}</h1><p class="doc-sub">changes ${fmt(j.a.received_at)} → ${fmt(j.b.received_at)}${state.split ? " · split" : " · inline"}</p></header><article class="prose kind-diff">${j.html}</article>`;
  swapIn();
  main.scrollTo({ top: 0, behavior: "instant" });
  buildToc(); renderMeta(true); enhanceCode();
}

/** Replace the inline diff body of a diff document with the side-by-side rendering. */
export async function split({ state, docEl }) {
  style();
  const art = docEl.querySelector("article.kind-diff");
  if (!art || !state.doc) return;
  try { const j = await (await fetch(`/api/docs/${state.doc.id}/split`)).json(); art.innerHTML = j.html; } catch {}
}
