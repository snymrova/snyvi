/* The wall, driven as a daemon drives it (src/server/api_wall.rs).
 *
 * `wrangler dev --env test` on a spare port, D1 and R2 local and in memory,
 * beside a server of the test's own that plays the relay (it keeps what is
 * deposited) and GitHub's raw files (it serves a repository's .snyvi/owner
 * when the test says so). Nothing here reaches Cloudflare or GitHub.
 *
 *   npm test          (from wall/; `npm install` first)
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { webcrypto as crypto } from "node:crypto";
import { blake3 } from "@noble/hashes/blake3";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.WALL_TEST_PORT || 8797);
const BASE = `http://127.0.0.1:${PORT}`;
const VECTORS = JSON.parse(readFileSync(resolve(HERE, "vectors.json"), "utf8"));
let wrangler, side;
const deposits = [];
const owners = new Map();

before(async () => {
  side = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (req.method === "POST" && req.url.startsWith("/to/")) {
        deposits.push({ to: req.url.slice(4), from: req.headers["x-snyvi-from"], auth: req.headers["x-snyvi-auth"], body: Buffer.concat(chunks) });
        res.writeHead(201).end();
        return;
      }
      const m = /^\/raw\/([^/]+)\/([^/]+)\/HEAD\/\.snyvi\/owner$/.exec(req.url);
      const owner = m && owners.get(`${m[1]}/${m[2]}`);
      if (owner) res.writeHead(200).end(owner);
      else res.writeHead(404).end();
    });
  }).listen(8796, "127.0.0.1");
  wrangler = spawn("npx", ["wrangler", "dev", "--env", "test", "--ip", "127.0.0.1", "--port", String(PORT), "--inspector-port", "0", "--log-level", "warn", "--var", `WALL_SEED:${VECTORS.wall_seed}`, "--var", "WALL_OPERATOR:op-token"], {
    cwd: resolve(HERE, ".."),
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
    detached: true,
  });
  let out = "";
  wrangler.stdout.on("data", (d) => (out += d));
  wrangler.stderr.on("data", (d) => (out += d));
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) break;
    } catch {}
    if (Date.now() > deadline) throw new Error(`wrangler dev did not come up:\n${out}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}, { timeout: 90_000 });

after(() => {
  if (wrangler?.pid) try { process.kill(-wrangler.pid, "SIGTERM"); } catch {}
  side?.close();
});

// --- what src/wall.rs and src/peer.rs do ----------------------------------

const b64url = (b) => Buffer.from(b).toString("base64url");
const hex = (b) => Buffer.from(b).toString("hex");

async function identity() {
  const k = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const address = b64url(new Uint8Array(await crypto.subtle.exportKey("raw", k.publicKey)));
  return { k, address, box: b64url(crypto.getRandomValues(new Uint8Array(32))) };
}

/** A signed write, as `api_wall::signed` sends one. */
async function signed(me, method, path, body = new Uint8Array(), skew = 0) {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  const secs = Math.floor(Date.now() / 1000) + skew;
  const msg = `snyvi-wall-v1\n${method}\n${path}\n${secs}\n${hex(blake3(bytes))}`;
  const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", me.k.privateKey, new TextEncoder().encode(msg)));
  return fetch(`${BASE}${path}`, { method, body: method === "DELETE" ? undefined : bytes, headers: { "x-snyvi-from": me.address, "x-snyvi-auth": `${secs}.${b64url(sig)}`, "content-type": "application/json" } });
}

const page = (me, slug, extra = {}) => JSON.stringify({ slug, title: "Breeds of dogs", lede: "Every breed.", kind: "Book", tone: "book", stage: "Writing", looking_for: "", logo: "", cover: "", hero: "mark", facts: ["stage", "kind"], github: `https://github.com/o/${slug}`, links: [], accent: "green", wash: "#22c55e", count_shown: true, v: 1, box: me.box, ...extra });
const wall = async () => (await (await fetch(`${BASE}/wall.json`)).json()).pages.map((p) => p.slug);

// --- the vectors cargo test writes -----------------------------------------

test("the wall's seal is the daemon's, byte for byte", async () => {
  const r = await fetch(`${BASE}/_test/seal`, { method: "POST", body: JSON.stringify(VECTORS) });
  const j = await r.json();
  assert.equal(j.wall_sign, VECTORS.wall_sign);
  assert.equal(j.wall_box, VECTORS.wall_box);
  assert.equal(j.frame, VECTORS.frame);
});

test("a daemon's signature in the vectors verifies with node's own Ed25519", async () => {
  const a = VECTORS.auth;
  const pub = await crypto.subtle.importKey("raw", Buffer.from(a.from, "base64url"), { name: "Ed25519" }, false, ["verify"]);
  assert.ok(await crypto.subtle.verify("Ed25519", pub, Buffer.from(a.signature, "base64url"), new TextEncoder().encode(a.message)));
  assert.equal(a.message.split("\n").pop(), hex(blake3(Buffer.from(a.body, "base64url"))));
});

// --- a page, end to end ----------------------------------------------------

test("a page goes up, its name is its first key's, and the check puts it on the wall", async () => {
  const [me, other] = [await identity(), await identity()];
  assert.equal((await signed(me, "PUT", "/pages/dogs", page(me, "dogs"))).status, 200);
  const html = await (await fetch(`${BASE}/p/dogs`)).text();
  assert.match(html, /Breeds of dogs/);
  assert.doesNotMatch(html, /<script/i);
  // Up, not checked: on its page, not on the wall.
  assert.ok(!(await wall()).includes("dogs"));
  assert.equal((await signed(other, "PUT", "/pages/dogs", page(other, "dogs"))).status, 409);
  let c = await (await signed(me, "POST", "/pages/dogs/check", "{}")).json();
  assert.equal(c.checked, false);
  owners.set("o/dogs", `snyvi-owner-v1 ${other.address}\n`);
  c = await (await signed(me, "POST", "/pages/dogs/check", "{}")).json();
  assert.equal(c.checked, false, "a file naming another key is no check");
  owners.set("o/dogs", `snyvi-owner-v1 ${me.address}\n`);
  c = await (await signed(me, "POST", "/pages/dogs/check", "{}")).json();
  assert.equal(c.checked, true);
  assert.ok((await wall()).includes("dogs"));
});

test("a write not signed by its key, or signed long ago, is refused", async () => {
  const me = await identity();
  const r = await fetch(`${BASE}/pages/nobody`, { method: "PUT", body: page(me, "nobody"), headers: { "x-snyvi-from": me.address, "x-snyvi-auth": "1.AAAA" } });
  assert.equal(r.status, 401);
  assert.equal((await signed(me, "PUT", "/pages/late", page(me, "late"), -600)).status, 401);
  // A body swapped after signing does not carry the signature with it.
  const secs = Math.floor(Date.now() / 1000);
  const msg = `snyvi-wall-v1\nPUT\n/pages/swap\n${secs}\n${hex(blake3(new TextEncoder().encode("{}")))}`;
  const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", me.k.privateKey, new TextEncoder().encode(msg)));
  const s = await fetch(`${BASE}/pages/swap`, { method: "PUT", body: page(me, "swap"), headers: { "x-snyvi-from": me.address, "x-snyvi-auth": `${secs}.${b64url(sig)}` } });
  assert.equal(s.status, 401);
});

test("a file's name is its blake3, and a moment shows on the page", async () => {
  const me = await identity();
  assert.equal((await signed(me, "PUT", "/pages/cats", page(me, "cats"))).status, 200);
  const png = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
  const name = `${hex(blake3(png)).slice(0, 16)}.png`;
  assert.equal((await signed(me, "PUT", `/pages/cats/files/0000000000000000.png`, png)).status, 422);
  assert.equal((await signed(me, "PUT", `/pages/cats/files/${name}`, png)).status, 200);
  assert.equal((await fetch(`${BASE}/files/${name}`)).status, 200);
  const m = JSON.stringify({ id: 7, title: "Chapter 4 is in", body_md: "It **landed**. <script>x</script>", files: [name], at: 1 });
  assert.equal((await signed(me, "PUT", "/pages/cats/moments/7", m)).status, 200);
  const html = await (await fetch(`${BASE}/p/cats`)).text();
  assert.match(html, /Chapter 4 is in/);
  assert.match(html, /<strong>landed<\/strong>/);
  assert.doesNotMatch(html, /<script>x/);
  const other = await identity();
  assert.equal((await signed(other, "PUT", "/pages/cats/moments/8", m)).status, 409);
});

test("a heart is one per key, a toggle, and a report is counted", async () => {
  const [me, fan] = [await identity(), await identity()];
  await signed(me, "PUT", "/pages/birds", page(me, "birds"));
  let h = await (await signed(fan, "POST", "/pages/birds/hearts")).json();
  assert.deepEqual(h, { on: true, hearts: 1 });
  h = await (await signed(fan, "POST", "/pages/birds/hearts")).json();
  assert.deepEqual(h, { on: false, hearts: 0 });
  assert.equal((await signed(fan, "POST", "/pages/birds/report")).status, 200);
  assert.equal((await signed(fan, "POST", "/pages/nope/hearts")).status, 404);
});

test("the daily line goes to the page's daemon, sealed by the wall's key", async () => {
  const [me, fan] = [await identity(), await identity()];
  await signed(me, "PUT", "/pages/fish", page(me, "fish"));
  await signed(fan, "POST", "/pages/fish/hearts");
  deposits.length = 0;
  const j = await (await fetch(`${BASE}/_test/daily`, { method: "POST" })).json();
  assert.ok(j.sent >= 1);
  const d = deposits.find((x) => x.to === me.address);
  assert.ok(d, "deposited to the page's daemon");
  assert.equal(d.from, VECTORS.wall_sign);
  assert.equal(d.body[0], 1);
  assert.equal(b64url(d.body.subarray(1, 33)), VECTORS.wall_sign);
  // Nothing new since: no second line.
  deposits.length = 0;
  await fetch(`${BASE}/_test/daily`, { method: "POST" });
  assert.ok(!deposits.some((x) => x.to === me.address));
});

test("taken down, a page is gone from the wall and from snyvi.page", async () => {
  const me = await identity();
  await signed(me, "PUT", "/pages/gone", page(me, "gone", { github: "https://github.com/o/gone" }));
  owners.set("o/gone", `snyvi-owner-v1 ${me.address}`);
  await signed(me, "POST", "/pages/gone/check", "{}");
  assert.ok((await wall()).includes("gone"));
  assert.equal((await signed(me, "DELETE", "/pages/gone")).status, 200);
  assert.ok(!(await wall()).includes("gone"));
  assert.equal((await fetch(`${BASE}/p/gone`)).status, 404);
  // The operator's hide, with its token only.
  await signed(me, "PUT", "/pages/hid", page(me, "hid"));
  assert.equal((await fetch(`${BASE}/_op/hide/hid`, { method: "POST" })).status, 401);
  assert.equal((await fetch(`${BASE}/_op/hide/hid`, { method: "POST", headers: { "x-wall-operator": "op-token" } })).status, 200);
  assert.equal((await fetch(`${BASE}/p/hid`)).status, 404);
});
