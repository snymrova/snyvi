/* Minisign, the two operations a test needs and nothing else: a key pair,
 * and a signature over a file, in the format `minisign -V` and the
 * `minisign-verify` crate read. So a bench can publish a signed manifest
 * without the minisign binary being on the machine, and never with the
 * release key -- every key made here is thrown away with the process.
 *
 * The format: a public key file is a comment line and base64 of
 * `"Ed" + key id (8 bytes) + Ed25519 public key (32)`. A signature file is a
 * comment line, base64 of `"ED" + key id + signature (64)`, a trusted comment
 * line, and base64 of a second signature over `signature + trusted comment`.
 * `ED` (not `Ed`) says the first signature is over BLAKE2b-512 of the file
 * rather than the file, which is what every minisign since 0.8 writes.
 */

import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";

/** A fresh key pair: `pub` is the text of a `.pub` file, `b64` its one
 *  base64 line (what `SNYVI_UPDATE_KEY` takes). */
export function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  const id = randomBytes(8);
  const b64 = Buffer.concat([Buffer.from("Ed"), id, raw]).toString("base64");
  const idHex = Buffer.from(id).reverse().toString("hex").toUpperCase();
  return { id, privateKey, b64, pub: `untrusted comment: minisign public key ${idHex}\n${b64}\n` };
}

/** The `.minisig` text for `message` (a Buffer or string). */
export function signFile(key, message, trusted = "") {
  const hashed = createHash("blake2b512").update(message).digest();
  const sig = sign(null, hashed, key.privateKey);
  const global = sign(null, Buffer.concat([sig, Buffer.from(trusted)]), key.privateKey);
  return `untrusted comment: signature from minisign secret key\n${Buffer.concat([Buffer.from("ED"), key.id, sig]).toString("base64")}\ntrusted comment: ${trusted}\n${global.toString("base64")}\n`;
}

export const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
