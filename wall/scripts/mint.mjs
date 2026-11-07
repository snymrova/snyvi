/* Mint the wall's own key pair, once (docs/WALL.md). Its seed goes to the
 * Worker as the secret WALL_SEED, piped straight into wrangler and never
 * printed or written to a file; its public halves are printed for
 * src/wall.rs (WALL_KEY, WALL_BOX), the one place a daemon learns them.
 *
 *   npm run mint            (from wall/, with CLOUDFLARE_API_TOKEN set)
 *
 * Running it again mints a new pair: every daemon then needs a release with
 * the new WALL_KEY before the daily line opens for it again. */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { ed25519, x25519 } from "@noble/curves/ed25519";

const b64 = (b) => Buffer.from(b).toString("base64url");
const seed = randomBytes(64);
const sign = ed25519.getPublicKey(seed.subarray(0, 32));
const box = x25519.getPublicKey(seed.subarray(32));

const put = spawn("npx", ["wrangler", "secret", "put", "WALL_SEED"], { stdio: ["pipe", "inherit", "inherit"] });
put.stdin.end(b64(seed));
put.on("exit", (code) => {
  seed.fill(0);
  if (code !== 0) {
    console.error("wrangler did not take the secret; nothing was minted that anyone holds.");
    process.exit(code ?? 1);
  }
  console.log(`\nIn src/wall.rs:\n\npub const WALL_KEY: &str = "${b64(sign)}";\npub const WALL_BOX: &str = "${b64(box)}";\n`);
});
