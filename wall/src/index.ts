/*
 * The wall (docs/WALL.md): every snyvi Home's "What people are building",
 * and each builder's page at snyvi.page/<slug>.
 *
 * What it holds: what a builder's daemon signed and they pressed Publish
 * on -- the page, its moments, its files -- in the clear, keyed by the
 * daemon's public key; the hearts, by the key that gave them; the reports,
 * counted. What it never holds: anything of the machine a page was made on,
 * a name that is not a page's own, an account, a log of who read what.
 *
 * Writes are signed (x-snyvi-from, x-snyvi-auth over the method, path,
 * time and the body's blake3: src/wall.rs `auth_message`). A slug belongs
 * to the key that first published it. A page is on Everyone's wall only
 * once its repository's `.snyvi/owner`, at HEAD, names that key.
 *
 * Reads never run the database: each write renders wall.json, the page's
 * page.json and its index.html into R2 once, and a read is R2 through the
 * cache. Once a day (09:00 UTC) each page with new hearts gets one line,
 * sealed to its daemon like a friend's frame and left at the relay.
 */

import { authMessage, b64, blake3hex16, keysOf, relayAuth, seal, unb64, verify, wallLine, type Keys } from "./seal";
import { card, CSP, fileOk, pageHtml, type MomentJson, type PageJson } from "./render";

interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  LIMIT_WRITE: RateLimit;
  LIMIT_HEART: RateLimit;
  LIMIT_FLOOD: RateLimit;
  /** The wall's 64-byte seed, base64url: a secret, minted by scripts/mint.mjs. */
  WALL_SEED: string;
  /** The operator's token for takedowns (scripts/hide.mjs). */
  WALL_OPERATOR?: string;
  RELAY_URL: string;
  RAW_BASE: string;
  WALL_TEST?: string;
}

const AUTH_SKEW_S = 90;
const KEY_RE = /^[A-Za-z0-9_-]{43}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;
const PAGE_MAX = 64 * 1024;
const MOMENT_MAX = 16 * 1024;
const FILE_CAP: Record<string, number> = { svg: 400 << 10, png: 1536 << 10, jpg: 1536 << 10, webp: 1536 << 10, gif: 1536 << 10, avif: 1536 << 10, mp4: 20 << 20, webm: 20 << 20 };
const PAGE_FILES_MAX = 50 << 20;
/** Hearts one key gives in a day: plenty for a reader, nothing for a script. */
const HEARTS_A_DAY = 200;
const WALL_SHOWN = 200;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pages (slug TEXT PRIMARY KEY, key TEXT NOT NULL, box TEXT NOT NULL DEFAULT '', json TEXT NOT NULL,
  checked_at INTEGER NOT NULL DEFAULT 0, hidden INTEGER NOT NULL DEFAULT 0, reports INTEGER NOT NULL DEFAULT 0,
  line_at INTEGER NOT NULL DEFAULT 0, newest INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS moments (slug TEXT NOT NULL, id INTEGER NOT NULL, json TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (slug, id));
CREATE TABLE IF NOT EXISTS files (name TEXT NOT NULL, slug TEXT NOT NULL, bytes INTEGER NOT NULL, PRIMARY KEY (name, slug));
CREATE TABLE IF NOT EXISTS hearts (key TEXT NOT NULL, target TEXT NOT NULL, slug TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (key, target));
CREATE INDEX IF NOT EXISTS hearts_of ON hearts (slug, at);
CREATE TABLE IF NOT EXISTS reports (key TEXT NOT NULL, slug TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (key, slug));
CREATE TABLE IF NOT EXISTS budget (key TEXT NOT NULL, day INTEGER NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (key, day));`;

let schemaReady: Promise<unknown> | null = null;
function ready(env: Env) {
  return (schemaReady ||= env.DB.exec(SCHEMA.replace(/\n\s*/g, " ")).catch((e) => { schemaReady = null; throw e; }));
}

const now = () => Math.floor(Date.now() / 1000);

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...extra } });
}
const no = (status: number, error: string) => json(status, { error });

async function under(limit: RateLimit, key: string): Promise<boolean> {
  try {
    return (await limit.limit({ key })).success;
  } catch {
    return true;
  }
}

/** A signed write: who signed it, or why it is refused. */
async function signer(req: Request, path: string, body: Uint8Array): Promise<{ key: string } | { error: Response }> {
  const from = req.headers.get("x-snyvi-from") ?? "";
  const auth = req.headers.get("x-snyvi-auth") ?? "";
  if (!KEY_RE.test(from)) return { error: no(401, "x-snyvi-from: the daemon's address") };
  const dot = auth.indexOf(".");
  const secs = Number(auth.slice(0, dot));
  if (dot < 1 || !Number.isInteger(secs)) return { error: no(401, "x-snyvi-auth: <seconds>.<signature>") };
  if (Math.abs(now() - secs) > AUTH_SKEW_S) return { error: no(401, "the signature's clock is off by more than 90 s") };
  if (!verify(from, authMessage(req.method, path, secs, body), auth.slice(dot + 1))) return { error: no(401, "not the key's signature") };
  return { key: from };
}

interface PageRow { slug: string; key: string; box: string; json: string; checked_at: number; hidden: number; reports: number; line_at: number; newest: number }

const pageRow = (env: Env, slug: string) => env.DB.prepare("SELECT * FROM pages WHERE slug = ?").bind(slug).first<PageRow>();

async function momentsOf(env: Env, slug: string): Promise<MomentJson[]> {
  const r = await env.DB.prepare("SELECT json FROM moments WHERE slug = ? ORDER BY at DESC, id DESC LIMIT 100").bind(slug).all<{ json: string }>();
  return (r.results || []).map((x) => JSON.parse(x.json));
}

async function heartsOf(env: Env, slug: string): Promise<number> {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM hearts WHERE slug = ? AND target = ?").bind(slug, `p:${slug}`).first<{ n: number }>();
  return r?.n ?? 0;
}

/** Render what a read of this page and of the wall serves, into R2. */
async function render(env: Env, origin: string, slug: string) {
  const row = await pageRow(env, slug);
  if (!row || row.hidden) {
    await env.BUCKET.delete([`pages/${slug}/index.html`, `pages/${slug}/page.json`]);
  } else {
    const p: PageJson = JSON.parse(row.json), ms = await momentsOf(env, slug), hearts = await heartsOf(env, slug);
    await env.BUCKET.put(`pages/${slug}/index.html`, pageHtml(p, ms, hearts, origin), { httpMetadata: { contentType: "text/html; charset=utf-8" } });
    await env.BUCKET.put(`pages/${slug}/page.json`, JSON.stringify({ page: p, moments: ms, hearts: p.count_shown ? hearts : null, checked_at: row.checked_at }), { httpMetadata: { contentType: "application/json" } });
  }
  await renderWall(env);
}

/** wall.json: every checked, shown page's card, newest moment first. */
async function renderWall(env: Env) {
  const r = await env.DB.prepare("SELECT * FROM pages WHERE checked_at > 0 AND hidden = 0 ORDER BY newest DESC, updated_at DESC LIMIT ?").bind(WALL_SHOWN).all<PageRow>();
  const cards = [];
  for (const row of r.results || []) {
    const p: PageJson = JSON.parse(row.json);
    cards.push(card(p, await momentsOf(env, row.slug), await heartsOf(env, row.slug), row.checked_at));
  }
  await env.BUCKET.put("wall.json", JSON.stringify({ v: 1, at: now(), pages: cards }), { httpMetadata: { contentType: "application/json" } });
}

/** A field the page must have, the right kind, short enough. */
function pageFrom(body: unknown, slug: string): PageJson | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const s = (k: string, n: number) => (typeof b[k] === "string" ? (b[k] as string).slice(0, n) : "");
  if (b.slug !== slug || !s("title", 80)) return null;
  return {
    slug, title: s("title", 80), lede: s("lede", 400), kind: s("kind", 40), tone: s("tone", 10), stage: s("stage", 40),
    looking_for: s("looking_for", 120), logo: fileOk(b.logo) ? (b.logo as string) : "", cover: fileOk(b.cover) ? (b.cover as string) : "",
    hero: s("hero", 10), facts: Array.isArray(b.facts) ? (b.facts as unknown[]).filter((f): f is string => typeof f === "string").slice(0, 4) : [],
    github: s("github", 300), links: Array.isArray(b.links) ? (b.links as { label?: unknown; url?: unknown }[]).slice(0, 6).map((l) => ({ label: String(l?.label ?? "").slice(0, 40), url: String(l?.url ?? "").slice(0, 300) })) : [],
    accent: s("accent", 10), wash: s("wash", 7), count_shown: b.count_shown !== false,
  };
}

async function putPage(env: Env, origin: string, slug: string, key: string, body: Uint8Array): Promise<Response> {
  if (body.length > PAGE_MAX) return no(413, "a page is at most 64 KB");
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder().decode(body)); } catch { return no(400, "a page is JSON"); }
  const p = pageFrom(parsed, slug);
  if (!p) return no(422, "a page says its slug and has a title");
  const box = String((parsed as Record<string, unknown>).box ?? "");
  if (!KEY_RE.test(box)) return no(422, "a page carries its daemon's box key");
  const row = await pageRow(env, slug);
  if (row && row.key !== key) return no(409, "that name is taken");
  const t = now();
  await env.DB.prepare(`INSERT INTO pages (slug, key, box, json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (slug) DO UPDATE SET box = excluded.box, json = excluded.json, updated_at = excluded.updated_at`).bind(slug, key, box, JSON.stringify(p), t, t).run();
  await render(env, origin, slug);
  return json(200, { slug, up: true });
}

/** Only the key that owns the slug writes under it. */
async function owned(env: Env, slug: string, key: string): Promise<PageRow | Response> {
  const row = await pageRow(env, slug);
  if (!row) return no(404, "no page by that name; put the page first");
  if (row.key !== key) return no(409, "that name is taken");
  return row;
}

async function putMoment(env: Env, origin: string, slug: string, id: number, key: string, body: Uint8Array): Promise<Response> {
  const row = await owned(env, slug, key);
  if (row instanceof Response) return row;
  if (body.length > MOMENT_MAX) return no(413, "a moment is at most 16 KB");
  let m: Record<string, unknown>;
  try { m = JSON.parse(new TextDecoder().decode(body)); } catch { return no(400, "a moment is JSON"); }
  const title = typeof m.title === "string" ? m.title.slice(0, 80) : "";
  if (!title) return no(422, "a moment has a title");
  const at = Number.isInteger(m.at) && (m.at as number) > 0 ? Math.min(m.at as number, now()) : now();
  const moment: MomentJson = { id, title, body_md: typeof m.body_md === "string" ? m.body_md.slice(0, 4000) : "", files: Array.isArray(m.files) ? (m.files as unknown[]).filter(fileOk).slice(0, 4) : [], at };
  await env.DB.batch([
    env.DB.prepare("INSERT INTO moments (slug, id, json, at) VALUES (?, ?, ?, ?) ON CONFLICT (slug, id) DO UPDATE SET json = excluded.json").bind(slug, id, JSON.stringify(moment), at),
    env.DB.prepare("UPDATE pages SET newest = MAX(newest, ?), updated_at = ? WHERE slug = ?").bind(at, now(), slug),
  ]);
  await render(env, origin, slug);
  return json(200, { slug, moment: id });
}

async function putFile(env: Env, slug: string, name: string, key: string, body: Uint8Array): Promise<Response> {
  const row = await owned(env, slug, key);
  if (row instanceof Response) return row;
  if (!fileOk(name)) return no(400, "a file is named <16 hex>.<ext>");
  const ext = name.split(".")[1];
  if (body.length > FILE_CAP[ext]) return no(413, `a .${ext} on a page is at most ${Math.round(FILE_CAP[ext] / 1024)} KB`);
  if (blake3hex16(body) !== name.split(".")[0]) return no(422, "a file's name is its blake3");
  const held = await env.DB.prepare("SELECT COALESCE(SUM(bytes), 0) AS n FROM files WHERE slug = ? AND name != ?").bind(slug, name).first<{ n: number }>();
  if ((held?.n ?? 0) + body.length > PAGE_FILES_MAX) return no(413, "a page is up to 50 MB in all");
  await env.BUCKET.put(`files/${name}`, body, { httpMetadata: { contentType: CT[ext] } });
  await env.DB.prepare("INSERT INTO files (name, slug, bytes) VALUES (?, ?, ?) ON CONFLICT DO NOTHING").bind(name, slug, body.length).run();
  return json(200, { file: name });
}

const CT: Record<string, string> = { svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", webp: "image/webp", gif: "image/gif", avif: "image/avif", mp4: "video/mp4", webm: "video/webm" };

/** `.snyvi/owner` at HEAD names this key: read once, from GitHub's raw files. */
async function check(env: Env, origin: string, slug: string, key: string): Promise<Response> {
  const row = await owned(env, slug, key);
  if (row instanceof Response) return row;
  const p: PageJson = JSON.parse(row.json);
  const m = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(p.github || "");
  let checked = false;
  if (m) {
    try {
      const r = await fetch(`${env.RAW_BASE}/${m[1]}/${m[2]}/HEAD/.snyvi/owner`, { redirect: "follow" });
      if (r.ok) checked = (await r.text()).trim() === `snyvi-owner-v1 ${key}`;
    } catch { /* not reachable: not checked */ }
  }
  await env.DB.prepare("UPDATE pages SET checked_at = ? WHERE slug = ?").bind(checked ? now() : 0, slug).run();
  await renderWall(env);
  return json(200, { checked, why: checked ? "" : m ? "the repository's .snyvi/owner does not name this key yet" : "the page has no GitHub repository to check" });
}

/** Taken down by its owner: the rows and the files go, within the minute. */
async function takeDown(env: Env, slug: string): Promise<void> {
  const files = await env.DB.prepare("SELECT name FROM files WHERE slug = ?").bind(slug).all<{ name: string }>();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM pages WHERE slug = ?").bind(slug),
    env.DB.prepare("DELETE FROM moments WHERE slug = ?").bind(slug),
    env.DB.prepare("DELETE FROM files WHERE slug = ?").bind(slug),
    env.DB.prepare("DELETE FROM hearts WHERE slug = ?").bind(slug),
  ]);
  const still = await env.DB.prepare("SELECT DISTINCT name FROM files").all<{ name: string }>();
  const kept = new Set((still.results || []).map((r) => r.name));
  const gone = (files.results || []).map((f) => f.name).filter((n) => !kept.has(n)).map((n) => `files/${n}`);
  await env.BUCKET.delete([`pages/${slug}/index.html`, `pages/${slug}/page.json`, ...gone]);
  await renderWall(env);
}

/** One heart per key per target, a toggle, within the day's budget. */
async function heart(env: Env, origin: string, slug: string, moment: number | null, key: string): Promise<Response> {
  if (!(await under(env.LIMIT_HEART, key))) return no(429, "slow down");
  const row = await pageRow(env, slug);
  if (!row || row.hidden) return no(404, "no page by that name");
  const day = Math.floor(now() / 86400);
  const spent = await env.DB.prepare("SELECT n FROM budget WHERE key = ? AND day = ?").bind(key, day).first<{ n: number }>();
  if ((spent?.n ?? 0) >= HEARTS_A_DAY) return no(429, "that is the day's hearts");
  const target = moment == null ? `p:${slug}` : `m:${slug}:${moment}`;
  const had = await env.DB.prepare("SELECT 1 AS x FROM hearts WHERE key = ? AND target = ?").bind(key, target).first();
  await env.DB.batch([
    had ? env.DB.prepare("DELETE FROM hearts WHERE key = ? AND target = ?").bind(key, target)
      : env.DB.prepare("INSERT INTO hearts (key, target, slug, at) VALUES (?, ?, ?, ?)").bind(key, target, slug, now()),
    env.DB.prepare("INSERT INTO budget (key, day, n) VALUES (?, ?, 1) ON CONFLICT (key, day) DO UPDATE SET n = n + 1").bind(key, day),
  ]);
  if (moment == null) await render(env, origin, slug);
  const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM hearts WHERE target = ?").bind(target).first<{ n: number }>();
  return json(200, { on: !had, hearts: n?.n ?? 0 });
}

async function report(env: Env, slug: string, key: string): Promise<Response> {
  const row = await pageRow(env, slug);
  if (!row) return no(404, "no page by that name");
  const r = await env.DB.prepare("INSERT INTO reports (key, slug, at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING").bind(key, slug, now()).run();
  if (r.meta.changes) await env.DB.prepare("UPDATE pages SET reports = reports + 1 WHERE slug = ?").bind(slug).run();
  return json(200, { reported: true });
}

/** A read out of R2, through the cache: no database, no Worker time to speak of. */
async function fromBucket(req: Request, env: Env, ctx: ExecutionContext, key: string, maxAge: number, extra: Record<string, string> = {}): Promise<Response> {
  const cache = caches.default;
  const hit = await cache.match(req);
  if (hit) return hit;
  const obj = await env.BUCKET.get(key);
  if (!obj) return no(404, "not here");
  const res = new Response(obj.body, {
    headers: { "content-type": obj.httpMetadata?.contentType || "application/octet-stream", "cache-control": `public, max-age=${maxAge}`, "x-content-type-options": "nosniff", ...extra },
  });
  if (!env.WALL_TEST) ctx.waitUntil(cache.put(req, res.clone()));
  return res;
}

async function readBody(req: Request, max: number): Promise<Uint8Array | null> {
  const len = Number(req.headers.get("content-length") ?? NaN);
  if (len > max) return null;
  const b = new Uint8Array(await req.arrayBuffer());
  return b.length > max ? null : b;
}

/** The writes, every one signed. */
async function write(req: Request, env: Env, origin: string, parts: string[], path: string): Promise<Response> {
  const slug = parts[1];
  if (!SLUG_RE.test(slug)) return no(404, "a page's name is 2 to 40 lowercase letters, digits and hyphens");
  const body = await readBody(req, 21 << 20);
  if (!body) return no(413, "too big");
  const who = await signer(req, path, body);
  if ("error" in who) return who.error;
  if (!(await under(env.LIMIT_WRITE, who.key))) return no(429, "slow down");
  const [m, rest] = [req.method, parts.slice(2).join("/")];
  if (m === "PUT" && rest === "") return putPage(env, origin, slug, who.key, body);
  if (m === "DELETE" && rest === "") {
    const row = await owned(env, slug, who.key);
    if (row instanceof Response) return row;
    await takeDown(env, slug);
    return json(200, { down: true });
  }
  if (m === "PUT" && parts[2] === "moments" && /^\d{1,15}$/.test(parts[3] ?? "") && parts.length === 4) return putMoment(env, origin, slug, Number(parts[3]), who.key, body);
  if (m === "PUT" && parts[2] === "files" && parts.length === 4) return putFile(env, slug, parts[3], who.key, body);
  if (m === "POST" && rest === "check") return check(env, origin, slug, who.key);
  if (m === "POST" && rest === "hearts") return heart(env, origin, slug, null, who.key);
  if (m === "POST" && parts[2] === "moments" && parts[4] === "hearts" && /^\d{1,15}$/.test(parts[3] ?? "")) return heart(env, origin, slug, Number(parts[3]), who.key);
  if (m === "POST" && rest === "report") return report(env, slug, who.key);
  return no(404, "no such write");
}

/** The daily line: each page with hearts since its last, sealed to its daemon. */
async function daily(env: Env): Promise<number> {
  const seed = unb64(env.WALL_SEED || "");
  if (!seed || seed.length !== 64) return 0;
  const me = keysOf(seed);
  const r = await env.DB.prepare(`SELECT p.slug, p.key, p.box, p.line_at, p.reports FROM pages p
    WHERE p.hidden = 0 AND EXISTS (SELECT 1 FROM hearts h WHERE h.slug = p.slug AND h.at > p.line_at)`).all<{ slug: string; key: string; box: string; line_at: number; reports: number }>();
  let sent = 0;
  for (const p of r.results || []) {
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM hearts WHERE slug = ? AND at > ?").bind(p.slug, p.line_at).first<{ n: number }>();
    // Names are those of hearts from checked pages: a page's title is its builder's name here.
    const named = await env.DB.prepare(`SELECT DISTINCT q.json FROM hearts h JOIN pages q ON q.key = h.key
      WHERE h.slug = ? AND h.at > ? AND q.checked_at > 0 AND q.hidden = 0 LIMIT 20`).bind(p.slug, p.line_at).all<{ json: string }>();
    const names = (named.results || []).map((x) => String(JSON.parse(x.json).title || "")).filter(Boolean);
    if (await deposit(env, me, p.key, p.box, wallLine(p.slug, n?.n ?? 0, names, p.line_at, p.reports))) {
      await env.DB.prepare("UPDATE pages SET line_at = ? WHERE slug = ?").bind(now(), p.slug).run();
      sent++;
    }
  }
  return sent;
}

async function deposit(env: Env, me: Keys, to: string, box: string, line: string, nonce?: Uint8Array): Promise<boolean> {
  const toBox = unb64(box);
  if (!toBox || toBox.length !== 32) return false;
  const frame = seal(me, toBox, line, new Uint8Array(), nonce ?? crypto.getRandomValues(new Uint8Array(24)));
  const path = `/to/${to}`;
  const id = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
  try {
    const r = await fetch(`${env.RELAY_URL}${path}`, {
      method: "POST", body: frame,
      headers: { "x-snyvi-id": id, "x-snyvi-from": b64(me.signPub), "x-snyvi-auth": relayAuth(me, "POST", path, now()), "content-type": "application/octet-stream" },
    });
    return r.ok;
  } catch {
    return false;
  }
}

/** Test-only routes (WALL_TEST): the seal against the vectors, and the cron. */
async function testRoute(req: Request, env: Env, parts: string[]): Promise<Response> {
  if (parts[1] === "seal" && req.method === "POST") {
    const v = (await req.json()) as Record<string, string>;
    const me = keysOf(unb64(v.wall_seed)!);
    const frame = seal(me, unb64(v.to_box)!, v.content, new Uint8Array(), unb64(v.nonce)!);
    return json(200, { frame: b64(frame), wall_sign: b64(me.signPub), wall_box: b64(me.boxPub) });
  }
  if (parts[1] === "daily" && req.method === "POST") return json(200, { sent: await daily(env) });
  return no(404, "no such test route");
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const parts = url.pathname.split("/").filter(Boolean);
    const page = url.hostname === "snyvi.page";
    const origin = "https://snyvi.page";
    if (url.pathname === "/health") return json(200, { ok: true });
    if (req.method === "GET" || req.method === "HEAD") {
      if (parts[0] === "files" && parts.length === 2 && fileOk(parts[1])) {
        const svg: Record<string, string> = parts[1].endsWith(".svg") ? { "content-security-policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'" } : {};
        return fromBucket(req, env, ctx, `files/${parts[1]}`, 31536000, svg);
      }
      if (!page && url.pathname === "/wall.json") return fromBucket(req, env, ctx, "wall.json", 60);
      if (!page && parts[0] === "pages" && parts[2] === "page.json" && SLUG_RE.test(parts[1] ?? "")) return fromBucket(req, env, ctx, `pages/${parts[1]}/page.json`, 300);
      // snyvi.page/<slug>, and /p/<slug> on any host (the tests, workers.dev).
      const slug = page ? parts[0] : parts[0] === "p" ? parts[1] : undefined;
      if (slug && SLUG_RE.test(slug) && parts.length === (page ? 1 : 2)) return fromBucket(req, env, ctx, `pages/${slug}/index.html`, 300, { "content-security-policy": CSP, "referrer-policy": "no-referrer" });
      if (page && parts.length === 0) return Response.redirect("https://snyvi.com/", 302);
      return no(404, "not here");
    }
    if (!(await under(env.LIMIT_FLOOD, req.headers.get("cf-connecting-ip") ?? "local"))) return no(429, "slow down");
    await ready(env);
    if (env.WALL_TEST && parts[0] === "_test") return testRoute(req, env, parts);
    if (parts[0] === "_op" && parts[1] === "hide" && req.method === "POST" && SLUG_RE.test(parts[2] ?? "")) {
      if (!env.WALL_OPERATOR || req.headers.get("x-wall-operator") !== env.WALL_OPERATOR) return no(401, "the operator's token");
      await env.DB.prepare("UPDATE pages SET hidden = 1 WHERE slug = ?").bind(parts[2]).run();
      await render(env, origin, parts[2]);
      return json(200, { hidden: parts[2] });
    }
    if (!page && parts[0] === "pages" && parts.length >= 2) return write(req, env, origin, parts, url.pathname);
    return no(404, "not here");
  },

  async scheduled(_ev: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(ready(env).then(() => daily(env)));
  },
};
