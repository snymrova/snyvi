/* A picture of a sandbox's page, for bench/sandbox.sh shot.
 *
 *   node bench/shot.mjs <base> <capability> <path> <out.png>
 *
 * The same headless Chromium the benches drive (chrome.mjs), on a profile of
 * its own, pointed at the sandbox's port and nothing else. It is given the
 * capability the sandbox minted, so desks draw as they do in the window. It
 * cannot photograph the daily window: it is never told where that is.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { launch, killTree, pageLoad, tab, sleep } from "./chrome.mjs";

const [base, cap, path = "/", out = "snyvi-shot.png"] = process.argv.slice(2);
if (!base || !/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) {
  console.error("shot: a sandbox's address first, as bench/sandbox.sh gives it");
  process.exit(1);
}
if (base.endsWith(":7777")) {
  console.error("shot: 7777 is the daily window's; this photographs a sandbox only");
  process.exit(1);
}

const profile = mkdtempSync(join(tmpdir(), "snyvi-shot-"));
const { proc, cdp } = await launch(profile, { windowSize: "1440,900" });
try {
  const { sessionId } = await tab(cdp);
  const sep = path.includes("?") ? "&" : "?";
  const loaded = pageLoad(cdp, sessionId, "shot");
  await cdp.send("Page.navigate", { url: `${base}${path}${sep}window=1${cap ? `#cap=${cap}` : ""}` }, sessionId);
  await loaded;
  // The page draws after load: the tree, then a desk's panels over its socket.
  await sleep(1500);
  const { data } = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId);
  writeFileSync(out, Buffer.from(data, "base64"));
  console.log(resolve(out));
} finally {
  killTree(proc);
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
