/* Runs before first paint: apply the saved theme, accent, font and pane state so nothing flashes. */
try {
  /* After a reset, nothing saved is read: the page that reset dropped the
     keys, but was still running as it left and may have written one back. */
  if (sessionStorage.getItem("snyvi.reset")) {
    sessionStorage.removeItem("snyvi.reset");
    Object.keys(localStorage).filter(function (k) { return k.indexOf("snyvi.") === 0; }).forEach(function (k) { localStorage.removeItem(k); });
  }
  var d = document.documentElement, t = localStorage.getItem("snyvi.theme");
  if (t) d.dataset.theme = t;
  var ac = localStorage.getItem("snyvi.accent");
  if (ac) d.dataset.accent = ac;
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
