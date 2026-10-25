/* The pictures on the What's new page (#191), shot from a real snyvi.
 *
 * features.toml names a still for an entry; this takes it, from a daemon the
 * caller already runs on a spare port with a library that shows the thing
 * (a desk with a dated note, a routine, ...), at twice the pixels of the
 * reading column so the page is sharp on any screen. Each picture is one
 * part of the page, clipped with a margin -- the section or the field the
 * entry is about, never the whole window.
 *
 *   PORT=7873 CAP=<capability> node bench/stills.mjs /desk/1 [name ...]
 *
 * PORT is never 7777: the daemon is a throwaway with its own HOME, data and
 * config folders. CAP is a capability minted for its window. The pictures
 * are written to docs/features/; src/features.rs lists them, and its test
 * holds the list and features.toml in step.
 */
import { launch, tab, evaluate, sleep, killTree, pageLoad } from "./chrome.mjs";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = process.env.PORT, CAP = process.env.CAP;
const [path = "/desk/1", ...only] = process.argv.slice(2);
if (!PORT || PORT === "7777" || !CAP) {
  console.error("PORT (a spare one, never 7777) and CAP are needed: see the head of this file");
  process.exit(2);
}

/* What each picture is of: the part to clip, and what to do first. The
 * part's box plus MARGIN, at most COLUMN wide, at 2x. */
const MARGIN = 14, COLUMN = 460;
const STILLS = {
  "dates.png": { part: '[data-sec="notes"]' },
  "routines.png": { part: '[data-sec="routines"]' },
  "inback.png": {
    part: '[data-sec="panels"]',
    first: `document.querySelector('[data-a="back-new"]')?.click(); await new Promise(r => setTimeout(r, 300));
      const i = document.querySelector(".dk-backnew input"); if (i) { i.value = "npm run dev"; i.blur(); }`,
  },
};

const profile = mkdtempSync(join(tmpdir(), "snyvi-stills-"));
const { proc, cdp } = await launch(profile, { windowSize: "1280,800" });
try {
  const { sessionId: s } = await tab(cdp);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 2, mobile: false }, s);
  // Paper, the default theme: a fresh profile may otherwise ask for dark.
  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] }, s);
  for (const [name, st] of Object.entries(STILLS)) {
    if (only.length && !only.includes(name)) continue;
    // A blank page between, so the same address loads again rather than
    // only moving its fragment.
    await cdp.send("Page.navigate", { url: "about:blank" }, s); await sleep(200);
    const loaded = pageLoad(cdp, s, path);
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${PORT}${path}#cap=${CAP}` }, s);
    await loaded; await sleep(1800);
    const box = await evaluate(cdp, s, `(async () => {
      // No new-control dots in a picture of the control (ui/guide.js).
      document.head.insertAdjacentHTML("beforeend", "<style>[data-gd-new]{background-image:none!important}</style>");
      ${st.first || ""}
      await new Promise(r => setTimeout(r, 300));
      // The first one with a box: a section can be a wrapper that draws none.
      let el = [...document.querySelectorAll(${JSON.stringify(st.part)})].find(e => e.getBoundingClientRect().height > 0)
        || [...document.querySelectorAll(${JSON.stringify(st.part)} + " > *")].find(e => e.getBoundingClientRect().height > 0);
      for (let i = 0; el && i < ${st.up || 0}; i++) el = el.parentElement;
      if (!el) return null;
      el.scrollIntoView({ block: "center" });
      // From its heading: a section's box starts in the gap above it, where
      // the one before still shows.
      const b = el.getBoundingClientRect(), top = Math.max(b.top, (el.firstElementChild || el).getBoundingClientRect().top - 10);
      return { x: b.left, y: top, w: b.width, h: b.bottom - top };
    })()`);
    if (!box) { console.error(`${name}: ${st.part} is not on ${path}`); continue; }
    const w = Math.min(COLUMN, box.w + MARGIN * 2);
    // The margin at the sides and under; above, the box starts at the
    // heading already.
    const clip = { x: Math.max(0, box.x - MARGIN), y: Math.max(0, box.y), width: w, height: box.h + MARGIN, scale: 1 };
    const { data } = await cdp.send("Page.captureScreenshot", { format: "png", clip }, s);
    writeFileSync(join(ROOT, "docs/features", name), Buffer.from(data, "base64"));
    console.log(`${name}  ${Math.round(clip.width * 2)}x${Math.round(clip.height * 2)}`);
  }
} finally { cdp.close(); killTree(proc); rmSync(profile, { recursive: true, force: true }); }
