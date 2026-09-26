/* Runs before first paint: apply the saved theme, accent, font and pane state so nothing flashes. */
try {
  /* After a reset, nothing saved is read: the page that reset dropped the
     keys, but was still running as it left and may have written one back. */
  if (sessionStorage.getItem("snyvi.reset")) {
    sessionStorage.removeItem("snyvi.reset");
    Object.keys(localStorage).filter(function (k) { return k.indexOf("snyvi.") === 0; }).forEach(function (k) { localStorage.removeItem(k); });
  }
  /* Before 1.4.0 the theme was one key, "light" | "dark" | "", and "" meant
     the system's. It is now which theme to follow, and the two slots below
     say what "light" and "dark" mean. */
  var old = localStorage.getItem("snyvi.theme");
  if (old !== null) {
    if (old === "light" || old === "dark") localStorage.setItem("snyvi.theme.follow", old);
    localStorage.removeItem("snyvi.theme");
  }
  var d = document.documentElement;
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

/* The theme, resolved here and nowhere else. Three keys: your light theme,
   your dark theme, and which of the two to follow -- "" is the system's
   choice, read from the media query once now and again whenever it moves.
   `data-theme` is always a concrete name, so the stylesheet carries each
   palette once, with no media block to keep in step, and "is it dark?" has
   one answer for every script: the `color-scheme` the theme's block set.
   Outside the try above on purpose: with storage unreadable there is still
   a theme, the system's, in the defaults. */
window.snyviTheme = (function () {
  var d = document.documentElement, sys = matchMedia("(prefers-color-scheme: dark)");
  var get = function (k, or) { try { return localStorage.getItem(k) || or; } catch (e) { return or; } };
  /* First paint has Paper and Ink and no other theme: the rest are in
     themes.css, which the page fetches once it is idle. Until it is in, a
     theme from there is drawn from the copy of its block the app kept for
     that slot -- written as `:root[data-theme=…]`, which outranks Paper's
     :root wherever it sits in the page -- and with no copy (a first launch,
     storage unreadable, a copy thrown out) the slot's own side stands in:
     Paper for light, Ink for dark, never a white frame on a dark system.
     The copies are only a head start; app.js checks them against the sheet
     when it lands and keeps them current. */
  var loaded = false, copy = document.createElement("style");
  copy.id = "theme-copy";
  copy.textContent = get("snyvi.theme.css.light", "") + get("snyvi.theme.css.dark", "");
  document.head.appendChild(copy);
  var apply = function () {
    /* Contrast is the dark slot's default under a system asking for more
       contrast: that is a signal like prefers-color-scheme and is honoured
       the same way, until the slot is chosen. */
    var light = get("snyvi.theme.light", "paper");
    var dark = get("snyvi.theme.dark", matchMedia("(prefers-contrast: more)").matches ? "contrast" : "ink");
    var follow = get("snyvi.theme.follow", "") || (sys.matches ? "dark" : "light");
    var t = follow === "dark" ? dark : light;
    if (!loaded && t !== "paper" && t !== "ink" && copy.textContent.indexOf(':root[data-theme="' + t + '"]') < 0) t = follow === "dark" ? "ink" : "paper";
    d.dataset.theme = t;
    return t;
  };
  apply();
  sys.addEventListener("change", apply);
  /* A token as a colour a script can hand to a canvas, a shell or Mermaid.
     Read off `:root` as text, --accent is `light-dark(#…, #…)` and --accent-bg
     a color-mix(): a custom property keeps its expression until an element
     uses it. So a probe uses it, on the element asked for (a desk wears its
     own accent in phase 4) or the root. The answer is said one way: a
     browser gives a mixed colour as `color(srgb …)` and a plain one as
     `rgb()`, and a shell prompt wants six hex digits while Mermaid's own
     colour maths reads neither form; so an opaque colour comes back as
     #rrggbb and one with alpha as rgba(). */
  var colour = function (name, on) {
    var p = document.createElement("i");
    p.style.cssText = "position:absolute;visibility:hidden;color:var(" + name + ")";
    (on || d).appendChild(p);
    var c = getComputedStyle(p).color, m, v;
    p.remove();
    if ((m = /^color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+))?\)$/.exec(c))) v = [m[1] * 255, m[2] * 255, m[3] * 255, m[4] == null ? 1 : +m[4]];
    else if ((m = /^rgba?\(([\d.]+), ([\d.]+), ([\d.]+)(?:, ([\d.]+))?\)$/.exec(c))) v = [+m[1], +m[2], +m[3], m[4] == null ? 1 : +m[4]];
    else return c;
    var h = function (n) { return ("0" + Math.round(n).toString(16)).slice(-2); };
    return v[3] < 1 ? "rgba(" + Math.round(v[0]) + ", " + Math.round(v[1]) + ", " + Math.round(v[2]) + ", " + v[3] + ")" : "#" + h(v[0]) + h(v[1]) + h(v[2]);
  };
  /* themes.css is in: every theme can be drawn from it, so the copies step
     aside and the saved choice is applied as it is. */
  var ready = function () { loaded = true; copy.remove(); return apply(); };
  return { apply: apply, ready: ready, system: sys, colour: colour, isDark: function () { return getComputedStyle(d).colorScheme === "dark"; } };
})();
