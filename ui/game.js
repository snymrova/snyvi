/* The rocket at the foot of the sidebar: snyvi in a helmet, in a small ship,
 * and rocks coming down. A chunk, like the desk view and the diagram
 * driver -- fetched the first time the rocket is pressed and never before,
 * so a reader who never presses it pays nothing for it.
 *
 * It covers the sidebar and only the sidebar. The page beside it is not
 * touched: a document that arrives mid-run opens the way it always does, and
 * the run goes on. Nothing here moves while the cover is down, and the cover
 * is only ever up because someone pressed the rocket.
 *
 * Keys are taken only while the cover is up, and only the ones the ship
 * uses -- the arrows or WASD, and space -- and everything else passes
 * through, so `?` still opens the shortcuts and `\` still folds the sidebar
 * (which pauses the run, since there is nothing to see it by). WASD are
 * keys the page reads too (`w` is the width, `s` the split), and taking them
 * is the one liberty the cover allows itself: whoever put it up is flying,
 * not reading. There is no pause key; the run pauses when the window loses
 * focus, and a press carries it on. A dialog
 * over the page makes the sidebar inert, and the run pauses for that too
 * rather than reading keys meant for a palette.
 *
 * The rocks get faster and more frequent as the run goes on: every twenty
 * seconds is a level, and each level trims the gap between rocks and adds to
 * their speed. Big rocks split into two middling ones, those into two small
 * ones, and the small ones are worth the most because they are the hardest
 * to hit. Three ships; the best score is kept beside the other settings, so
 * a reset forgets it with the rest.
 */

const KEY_BEST = "snyvi.best";
const LEVEL_EVERY = 20;     // seconds per level
const FIRE_GAP = 0.16;      // seconds between shots
const SHIP_SPEED = 270;     // px/s at full tilt, sideways
const SHIP_CLIMB = 200;     // px/s forward and back
const BULLET_SPEED = 520;
const SHIPS = 3;

/* Three sizes of rock: the radius in px, what one is worth, and the size it
 * breaks into. A small one breaks into nothing. */
const TIERS = { 3: { r: 22, pts: 20, next: 2 }, 2: { r: 14, pts: 50, next: 1 }, 1: { r: 8, pts: 100, next: 0 } };

const KEYS_LEFT = new Set(["ArrowLeft", "a", "A"]);
const KEYS_RIGHT = new Set(["ArrowRight", "d", "D"]);
const KEYS_UP = new Set(["ArrowUp", "w", "W"]);
const KEYS_DOWN = new Set(["ArrowDown", "s", "S"]);
const KEYS_FIRE = new Set([" "]);

const store = {
  get: k => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};
const fmt = n => n.toLocaleString("en-US");
const rnd = (a, b) => a + Math.random() * (b - a);

let run = null;

/** Put the cover up over `host` (the sidebar) and start listening. A second
 *  call while it is up only gives the sky focus back. `opts.onClose` is told
 *  when the cover comes down, and `opts.back` is where focus goes then. */
export function open(host, opts = {}) {
  if (run) { run.canvas.focus(); return run; }
  run = new Game(host, opts);
  return run;
}
/** Take the cover down, if it is up. */
export function close() { if (run) run.end(); }
export function isOpen() { return !!run; }

class Game {
  constructor(host, opts) {
    this.host = host;
    this.opts = opts;
    this.el = document.createElement("div");
    this.el.className = "game";
    this.el.setAttribute("role", "region");
    this.el.setAttribute("aria-label", "Asteroids");
    this.el.innerHTML =
      `<div class="game-head"><span class="game-title">Asteroids</span><span class="game-score">0</span>` +
      `<button class="icon game-close" type="button" aria-label="Close (Esc)" title="Close (Esc)">✕</button></div>` +
      `<canvas class="game-sky" tabindex="0" aria-label="The sky. Arrows steer, space fires."></canvas>` +
      `<div class="game-foot"><span class="game-hint">arrows steer · space fires · esc leaves</span><span class="game-best"></span></div>`;
    host.appendChild(this.el);
    this.canvas = this.el.querySelector(".game-sky");
    this.scoreEl = this.el.querySelector(".game-score");
    this.bestEl = this.el.querySelector(".game-best");
    this.ctx = this.canvas.getContext("2d");
    this.best = Number(store.get(KEY_BEST)) || 0;
    this.paintBest();

    this.w = 0; this.h = 0; this.dpr = 1;
    this.held = new Set();
    this.pointerX = null; this.pointerY = null;
    this.palette = null;
    this.paletteAt = -1e9;
    this.reset("ready");

    this.onKey = this.onKey.bind(this);
    this.onKeyUp = this.onKeyUp.bind(this);
    this.onBlur = this.onBlur.bind(this);
    this.onPointer = this.onPointer.bind(this);
    this.frame = this.frame.bind(this);
    document.addEventListener("keydown", this.onKey, true);
    document.addEventListener("keyup", this.onKeyUp, true);
    addEventListener("blur", this.onBlur);
    document.addEventListener("visibilitychange", this.onBlur);
    this.canvas.addEventListener("pointermove", this.onPointer);
    this.canvas.addEventListener("pointerdown", this.onPointer);
    this.canvas.addEventListener("pointerleave", () => { this.pointerX = this.pointerY = null; });
    this.el.querySelector(".game-close").addEventListener("click", () => this.end());

    // The sky is the size the sidebar gives it, at the screen's density. A
    // folded sidebar reports nothing, and nothing is a pause: there is no one
    // to see the rocks by.
    this.ro = new ResizeObserver(() => this.fit());
    this.ro.observe(this.canvas);
    this.fit();
    this.canvas.focus({ preventScroll: true });
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  fit() {
    const r = this.canvas.getBoundingClientRect();
    const w = Math.round(r.width), h = Math.round(r.height);
    if (!w || !h) { if (this.state === "play") this.state = "paused"; return; }
    this.dpr = Math.min(devicePixelRatio || 1, 2);
    if (w !== this.w || h !== this.h) {
      this.w = w; this.h = h;
      this.canvas.width = Math.round(w * this.dpr);
      this.canvas.height = Math.round(h * this.dpr);
      this.ship.x = Math.min(Math.max(this.ship.x, 22), w - 22);
      this.ship.y = Math.min(Math.max(this.ship.y, this.ceiling()), h - 40);
      this.stars = Array.from({ length: Math.round(w * h / 2600) }, () => ({ x: rnd(0, w), y: rnd(0, h), s: rnd(0.6, 1.6), p: rnd(0, 6.3) }));
    }
  }

  /** A fresh sky and a fresh ship. `state` is what to wait in: "ready" before
   *  the first launch, "play" straight away. */
  reset(state) {
    this.state = state;
    this.t = 0; this.level = 1; this.levelAt = 0;
    this.score = 0; this.ships = SHIPS;
    this.ship = { x: this.w / 2 || 132, y: (this.h || 600) - 40, vx: 0, vy: 0, safe: 0, flame: 0 };
    this.bullets = []; this.rocks = []; this.bits = [];
    this.spawnIn = 0.8; this.fireIn = 0;
    this.stars ||= [];
    this.paintScore();
  }

  // ---------- input ----------
  onKey(e) {
    // A dialog over the page has made the sidebar inert; the keys are its.
    if (this.el.closest("[inert]")) { this.held.clear(); if (this.state === "play") this.state = "paused"; return; }
    const tag = e.target.tagName;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag) || e.target.isContentEditable) return;
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); this.end(); return; }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key;
    if (KEYS_LEFT.has(k)) this.held.add("L");
    else if (KEYS_RIGHT.has(k)) this.held.add("R");
    else if (KEYS_UP.has(k)) this.held.add("U");
    else if (KEYS_DOWN.has(k)) this.held.add("D");
    else if (KEYS_FIRE.has(k)) { this.held.add("F"); if (this.state !== "play") this.launch(); }
    else return;
    e.preventDefault();
    e.stopPropagation();
    if (this.state === "paused") this.state = "play";
  }
  onKeyUp(e) {
    const k = e.key;
    if (KEYS_LEFT.has(k)) this.held.delete("L");
    else if (KEYS_RIGHT.has(k)) this.held.delete("R");
    else if (KEYS_UP.has(k)) this.held.delete("U");
    else if (KEYS_DOWN.has(k)) this.held.delete("D");
    else if (KEYS_FIRE.has(k)) this.held.delete("F");
  }
  onBlur() {
    if (document.visibilityState === "hidden" || !document.hasFocus()) {
      this.held.clear();
      if (this.state === "play") this.state = "paused";
    }
  }
  /** A pointer is the other way to steer: the ship goes to where it is, and a
   *  press fires -- or launches, if there is nothing to fire at yet. */
  onPointer(e) {
    const r = this.canvas.getBoundingClientRect();
    this.pointerX = e.clientX - r.left;
    this.pointerY = e.clientY - r.top;
    if (e.type === "pointerdown") {
      this.canvas.focus({ preventScroll: true });
      if (this.state === "play") this.fire();
      else if (this.state === "paused") this.state = "play";
      else this.launch();
    }
  }
  launch() {
    if (this.state === "over" || this.state === "ready") this.reset("play");
    else this.state = "play";
  }

  // ---------- the run ----------
  frame(now) {
    this.raf = requestAnimationFrame(this.frame);
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    if (!this.w) return;
    if (this.state === "play") this.step(dt);
    this.draw(now);
  }

  step(dt) {
    this.t += dt;
    const level = 1 + Math.floor(this.t / LEVEL_EVERY);
    if (level !== this.level) { this.level = level; this.levelAt = this.t; }

    // The ship: keys push it, a pointer pulls it, and it eases either way so
    // it never snaps. Forward is up the sky, as far as the ceiling, and back
    // is the foot of it; there is no reversing out of the sky's bottom edge.
    const s = this.ship;
    let want = 0, climb = 0;
    if (this.held.has("L")) want -= 1;
    if (this.held.has("R")) want += 1;
    if (this.held.has("U")) climb -= 1;
    if (this.held.has("D")) climb += 1;
    if (!want && !climb && this.pointerX != null) {
      const dx = this.pointerX - s.x, dy = this.pointerY - s.y;
      want = Math.abs(dx) < 3 ? 0 : Math.max(-1, Math.min(1, dx / 40));
      climb = Math.abs(dy) < 3 ? 0 : Math.max(-1, Math.min(1, dy / 40));
    }
    s.vx += (want * SHIP_SPEED - s.vx) * Math.min(1, dt * 12);
    s.vy += (climb * SHIP_CLIMB - s.vy) * Math.min(1, dt * 10);
    s.x = Math.min(Math.max(s.x + s.vx * dt, 22), this.w - 22);
    s.y = Math.min(Math.max(s.y + s.vy * dt, this.ceiling()), this.h - 40);
    s.safe = Math.max(0, s.safe - dt);
    s.flame = Math.max(0, s.flame - dt);
    this.fireIn -= dt;
    if (this.held.has("F")) this.fire();

    for (const b of this.bullets) b.y -= BULLET_SPEED * dt;
    this.bullets = this.bullets.filter(b => b.y > -10);

    // Rocks: fewer seconds between them and more speed in them per level.
    this.spawnIn -= dt;
    if (this.spawnIn <= 0) {
      this.spawnIn = Math.max(0.3, 1.5 * Math.pow(0.86, this.level - 1)) * rnd(0.7, 1.3);
      const tier = Math.random() < 0.55 ? 3 : Math.random() < 0.6 ? 2 : 1;
      this.addRock(rnd(20, this.w - 20), -TIERS[tier].r - 4, tier, rnd(-30, 30), 50 + 14 * (this.level - 1));
    }
    for (const r of this.rocks) {
      r.x += r.vx * dt; r.y += r.vy * dt; r.rot += r.spin * dt;
      if (r.x < -r.r) r.x = this.w + r.r; else if (r.x > this.w + r.r) r.x = -r.r;
    }
    this.rocks = this.rocks.filter(r => r.y < this.h + r.r + 4);

    // A bullet in a rock breaks it; the ship in a rock costs a ship.
    for (const b of this.bullets) {
      for (const r of this.rocks) {
        if (r.dead) continue;
        const dx = r.x - b.x, dy = r.y - b.y;
        if (dx * dx + dy * dy < r.r * r.r) { r.dead = true; b.dead = true; this.breakRock(r); break; }
      }
    }
    this.bullets = this.bullets.filter(b => !b.dead);
    this.rocks = this.rocks.filter(r => !r.dead);
    if (s.safe <= 0) {
      for (const r of this.rocks) {
        const dx = r.x - s.x, dy = r.y - s.y, hit = r.r + 12;
        if (dx * dx + dy * dy < hit * hit) { this.hitShip(); break; }
      }
    }

    for (const p of this.bits) { p.x += p.vx * dt; p.y += p.vy * dt; p.life -= dt; }
    this.bits = this.bits.filter(p => p.life > 0);
  }

  /** How far forward the ship may fly: the top third is the rocks' own, so a
   *  ship that presses forward still has something coming at it. */
  ceiling() { return Math.max(60, this.h * 0.36); }

  fire() {
    if (this.fireIn > 0) return;
    this.fireIn = FIRE_GAP;
    this.bullets.push({ x: this.ship.x, y: this.ship.y - 30 });
    this.ship.flame = 0.12;
  }

  addRock(x, y, tier, vx, vy) {
    const n = 8 + Math.floor(rnd(0, 4));
    this.rocks.push({
      x, y, vx, vy, tier, r: TIERS[tier].r,
      rot: rnd(0, 6.3), spin: rnd(-1.2, 1.2),
      shape: Array.from({ length: n }, () => rnd(0.72, 1.08)),
      craters: tier === 1 ? [] : Array.from({ length: tier - 1 }, () => ({ a: rnd(0, 6.3), d: rnd(0.15, 0.5), r: rnd(0.12, 0.22) })),
    });
  }

  breakRock(r) {
    const t = TIERS[r.tier];
    this.score += t.pts;
    this.paintScore();
    this.burst(r.x, r.y, r.tier * 3 + 2, 60 + r.tier * 20);
    if (t.next) for (let i = 0; i < 2; i++) {
      this.addRock(r.x, r.y, t.next, r.vx + rnd(-60, 60) * (i ? 1 : -1), Math.abs(r.vy) * rnd(0.9, 1.3) + 20);
    }
  }

  hitShip() {
    this.ships -= 1;
    this.burst(this.ship.x, this.ship.y, 14, 140, "ship");
    this.ship.safe = 2.2;
    this.held.delete("F");
    if (this.ships <= 0) {
      this.state = "over";
      if (this.score > this.best) { this.best = this.score; store.set(KEY_BEST, String(this.best)); this.paintBest(); }
    }
  }

  burst(x, y, n, speed, kind) {
    for (let i = 0; i < n; i++) {
      const a = rnd(0, 6.3), v = rnd(0.3, 1) * speed;
      this.bits.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: rnd(0.3, 0.8), kind });
    }
  }

  paintScore() { this.scoreEl.textContent = fmt(this.score); }
  paintBest() { this.bestEl.textContent = this.best ? `best ${fmt(this.best)}` : ""; }

  // ---------- drawing ----------
  /** The colours are the page's: read off the sidebar, so a theme or accent
   *  change repaints the sky with everything else. Read every half second
   *  rather than every frame -- a computed style is not free. */
  colours(now) {
    if (this.palette && now - this.paletteAt < 500) return this.palette;
    const cs = getComputedStyle(this.host);
    const v = n => cs.getPropertyValue(n).trim();
    this.paletteAt = now;
    return this.palette = {
      bg: v("--bg-side"), fg: v("--fg"), fg2: v("--fg-2"), fg3: v("--fg-3"), rule: v("--rule"), rule2: v("--rule-2"),
      raise: v("--bg-raise"), accent: v("--accent"),
      mascot: v("--mascot"), nub: v("--mascot-nub"), ink: v("--mascot-ink"),
    };
  }

  draw(now) {
    const c = this.ctx, w = this.w, h = this.h, p = this.colours(now);
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.fillStyle = p.bg;
    c.fillRect(0, 0, w, h);

    // Stars, drifting down a little so the ship reads as flying.
    const drift = this.state === "play" ? this.t * 12 : 0;
    c.fillStyle = p.fg3;
    for (const s of this.stars) {
      const y = (s.y + drift * s.s) % h;
      c.globalAlpha = 0.25 + 0.25 * Math.sin(now / 900 + s.p);
      c.fillRect(s.x, y, s.s, s.s);
    }
    c.globalAlpha = 1;

    for (const r of this.rocks) this.drawRock(r, p);

    c.strokeStyle = p.accent; c.lineWidth = 2; c.lineCap = "round";
    for (const b of this.bullets) { c.beginPath(); c.moveTo(b.x, b.y); c.lineTo(b.x, b.y + 7); c.stroke(); }

    for (const b of this.bits) {
      c.globalAlpha = Math.min(1, b.life * 2);
      c.fillStyle = b.kind === "ship" ? p.accent : p.fg2;
      c.fillRect(b.x - 1, b.y - 1, 2, 2);
    }
    c.globalAlpha = 1;

    if (this.state !== "over") this.drawShip(this.ship.x, this.ship.y, p, now);

    // The ships left, top left; the level, top right.
    for (let i = 0; i < this.ships; i++) this.drawShipMark(14 + i * 16, 14, p);
    c.fillStyle = p.fg3; c.font = "500 10px ui-monospace, monospace"; c.textAlign = "right"; c.textBaseline = "top";
    c.fillText(`L${this.level}`, w - 10, 8);

    // A word in the middle when there is one to say.
    const say = (a, b) => {
      c.textAlign = "center"; c.textBaseline = "middle";
      c.fillStyle = p.fg; c.font = "600 14px system-ui, sans-serif";
      c.fillText(a, w / 2, h / 2 - 10);
      if (b) { c.fillStyle = p.fg3; c.font = "500 11px system-ui, sans-serif"; c.fillText(b, w / 2, h / 2 + 10); }
    };
    if (this.state === "ready") say("Press space to fly", "or tap the sky");
    else if (this.state === "paused") say("Paused", "space carries on");
    else if (this.state === "over") say(`Out of ships · ${fmt(this.score)}`, this.score >= this.best && this.score ? "a new best · space to fly again" : "space to fly again");
    else if (this.t - this.levelAt < 1.6 && this.level > 1) {
      c.globalAlpha = Math.min(1, (1.6 - (this.t - this.levelAt)) * 2);
      say(`Level ${this.level}`);
      c.globalAlpha = 1;
    }
  }

  drawRock(r, p) {
    const c = this.ctx;
    c.save();
    c.translate(r.x, r.y);
    c.rotate(r.rot);
    c.beginPath();
    const n = r.shape.length;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2, d = r.r * r.shape[i];
      i ? c.lineTo(Math.cos(a) * d, Math.sin(a) * d) : c.moveTo(Math.cos(a) * d, Math.sin(a) * d);
    }
    c.closePath();
    c.fillStyle = p.rule; c.fill();
    c.strokeStyle = p.fg2; c.lineWidth = 1.4; c.lineJoin = "round"; c.stroke();
    c.fillStyle = p.fg2; c.globalAlpha = 0.22;
    for (const k of r.craters) { c.beginPath(); c.arc(Math.cos(k.a) * r.r * k.d, Math.sin(k.a) * r.r * k.d, r.r * k.r, 0, Math.PI * 2); c.fill(); }
    c.globalAlpha = 1;
    c.restore();
  }

  /** The ship: a rocket with a coloured nose, swept wings, a nozzle and a
   *  two-tone flame that lengthens under thrust -- and snyvi in the cockpit,
   *  behind a glass dome, the same face as the mark in the sidebar's head,
   *  clipped to the dome so it sits in the helmet rather than on it. */
  drawShip(x, y, p, now) {
    const c = this.ctx, s = this.ship;
    if (s.safe > 0 && Math.floor(now / 90) % 2) return;   // a fresh ship blinks
    c.save();
    c.translate(x, y);
    c.rotate(s.vx / SHIP_SPEED * 0.2);
    c.lineJoin = "round"; c.lineCap = "round";

    // The flame: longer for a burst of thrust or for pressing forward, and a
    // little uneasy at every length. Outer in the accent, a paler core, and
    // a soft glow under both.
    const thrust = (s.flame > 0 ? 1 : 0) + Math.max(0, -s.vy / SHIP_CLIMB);
    const f = 9 + thrust * 7 + Math.sin(now / 38) * 1.6;
    const glow = c.createRadialGradient(0, 22, 0, 0, 22, f + 8);
    glow.addColorStop(0, p.accent); glow.addColorStop(1, "transparent");
    c.globalAlpha = 0.28; c.fillStyle = glow; c.fillRect(-f - 8, 14, 2 * f + 16, f + 16); c.globalAlpha = 1;
    c.fillStyle = p.accent;
    c.beginPath(); c.moveTo(-5.5, 21); c.quadraticCurveTo(0, 21 + f * 1.4, 5.5, 21); c.closePath(); c.fill();
    c.fillStyle = p.raise; c.globalAlpha = 0.85;
    c.beginPath(); c.moveTo(-2.5, 21); c.quadraticCurveTo(0, 21 + f * 0.8, 2.5, 21); c.closePath(); c.fill();
    c.globalAlpha = 1;

    // Wings, swept back, drawn first so the fuselage sits over their roots;
    // and two small stabilisers at the tail.
    c.fillStyle = p.rule; c.strokeStyle = p.fg2; c.lineWidth = 1.5;
    for (const m of [1, -1]) {
      c.beginPath(); c.moveTo(m * 9, 0); c.lineTo(m * 23, 19); c.lineTo(m * 23, 24); c.lineTo(m * 9, 17); c.closePath();
      c.fill(); c.stroke();
      c.beginPath(); c.moveTo(m * 8, 13); c.lineTo(m * 13, 23); c.lineTo(m * 7, 21); c.closePath();
      c.fill(); c.stroke();
    }
    // The nozzle, dark, under the tail.
    c.fillStyle = p.fg2; c.globalAlpha = 0.7;
    roundRect(c, -6, 17, 12, 5, 1.5); c.fill(); c.globalAlpha = 1;

    // The fuselage.
    c.beginPath();
    c.moveTo(0, -31);
    c.bezierCurveTo(7, -25, 10, -13, 10, -2);
    c.lineTo(10, 15);
    c.quadraticCurveTo(0, 20, -10, 15);
    c.lineTo(-10, -2);
    c.bezierCurveTo(-10, -13, -7, -25, 0, -31);
    c.closePath();
    c.fillStyle = p.raise; c.fill();
    c.strokeStyle = p.fg2; c.lineWidth = 1.5; c.stroke();
    // A darker flank down one side, so the hull reads as round.
    c.save(); c.clip();
    c.fillStyle = p.fg2; c.globalAlpha = 0.09;
    c.fillRect(3, -31, 8, 50);
    c.globalAlpha = 1;
    // The nose cone and a band above the tail, both in the accent.
    c.fillStyle = p.accent;
    c.beginPath(); c.moveTo(0, -31); c.bezierCurveTo(5, -27, 7.5, -22, 8.3, -17); c.lineTo(-8.3, -17); c.bezierCurveTo(-7.5, -22, -5, -27, 0, -31); c.closePath(); c.fill();
    c.globalAlpha = 0.75; c.fillRect(-10, 9, 20, 3); c.globalAlpha = 1;
    c.restore();

    // The helmet: a collar ring, the glass, and snyvi inside it.
    const hy = -5, hr = 10.5;
    c.beginPath(); c.arc(0, hy, hr + 1.5, 0, Math.PI * 2);
    c.fillStyle = p.fg2; c.globalAlpha = 0.9; c.fill(); c.globalAlpha = 1;
    c.beginPath(); c.arc(0, hy, hr, 0, Math.PI * 2);
    c.fillStyle = p.bg; c.fill();
    c.save();
    c.clip();
    // The face, 32 units drawn at 0.6 and centred in the dome; its lower
    // corners fall outside the glass and are clipped, which is what makes it
    // sit in the helmet rather than float over it.
    c.translate(-16 * 0.6, hy - 16 * 0.6 - 1); c.scale(0.6, 0.6);
    c.fillStyle = p.nub; roundRect(c, 14, 0.5, 4, 5, 2); c.fill();
    c.fillStyle = p.mascot; roundRect(c, 1, 4, 30, 27, 9); c.fill();
    c.fillStyle = p.ink;
    c.beginPath(); c.ellipse(11, 16.5, 2.6, 3.3, 0, 0, Math.PI * 2); c.fill();
    c.beginPath(); c.ellipse(21, 16.5, 2.6, 3.3, 0, 0, Math.PI * 2); c.fill();
    c.strokeStyle = p.ink; c.lineWidth = 2.2;
    c.beginPath(); c.moveTo(13.5, 23); c.quadraticCurveTo(16, 25.2, 18.5, 23); c.stroke();
    c.restore();
    // Glass over the face: a faint tint, a rim, and a highlight up and left.
    const glass = c.createRadialGradient(-3, hy - 4, 1, 0, hy, hr);
    glass.addColorStop(0, "rgba(255,255,255,.28)"); glass.addColorStop(0.6, "rgba(255,255,255,.04)"); glass.addColorStop(1, "rgba(0,0,0,.10)");
    c.beginPath(); c.arc(0, hy, hr, 0, Math.PI * 2); c.fillStyle = glass; c.fill();
    c.strokeStyle = p.fg2; c.lineWidth = 1.4; c.stroke();
    c.beginPath(); c.arc(0, hy, hr - 2.8, -2.55, -1.45);
    c.strokeStyle = p.raise; c.lineWidth = 1.8; c.globalAlpha = 0.95; c.stroke();
    c.beginPath(); c.arc(-1.5, hy - 6.6, 0.9, 0, Math.PI * 2); c.fillStyle = p.raise; c.fill();
    c.globalAlpha = 1;
    c.restore();
  }

  drawShipMark(x, y, p) {
    const c = this.ctx;
    c.save(); c.translate(x, y);
    c.beginPath(); c.moveTo(0, -6); c.lineTo(4.5, 5); c.lineTo(0, 3); c.lineTo(-4.5, 5); c.closePath();
    c.fillStyle = p.fg3; c.fill();
    c.restore();
  }

  end() {
    if (run !== this) return;
    run = null;
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    document.removeEventListener("keydown", this.onKey, true);
    document.removeEventListener("keyup", this.onKeyUp, true);
    removeEventListener("blur", this.onBlur);
    document.removeEventListener("visibilitychange", this.onBlur);
    if (this.score > this.best) { this.best = this.score; store.set(KEY_BEST, String(this.best)); }
    this.el.remove();
    this.opts.onClose?.();
    const back = this.opts.back;
    if (back?.isConnected) back.focus({ preventScroll: true });
  }
}

function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}
