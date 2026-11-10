/*
 * The wall's half of a snyvi frame (src/peer.rs `seal`, `open`): the one
 * piece of cryptography here, checked byte for byte against the daemon's
 * own by the vectors `cargo test` writes (test/vectors.json).
 *
 * A frame: version 1, the sender's Ed25519 public key (32), a nonce (24),
 * XChaCha20-Poly1305 over `pack(content, body)` with the first 33 bytes as
 * associated data, then an Ed25519 signature over everything before it.
 * The box key is blake3's derive_key("snyvi peer v1 box", X25519 shared
 * secret ‖ sender's box public ‖ receiver's box public).
 *
 * The wall's keys are one 64-byte seed, as a daemon's are
 * (`Identity::from_seed`): the first half signs, the second is the box.
 */

import { ed25519, x25519 } from "@noble/curves/ed25519";
import { blake3 } from "@noble/hashes/blake3";
import { xchacha20poly1305 } from "@noble/ciphers/chacha";

export const VERSION = 1;

export interface Keys {
  sign: Uint8Array;     // the seed's first half
  signPub: Uint8Array;
  box: Uint8Array;      // the seed's second half
  boxPub: Uint8Array;
}

export function keysOf(seed: Uint8Array): Keys {
  if (seed.length !== 64) throw new Error("a seed is 64 bytes");
  const sign = seed.slice(0, 32), box = seed.slice(32);
  return { sign, signPub: ed25519.getPublicKey(sign), box, boxPub: x25519.getPublicKey(box) };
}

/** The relay's spelling of a key: base64url, unpadded. */
export function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function unb64(s: string): Uint8Array | null {
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

const enc = new TextEncoder();

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** The content as JSON, its length before it (u32, little-endian), then the body. */
function pack(contentJson: string, body: Uint8Array): Uint8Array {
  const meta = enc.encode(contentJson);
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, meta.length, true);
  return concat(len, meta, body);
}

/** Seal `contentJson` from `me` to the daemon with these public keys. The
 *  JSON is written by the caller, in the order serde writes the Rust enum. */
export function seal(me: Keys, toBoxPub: Uint8Array, contentJson: string, body: Uint8Array, nonce: Uint8Array): Uint8Array {
  if (nonce.length !== 24) throw new Error("a nonce is 24 bytes");
  const shared = x25519.getSharedSecret(me.box, toBoxPub);
  const key = blake3(concat(shared, me.boxPub, toBoxPub), { context: "snyvi peer v1 box" });
  const head = concat(new Uint8Array([VERSION]), me.signPub, nonce);
  const ct = xchacha20poly1305(key, nonce, head.slice(0, 33)).encrypt(pack(contentJson, body));
  const signed = concat(head, ct);
  return concat(signed, ed25519.sign(signed, me.sign));
}

/** The relay's signature on a deposit (src/peer.rs `relay_auth`). */
export function relayAuth(me: Keys, method: string, path: string, secs: number): string {
  const sig = ed25519.sign(enc.encode(`snyvi-relay-v1\n${method}\n${path}\n${secs}`), me.sign);
  return `${secs}.${b64(sig)}`;
}

/** The message a daemon signs on a write to the wall (src/wall.rs `auth_message`). */
export function authMessage(method: string, path: string, secs: number, body: Uint8Array): string {
  return `snyvi-wall-v1\n${method}\n${path}\n${secs}\n${hex(blake3(body))}`;
}

export function hex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/** A daemon's signature, checked against its address. */
export function verify(address: string, message: string, sigB64: string): boolean {
  const pub = unb64(address), sig = unb64(sigB64);
  if (!pub || pub.length !== 32 || !sig || sig.length !== 64) return false;
  try {
    return ed25519.verify(sig, enc.encode(message), pub, { zip215: false });
  } catch {
    return false;
  }
}

export function blake3hex16(bytes: Uint8Array): string {
  return hex(blake3(bytes)).slice(0, 16);
}

/** `Content::Wall` as serde writes it: field order is the enum's. */
/** The daily line's content, as the daemon reads it (src/peer.rs,
 *  `Content::Wall`): v6 adds the follows, the new followers' names and the
 *  week's reads, which a daemon from before leaves unread. */
export interface WallLine { slug: string; hearts: number; names: string[]; since: number; reported: number; follows: number; followers: string[]; reads: number }
export function wallLine(l: WallLine): string {
  return JSON.stringify({ kind: "wall", ...l, v: 6 });
}
