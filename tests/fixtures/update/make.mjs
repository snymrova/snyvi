/* Writes the fixtures src/update.rs tests against: a throwaway key pair's
 * public half, a manifest for 1.9.9 that names one download, that download
 * (a tarball whose `snyvi` is a line of text), and the manifest's signature.
 * The secret key lives only in this process. Run from the repository root:
 *
 *   node tests/fixtures/update/make.mjs
 *
 * Regenerate all four together; a signature is over exactly one manifest,
 * and the manifest carries the tarball's hash.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { keypair, sha256, signFile } from "../../../bench/minisign.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), "snyvi-fixture-"));
try {
  const top = "snyvi-1.9.9-x86_64-unknown-linux-musl";
  mkdirSync(join(tmp, top));
  writeFileSync(join(tmp, top, "snyvi"), "the 1.9.9 daemon\n", { mode: 0o755 });
  const tgz = join(tmp, "snyvi-linux-x64.tar.gz");
  execFileSync("tar", ["-C", tmp, "--owner=0", "--group=0", "--mtime=@0", "-czf", tgz, top]);
  const tarball = readFileSync(tgz);
  const key = keypair();
  const manifest = JSON.stringify({
    version: "1.9.9",
    date: "2026-09-26T00:00:00Z",
    channel: "daily",
    notes: "https://github.com/snymrova/snyvi/releases/tag/v1.9.9",
    app_min: "1.6.0",
    hotfix_below: null,
    assets: { "linux-x64": { snyvi: ["snyvi-linux-x64.tar.gz", sha256(tarball)] } },
  }, null, 2) + "\n";
  writeFileSync(join(here, "test.pub"), key.pub);
  writeFileSync(join(here, "latest.json"), manifest);
  writeFileSync(join(here, "latest.json.minisig"), signFile(key, manifest, "snyvi 1.9.9 (test key)"));
  writeFileSync(join(here, "snyvi-linux-x64.tar.gz"), tarball);
  console.log(`wrote test.pub, latest.json, latest.json.minisig, snyvi-linux-x64.tar.gz (${tarball.length} bytes) in ${here}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
