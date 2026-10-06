/* The relay, driven as a daemon drives it.
 *
 * `wrangler dev` on a spare port, workerd and its Durable Objects local
 * and in memory, and every route called the way src/peer.rs calls it: a
 * pairing room through both stages, a frame in and out of a mailbox under
 * a signature by the mailbox's key, the link (Node 22's own WebSocket, the
 * signature as ?auth= since it cannot set a header), the caps and the
 * refusals, the limits, and what a mailbox keeps. Nothing here reaches
 * Cloudflare. It runs `--env test` (wrangler.toml): the IP limits out of
 * the way, and the /_test routes that look inside a mailbox.
 *
 *   npm test          (from relay/; `npm install` first)
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { webcrypto as crypto, randomFillSync } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.RELAY_TEST_PORT || 8799);
const BASE = `http://127.0.0.1:${PORT}`;
let wrangler;

before(async () => {
  wrangler = spawn("npx", ["wrangler", "dev", "--env", "test", "--ip", "127.0.0.1", "--port", String(PORT), "--inspector-port", "0", "--log-level", "warn"], {
    cwd: resolve(HERE, ".."),
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
    detached: true, // its own process group: npx, wrangler and workerd go down together

  });
  let out = "";
  wrangler.stdout.on("data", (d) => (out += d));
  wrangler.stderr.on("data", (d) => (out += d));
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) break;
    } catch {}
    if (Date.now() > deadline) throw new Error(`wrangler dev did not come up:\n${out}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}, { timeout: 90_000 });

after(() => {
  // npx alone would leave wrangler and workerd holding the pipes, and the run would never end
  if (wrangler?.pid) try { process.kill(-wrangler.pid, "SIGTERM"); } catch {}
});

// --- helpers: what src/peer.rs does ---------------------------------------

const b64url = (bytes) => Buffer.from(bytes).toString("base64url");
const hex = (n) => Buffer.from(crypto.getRandomValues(new Uint8Array(n))).toString("hex");

/** An identity: an Ed25519 pair, and the address the relay knows it by. */
async function identity() {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return { pair, raw, key: b64url(raw) };
}

/** An identity whose owner has signed in, as a daemon's link does at once: its mailbox takes frames. */
async function mailbox() {
  const me = await identity();
  await inbox(me);
  return me;
}

/** What a mailbox keeps, seen from the test route: its frames tables, and `seen`. */
async function peek(me) {
  return (await fetch(`${BASE}/_test/tables/${me.key}`)).json();
}

/** The x-snyvi-auth header for a request by this identity. */
async function auth(me, method, path, seconds = Math.floor(Date.now() / 1000)) {
  const msg = new TextEncoder().encode(`snyvi-relay-v1\n${method}\n${path}\n${seconds}`);
  const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", me.pair.privateKey, msg));
  return `${seconds}.${b64url(sig)}`;
}

/** A frame as the daemon writes one: version, sender's key, then the sealed rest. */
function frame(sender, payload) {
  const body = typeof payload === "string" ? new TextEncoder().encode(payload) : payload;
  const out = new Uint8Array(33 + body.length);
  out[0] = 1;
  out.set(sender.raw, 1);
  out.set(body, 33);
  return out;
}

/** Leave a frame for `to`; signed by `from` when given, as a 1.19.0 daemon does, unsigned as 1.18.0's. */
async function deposit(to, bytes, id = hex(32), from = null) {
  const headers = { "x-snyvi-id": id };
  if (from) {
    headers["x-snyvi-from"] = from.key;
    headers["x-snyvi-auth"] = await auth(from, "POST", `/to/${to.key}`);
  }
  const r = await fetch(`${BASE}/to/${to.key}`, { method: "POST", headers, body: bytes });
  return { status: r.status, id, body: r.headers.get("content-type")?.includes("json") ? await r.json() : await r.text() };
}

async function inbox(me, query = "") {
  const path = `/inbox/${me.key}`;
  const r = await fetch(`${BASE}${path}${query}`, { headers: { "x-snyvi-auth": await auth(me, "GET", path) } });
  const body = await r.text();
  assert.equal(r.status, 200, body);
  return JSON.parse(body).frames;
}

/**
 * The link, as src/server/peer_link.rs holds it: one socket to the inbox,
 * frames arriving as a text message then (when small) a binary one, acks
 * going back as text. `next()` is the next message, parsed: an object for
 * text, a Uint8Array for bytes. `auth` is the signature, or null for none.
 */
async function link(me, sig) {
  const path = `/inbox/${me.key}`;
  const q = sig === null ? "" : `?auth=${encodeURIComponent(sig ?? (await auth(me, "GET", path)))}`;
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}${path}${q}`);
  ws.binaryType = "arraybuffer";
  const queue = [], waiters = [];
  ws.addEventListener("message", (e) => {
    const m = typeof e.data === "string" ? JSON.parse(e.data) : new Uint8Array(e.data);
    if (waiters.length) waiters.shift()(m);
    else queue.push(m);
  });
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", () => rej(new Error("the upgrade was refused")), { once: true });
    ws.addEventListener("close", () => rej(new Error("closed before open")), { once: true });
  });
  const next = (ms = 5_000) =>
    queue.length
      ? Promise.resolve(queue.shift())
      : new Promise((res, rej) => {
          const t = setTimeout(() => rej(new Error(`no message in ${ms} ms`)), ms);
          waiters.push((m) => {
            clearTimeout(t);
            res(m);
          });
        });
  return { ws, next, ack: (id) => ws.send(JSON.stringify({ ack: id })), close: () => ws.close() };
}

/** Wait, briefly, for the relay to have done something it does after answering. */
async function until(check, ms = 3_000) {
  const t0 = Date.now();
  for (;;) {
    if (await check()) return;
    if (Date.now() - t0 > ms) throw new Error("did not happen in time");
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function open(me, id) {
  const path = `/inbox/${me.key}/${id}`;
  const r = await fetch(`${BASE}${path}`, { headers: { "x-snyvi-auth": await auth(me, "GET", path) } });
  return { status: r.status, bytes: new Uint8Array(await r.arrayBuffer()) };
}

async function ack(me, id) {
  const path = `/inbox/${me.key}/${id}`;
  const r = await fetch(`${BASE}${path}`, { method: "DELETE", headers: { "x-snyvi-auth": await auth(me, "DELETE", path) } });
  return r.status;
}

async function room(id, stage, side, method, body, wait = 0) {
  const r = await fetch(`${BASE}/room/${id}/${stage}?wait=${wait}`, { method, headers: { "x-snyvi-side": side }, body });
  return { status: r.status, bytes: new Uint8Array(await r.arrayBuffer()) };
}

// --- the room ---------------------------------------------------------------

test("health", async () => {
  const r = await fetch(`${BASE}/health`);
  assert.deepEqual(await r.json(), { ok: true });
});

test("two sides meet in a room, through both stages, and the room is spent", async () => {
  const id = hex(32);
  const a = hex(16), b = hex(16);
  // A arrives first: nothing to read yet.
  let r = await room(id, "spake", a, "PUT", "A-spake");
  assert.equal(r.status, 202);
  r = await room(id, "spake", a, "GET", null, 0);
  assert.equal(r.status, 204);
  // B arrives and gets A's message on the way in.
  r = await room(id, "spake", b, "PUT", "B-spake");
  assert.equal(r.status, 200);
  assert.equal(Buffer.from(r.bytes).toString(), "A-spake");
  // A, polling, gets B's.
  r = await room(id, "spake", a, "GET", null, 2);
  assert.equal(r.status, 200);
  assert.equal(Buffer.from(r.bytes).toString(), "B-spake");
  // The hellos, the same way, B polling while A is still typing.
  const bPoll = room(id, "hello", b, "GET", null, 5);
  await new Promise((res) => setTimeout(res, 300));
  r = await room(id, "hello", a, "PUT", "A-hello");
  assert.equal(r.status, 202);
  r = await bPoll;
  assert.equal(r.status, 200);
  assert.equal(Buffer.from(r.bytes).toString(), "A-hello");
  r = await room(id, "hello", b, "PUT", "B-hello");
  assert.equal(r.status, 200, "A's hello is there, so B's put brings it back");
  assert.equal(Buffer.from(r.bytes).toString(), "A-hello");
  r = await room(id, "hello", a, "GET", null, 2);
  assert.equal(r.status, 200);
  assert.equal(Buffer.from(r.bytes).toString(), "B-hello");
  // Both hellos read: the room is spent.
  r = await room(id, "hello", a, "GET", null, 0);
  assert.equal(r.status, 410);
  r = await room(id, "spake", hex(16), "PUT", "C-spake");
  assert.equal(r.status, 410);
});

test("a third side is turned away, and a stranger reads nothing", async () => {
  const id = hex(32);
  assert.equal((await room(id, "spake", hex(16), "PUT", "a")).status, 202);
  assert.equal((await room(id, "spake", hex(16), "PUT", "b")).status, 200);
  assert.equal((await room(id, "spake", hex(16), "PUT", "c")).status, 409);
  assert.equal((await room(id, "spake", hex(16), "GET", null)).status, 404);
});

test("a room message has a cap and a shape", async () => {
  const id = hex(32);
  assert.equal((await room(id, "spake", hex(16), "PUT", new Uint8Array(9 * 1024))).status, 413);
  assert.equal((await room(id, "spake", hex(16), "PUT", "")).status, 400);
  assert.equal((await room(id, "nope", hex(16), "PUT", "x")).status, 404);
  assert.equal((await room("not-a-room", "spake", hex(16), "PUT", "x")).status, 404);
  const r = await fetch(`${BASE}/room/${id}/spake`, { method: "PUT", body: "x" });
  assert.equal(r.status, 400, "no side header");
});

// --- the mailbox ------------------------------------------------------------

test("a frame goes in, is listed, read, and acked", async () => {
  const sunny = await identity(), trapti = await mailbox();
  const bytes = frame(sunny, "sealed plan for the garden");
  const d = await deposit(trapti, bytes);
  assert.equal(d.status, 201);
  assert.deepEqual(d.body, { id: d.id, size: bytes.length });

  const frames = await inbox(trapti);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].id, d.id);
  assert.equal(frames[0].sender, sunny.key, "the relay reads the sender off the frame, so an unknown key is dropped unread");
  assert.equal(frames[0].size, bytes.length);

  const got = await open(trapti, d.id);
  assert.equal(got.status, 200);
  assert.deepEqual(got.bytes, bytes);

  assert.equal(await ack(trapti, d.id), 204);
  assert.deepEqual(await inbox(trapti), []);
  assert.equal((await open(trapti, d.id)).status, 404);
  assert.equal(await ack(trapti, d.id), 204, "an ack twice is still an ack");
});

test("only the mailbox's key reads or clears it", async () => {
  const sunny = await identity(), trapti = await mailbox(), stranger = await identity();
  const d = await deposit(trapti, frame(sunny, "x"));
  const path = `/inbox/${trapti.key}`;
  let r = await fetch(`${BASE}${path}`);
  assert.equal(r.status, 401, "no header");
  r = await fetch(`${BASE}${path}`, { headers: { "x-snyvi-auth": await auth(stranger, "GET", path) } });
  assert.equal(r.status, 401, "someone else's key");
  r = await fetch(`${BASE}${path}`, { headers: { "x-snyvi-auth": await auth(trapti, "DELETE", path) } });
  assert.equal(r.status, 401, "the right key over the wrong request");
  r = await fetch(`${BASE}${path}`, { headers: { "x-snyvi-auth": await auth(trapti, "GET", path, Math.floor(Date.now() / 1000) - 600) } });
  assert.equal(r.status, 401, "ten minutes stale");
  r = await fetch(`${BASE}${path}/${d.id}`, { method: "DELETE", headers: { "x-snyvi-auth": await auth(stranger, "DELETE", `${path}/${d.id}`) } });
  assert.equal(r.status, 401);
  assert.equal((await inbox(trapti)).length, 1, "and the frame is still there");
  assert.equal(await ack(trapti, d.id), 204);
});

test("a socket gets what waits, then what arrives, and an ack clears it", async () => {
  const sunny = await identity(), trapti = await mailbox();
  const first = frame(sunny, "was waiting");
  const d1 = await deposit(trapti, first);
  const l = await link(trapti);
  // Catch-up: the frame that was there before the link opened.
  let m = await l.next();
  assert.deepEqual(m, { frame: { id: d1.id, sender: sunny.key, size: first.length, at: m.frame.at } });
  assert.ok(Number.isInteger(m.frame.at));
  m = await l.next();
  assert.deepEqual(m, first, "small enough to ride the push");
  // Live: a frame deposited while the link is open is pushed at once.
  const second = frame(sunny, "just now");
  const t0 = Date.now();
  const d2 = await deposit(trapti, second);
  m = await l.next();
  assert.equal(m.frame.id, d2.id);
  assert.deepEqual(await l.next(), second);
  assert.ok(Date.now() - t0 < 2_000, "pushed on arrival");
  // The ack, down the socket: the relay forgets.
  l.ack(d1.id);
  l.ack(d2.id);
  await until(async () => (await inbox(trapti)).length === 0);
  assert.equal((await open(trapti, d1.id)).status, 404);
  l.close();
});

test("a big frame is announced, not carried", async () => {
  const sunny = await identity(), trapti = await mailbox();
  const l = await link(trapti);
  const big = frame(sunny, randomFillSync(new Uint8Array(200 * 1024)));
  const d = await deposit(trapti, big);
  const m = await l.next();
  assert.equal(m.frame.id, d.id);
  assert.equal(m.frame.size, big.length);
  await assert.rejects(l.next(800), /no message/, "nothing follows the announcement");
  const got = await open(trapti, d.id);
  assert.equal(got.status, 200);
  assert.deepEqual(got.bytes, big, "fetched whole over HTTP instead");
  l.ack(d.id);
  await until(async () => (await inbox(trapti)).length === 0);
  l.close();
});

test("an unsigned or wrongly signed upgrade is refused", async () => {
  const trapti = await mailbox(), stranger = await identity();
  const path = `/inbox/${trapti.key}`;
  await assert.rejects(link(trapti, null), /refused|closed/, "no signature");
  await assert.rejects(link(trapti, await auth(stranger, "GET", path)), /refused|closed/, "someone else's key");
  await assert.rejects(link(trapti, await auth(trapti, "GET", path, Math.floor(Date.now() / 1000) - 600)), /refused|closed/, "stale");
  await assert.rejects(link(trapti, await auth(trapti, "GET", `${path}?auth=x`)), /refused|closed/, "the query is not part of what is signed");
  const l = await link(trapti);
  l.close();
});

test("the inbox list no longer waits", async () => {
  const trapti = await identity();
  const t0 = Date.now();
  assert.deepEqual(await inbox(trapti, "?wait=10"), []);
  assert.ok(Date.now() - t0 < 1_000, "?wait is ignored on an inbox");
});

test("the same id twice is one frame, and twenty is the cap", async () => {
  const trapti = await mailbox();
  const senders = await Promise.all([identity(), identity(), identity(), identity()]);
  const [sunny] = senders;
  const id = hex(32);
  assert.equal((await deposit(trapti, frame(sunny, "first"), id)).status, 201);
  assert.equal((await deposit(trapti, frame(sunny, "second draft"), id)).status, 201, "a replacement says the same as a first");
  let frames = await inbox(trapti);
  assert.equal(frames.length, 1);
  assert.equal(Buffer.from((await open(trapti, id)).bytes.subarray(33)).toString(), "second draft");
  // Five a sender, four senders: twenty.
  for (const [i, s] of senders.entries()) {
    for (let n = i === 0 ? 1 : 0; n < 5; n++) assert.equal((await deposit(trapti, frame(s, `n${i}.${n}`))).status, 201);
  }
  const fifth = await identity();
  assert.equal((await deposit(trapti, frame(fifth, "one too many"))).status, 429);
  assert.equal((await deposit(trapti, frame(sunny, "third draft"), id)).status, 201, "a replacement still fits");
  frames = await inbox(trapti);
  assert.equal(frames.length, 20);
  for (const f of frames) await ack(trapti, f.id);
  assert.deepEqual(await inbox(trapti), []);
});

test("a frame that is not one is refused before it is kept", async () => {
  const sunny = await identity(), trapti = await mailbox();
  assert.equal((await deposit(trapti, new Uint8Array([1, 2, 3]))).status, 400, "too short to carry a sender");
  const wrong = frame(sunny, "x");
  wrong[0] = 2;
  assert.equal((await deposit(trapti, wrong)).status, 400, "a version this relay does not know");
  const r = await fetch(`${BASE}/to/${trapti.key}`, { method: "POST", body: frame(sunny, "x") });
  assert.equal(r.status, 400, "no id");
  assert.equal((await fetch(`${BASE}/to/not-a-key`, { method: "POST", headers: { "x-snyvi-id": hex(32) }, body: "x" })).status, 404);
  assert.deepEqual(await inbox(trapti), []);
});

test("a large frame goes through in pieces and comes back whole", async () => {
  const sunny = await identity(), trapti = await mailbox();
  const big = randomFillSync(new Uint8Array(3 * 1024 * 1024 + 7));
  const bytes = frame(sunny, big);
  const d = await deposit(trapti, bytes);
  assert.equal(d.status, 201);
  const got = await open(trapti, d.id);
  assert.equal(got.bytes.length, bytes.length);
  assert.deepEqual(got.bytes, bytes);
  await ack(trapti, d.id);
});

test("an 8 MB document in its envelope fits, to the byte", async () => {
  // The daemon lets a document of 8 MB through its Send button; the frame
  // around it is up to 4 KB more, and the relay has to take all of it.
  const sunny = await identity(), trapti = await mailbox();
  const bytes = frame(sunny, randomFillSync(new Uint8Array(8 * 1024 * 1024 + 4096 - 33)));
  const d = await deposit(trapti, bytes);
  assert.equal(d.status, 201);
  const got = await open(trapti, d.id);
  assert.equal(got.bytes.length, bytes.length);
  await ack(trapti, d.id);
});

test("over the cap is refused", async () => {
  const sunny = await identity(), trapti = await mailbox();
  const r = await fetch(`${BASE}/to/${trapti.key}`, {
    method: "POST",
    headers: { "x-snyvi-id": hex(32) },
    body: frame(sunny, new Uint8Array(8 * 1024 * 1024 + 4096 + 1 - 33)),
  });
  assert.equal(r.status, 413, "a frame of 8 MB, its envelope, and one byte");
  assert.deepEqual(await inbox(trapti), []);
});

test("what is not a route", async () => {
  assert.equal((await fetch(`${BASE}/`)).status, 404);
  assert.equal((await fetch(`${BASE}/inbox/${(await identity()).key}`, { method: "POST" })).status, 405);
  assert.equal((await fetch(`${BASE}/to/${(await identity()).key}`)).status, 405);
});

// --- what a mailbox keeps -----------------------------------------------------

test("an address nobody signed in as takes nothing, and keeps nothing", async () => {
  const sunny = await identity(), madeUp = await identity();
  assert.equal((await deposit(madeUp, frame(sunny, "into the void"))).status, 404);
  assert.deepEqual(await peek(madeUp), { tables: false, seen: false }, "not even a schema");
  await inbox(madeUp); // the owner arrives
  assert.deepEqual(await peek(madeUp), { tables: false, seen: true }, "signing in keeps `seen` and nothing else");
  assert.equal((await deposit(madeUp, frame(sunny, "now it takes it"))).status, 201);
});

test("the last frame gone, its tables go too", async () => {
  const sunny = await identity(), trapti = await mailbox();
  const a = await deposit(trapti, frame(sunny, "a"));
  const b = await deposit(trapti, frame(sunny, "b"));
  assert.deepEqual(await peek(trapti), { tables: true, seen: true });
  await ack(trapti, a.id);
  assert.equal((await peek(trapti)).tables, true, "one still waiting");
  const l = await link(trapti);
  await l.next();
  await l.next();
  l.ack(b.id); // the last, down the link
  await until(async () => !(await peek(trapti)).tables);
  assert.deepEqual(await peek(trapti), { tables: false, seen: true });
  assert.deepEqual(await inbox(trapti), []);
  l.close();
});

test("a mailbox from 1.18.0 counts as signed in, and is brought up to date", async () => {
  const sunny = await identity(), old = await identity();
  assert.deepEqual(await (await fetch(`${BASE}/_test/legacy/${old.key}`)).json(), { tables: true, seen: false });
  const d = await deposit(old, frame(sunny, "to a friend asleep through the deploy"));
  assert.equal(d.status, 201, "its tables are its proof of an owner");
  assert.equal((await peek(old)).seen, true);
  const frames = await inbox(old);
  assert.deepEqual(frames.map((f) => f.id), [d.id]);
  await ack(old, d.id);
  assert.deepEqual(await peek(old), { tables: false, seen: true });
});

// --- who may put what where -----------------------------------------------------

test("one sender has five slots; another still gets in", async () => {
  const pushy = await identity(), friend = await identity(), trapti = await mailbox();
  for (let i = 0; i < 5; i++) assert.equal((await deposit(trapti, frame(pushy, `p${i}`))).status, 201);
  assert.equal((await deposit(trapti, frame(pushy, "p5"))).status, 429);
  assert.equal((await deposit(trapti, frame(friend, "still room for me"))).status, 201);
  for (const f of await inbox(trapti)) await ack(trapti, f.id);
});

test("a mailbox holds five full frames, and no more", async () => {
  const trapti = await mailbox();
  const full = 8 * 1024 * 1024 + 4096 - 33;
  const ids = [];
  for (let i = 0; i < 5; i++) {
    const d = await deposit(trapti, frame(await identity(), new Uint8Array(full)));
    assert.equal(d.status, 201);
    ids.push(d.id);
  }
  assert.equal((await deposit(trapti, frame(await identity(), "even a small one"))).status, 429);
  await ack(trapti, ids[0]);
  assert.equal((await deposit(trapti, frame(await identity(), "room again"))).status, 201);
  for (const f of await inbox(trapti)) await ack(trapti, f.id);
});

test("the same id from someone else leaves the first in place, and says nothing", async () => {
  const sunny = await identity(), stranger = await identity(), trapti = await mailbox();
  const id = hex(32);
  assert.equal((await deposit(trapti, frame(sunny, "the real one"), id)).status, 201);
  assert.equal((await deposit(trapti, frame(stranger, "a swap"), id)).status, 201, "the same answer as a success");
  const got = await open(trapti, id);
  assert.equal(Buffer.from(got.bytes.subarray(33)).toString(), "the real one");
  assert.equal((await inbox(trapti))[0].sender, sunny.key);
  await ack(trapti, id);
});

test("a signed deposit: its signer is its sender, and nothing unsigned replaces it", async () => {
  const sunny = await identity(), stranger = await identity(), trapti = await mailbox();
  const id = hex(32);
  assert.equal((await deposit(trapti, frame(sunny, "signed"), id, sunny)).status, 201);
  // The sender field says sunny, but nobody signed: the signed one stays.
  assert.equal((await deposit(trapti, frame(sunny, "unsigned swap"), id)).status, 201);
  assert.equal(Buffer.from((await open(trapti, id)).bytes.subarray(33)).toString(), "signed");
  // Sunny, signed, may replace it.
  assert.equal((await deposit(trapti, frame(sunny, "signed, second draft"), id, sunny)).status, 201);
  assert.equal(Buffer.from((await open(trapti, id)).bytes.subarray(33)).toString(), "signed, second draft");
  // A signer who is not the frame's sender.
  assert.equal((await deposit(trapti, frame(sunny, "x"), hex(32), stranger)).status, 400);
  // A bad signature, and a signature with no sender named.
  const path = `/to/${trapti.key}`;
  let r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "x-snyvi-id": hex(32), "x-snyvi-from": sunny.key, "x-snyvi-auth": await auth(stranger, "POST", path) },
    body: frame(sunny, "x"),
  });
  assert.equal(r.status, 401);
  r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "x-snyvi-id": hex(32), "x-snyvi-auth": await auth(sunny, "POST", path) },
    body: frame(sunny, "x"),
  });
  assert.equal(r.status, 400);
  assert.equal((await inbox(trapti)).length, 1);
  await ack(trapti, id);
});

test("a body with no length given is counted as it comes, and refused past the cap", async () => {
  const sunny = await identity(), trapti = await mailbox();
  const bytes = frame(sunny, new Uint8Array(8 * 1024 * 1024 + 4096 + 1 - 33));
  const body = new ReadableStream({
    start(c) {
      for (let off = 0; off < bytes.length; off += 64 * 1024) c.enqueue(bytes.subarray(off, off + 64 * 1024));
      c.close();
    },
  });
  const r = await fetch(`${BASE}/to/${trapti.key}`, { method: "POST", headers: { "x-snyvi-id": hex(32) }, body, duplex: "half" });
  assert.equal(r.status, 413);
  assert.deepEqual(await peek(trapti), { tables: false, seen: true }, "nothing kept");
});

test("a newer link closes the older", async () => {
  const sunny = await identity(), trapti = await mailbox();
  const first = await link(trapti);
  const second = await link(trapti);
  // The relay's close frame, not the TCP close Node's client waits on after it.
  await until(() => first.ws.readyState >= WebSocket.CLOSING, 2_000);
  const d = await deposit(trapti, frame(sunny, "to the newer link only"));
  assert.equal((await second.next()).frame.id, d.id);
  await second.next();
  second.ack(d.id);
  await until(async () => (await inbox(trapti)).length === 0);
  second.close();
});

// --- the doorbell and the limits ------------------------------------------------

/** A side's doorbell on a room: the next {"ready":stage} it rings with. */
async function bell(id, side) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/room/${id}/ws?side=${side}`);
  const queue = [], waiters = [];
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (waiters.length) waiters.shift()(m);
    else queue.push(m);
  });
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", () => rej(new Error("the doorbell was refused")), { once: true });
  });
  const next = (ms = 5_000) =>
    queue.length
      ? Promise.resolve(queue.shift())
      : new Promise((res, rej) => {
          const t = setTimeout(() => rej(new Error(`no ring in ${ms} ms`)), ms);
          waiters.push((m) => {
            clearTimeout(t);
            res(m);
          });
        });
  return { next, close: () => ws.close() };
}

test("the doorbell rings for the other side's message, and for one already there", async () => {
  const id = hex(32);
  const a = hex(16), b = hex(16);
  await assert.rejects(bell(id, a), /refused/, "not a side yet");
  assert.equal((await room(id, "spake", a, "PUT", "A-spake")).status, 202);
  const ring = await bell(id, a);
  assert.equal((await room(id, "spake", b, "PUT", "B-spake")).status, 200);
  assert.deepEqual(await ring.next(), { ready: "spake" });
  const r = await room(id, "spake", a, "GET", null, 0);
  assert.equal(Buffer.from(r.bytes).toString(), "B-spake");
  // B's hello lands before A's bell for it is open: the new bell rings at once.
  ring.close();
  assert.equal((await room(id, "hello", b, "PUT", "B-hello")).status, 202);
  const again = await bell(id, a);
  const rings = [await again.next(), await again.next()];
  assert.deepEqual(rings, [{ ready: "spake" }, { ready: "hello" }]);
  again.close();
});

test("one poll per side: a newer poll ends the older", async () => {
  const id = hex(32), a = hex(16);
  assert.equal((await room(id, "spake", a, "PUT", "A")).status, 202);
  const t0 = Date.now();
  const first = room(id, "spake", a, "GET", null, 20);
  await new Promise((res) => setTimeout(res, 300));
  const second = room(id, "spake", a, "GET", null, 1);
  assert.equal((await first).status, 204);
  assert.ok(Date.now() - t0 < 3_000, "ended by the newer poll, not by its own 20 s");
  assert.equal((await second).status, 204);
});

test("a room's own limit: thirty calls a minute, then busy", async () => {
  const id = hex(32), a = hex(16);
  assert.equal((await room(id, "spake", a, "PUT", "A")).status, 202);
  const codes = [];
  for (let i = 0; i < 30; i++) codes.push((await room(id, "spake", a, "GET", null, 0)).status);
  assert.equal(codes.filter((c) => c === 204).length, 29);
  assert.equal(codes.at(-1), 429, "the 31st call");
  assert.equal((await room(hex(32), "spake", a, "PUT", "another room is its own")).status, 202);
});
