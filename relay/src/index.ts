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
 * after ten minutes, and a mailbox whose owner has not been here for ninety
 * days goes whole.
 *
 * Routes, all under https://relay.snyvi.com:
 *
 *   PUT    /room/{id}/{stage}       leave this side's message, get the other's if it is there
 *   GET    /room/{id}/{stage}       the other side's message: at once with ?wait=0, else up to 25 s
 *   GET    /room/{id}/ws?side=      Upgrade: websocket -- the doorbell: {"ready":stage} when the other side's lands
 *   POST   /to/{key}                leave a frame (x-snyvi-id names it; the same id from the same sender replaces)
 *   GET    /inbox/{key}             Upgrade: websocket -- the link: frames pushed as they land  (signed)
 *   GET    /inbox/{key}             what is waiting, as JSON, at once                           (signed)
 *   GET    /inbox/{key}/{id}        the frame's bytes                                           (signed)
 *   DELETE /inbox/{key}/{id}        ack: the frame is gone                                      (signed)
 *   GET    /health                  {"ok":true}
 *
 * Signed means the header x-snyvi-auth: <unix seconds>.<base64url sig>, an
 * Ed25519 signature over "snyvi-relay-v1\n{METHOD}\n{path}\n{seconds}",
 * good for ninety seconds either way. An inbox is signed by its own key;
 * on the upgrade the same value may come as ?auth=, because a browser-style
 * WebSocket client cannot set a header, and the path signed is the path
 * without the query. A deposit is signed by its sender, named in
 * x-snyvi-from, which must also be the sender the frame itself names; an
 * unsigned deposit is taken from the daemons that cannot sign yet (1.18.0)
 * until REQUIRE_SIGNED, and never replaces a signed one.
 *
 * Only an address whose owner has signed in here can be written to, so an
 * address made up costs nothing: the deposit is a 404 and nothing is kept.
 *
 * Limits are keyed by who is asking: the signed address, the signed
 * sender, the room. An IP is a key only where nothing else is -- the first
 * sign-in of a mailbox, the first message of a room, an unsigned deposit --
 * and for a flood backstop far above what anyone honest sends, because many
 * people can share one (a carrier's NAT, an office, a VPN). Whatever is
 * refused waits and goes again; nothing is lost to a limit.
 *
 * The link is how a daemon waits. It holds one WebSocket to its mailbox
 * for as long as it has a friend; the mailbox hibernates between events
 * (Durable Object hibernation: the socket stays open, the object is
 * evicted, nothing is billed). A frame deposited wakes it for a
 * millisecond: a text message {"frame":{id,sender,size,at}} down the open
 * socket, then the bytes as one binary message when they are small enough,
 * and it sleeps again. The daemon answers {"ack":id}. "ping" is answered
 * "pong" by the runtime without waking anything. The JSON routes stay for
 * the catch-up a daemon does when the socket will not open, and for a
 * frame too big to push. A room's doorbell is the same kind of socket.
 */

import { DurableObject } from "cloudflare:workers";

export interface Env {
  ROOM: DurableObjectNamespace<Room>;
  MAILBOX: DurableObjectNamespace<Mailbox>;
  /** Everything, by IP: a backstop, far above an honest daemon's few calls a minute. */
  LIMIT_FLOOD: RateLimit;
  /** By IP: a mailbox's first sign-in, a room's first message. Once per install, once per pairing. */
  LIMIT_FIRST: RateLimit;
  /** By room id: one pairing's own calls. */
  LIMIT_ROOM: RateLimit;
  /** By address: an owner's signed reads of its inbox. */
  LIMIT_INBOX: RateLimit;
  /** By the signed sender: deposits, and those over BIG. */
  LIMIT_SEND: RateLimit;
  LIMIT_SEND_BIG: RateLimit;
  /** By IP: deposits nobody signed (1.18.0 daemons), and those over BIG. */
  LIMIT_UNSIGNED: RateLimit;
  LIMIT_UNSIGNED_BIG: RateLimit;
  /** "1" under `wrangler dev --env test` only: the /_test routes. Never set where it is deployed. */
  RELAY_TEST?: string;
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
/** Frames one sender may have waiting in one mailbox: a stranger cannot take a friend's every slot. */
const FRAMES_PER_SENDER = 5;
/** Bytes one mailbox may hold: five full frames. */
const MAILBOX_BYTES_MAX = 5 * FRAME_MAX;
/** A deposit over this counts against the big-frame limits too. */
const BIG = 1 << 20;
/** An unread frame is dropped after this. */
const FRAME_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** A mailbox holding nothing, whose owner has not been here this long, goes whole. */
const IDLE_MS = 90 * 24 * 60 * 60 * 1000;
/** How stale the owner's last-seen may get before a signed request writes it again. */
const SEEN_REFRESH_MS = 24 * 60 * 60 * 1000;
/** The longest a room poll is held open. Under the free plan's 30 s wall limit for a DO request. */
const POLL_MAX_S = 25;
/** The clock a signature is checked against may be this far off. */
const AUTH_SKEW_S = 90;
/** SQLite rows on a Durable Object are capped at 2 MB; frames go in in halves of that. */
const CHUNK = 1 << 20;
/** The one frame version the daemon writes today. */
const FRAME_VERSION = 1;
/**
 * Refuse a deposit nobody signed. Off while 1.18.0 daemons, which cannot
 * sign, are still about; on about two weeks after 1.19.0 (docs/PEER.md).
 */
const REQUIRE_SIGNED = false;
/** Set by the Worker on everything it hands a Durable Object: the key an IP limit counts under. */
const CLIENT = "x-snyvi-client";
/** Set by the Worker on a deposit: the sender whose signature it checked, or empty. */
const SIGNED_BY = "x-snyvi-signed-by";

const KEY_RE = /^[A-Za-z0-9_-]{43}$/;
const ROOM_RE = /^[0-9a-f]{64}$/;
const FRAME_ID_RE = /^[0-9a-f]{64}$/;
const SIDE_RE = /^[0-9a-f]{16,64}$/;
const STAGES = ["spake", "hello"];

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
    const client = clientKey(request);

    if (!(await under(env.LIMIT_FLOOD, client))) return busy();

    if (parts.length === 1 && parts[0] === "health" && method === "GET") {
      return json({ ok: true });
    }

    if (parts[0] === "room" && parts.length === 3) {
      const [, id, stage] = parts;
      if (!ROOM_RE.test(id) || !(STAGES.includes(stage) || stage === "ws")) return text(404, "no such room");
      const bell = stage === "ws";
      if (bell ? method !== "GET" || !isUpgrade(request) : method !== "PUT" && method !== "GET") {
        return text(405, bell ? "GET with Upgrade: websocket" : "PUT or GET");
      }
      const side = request.headers.get("x-snyvi-side") ?? url.searchParams.get("side") ?? "";
      if (!SIDE_RE.test(side)) return text(400, "x-snyvi-side: 16-64 hex characters");
      if (method === "PUT" && over(request, ROOM_MSG_MAX)) return text(413, "a room message is at most 8 KB");
      if (!(await under(env.LIMIT_ROOM, id))) return busy();
      return env.ROOM.get(env.ROOM.idFromName(id)).fetch(forward(request, { [CLIENT]: client }));
    }

    if (parts[0] === "to" && parts.length === 2) {
      const key = parts[1];
      if (!KEY_RE.test(key)) return text(404, "no such mailbox");
      if (method !== "POST") return text(405, "POST");
      const id = request.headers.get("x-snyvi-id") ?? "";
      if (!FRAME_ID_RE.test(id)) return text(400, "x-snyvi-id: 64 hex characters");
      if (over(request, FRAME_MAX)) return text(413, "a frame is at most 8 MB");
      // A frame with no length given counts as big: it may be.
      const big = !(Number(request.headers.get("content-length") ?? NaN) <= BIG);
      const from = request.headers.get("x-snyvi-from");
      let signedBy = "";
      if (from !== null || request.headers.has("x-snyvi-auth")) {
        if (from === null || !KEY_RE.test(from)) return text(400, "x-snyvi-from: the sender's address");
        const why = await verify(request, from, url.pathname, null);
        if (why) return text(401, why);
        if (!(await under(env.LIMIT_SEND, from))) return busy();
        if (big && !(await under(env.LIMIT_SEND_BIG, from))) return busy();
        signedBy = from;
      } else {
        if (REQUIRE_SIGNED) return text(401, "a deposit is signed by its sender; this snyvi needs an update");
        if (!(await under(env.LIMIT_UNSIGNED, client))) return busy();
        if (big && !(await under(env.LIMIT_UNSIGNED_BIG, client))) return busy();
      }
      return env.MAILBOX.get(env.MAILBOX.idFromName(key)).fetch(forward(request, { [CLIENT]: client, [SIGNED_BY]: signedBy }));
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
      if (!(await under(env.LIMIT_INBOX, key))) return busy();
      return env.MAILBOX.get(env.MAILBOX.idFromName(key)).fetch(forward(request, { [CLIENT]: client }));
    }

    // The tests' view inside a mailbox: /_test/{tables|legacy}/{key}.
    if (env.RELAY_TEST === "1" && parts[0] === "_test" && parts.length === 3 && KEY_RE.test(parts[2])) {
      return env.MAILBOX.get(env.MAILBOX.idFromName(parts[2])).fetch(request);
    }

    return text(404, "snyvi relay");
  },
} satisfies ExportedHandler<Env>;

/**
 * The key an IP limit counts under: the address, or for IPv6 its /64,
 * since one machine often holds a whole /64. Never kept anywhere; it lives
 * only in the limiter's counters.
 */
function clientKey(request: Request): string {
  const ip = request.headers.get("cf-connecting-ip") ?? "";
  if (!ip.includes(":")) return ip || "unknown";
  const [head, tail = ""] = ip.toLowerCase().split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const groups = ip.includes("::") ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t] : h;
  return groups.slice(0, 4).map((g) => parseInt(g || "0", 16).toString(16)).join(":") + "::/64";
}

/** Under the limit, or the limiter could not say: a limit that cannot count lets through rather than shut the relay. */
async function under(limiter: RateLimit, key: string): Promise<boolean> {
  try {
    return (await limiter.limit({ key })).success;
  } catch {
    return true;
  }
}

function busy(): Response {
  const r = text(429, "the relay is busy; try again in a minute");
  r.headers.set("retry-after", "60");
  return r;
}

/** The request as a Durable Object gets it: the Worker's own headers set over whatever the client sent under those names. */
function forward(request: Request, headers: Record<string, string>): Request {
  const r = new Request(request);
  for (const [k, v] of Object.entries(headers)) r.headers.set(k, v);
  return r;
}

/** Content-Length over the cap, when the client sends one; the body is counted again as it is read. */
function over(request: Request, max: number): boolean {
  const n = Number(request.headers.get("content-length") ?? "0");
  return Number.isFinite(n) && n > max;
}

/** The body, read with a running count: null the moment it passes `max`, so a body with no length given is never held whole. */
async function readCapped(request: Request, max: number): Promise<Uint8Array | null> {
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(n);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

function isUpgrade(request: Request): boolean {
  return (request.headers.get("upgrade") ?? "").toLowerCase() === "websocket";
}

/**
 * `key`'s signature over the request: the mailbox's own on a read of it,
 * the sender's on a deposit. `query` is the signature as `?auth=` carried
 * it, accepted on the upgrade only. Returns why it failed, or null when it
 * is good.
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
  if (!raw || raw.length !== 32) return "no such key";
  let pub: CryptoKey;
  try {
    pub = await crypto.subtle.importKey("raw", raw, { name: "Ed25519" }, false, ["verify"]);
  } catch {
    return "no such key";
  }
  const msg = new TextEncoder().encode(`snyvi-relay-v1\n${request.method}\n${path}\n${seconds}`);
  const good = await crypto.subtle.verify("Ed25519", pub, sig, msg);
  return good ? null : "not the key's signature";
}

/**
 * The minute of pairing. Two sides, each named by a random id it chose,
 * leave a message per stage and read the other's: first the SPAKE2
 * messages, then the hellos sealed under the key SPAKE2 gave them. A third
 * side is turned away, so a guessed code meets a full room; both hellos
 * read, or ten minutes, and the room is gone.
 *
 * A side waits on the doorbell: a WebSocket the room accepts with
 * hibernation and rings with {"ready":stage} when the other side's message
 * for that stage lands, then the side reads it with ?wait=0. Waiting so
 * costs nothing. The long poll (a GET that waits) stays for the 1.18.0
 * daemons, one poll per side: a second from the same side ends the first.
 */
export class Room extends DurableObject<Env> {
  private waiters = new Set<() => void>();
  private polls = new Map<string, symbol>();

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const [, , stage] = url.pathname.split("/").filter(Boolean);
    const side = request.headers.get("x-snyvi-side") ?? url.searchParams.get("side")!;
    const storage = this.ctx.storage;

    if (await storage.get<boolean>("spent")) return text(410, "this room has been used");

    if (stage === "ws") return this.doorbell(side);

    if (request.method === "PUT") {
      const bytes = await readCapped(request, ROOM_MSG_MAX);
      if (!bytes) return text(413, "a room message is at most 8 KB");
      if (bytes.length === 0) return text(400, "an empty message");
      const sides = (await storage.get<string[]>("sides")) ?? [];
      if (!sides.includes(side)) {
        if (sides.length >= 2) return text(409, "the room is full");
        // A room's first message is the one an IP limit counts: once per pairing.
        if (sides.length === 0 && !(await under(this.env.LIMIT_FIRST, request.headers.get(CLIENT) ?? ""))) return busy();
        sides.push(side);
        await storage.put("sides", sides);
        if (sides.length === 1) await storage.setAlarm(Date.now() + ROOM_TTL_MS);
      }
      await storage.put(`msg:${stage}:${side}`, bytes);
      this.wake();
      this.ring(sides, side, stage);
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

  /** A side's doorbell: one socket per side, rung at once for whatever is already waiting. */
  private async doorbell(side: string): Promise<Response> {
    const sides = (await this.ctx.storage.get<string[]>("sides")) ?? [];
    if (!sides.includes(side)) return text(404, "not a side of this room");
    for (const old of this.ctx.getWebSockets(side)) {
      try {
        old.close(1000, "replaced");
      } catch {}
    }
    const pair = new WebSocketPair();
    const client = pair[0], server = pair[1];
    this.ctx.acceptWebSocket(server, [side]);
    const them = sides.find((s) => s !== side);
    if (them) {
      for (const stage of STAGES) {
        if (await this.ctx.storage.get(`msg:${stage}:${them}`)) send(server, { ready: stage });
      }
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Tell the other side's doorbell that `side`'s message for `stage` is in. */
  private ring(sides: string[], side: string, stage: string) {
    for (const s of sides) {
      if (s === side) continue;
      for (const ws of this.ctx.getWebSockets(s)) send(ws, { ready: stage });
    }
  }

  /**
   * The other side's message for the stage, waiting up to `wait` seconds
   * for it. A side has one poll at a time: a newer one from the same side
   * ends this one empty.
   */
  private async other(stage: string, side: string, wait: number): Promise<Uint8Array | undefined> {
    const until = Date.now() + wait * 1000;
    const token = Symbol();
    if (wait > 0) {
      this.polls.set(side, token);
      this.wake();
    }
    try {
      for (;;) {
        const sides = (await this.ctx.storage.get<string[]>("sides")) ?? [];
        const them = sides.find((s) => s !== side);
        if (them) {
          const msg = await this.ctx.storage.get<Uint8Array>(`msg:${stage}:${them}`);
          if (msg) return msg;
        }
        if (wait > 0 && this.polls.get(side) !== token) return undefined;
        const left = until - Date.now();
        if (left <= 0) return undefined;
        await this.sleep(left);
      }
    } finally {
      if (this.polls.get(side) === token) this.polls.delete(side);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(t);
        this.waiters.delete(done);
        resolve();
      };
      const t = setTimeout(done, ms);
      this.waiters.add(done);
    });
  }

  private wake() {
    for (const done of [...this.waiters]) done();
  }

  /** A doorbell only rings one way; whatever a side says down it is ignored. */
  async webSocketMessage(): Promise<void> {}

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code, reason);
    } catch {}
  }

  async alarm(): Promise<void> {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(1000, "the room is gone");
      } catch {}
    }
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
 * What it keeps, and for how long: `seen`, when the owner last signed in,
 * from the first sign-in -- without it the mailbox takes nothing. The
 * frames tables only while a frame is waiting: made by the first deposit,
 * dropped with the last frame. And once nothing is waiting and the owner
 * has not been here for ninety days with no link open, nothing at all.
 * A mailbox from before `seen` (1.18.0's, which made its tables on every
 * wake) counts as signed in by those tables, and writes `seen` once.
 *
 * Nothing lives in memory between events. The socket is the runtime's
 * (acceptWebSocket), so the object hibernates with it open and is woken by
 * a deposit, an ack, a close, or the alarm -- never by a ping. One link per
 * address: a newer one closes the older.
 */
export class Mailbox extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // The daemon's keepalive, answered without waking this object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  private get sql() {
    return this.ctx.storage.sql;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] === "_test" && this.env.RELAY_TEST === "1") return this.test(parts[1]);
    if (parts[0] === "to") {
      return this.deposit(request, request.headers.get("x-snyvi-id")!, request.headers.get(SIGNED_BY) ?? "");
    }
    // Everything else is the owner, signed: the Worker checked it.
    const refused = await this.signIn(request.headers.get(CLIENT) ?? "");
    if (refused) return refused;
    if (parts.length === 2) return isUpgrade(request) ? this.link(parts[1]) : this.list();
    if (request.method === "DELETE") return this.ack(parts[2]);
    return this.open(parts[2]);
  }

  /**
   * The owner is here. The first time, an IP limit counts it (once per
   * install, so a shared IP rarely meets it) and `seen` is written; after
   * that `seen` is refreshed at most once a day.
   */
  private async signIn(client: string): Promise<Response | null> {
    const now = Date.now();
    const seen = await this.ctx.storage.get<number>("seen");
    if (seen !== undefined) {
      if (now - seen > SEEN_REFRESH_MS) await this.ctx.storage.put("seen", now);
      return null;
    }
    const legacy = this.hasTables();
    if (!legacy && !(await under(this.env.LIMIT_FIRST, client))) return busy();
    await this.ctx.storage.put("seen", now);
    if (legacy) this.dropIfEmpty();
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(now + IDLE_MS);
    return null;
  }

  private async deposit(request: Request, id: string, signedBy: string): Promise<Response> {
    const seen = await this.ctx.storage.get<number>("seen");
    const has = this.hasTables();
    // Nobody has signed in as this address: nothing is read, nothing kept.
    if (seen === undefined && !has) return text(404, "no such mailbox");

    const bytes = await readCapped(request, FRAME_MAX);
    if (!bytes) return text(413, "a frame is at most 8 MB");
    if (bytes.length < 33 || bytes[0] !== FRAME_VERSION) return text(400, "not a snyvi frame");
    const sender = b64encode(bytes.subarray(1, 33));
    const signed = signedBy !== "";
    if (signed && sender !== signedBy) return text(400, "the frame's sender is not who signed it");

    const sql = this.sql;
    if (has) this.ensure(); // a 1.18.0 mailbox's tables get the column the next line reads
    const old = has
      ? (sql.exec("SELECT sender, size, signed FROM frames WHERE id = ?", id).toArray()[0] as
          | { sender: string; size: number; signed: number }
          | undefined)
      : undefined;
    // The same id from someone else, or unsigned over signed: the one there
    // stays. The answer is the same either way, so it says nothing about
    // what is waiting.
    if (old && (old.sender !== sender || (old.signed && !signed))) return json({ id, size: bytes.length }, 201);
    const held = has
      ? (sql.exec("SELECT count(*) AS n, coalesce(sum(size), 0) AS bytes FROM frames").one() as { n: number; bytes: number })
      : { n: 0, bytes: 0 };
    if (!old) {
      if (held.n >= FRAMES_WAITING_MAX) return text(429, "the mailbox is full; try later");
      const mine = has ? (sql.exec("SELECT count(*) AS n FROM frames WHERE sender = ?", sender).one().n as number) : 0;
      if (mine >= FRAMES_PER_SENDER) return text(429, "the mailbox is full; try later");
    }
    if (held.bytes - (old?.size ?? 0) + bytes.length > MAILBOX_BYTES_MAX) return text(429, "the mailbox is full; try later");

    if (seen === undefined) await this.ctx.storage.put("seen", Date.now());
    this.ensure();
    const at = Date.now();
    this.ctx.storage.transactionSync(() => {
      sql.exec("DELETE FROM chunks WHERE id = ?", id);
      sql.exec("DELETE FROM frames WHERE id = ?", id);
      sql.exec("INSERT INTO frames (id, sender, size, at, signed) VALUES (?, ?, ?, ?, ?)", id, sender, bytes.length, at, signed ? 1 : 0);
      for (let n = 0, off = 0; off < bytes.length; n++, off += CHUNK) {
        sql.exec("INSERT INTO chunks (id, n, data) VALUES (?, ?, ?)", id, n, bytes.subarray(off, off + CHUNK));
      }
    });
    // The seven-day sweep, pulled in from the ninety-day one if that is what is set.
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || alarm > at + FRAME_TTL_MS) await this.ctx.storage.setAlarm(at + FRAME_TTL_MS);
    // The push: whoever holds the link hears of it now. A socket that has
    // gone away throws here and is closed by the runtime; the frame waits
    // for the next link's catch-up either way.
    const frame: Frame = { id, sender, size: bytes.length, at };
    for (const ws of this.ctx.getWebSockets()) this.push(ws, frame, bytes);
    return json({ id, size: bytes.length }, 201);
  }

  /** The link: the older one closed, accept, then everything already waiting, in order. */
  private link(key: string): Response {
    for (const old of this.ctx.getWebSockets()) {
      try {
        old.close(1000, "replaced by a newer link");
      } catch {}
    }
    const pair = new WebSocketPair();
    const client = pair[0], server = pair[1];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ key });
    for (const f of this.frames()) this.push(server, f);
    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Under `--env test` only. "tables": what this mailbox keeps, without
   * signing in. "legacy": the tables as 1.18.0 made them (no `signed`, no
   * `seen`), to stand in for a mailbox from before this change.
   */
  private async test(what: string): Promise<Response> {
    if (what === "legacy") {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS frames (id TEXT PRIMARY KEY, sender TEXT NOT NULL, size INTEGER NOT NULL, at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS chunks (id TEXT NOT NULL, n INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (id, n));
      `);
    }
    return json({ tables: this.hasTables(), seen: (await this.ctx.storage.get("seen")) !== undefined });
  }

  private hasTables(): boolean {
    return this.sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'frames'").toArray().length > 0;
  }

  /** The tables, made when the first frame comes; a 1.18.0 mailbox's gets the column it lacks. */
  private ensure() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS frames (
        id TEXT PRIMARY KEY, sender TEXT NOT NULL, size INTEGER NOT NULL, at INTEGER NOT NULL,
        signed INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS chunks (
        id TEXT NOT NULL, n INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (id, n)
      );
    `);
    const ddl = this.sql.exec("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'frames'").one().sql as string;
    if (!/\bsigned\b/.test(ddl)) this.sql.exec("ALTER TABLE frames ADD COLUMN signed INTEGER NOT NULL DEFAULT 0");
  }

  /** The last frame gone, its tables go too: an empty mailbox holds `seen` and nothing more. */
  private dropIfEmpty() {
    if (!this.hasTables()) return;
    if ((this.sql.exec("SELECT count(*) AS n FROM frames").one().n as number) > 0) return;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("DROP TABLE chunks");
      this.sql.exec("DROP TABLE frames");
    });
  }

  private frames(): Frame[] {
    if (!this.hasTables()) return [];
    return this.sql.exec("SELECT id, sender, size, at FROM frames ORDER BY at, id").toArray() as unknown as Frame[];
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
    const rows = this.sql.exec("SELECT data FROM chunks WHERE id = ? ORDER BY n", id).toArray();
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
    if (!this.hasTables()) return text(404, "no such frame");
    const sql = this.sql;
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
    if (!this.hasTables()) return;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM chunks WHERE id = ?", id);
      this.sql.exec("DELETE FROM frames WHERE id = ?", id);
    });
    this.dropIfEmpty();
  }

  /**
   * The sweep. Frames past seven days go; while any are left the next
   * sweep is the oldest's. Once none are: an open link means the owner is
   * here, so look again in ninety days; no link and no sign of the owner
   * for ninety days, and the mailbox goes whole (deleteAll takes the alarm
   * with it on this compatibility date).
   */
  async alarm(): Promise<void> {
    const sql = this.sql;
    const now = Date.now();
    if (this.hasTables()) {
      const cutoff = now - FRAME_TTL_MS;
      this.ctx.storage.transactionSync(() => {
        sql.exec("DELETE FROM chunks WHERE id IN (SELECT id FROM frames WHERE at <= ?)", cutoff);
        sql.exec("DELETE FROM frames WHERE at <= ?", cutoff);
      });
      const oldest = sql.exec("SELECT min(at) AS at FROM frames").one().at as number | null;
      if (oldest !== null) {
        await this.ctx.storage.setAlarm(oldest + FRAME_TTL_MS);
        return;
      }
      this.dropIfEmpty();
    }
    if (this.ctx.getWebSockets().length > 0) {
      await this.ctx.storage.put("seen", now);
      await this.ctx.storage.setAlarm(now + IDLE_MS);
      return;
    }
    const seen = await this.ctx.storage.get<number>("seen");
    if (seen === undefined || now - seen >= IDLE_MS) {
      await this.ctx.storage.deleteAll();
      return;
    }
    await this.ctx.storage.setAlarm(seen + IDLE_MS);
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

function send(ws: WebSocket, msg: unknown) {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    // Closed under us.
  }
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
