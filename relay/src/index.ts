/* The relay two snyvis meet through.
 *
 * A snyvi on one laptop cannot reach a snyvi on another: both sit behind
 * NAT, one of them is asleep. So each has an address here -- its Ed25519
 * public key -- and a mailbox under it, and a friend's daemon leaves a
 * sealed frame in it. Pairing, the one minute in which two daemons learn
 * each other's keys, goes through a room named by the hash of a spoken
 * code. The daemon's side is src/peer.rs; the frame and the pairing are
 * written down in docs/PEER.md.
 *
 * What this sees: two public keys, a size, and when. Every frame arrives
 * sealed to the recipient's box key and signed by the sender; the room
 * carries SPAKE2 messages that are useless without the code. Nothing here
 * is parsed beyond the first 33 bytes of a frame (version and sender), and
 * nothing is kept past its use: a frame goes when the recipient acks it or
 * after seven days, a room when both sides have read the last message or
 * after ten minutes.
 *
 * Routes, all under https://relay.snyvi.com:
 *
 *   PUT    /room/{id}/{stage}       leave this side's message, get the other's if it is there
 *   GET    /room/{id}/{stage}       wait up to 25 s for the other side's message
 *   POST   /to/{key}                leave a frame (x-snyvi-id names it; the same id replaces)
 *   GET    /inbox/{key}             Upgrade: websocket -- the link: frames pushed as they land  (signed)
 *   GET    /inbox/{key}             what is waiting, as JSON, at once                           (signed)
 *   GET    /inbox/{key}/{id}        the frame's bytes                                           (signed)
 *   DELETE /inbox/{key}/{id}        ack: the frame is gone                                      (signed)
 *   GET    /health                  {"ok":true}
 *
 * Signed means the header x-snyvi-auth: <unix seconds>.<base64url sig>, an
 * Ed25519 signature by the mailbox's own key over
 * "snyvi-relay-v1\n{METHOD}\n{path}\n{seconds}", good for ninety seconds
 * either way. On the upgrade only, the same value may come as ?auth=,
 * because a browser-style WebSocket client cannot set a header; the path
 * signed is the path without the query. Dropping a frame into a mailbox
 * needs no signature: the recipient drops anything not from a pinned key
 * before it is opened, and a stranger can fill at most twenty slots, which
 * the link clears unread.
 *
 * The link is how a daemon waits. It holds one WebSocket to its mailbox
 * for as long as it has a friend; the mailbox hibernates between events
 * (Durable Object hibernation: the socket stays open, the object is
 * evicted, nothing is billed). A frame deposited wakes it for a
 * millisecond: a text message {"frame":{id,sender,size,at}} down every open
 * socket, then the bytes as one binary message when they are small enough,
 * and it sleeps again. The daemon answers {"ack":id}. "ping" is answered
 * "pong" by the runtime without waking anything. The JSON routes stay for
 * the catch-up a daemon does when the socket will not open, and for a
 * frame too big to push.
 */

import { DurableObject } from "cloudflare:workers";

export interface Env {
  ROOM: DurableObjectNamespace<Room>;
  MAILBOX: DurableObjectNamespace<Mailbox>;
}

/** A room lives ten minutes from its first message; a code is spoken once. */
const ROOM_TTL_MS = 10 * 60 * 1000;
/** A SPAKE2 message or a sealed hello: a few hundred bytes, never kilobytes. */
const ROOM_MSG_MAX = 8 * 1024;
/**
 * The most a frame may be: a document of up to 8 MB, which the daemon
 * refuses past at the Send button, and the header, nonce, tag and
 * signature around it. `FRAME_MAX` in src/peer.rs is the same number.
 */
const FRAME_MAX = 8 * 1024 * 1024 + 4096;
/** Up to this, a frame's bytes ride the push itself; past it the daemon fetches them. */
const INLINE_MAX = 128 * 1024;
/** Frames waiting in one mailbox before a sender is told to wait. */
const FRAMES_WAITING_MAX = 20;
/** An unread frame is dropped after this. */
const FRAME_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** The longest a room poll is held open. Under the free plan's 30 s wall limit for a DO request. */
const POLL_MAX_S = 25;
/** The clock a signature is checked against may be this far off. */
const AUTH_SKEW_S = 90;
/** SQLite rows on a Durable Object are capped at 2 MB; frames go in in halves of that. */
const CHUNK = 1 << 20;
/** The one frame version the daemon writes today. */
const FRAME_VERSION = 1;

const KEY_RE = /^[A-Za-z0-9_-]{43}$/;
const ROOM_RE = /^[0-9a-f]{64}$/;
const FRAME_ID_RE = /^[0-9a-f]{64}$/;
const SIDE_RE = /^[0-9a-f]{16,64}$/;
const STAGES = new Set(["spake", "hello"]);

/** A frame's row, as the listing and the push both say it. */
interface Frame {
  id: string;
  sender: string;
  size: number;
  at: number;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    const method = request.method;

    if (parts.length === 1 && parts[0] === "health" && method === "GET") {
      return json({ ok: true });
    }

    if (parts[0] === "room" && parts.length === 3) {
      const [, id, stage] = parts;
      if (!ROOM_RE.test(id) || !STAGES.has(stage)) return text(404, "no such room");
      if (method !== "PUT" && method !== "GET") return text(405, "PUT or GET");
      const side = request.headers.get("x-snyvi-side") ?? "";
      if (!SIDE_RE.test(side)) return text(400, "x-snyvi-side: 16-64 hex characters");
      if (method === "PUT" && over(request, ROOM_MSG_MAX)) return text(413, "a room message is at most 8 KB");
      return env.ROOM.get(env.ROOM.idFromName(id)).fetch(request);
    }

    if (parts[0] === "to" && parts.length === 2) {
      const key = parts[1];
      if (!KEY_RE.test(key)) return text(404, "no such mailbox");
      if (method !== "POST") return text(405, "POST");
      const id = request.headers.get("x-snyvi-id") ?? "";
      if (!FRAME_ID_RE.test(id)) return text(400, "x-snyvi-id: 64 hex characters");
      if (over(request, FRAME_MAX)) return text(413, "a frame is at most 8 MB");
      return env.MAILBOX.get(env.MAILBOX.idFromName(key)).fetch(request);
    }

    if (parts[0] === "inbox" && (parts.length === 2 || parts.length === 3)) {
      const key = parts[1];
      if (!KEY_RE.test(key)) return text(404, "no such mailbox");
      if (parts.length === 3 && !FRAME_ID_RE.test(parts[2])) return text(404, "no such frame");
      const ok = parts.length === 2 ? method === "GET" : method === "GET" || method === "DELETE";
      if (!ok) return text(405, parts.length === 2 ? "GET" : "GET or DELETE");
      // The link is a GET of the inbox with Upgrade; verified like any
      // read of it, then handed to the mailbox, which answers the 101.
      const upgrade = parts.length === 2 && isUpgrade(request);
      const why = await verify(request, key, url.pathname, upgrade ? url.searchParams.get("auth") : null);
      if (why) return text(401, why);
      return env.MAILBOX.get(env.MAILBOX.idFromName(key)).fetch(request);
    }

    return text(404, "snyvi relay");
  },
} satisfies ExportedHandler<Env>;

/** Content-Length over the cap, when the client sends one; the body is measured again on arrival. */
function over(request: Request, max: number): boolean {
  const n = Number(request.headers.get("content-length") ?? "0");
  return Number.isFinite(n) && n > max;
}

function isUpgrade(request: Request): boolean {
  return (request.headers.get("upgrade") ?? "").toLowerCase() === "websocket";
}

/**
 * The mailbox's own key over the request, so that only its owner reads or
 * clears it. `query` is the signature as `?auth=` carried it, accepted on
 * the upgrade only. Returns why it failed, or null when it is good.
 */
async function verify(request: Request, key: string, path: string, query: string | null): Promise<string | null> {
  const header = request.headers.get("x-snyvi-auth") ?? query ?? "";
  const dot = header.indexOf(".");
  if (dot < 1) return "x-snyvi-auth: <seconds>.<signature>";
  const seconds = Number(header.slice(0, dot));
  const sig = b64decode(header.slice(dot + 1));
  if (!Number.isInteger(seconds) || !sig || sig.length !== 64) return "x-snyvi-auth: <seconds>.<signature>";
  if (Math.abs(Date.now() / 1000 - seconds) > AUTH_SKEW_S) return "the signature's clock is off by more than 90 s";
  const raw = b64decode(key);
  if (!raw || raw.length !== 32) return "no such mailbox";
  let pub: CryptoKey;
  try {
    pub = await crypto.subtle.importKey("raw", raw, { name: "Ed25519" }, false, ["verify"]);
  } catch {
    return "no such mailbox";
  }
  const msg = new TextEncoder().encode(`snyvi-relay-v1\n${request.method}\n${path}\n${seconds}`);
  const good = await crypto.subtle.verify("Ed25519", pub, sig, msg);
  return good ? null : "not the mailbox's key";
}

/**
 * The minute of pairing. Two sides, each named by a random id it chose,
 * leave a message per stage and read the other's: first the SPAKE2
 * messages, then the hellos sealed under the key SPAKE2 gave them. A third
 * side is turned away, so a guessed code meets a full room; both hellos
 * read, or ten minutes, and the room is gone. A room waits for the other
 * side in a long poll: pairing is seconds, and the room is gone after.
 */
export class Room extends DurableObject<Env> {
  private waiters: (() => void)[] = [];

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const [, , stage] = url.pathname.split("/").filter(Boolean);
    const side = request.headers.get("x-snyvi-side")!;
    const storage = this.ctx.storage;

    if (await storage.get<boolean>("spent")) return text(410, "this room has been used");

    if (request.method === "PUT") {
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (bytes.length > ROOM_MSG_MAX) return text(413, "a room message is at most 8 KB");
      if (bytes.length === 0) return text(400, "an empty message");
      const sides = (await storage.get<string[]>("sides")) ?? [];
      if (!sides.includes(side)) {
        if (sides.length >= 2) return text(409, "the room is full");
        sides.push(side);
        await storage.put("sides", sides);
        if (sides.length === 1) await storage.setAlarm(Date.now() + ROOM_TTL_MS);
      }
      await storage.put(`msg:${stage}:${side}`, bytes);
      this.wake();
    } else {
      const sides = (await storage.get<string[]>("sides")) ?? [];
      if (!sides.includes(side)) return text(404, "not a side of this room");
    }

    const wait = request.method === "GET" ? waitSeconds(url) : 0;
    const other = await this.other(stage, side, wait);
    if (!other) return new Response(null, { status: request.method === "PUT" ? 202 : 204 });

    // The last message read by the second reader spends the room. The
    // storage stays a minute in case the reply was lost on the wire and the
    // reader asks again; the alarm clears it either way.
    if (stage === "hello") {
      await storage.put(`read:${side}`, true);
      const sides = (await storage.get<string[]>("sides")) ?? [];
      const reads = await Promise.all(sides.map((s) => storage.get<boolean>(`read:${s}`)));
      if (sides.length === 2 && reads.every(Boolean)) {
        await storage.put("spent", true);
        await storage.setAlarm(Date.now() + 60 * 1000);
      }
    }
    return new Response(other, { status: 200, headers: { "content-type": "application/octet-stream" } });
  }

  /** The other side's message for the stage, waiting up to `wait` seconds for it. */
  private async other(stage: string, side: string, wait: number): Promise<Uint8Array | undefined> {
    const until = Date.now() + wait * 1000;
    for (;;) {
      const sides = (await this.ctx.storage.get<string[]>("sides")) ?? [];
      const them = sides.find((s) => s !== side);
      if (them) {
        const msg = await this.ctx.storage.get<Uint8Array>(`msg:${stage}:${them}`);
        if (msg) return msg;
      }
      const left = until - Date.now();
      if (left <= 0) return undefined;
      await this.sleep(left);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(done, ms);
      function done() {
        clearTimeout(t);
        resolve();
      }
      this.waiters.push(done);
    });
  }

  private wake() {
    const w = this.waiters;
    this.waiters = [];
    for (const done of w) done();
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}

/**
 * One address, one mailbox. Frames go in under the id the sender chose
 * (blake3 of document and recipient, so a resend replaces rather than
 * repeats) and come out in the order they arrived, to whoever can sign as
 * the address: pushed down the link as they land, or listed on a GET.
 * Delete on ack; the alarm sweeps what sat seven days.
 *
 * Nothing lives in memory between events. The sockets are the runtime's
 * (acceptWebSocket), so the object hibernates with them open and is woken
 * by a deposit, an ack, a close, or the alarm -- never by a ping.
 */
export class Mailbox extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS frames (
        id TEXT PRIMARY KEY, sender TEXT NOT NULL, size INTEGER NOT NULL, at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chunks (
        id TEXT NOT NULL, n INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (id, n)
      );
    `);
    // The daemon's keepalive, answered without waking this object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] === "to") return this.deposit(request, request.headers.get("x-snyvi-id")!);
    if (parts.length === 2) return isUpgrade(request) ? this.link(parts[1]) : this.list();
    if (request.method === "DELETE") return this.ack(parts[2]);
    return this.open(parts[2]);
  }

  private async deposit(request: Request, id: string): Promise<Response> {
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.length > FRAME_MAX) return text(413, "a frame is at most 8 MB");
    if (bytes.length < 33 || bytes[0] !== FRAME_VERSION) return text(400, "not a snyvi frame");
    const sender = b64encode(bytes.subarray(1, 33));
    const sql = this.ctx.storage.sql;
    const replacing = sql.exec("SELECT 1 FROM frames WHERE id = ?", id).toArray().length > 0;
    const waiting = sql.exec("SELECT count(*) AS n FROM frames").one().n as number;
    if (!replacing && waiting >= FRAMES_WAITING_MAX) return text(429, "the mailbox is full; try later");

    const at = Date.now();
    this.ctx.storage.transactionSync(() => {
      sql.exec("DELETE FROM chunks WHERE id = ?", id);
      sql.exec("DELETE FROM frames WHERE id = ?", id);
      sql.exec("INSERT INTO frames (id, sender, size, at) VALUES (?, ?, ?, ?)", id, sender, bytes.length, at);
      for (let n = 0, off = 0; off < bytes.length; n++, off += CHUNK) {
        sql.exec("INSERT INTO chunks (id, n, data) VALUES (?, ?, ?)", id, n, bytes.subarray(off, off + CHUNK));
      }
    });
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(at + FRAME_TTL_MS);
    // The push: whoever holds the link hears of it now. A socket that has
    // gone away throws here and is closed by the runtime; the frame waits
    // for the next link's catch-up either way.
    const frame: Frame = { id, sender, size: bytes.length, at };
    for (const ws of this.ctx.getWebSockets()) this.push(ws, frame, bytes);
    return json({ id, size: bytes.length }, replacing ? 200 : 201);
  }

  /** The link: accept, then everything already waiting, in order. */
  private link(key: string): Response {
    const pair = new WebSocketPair();
    const client = pair[0], server = pair[1];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ key });
    for (const f of this.frames()) this.push(server, f);
    return new Response(null, { status: 101, webSocket: client });
  }

  private frames(): Frame[] {
    return this.ctx.storage.sql.exec("SELECT id, sender, size, at FROM frames ORDER BY at, id").toArray() as unknown as Frame[];
  }

  /** One frame down one socket: the announcement, then the bytes when they are small. */
  private push(ws: WebSocket, f: Frame, bytes?: Uint8Array) {
    try {
      ws.send(JSON.stringify({ frame: f }));
      if (f.size <= INLINE_MAX) ws.send(bytes ?? this.bytes(f.id));
    } catch {
      // Closed under us; the close handler tidies it.
    }
  }

  /** A frame's bytes in one piece: only ever asked for one under INLINE_MAX, which is one chunk. */
  private bytes(id: string): Uint8Array {
    const rows = this.ctx.storage.sql.exec("SELECT data FROM chunks WHERE id = ? ORDER BY n", id).toArray();
    const parts = rows.map((r) => new Uint8Array(r.data as ArrayBuffer));
    if (parts.length === 1) return parts[0];
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let off = 0;
    for (const p of parts) {
      out.set(p, off);
      off += p.length;
    }
    return out;
  }

  /** What the daemon says down the link: {"ack": id}. Anything else is ignored. */
  async webSocketMessage(_ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;
    let ack: unknown;
    try {
      ack = (JSON.parse(message) as { ack?: unknown }).ack;
    } catch {
      return;
    }
    if (typeof ack === "string" && FRAME_ID_RE.test(ack)) this.forget(ack);
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code, reason);
    } catch {}
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    try {
      ws.close(1011, "error");
    } catch {}
  }

  private list(): Response {
    return json({ frames: this.frames() });
  }

  private open(id: string): Response {
    const sql = this.ctx.storage.sql;
    const row = sql.exec("SELECT size FROM frames WHERE id = ?", id).toArray()[0];
    if (!row) return text(404, "no such frame");
    const size = row.size as number;
    let n = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = sql.exec("SELECT data FROM chunks WHERE id = ? AND n = ?", id, n).toArray()[0];
        if (!chunk) {
          controller.close();
          return;
        }
        controller.enqueue(new Uint8Array(chunk.data as ArrayBuffer));
        n++;
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "content-type": "application/octet-stream", "content-length": String(size) },
    });
  }

  private ack(id: string): Response {
    this.forget(id);
    return new Response(null, { status: 204 });
  }

  private forget(id: string) {
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("DELETE FROM chunks WHERE id = ?", id);
      this.ctx.storage.sql.exec("DELETE FROM frames WHERE id = ?", id);
    });
  }

  async alarm(): Promise<void> {
    const sql = this.ctx.storage.sql;
    const cutoff = Date.now() - FRAME_TTL_MS;
    this.ctx.storage.transactionSync(() => {
      sql.exec("DELETE FROM chunks WHERE id IN (SELECT id FROM frames WHERE at <= ?)", cutoff);
      sql.exec("DELETE FROM frames WHERE at <= ?", cutoff);
    });
    const oldest = sql.exec("SELECT min(at) AS at FROM frames").one().at as number | null;
    if (oldest !== null) await this.ctx.storage.setAlarm(oldest + FRAME_TTL_MS);
  }
}

/** `?wait=` seconds on a room, 0 to 25; a GET with none waits the full 25. */
function waitSeconds(url: URL): number {
  const raw = url.searchParams.get("wait");
  if (raw === null) return POLL_MAX_S;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, POLL_MAX_S);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function text(status: number, body: string): Response {
  return new Response(body + "\n", { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

function b64encode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64decode(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  const std = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  try {
    const bin = atob(std);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}
