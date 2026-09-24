/** The webhook receiver: verify, deduplicate, enqueue. Nothing here talks to
 *  the database — a handler that writes is a handler that times out under a
 *  replay storm, and providers replay far more than they admit. */

import { createHmac, timingSafeEqual } from "node:crypto";
import { queue } from "./queue";
import type { Provider, Event } from "./types";

const TOLERANCE_S = 300;

export class BadSignature extends Error {}
export class TooOld extends Error {}

/** Constant time, and over the raw body: a re-serialised object is a
 *  different string and every provider signs the bytes they sent. */
export function verify(raw: Buffer, header: string, secret: string): void {
  const [ts, sig] = parse(header);
  if (Math.abs(Date.now() / 1000 - ts) > TOLERANCE_S) throw new TooOld();
  const want = createHmac("sha256", secret).update(`${ts}.`).update(raw).digest();
  const got = Buffer.from(sig, "hex");
  if (want.length !== got.length || !timingSafeEqual(want, got)) throw new BadSignature();
}

function parse(header: string): [number, string] {
  const parts = Object.fromEntries(header.split(",").map(p => p.split("=") as [string, string]));
  if (!parts.t || !parts.v1) throw new BadSignature();
  return [Number(parts.t), parts.v1];
}

/** Providers retry, and two deliveries of the same event are the same event.
 *  The id is the provider's, so dedup survives our own restarts. */
export async function receive(p: Provider, raw: Buffer, header: string): Promise<Event | null> {
  verify(raw, header, p.secret);
  const event = JSON.parse(raw.toString()) as Event;
  if (await queue.seen(p.name, event.id)) return null;
  await queue.push(p.name, event);
  return event;
}
