/* Runs before first paint: apply the saved theme, font and pane state so nothing flashes. */
try {
  var d = document.documentElement, t = localStorage.getItem("snyvi.theme");
  if (t) d.dataset.theme = t;
  var f = localStorage.getItem("snyvi.font");
  if (f) d.dataset.font = f;
  if (localStorage.getItem("snyvi.side") === "0") d.dataset.side = "0";
  if (localStorage.getItem("snyvi.wide") === "1") d.dataset.wide = "1";
} catch (e) {}
