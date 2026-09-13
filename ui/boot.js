/* Runs before first paint: apply the saved theme, font and pane state so nothing flashes. */
try {
  var d = document.documentElement, t = localStorage.getItem("snyvi.theme");
  if (t) d.dataset.theme = t;
  var f = localStorage.getItem("snyvi.font");
  if (f) d.dataset.font = f;
  if (localStorage.getItem("snyvi.side") === "0") d.dataset.side = "0";
  if (localStorage.getItem("snyvi.rail") === "0") d.dataset.rail = "0";
  if (localStorage.getItem("snyvi.wide") === "1") d.dataset.wide = "1";
  if (localStorage.getItem("snyvi.wrap") === "1") d.dataset.wrap = "1";
  var sw = +localStorage.getItem("snyvi.side-w"), rw = +localStorage.getItem("snyvi.rail-w");
  if (sw) d.style.setProperty("--side-w", sw + "px");
  if (rw) d.style.setProperty("--rail-w", rw + "px");
} catch (e) {}
