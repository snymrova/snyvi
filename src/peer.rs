//! A friend's snyvi: two daemons that have met once and can hand each other
//! a document after. Everything cryptographic is here; the routes are in
//! `server::api_peer`, the relay is `relay/`, and `docs/PEER.md` writes the
//! whole of it down.
//!
//! The daemon has one identity: an Ed25519 signing key, whose public half is
//! its address at the relay, and an X25519 box key. Both secrets live in
//! `secrets::Secrets` under desk 0 as `SNYVI_PEER_KEY`, where a desk's key
//! values go (the keychain on macOS and Windows, a 0600 file on Linux), and
//! are minted the first time anyone pairs.
//!
//! Pairing: one side mints a code of three words the two say to each other.
//! Both run SPAKE2 over a relay room named by the code's hash, which gives
//! each a key the other has and nobody else can derive, then exchange their
//! public keys sealed under it. Each pins the other's keys as a row in
//! `peers`, and both show the same four emoji from the two keys, so a glance
//! says the room had no third party. A code is one use and ten minutes.
//!
//! A frame -- a document or a suggested note going one way -- is
//! `version ‖ sender's signing key ‖ nonce ‖ box(payload) ‖ signature`. The
//! box is XChaCha20-Poly1305 under a key derived from X25519 between the two
//! static box keys and both public keys; the signature is Ed25519 over
//! everything before it. A receiver finds the sender among its pinned keys
//! *before* it checks anything else: a frame from a key it has not met is
//! dropped unread, and the relay's listing says the sender, so it is not
//! even downloaded.
//!
//! The relay (`relay/src/index.ts`) sees two public keys, a size and a time.
//! `RELAY` is the one place its address is written; `SNYVI_RELAY` overrides
//! it for the tests and for anyone running their own copy. The daemon waits
//! on one WebSocket to its own mailbox (`server::peer_link`), down which the
//! relay pushes a frame the moment it lands; the pieces that link is made of
//! -- its address, its messages, its backoff, the table that keeps a frame
//! from being brought in twice -- are here with the HTTP client.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use chacha20poly1305::aead::{Aead, KeyInit, Payload as AeadPayload};
use chacha20poly1305::{Key, XChaCha20Poly1305, XNonce};
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

/// Where the two daemons meet. One constant, so the switch to another host
/// is one line; the environment variable is for tests and self-hosters.
pub const RELAY: &str = "https://relay.snyvi.com";

pub fn relay() -> String {
    std::env::var("SNYVI_RELAY")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.trim().trim_end_matches('/').to_string())
        .unwrap_or_else(|| RELAY.to_string())
}

/// The desk key the identity is kept under, for desk 0: not a desk's, the
/// daemon's own, and never handed to a panel's environment (`desk::keys`
/// lists names from the store, and this name is in no row there).
pub const KEY_NAME: &str = "SNYVI_PEER_KEY";

/// A code is spoken once and dies in ten minutes.
pub const CODE_TTL: i64 = 10 * 60;
/// How long one side waits for the other's hello once their SPAKE2 message
/// is in. A live other side sends it within seconds; one that cancelled, or
/// closed, never does, and this is how soon the joiner hears so.
pub const HELLO_WAIT: i64 = 90;
/// The frame version this daemon writes and the only one it reads.
const VERSION: u8 = 1;
/// What SPAKE2 binds the exchange to: the same on both sides, by design --
/// the two sides are symmetric, neither is the server.
const SPAKE_ID: &[u8] = b"snyvi peer v1";
const HELLO_AAD: &[u8] = b"snyvi hello v1";
/// A suggested note travelling: the same cap as a desk's line.
pub const NOTE_CHARS: usize = 200;
/// How long one HTTP call to the relay may take: an 8 MB frame fetched on
/// a slow line, with the round trip on top. Nothing waits at the relay any
/// more; the link does the waiting.
const HTTP_TIMEOUT: Duration = Duration::from_secs(40);
/// The most a document may be to go to a friend. The relay says the same
/// (`FRAME_MAX` there), and a Send of anything larger is refused before it
/// is queued. Under `receive::MAX_BYTES` on purpose: a frame is kept whole
/// in a Durable Object's memory while it is pushed, and a friend's mailbox
/// is twenty of them.
pub const SEND_MAX: usize = 8 * 1024 * 1024;
/// A frame is a document plus the header, nonce and signature around it.
pub const FRAME_MAX: usize = SEND_MAX + 4096;
/// Up to this, the relay sends a frame's bytes down the link right after
/// announcing it; past it, the daemon fetches them over HTTP.
pub const INLINE_MAX: usize = 128 * 1024;
/// The link says "ping" this often; the relay answers "pong" without waking.
pub const PING_EVERY: Duration = Duration::from_secs(45);
/// The longest the link waits between tries to reach the relay.
pub const BACKOFF_MAX: Duration = Duration::from_secs(300);
/// A frame's id is remembered this long after it was brought in: a day
/// past the relay's own seven, so nothing older can come again.
pub const TAKEN_KEPT: i64 = 8 * 24 * 60 * 60;

// ---- identity ----------------------------------------------------------------

/// The daemon's own keys, in memory for the life of the process once read.
#[derive(Clone)]
pub struct Identity {
    sign: SigningKey,
    boxk: x25519_dalek::StaticSecret,
}

impl std::fmt::Debug for Identity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Identity")
            .field("address", &self.address())
            .finish()
    }
}

impl Identity {
    /// Read from the secrets, or mint and keep one. Blocking: the keychain.
    pub fn load_or_mint(secrets: &crate::secrets::Secrets) -> Result<Identity> {
        if let Some(v) = secrets.value(0, KEY_NAME) {
            if let Some(id) = Identity::from_secret(&v) {
                return Ok(id);
            }
            bail!("the peer key kept as {KEY_NAME} is not one this snyvi can read; remove it to pair afresh");
        }
        let mut seed = [0u8; 64];
        getrandom::fill(&mut seed)
            .map_err(|e| anyhow!("reading random bytes for the peer key: {e}"))?;
        let id = Identity::from_seed(&seed);
        secrets
            .keep(0, KEY_NAME, &b64(&seed))
            .context("keeping the peer key")?;
        Ok(id)
    }

    /// Already there, or not: never mints. What the link asks, so a daemon
    /// that has never paired touches no keychain.
    pub fn load(secrets: &crate::secrets::Secrets) -> Option<Identity> {
        secrets
            .value(0, KEY_NAME)
            .and_then(|v| Identity::from_secret(&v))
    }

    fn from_secret(v: &str) -> Option<Identity> {
        let bytes = unb64(v.trim())?;
        (bytes.len() == 64).then(|| Identity::from_seed(bytes.as_slice().try_into().unwrap()))
    }

    pub fn from_seed(seed: &[u8; 64]) -> Identity {
        let mut s = [0u8; 32];
        s.copy_from_slice(&seed[..32]);
        let mut b = [0u8; 32];
        b.copy_from_slice(&seed[32..]);
        Identity {
            sign: SigningKey::from_bytes(&s),
            boxk: x25519_dalek::StaticSecret::from(b),
        }
    }

    /// The address: the signing key's public half, as the relay spells it.
    pub fn address(&self) -> String {
        b64(self.sign.verifying_key().as_bytes())
    }

    pub fn box_public(&self) -> [u8; 32] {
        x25519_dalek::PublicKey::from(&self.boxk).to_bytes()
    }

    /// The header the relay wants on a read of this daemon's own mailbox:
    /// the time, and a signature over the request.
    pub fn relay_auth(&self, method: &str, path: &str) -> String {
        let secs = crate::store::now();
        let msg = format!("snyvi-relay-v1\n{method}\n{path}\n{secs}");
        let sig = self.sign.sign(msg.as_bytes());
        format!("{secs}.{}", b64(&sig.to_bytes()))
    }

    /// The key the box between this daemon and `peer` is sealed under, in the
    /// direction `from_me` says. Both public keys are in the derivation, so a
    /// key is one pair's and one direction's.
    fn box_key(&self, peer_box: &[u8; 32], from_me: bool) -> [u8; 32] {
        let shared = self
            .boxk
            .diffie_hellman(&x25519_dalek::PublicKey::from(*peer_box));
        let mine = self.box_public();
        let (a, b) = if from_me {
            (&mine, peer_box)
        } else {
            (peer_box, &mine)
        };
        let mut material = Vec::with_capacity(96);
        material.extend_from_slice(shared.as_bytes());
        material.extend_from_slice(a);
        material.extend_from_slice(b);
        blake3::derive_key("snyvi peer v1 box", &material)
    }
}

// ---- the code ------------------------------------------------------------------

/// The EFF short list: 1,296 words, none over five letters, none a prefix
/// of another, chosen to be heard right over a bad line.
const WORDS: &str = include_str!("peer_words.txt");

fn words() -> Vec<&'static str> {
    WORDS
        .lines()
        .map(str::trim)
        .filter(|w| !w.is_empty())
        .collect()
}

/// The three letters that end a code: what catches a word heard wrong
/// before the relay is asked. No vowels, no l, no confusable pairs.
const CHECK: &[u8] = b"bcdfghjkmnpqrstvwxz";

fn check(words: &str) -> String {
    let h = blake3::hash(format!("snyvi code v1 {words}").as_bytes());
    h.as_bytes()[..3]
        .iter()
        .map(|b| CHECK[*b as usize % CHECK.len()] as char)
        .collect()
}

/// A fresh code: `ocean-ladder-fish-kpm`. A word with a `-` in it
/// (`yo-yo`) is never picked: said aloud it is two words, and a code
/// made before 1.29 with it still joins through `normalize_code`.
pub fn mint_code() -> Result<String> {
    let list: Vec<&str> = words().into_iter().filter(|w| !w.contains('-')).collect();
    let mut r = [0u8; 8];
    getrandom::fill(&mut r).map_err(|e| anyhow!("reading random bytes for the code: {e}"))?;
    let n = u64::from_le_bytes(r);
    // Sixteen bits a word over 1,295: the bias is one part in a thousand.
    let pick = |i: u32| list[((n >> (i * 16)) & 0xffff) as usize % list.len()];
    let w = format!("{}-{}-{}", pick(0), pick(1), pick(2));
    let c = check(&w);
    Ok(format!("{w}-{c}"))
}

/// A code as typed or pasted, made the code as minted, or why it is not one.
pub fn normalize_code(typed: &str) -> std::result::Result<String, &'static str> {
    let parts: Vec<String> = typed
        .trim()
        .to_lowercase()
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|p| !p.is_empty())
        .map(str::to_string)
        .collect();
    let list = words();
    // `yo yo` and `yo-yo` both split in two: join neighbours back into a
    // listed word that holds a `-` before counting them.
    let mut joined: Vec<String> = Vec::with_capacity(parts.len());
    for p in parts {
        let glue = joined
            .last()
            .is_some_and(|last| list.contains(&format!("{last}-{p}").as_str()));
        if let (true, Some(last)) = (glue, joined.last_mut()) {
            last.push('-');
            last.push_str(&p);
        } else {
            joined.push(p);
        }
    }
    let parts = joined;
    if parts.len() != 4 {
        return Err("a code is three words and three letters, like ocean-ladder-fish-kpm");
    }
    if !parts[..3].iter().all(|p| list.contains(&p.as_str())) {
        return Err("one of the words is not one a code is made of; ask for it again");
    }
    let w = parts[..3].join("-");
    if check(&w) != parts[3] {
        return Err("the last three letters do not match the words; one was heard wrong");
    }
    Ok(format!("{w}-{}", parts[3]))
}

/// The relay room a code names: nothing of the code is in it.
pub fn room_of(code: &str) -> String {
    blake3::hash(format!("snyvi room v1 {code}").as_bytes())
        .to_hex()
        .to_string()
}

// ---- the emoji ------------------------------------------------------------------

/// Sixty-four glyphs any two readers can name to each other.
const EMOJI: [&str; 64] = [
    "🍎", "🍌", "🍒", "🍇", "🍋", "🍓", "🥝", "🍑", "🥕", "🌽", "🍄", "🌶️", "🥑", "🍞", "🧀", "🍪",
    "🐶", "🐱", "🐭", "🐰", "🦊", "🐻", "🐼", "🐨", "🐸", "🐧", "🦉", "🐝", "🦋", "🐢", "🐙", "🦀",
    "🌸", "🌻", "🌵", "🍀", "🌙", "⭐", "☀️", "🌈", "⚡", "❄️", "🔥", "💧", "🌊", "🍁", "🪐", "🌍",
    "⚽", "🎸", "🎹", "🎲", "🎈", "🎁", "🔑", "🔔", "⏰", "📚", "✏️", "🧭", "🔭", "🚲", "⛵", "🚀",
];

/// Four glyphs from two addresses, the same on both sides whichever minted
/// the code: both daemons show them, and the two readers compare.
pub fn emoji(a: &[u8; 32], b: &[u8; 32]) -> String {
    let (x, y) = if a <= b { (a, b) } else { (b, a) };
    let mut m = Vec::with_capacity(64);
    m.extend_from_slice(x);
    m.extend_from_slice(y);
    let h = blake3::derive_key("snyvi peer v1 emoji", &m);
    h[..4]
        .iter()
        .map(|i| EMOJI[(*i as usize) % 64])
        .collect::<Vec<_>>()
        .join(" ")
}

// ---- the frame ------------------------------------------------------------------

/// What the frames say, as a number: 1 from 1.22, when a frame began to say
/// which repository it is about; 2 from 1.23, which reads the kinds that
/// close the loop -- a receipt, a reply, a line done. A frame without one is
/// older. What a friend's last frame said is kept (`Peer::v`), and those
/// kinds go only to a friend at `REPLIES_V` or past it.
pub const CONTENT_V: u32 = 3;

/// The first `v` that reads `Receipt`, `Reply` and `Done`.
pub const REPLIES_V: u32 = 2;

/// The first `v` that speaks on a line (`line_ws`): a friend at it is sent
/// everything down the line, and a frame from them comes the same way. An
/// older friend keeps the mailbox and the HTTP deposit.
pub const LINE_V: u32 = 3;

/// What travels inside a frame.
///
/// Every field added after 1.18 is optional, so an older snyvi still opens
/// a newer frame (it ignores what it does not know) and a newer one opens an
/// older frame. A `kind` this snyvi does not know opens as `Other` and is
/// held (`Store::peer_hold`), so a newer friend's frame is read once this
/// snyvi is new enough, not dropped.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase", tag = "kind")]
pub enum Content {
    /// A document: its title, a language hint, the sender's name, and the
    /// bytes after the JSON.
    Document {
        title: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        lang: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        file: Option<String>,
        name: String,
        /// The sender's id for it, so a resend lands as one row.
        id: String,
        /// The folder it is about, so it lands in the reader's own row for
        /// that folder (`Folder`).
        #[serde(flatten)]
        at: Folder,
    },
    /// A line for the reader's notes, with the sender's name.
    Note {
        text: String,
        name: String,
        #[serde(flatten)]
        at: Folder,
    },
    /// What became of a frame this snyvi sent: `arrived` when it was kept,
    /// `read` when it was opened -- that one only when the reader allows it
    /// for this friend (`Peer::read_receipts`). `of` is the frame's id.
    Receipt {
        of: String,
        state: String,
        #[serde(default)]
        v: u32,
    },
    /// One line back about a document the friend sent: `re` is the sender's
    /// id for it (`Document::id`), so it lands under that document's head.
    Reply {
        re: String,
        text: String,
        name: String,
        #[serde(default)]
        v: u32,
    },
    /// A line the friend sent, ticked here and told back: `of` is the line's
    /// frame id, `commit` what the tick said the work is in.
    Done {
        of: String,
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        commit: Option<String>,
        name: String,
        #[serde(default)]
        v: u32,
    },
    /// A kind a newer snyvi sends: opened, held, read after an update.
    #[serde(other)]
    Other,
}

impl Content {
    /// The `v` the sending snyvi wrote, 0 when it wrote none.
    pub fn v(&self) -> u32 {
        match self {
            Content::Document { at, .. } | Content::Note { at, .. } => at.v,
            Content::Receipt { v, .. } | Content::Reply { v, .. } | Content::Done { v, .. } => *v,
            Content::Other => 0,
        }
    }
}

/// Which folder a frame is about, in words both sides can check without
/// sharing a path: the repository's fingerprint (`crate::git::print`), the
/// file's place inside it, and the branch. Each side keeps its own folders;
/// the reader's snyvi looks for the one it already has
/// (`Store::projects_by_print`) and never anywhere else.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct Folder {
    /// blake3 over the sorted root commits. Not in a shallow clone, whose
    /// oldest commits only look like roots.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo: Option<String>,
    /// blake3 over the remote's web address, for the shallow clone; a fork
    /// has its own remote and the same `repo`, so either matching is enough.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote: Option<String>,
    /// The file's path inside the repository, with `/`: only when it is in
    /// there. Untrusted on arrival (`safe_path`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// A file outside the repository, a plan in a scratch folder: blake3 of
    /// its path on the sender's machine, so its versions land as one row and
    /// the path itself does not travel.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    /// `CONTENT_V` when sent; 0 from a snyvi before 1.22.
    #[serde(default, skip_serializing_if = "v_unset")]
    pub v: u32,
}

fn v_unset(n: &u32) -> bool {
    *n == 0
}

impl Folder {
    /// Whether it names a repository at all.
    pub fn named(&self) -> bool {
        self.repo.is_some() || self.remote.is_some()
    }
}

/// A path a friend's frame says a file has inside the repository, if it is
/// one that stays inside: relative, no `..`, no drive, nothing a terminal
/// would act on, not too long. A `\` from Windows reads as `/`. Anything
/// else is no path, and the document lands by name, as before 1.22.
pub fn safe_path(p: &str) -> Option<String> {
    let p = p.replace('\\', "/");
    if p.is_empty() || p.len() > 400 || p.starts_with('/') || p.chars().any(char::is_control) {
        return None;
    }
    let parts: Vec<&str> = p.split('/').collect();
    if parts.first().is_some_and(|f| f.contains(':')) {
        return None;
    }
    if parts
        .iter()
        .any(|c| c.is_empty() || *c == "." || *c == "..")
    {
        return None;
    }
    Some(p)
}

/// A payload is the content's JSON, its length first, then the body bytes
/// (a document's; a note has none).
fn pack(content: &Content, body: &[u8]) -> Vec<u8> {
    let meta = serde_json::to_vec(content).expect("content is json");
    let mut out = Vec::with_capacity(4 + meta.len() + body.len());
    out.extend_from_slice(&(meta.len() as u32).to_le_bytes());
    out.extend_from_slice(&meta);
    out.extend_from_slice(body);
    out
}

fn unpack(payload: &[u8]) -> Result<(Content, Vec<u8>)> {
    if payload.len() < 4 {
        bail!("a payload too short to carry anything");
    }
    let n = u32::from_le_bytes(payload[..4].try_into().unwrap()) as usize;
    if payload.len() < 4 + n {
        bail!("a payload whose header outruns it");
    }
    let content: Content =
        serde_json::from_slice(&payload[4..4 + n]).context("the frame's content")?;
    Ok((content, payload[4 + n..].to_vec()))
}

/// Seal `content` for `peer`: the frame as the relay takes it.
pub fn seal(me: &Identity, peer: &Peer, content: &Content, body: &[u8]) -> Result<Vec<u8>> {
    let peer_box = peer.box_bytes()?;
    let key = me.box_key(&peer_box, true);
    let mut nonce = [0u8; 24];
    getrandom::fill(&mut nonce).map_err(|e| anyhow!("reading random bytes for a nonce: {e}"))?;
    let mut out = Vec::with_capacity(1 + 32 + 24 + body.len() + 256);
    out.push(VERSION);
    out.extend_from_slice(me.sign.verifying_key().as_bytes());
    out.extend_from_slice(&nonce);
    let cipher = XChaCha20Poly1305::new(Key::from_slice(&key));
    let plain = pack(content, body);
    let ct = cipher
        .encrypt(
            XNonce::from_slice(&nonce),
            AeadPayload {
                msg: &plain,
                aad: &out[..33],
            },
        )
        .map_err(|_| anyhow!("sealing the frame"))?;
    out.extend_from_slice(&ct);
    let sig = me.sign.sign(&out);
    out.extend_from_slice(&sig.to_bytes());
    Ok(out)
}

/// The sender a frame names, before anything else is read of it. The link
/// takes the sender from the relay's listing and `open` checks it against
/// the pinned key, so only the tests read it straight off the frame.
#[cfg(test)]
pub fn sender_of(frame: &[u8]) -> Option<String> {
    (frame.len() >= 33 && frame[0] == VERSION).then(|| b64(&frame[1..33]))
}

/// Open a frame from `peer`, whose keys are pinned. Anything that does not
/// check -- the signature against the pinned key first, then the box -- is
/// an error and the frame is content to nobody.
pub fn open(me: &Identity, peer: &Peer, frame: &[u8]) -> Result<(Content, Vec<u8>)> {
    if frame.len() < 1 + 32 + 24 + 16 + 64 {
        bail!("a frame too short to be one");
    }
    if frame[0] != VERSION {
        bail!("a frame of a version this snyvi does not read");
    }
    if b64(&frame[1..33]) != peer.sign_key {
        bail!("a frame that names another sender");
    }
    let (signed, sig) = frame.split_at(frame.len() - 64);
    let pinned = peer.verifying_key()?;
    let sig: [u8; 64] = sig.try_into().unwrap();
    let sig = Signature::from_bytes(&sig);
    pinned
        .verify_strict(signed, &sig)
        .map_err(|_| anyhow!("a frame whose signature is not {}'s", peer.name))?;
    let peer_box = peer.box_bytes()?;
    let key = me.box_key(&peer_box, false);
    let cipher = XChaCha20Poly1305::new(Key::from_slice(&key));
    let plain = cipher
        .decrypt(
            XNonce::from_slice(&signed[33..57]),
            AeadPayload {
                msg: &signed[57..],
                aad: &signed[..33],
            },
        )
        .map_err(|_| anyhow!("a frame that does not open with {}'s key", peer.name))?;
    unpack(&plain)
}

/// The id a document travels under: one per document and recipient, so a
/// second send replaces the first in the relay and lands as one row.
pub fn frame_id(doc_id: &str, peer_sign_key: &str) -> String {
    blake3::hash(format!("snyvi frame v1 {doc_id} {peer_sign_key}").as_bytes())
        .to_hex()
        .to_string()
}

// ---- pairing ---------------------------------------------------------------------

/// What one side says once SPAKE2 has given both the key.
#[derive(Serialize, Deserialize)]
struct Hello {
    sign: String,
    #[serde(rename = "box")]
    boxk: String,
    name: String,
}

/// Where a pairing has got to, as the page polls it.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase", tag = "state")]
pub enum PairState {
    /// Nobody has typed the code yet.
    Waiting,
    /// Both keys exchanged and pinned: the emoji to compare, the new friend.
    Done {
        emoji: String,
        name: String,
        peer: i64,
    },
    Failed {
        why: String,
    },
    /// Withdrawn on this side: no hello goes, nothing is pinned.
    Cancelled,
}

/// Until when the hello is waited for, from `now`, and whether that is
/// sooner than the code's own end (so a late hello means they left).
pub fn hello_by(now: i64, until: i64) -> (i64, bool) {
    let by = now + HELLO_WAIT;
    if by < until {
        (by, true)
    } else {
        (until, false)
    }
}

const RAN_OUT: &str = "the code ran out before the other side typed it";
const THEY_LEFT: &str = "they cancelled the code, or their snyvi closed";
const CANCELLED: &str = "the code was cancelled";

fn go_on(stop: &AtomicBool) -> Result<()> {
    if stop.load(Ordering::Relaxed) {
        bail!(CANCELLED);
    }
    Ok(())
}

/// The HTTP client the relay is spoken to with. Blocking, like `client.rs`'s:
/// every call here runs under `spawn_blocking`.
/// One agent for the process: a deposit after a deposit reuses the
/// connection instead of a TLS handshake each. ureq lets an idle connection
/// go after fifteen seconds, under what the relay allows, so a POST rarely
/// meets one the relay closed; when it does, the try is retried.
fn http() -> ureq::Agent {
    static AGENT: std::sync::OnceLock<ureq::Agent> = std::sync::OnceLock::new();
    AGENT
        .get_or_init(|| {
            ureq::config::Config::builder()
                .timeout_global(Some(HTTP_TIMEOUT))
                .http_status_as_error(false)
                .build()
                .new_agent()
        })
        .clone()
}

/// One side of a pairing, start to finish. Symmetric: whoever minted the code
/// and whoever typed it run the same steps. Returns the hello the other side
/// sent, verified to open under the SPAKE2 key, and the emoji. `stop` set
/// (the reader cancelled) ends it at the next turn of a wait, before any
/// hello goes.
pub fn pair(
    me: &Identity,
    code: &str,
    my_name: &str,
    until: i64,
    stop: &AtomicBool,
) -> Result<(Peer, String)> {
    use spake2::{Ed25519Group, Identity as SpakeId, Password, Spake2};
    let room = room_of(code);
    let mut side = [0u8; 16];
    getrandom::fill(&mut side).map_err(|e| anyhow!("reading random bytes: {e}"))?;
    let side = hex(&side);
    let agent = http();
    let base = relay();

    let (state, msg) = Spake2::<Ed25519Group>::start_symmetric(
        &Password::new(code.as_bytes()),
        &SpakeId::new(SPAKE_ID),
    );
    let theirs = exchange(
        &agent, &base, &room, "spake", &side, &msg, until, RAN_OUT, stop,
    )?;
    go_on(stop)?;
    let key = state
        .finish(&theirs)
        .map_err(|_| anyhow!("the other side had a different code"))?;
    let key: [u8; 32] = blake3::derive_key("snyvi peer v1 hello", &key);

    let hello = Hello {
        sign: me.address(),
        boxk: b64(&me.box_public()),
        name: my_name.trim().chars().take(60).collect(),
    };
    let mut nonce = [0u8; 24];
    getrandom::fill(&mut nonce).map_err(|e| anyhow!("reading random bytes: {e}"))?;
    let cipher = XChaCha20Poly1305::new(Key::from_slice(&key));
    let mut sealed = nonce.to_vec();
    sealed.extend(
        cipher
            .encrypt(
                XNonce::from_slice(&nonce),
                AeadPayload {
                    msg: &serde_json::to_vec(&hello)?,
                    aad: HELLO_AAD,
                },
            )
            .map_err(|_| anyhow!("sealing the hello"))?,
    );
    go_on(stop)?;
    let (by, sooner) = hello_by(crate::store::now(), until);
    let late = if sooner { THEY_LEFT } else { RAN_OUT };
    let theirs = exchange(
        &agent, &base, &room, "hello", &side, &sealed, by, late, stop,
    )?;
    if theirs.len() < 24 + 16 {
        bail!("the other side's hello is not one");
    }
    let plain = cipher
        .decrypt(
            XNonce::from_slice(&theirs[..24]),
            AeadPayload {
                msg: &theirs[24..],
                aad: HELLO_AAD,
            },
        )
        .map_err(|_| anyhow!("the other side's hello does not open: a different code"))?;
    let h: Hello = serde_json::from_slice(&plain).context("the other side's hello")?;
    let peer = Peer {
        id: 0,
        sign_key: h.sign,
        box_key: h.boxk,
        name: if h.name.trim().is_empty() {
            "a friend".to_string()
        } else {
            h.name.trim().to_string()
        },
        paired_at: 0,
        muted: false,
        removed_at: 0,
        last_from: 0,
        last_to: 0,
        desk_id: 0,
        v: 0,
        read_receipts: false,
    };
    // The keys have to be keys, or nothing is pinned.
    let their_sign = peer.verifying_key()?;
    peer.box_bytes()?;
    if peer.sign_key == me.address() {
        bail!("that is this snyvi's own code");
    }
    let glyphs = emoji(me.sign.verifying_key().as_bytes(), their_sign.as_bytes());
    // Sign in to this daemon's own mailbox now: the relay takes nothing for
    // an address nobody has signed in as, and the new friend's first
    // document may come before the link opens. The link does it too, so a
    // failure here only costs that document a retry.
    let _ = inbox(me);
    Ok((peer, glyphs))
}

/// Leave `mine` in the room's `stage` and wait for the other side's, until
/// `until`, when it fails with `late`; or until `stop` is set.
#[allow(clippy::too_many_arguments)]
fn exchange(
    agent: &ureq::Agent,
    base: &str,
    room: &str,
    stage: &str,
    side: &str,
    mine: &[u8],
    until: i64,
    late: &'static str,
    stop: &AtomicBool,
) -> Result<Vec<u8>> {
    let url = format!("{base}/room/{room}/{stage}");
    let mut resp = agent
        .put(&url)
        .header("x-snyvi-side", side)
        .send(mine)
        .context("reaching the relay")?;
    match resp.status().as_u16() {
        200 => return read_all(&mut resp),
        202 => {}
        s => return Err(pair_refused(s)),
    }
    // The wait is on the room's doorbell, which rings when the other side's
    // message lands and costs the relay nothing while it does not; then the
    // message is read at once. Where the bell will not open (an older relay,
    // a proxy that drops WebSockets) the wait is a long poll instead.
    let mut bell = true;
    loop {
        go_on(stop)?;
        let left = until - crate::store::now();
        if left <= 0 {
            bail!(late);
        }
        let wait = if bell {
            match ring_wait(base, room, stage, side, left.min(25)) {
                Bell::Rang | Bell::Quiet => 0,
                Bell::Absent => {
                    bell = false;
                    left.min(25)
                }
            }
        } else {
            left.min(25)
        };
        let asked = std::time::Instant::now();
        let mut resp = agent
            .get(&format!("{url}?wait={wait}"))
            .header("x-snyvi-side", side)
            .call()
            .context("reaching the relay")?;
        match resp.status().as_u16() {
            200 => return read_all(&mut resp),
            // A poll answered at once though it asked to wait (a relay that
            // no longer holds polls): not straight back.
            204 if wait > 0 && asked.elapsed() < Duration::from_secs(1) => {
                std::thread::sleep(Duration::from_secs(1))
            }
            204 => {}
            s => return Err(pair_refused(s)),
        }
    }
}

/// A room's answer that ends the pairing, in the reader's words.
fn pair_refused(status: u16) -> anyhow::Error {
    match status {
        409 => anyhow!("someone else already used this code"),
        410 => anyhow!("this code was already used"),
        429 => anyhow!("{BUSY}; try again in a minute"),
        s => anyhow!("the relay answered {s} to the pairing"),
    }
}

/// How a wait on the doorbell ended.
#[derive(Debug, PartialEq, Eq)]
enum Bell {
    /// The other side's message is in.
    Rang,
    /// Nothing in the time, or the bell closed: ask, then wait again.
    Quiet,
    /// The bell would not open.
    Absent,
}

/// Wait up to `secs` on the room's doorbell for the other side's `stage`.
/// Blocking, like the rest of the pairing: it borrows the daemon's runtime
/// for the socket, from the `spawn_blocking` thread the pairing runs on.
fn ring_wait(base: &str, room: &str, stage: &str, side: &str, secs: i64) -> Bell {
    let Ok(rt) = tokio::runtime::Handle::try_current() else {
        return Bell::Absent;
    };
    let url = format!("{}/room/{room}/ws?side={side}", ws_base(base));
    rt.block_on(async move {
        use futures_util::StreamExt;
        use tokio_tungstenite::tungstenite::Message;
        let connect = tokio::time::timeout(
            Duration::from_secs(10),
            tokio_tungstenite::connect_async(url.as_str()),
        );
        let Ok(Ok((mut socket, _))) = connect.await else {
            return Bell::Absent;
        };
        let ring = async {
            while let Some(Ok(msg)) = socket.next().await {
                if matches!(&msg, Message::Text(t) if rings_for(t.as_str()) == Some(stage)) {
                    return Bell::Rang;
                }
            }
            Bell::Quiet
        };
        let bell = tokio::time::timeout(Duration::from_secs(secs.max(1) as u64), ring)
            .await
            .unwrap_or(Bell::Quiet);
        let _ = socket.close(None).await;
        bell
    })
}

/// The stage a doorbell's `{"ready":stage}` names.
fn rings_for(text: &str) -> Option<&str> {
    let v: serde_json::Value = serde_json::from_str(text).ok()?;
    match v.get("ready")?.as_str()? {
        "spake" => Some("spake"),
        "hello" => Some("hello"),
        _ => None,
    }
}

fn read_all(resp: &mut ureq::http::Response<ureq::Body>) -> Result<Vec<u8>> {
    Ok(resp
        .body_mut()
        .with_config()
        .limit(FRAME_MAX as u64)
        .read_to_vec()?)
}

// ---- the relay's mailbox ------------------------------------------------------

/// A frame waiting at the relay, as its listing says.
#[derive(Clone, Debug, Deserialize)]
pub struct Waiting {
    pub id: String,
    pub sender: String,
    pub size: u64,
}

/// What a deposit came to.
#[derive(Debug, PartialEq, Eq)]
pub enum Deposit {
    /// In the friend's mailbox.
    Sent,
    /// Not now, and nothing wrong: it stays in the outbox for the next try,
    /// and the wait does not count against the tries a frame has. `until`
    /// when the relay named the moment (Retry-After), else the friend is
    /// away and the wait grows (`waiting`).
    Later {
        why: &'static str,
        until: Option<i64>,
    },
    /// Down the line, waiting for the friend's ack (`pending`).
    Pending,
}

/// What the reader is told when the relay asks everyone to slow down.
pub const BUSY: &str = "the relay is busy";

/// Leave a frame for `to` (an address), signed by `me` -- the sender the
/// frame names -- so that the relay lets nobody else replace it. The
/// relay's id makes a resend a replacement.
pub fn deposit(me: &Identity, to: &str, id: &str, frame: &[u8]) -> Result<Deposit> {
    let path = format!("/to/{to}");
    let mut resp = http()
        .post(&format!("{}{path}", relay()))
        .header("x-snyvi-id", id)
        .header("x-snyvi-from", &me.address())
        .header("x-snyvi-auth", &me.relay_auth("POST", &path))
        .send(frame)
        .context("reaching the relay")?;
    let status = resp.status().as_u16();
    if status == 200 || status == 201 {
        return Ok(Deposit::Sent);
    }
    let until = retry_after(&resp);
    let body = String::from_utf8_lossy(&read_all(&mut resp)?)
        .trim()
        .to_string();
    match later(status, &body) {
        Some(why) => Ok(Deposit::Later { why, until }),
        None => bail!("the relay answered {status}: {body}"),
    }
}

/// When the relay said to come back: its `Retry-After`, in seconds from
/// now, as a moment. Honoured so the relay can say "an hour" and be obeyed.
fn retry_after(resp: &ureq::http::Response<ureq::Body>) -> Option<i64> {
    let secs: i64 = resp
        .headers()
        .get("retry-after")?
        .to_str()
        .ok()?
        .trim()
        .parse()
        .ok()?;
    (secs > 0).then(|| crate::store::now() + secs.min(7 * 86_400))
}

/// The answers to a deposit that mean "not now": the mailbox full, the
/// relay asking to slow down, or a friend whose snyvi has not been online
/// since its mailbox was cleared for being idle (a 404: the relay takes
/// nothing for an address nobody has signed in as).
fn later(status: u16, body: &str) -> Option<&'static str> {
    match status {
        429 if body.contains("busy") => Some(BUSY),
        429 => Some("their mailbox is full"),
        503 => Some(NEARLY_OUT),
        404 => Some("their snyvi has not been online for a while"),
        _ => None,
    }
}

/// What the reader is told when the relay is nearly out for the day and a
/// big document waits for tomorrow.
pub const NEARLY_OUT: &str = "the relay is nearly out for today; this goes tomorrow";

/// What is waiting for me, at once. The sweep the link falls back on when
/// the socket will not open; the socket itself says the same as it lands.
pub fn inbox(me: &Identity) -> Result<Vec<Waiting>> {
    let path = format!("/inbox/{}", me.address());
    let mut resp = http()
        .get(&format!("{}{path}", relay()))
        .header("x-snyvi-auth", &me.relay_auth("GET", &path))
        .call()
        .context("reaching the relay")?;
    if resp.status().as_u16() != 200 {
        bail!("the relay answered {} to the inbox", resp.status());
    }
    #[derive(Deserialize)]
    struct List {
        frames: Vec<Waiting>,
    }
    let l: List = resp.body_mut().read_json().context("the relay's listing")?;
    Ok(l.frames)
}

/// One frame's bytes.
pub fn fetch(me: &Identity, id: &str) -> Result<Vec<u8>> {
    let path = format!("/inbox/{}/{id}", me.address());
    let mut resp = http()
        .get(&format!("{}{path}", relay()))
        .header("x-snyvi-auth", &me.relay_auth("GET", &path))
        .call()
        .context("reaching the relay")?;
    if resp.status().as_u16() != 200 {
        bail!("the relay answered {} to a frame", resp.status());
    }
    read_all(&mut resp)
}

/// Ack: the relay forgets it.
pub fn ack(me: &Identity, id: &str) -> Result<()> {
    let path = format!("/inbox/{}/{id}", me.address());
    let resp = http()
        .delete(&format!("{}{path}", relay()))
        .header("x-snyvi-auth", &me.relay_auth("DELETE", &path))
        .call()
        .context("reaching the relay")?;
    match resp.status().as_u16() {
        204 | 404 => Ok(()),
        s => bail!("the relay answered {s} to an ack"),
    }
}

// ---- the link ------------------------------------------------------------------

/// Where the link opens: the relay's address with its scheme turned to the
/// WebSocket one, at this daemon's own inbox. The upgrade is signed like
/// any read of the inbox, as `x-snyvi-auth` over `GET` and this path.
pub fn relay_ws(address: &str) -> String {
    ws_of(&relay(), address)
}

fn ws_of(relay: &str, address: &str) -> String {
    format!("{}/inbox/{address}", ws_base(relay))
}

/// The relay's address with its scheme turned to the WebSocket one.
fn ws_base(relay: &str) -> String {
    if let Some(rest) = relay.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = relay.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        relay.to_string()
    }
}

/// What the relay says down the link, as text: a frame that landed (or was
/// waiting when the link opened). When its size is within `INLINE_MAX` the
/// bytes follow as one binary message; past it the daemon fetches them.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Pushed {
    Frame(Waiting),
}

/// What the daemon says back: the frame is in, forget it.
pub fn ack_message(id: &str) -> String {
    serde_json::json!({ "ack": id }).to_string()
}

// ---- the line ------------------------------------------------------------------

/// Where a line opens: one object at the relay per friendship, named by the
/// two addresses, that passes a frame straight from one socket to the
/// other and stores it only when the other side is away. Signed like a
/// read of the inbox, over `GET` and this path.
pub fn line_ws(me: &str, them: &str) -> String {
    format!("{}/line/{me}/{them}", ws_base(&relay()))
}

/// A frame goes down the line in pieces of this many bytes: a WebSocket
/// message is capped at 1 MiB on the way in, and each piece carries
/// `CHUNK_HEADER` bytes of its own.
pub const LINE_CHUNK: usize = (1 << 20) - 64;
/// A piece's header: the frame's id as 32 raw bytes, then this piece's
/// index and the count, each a little-endian u32.
pub const CHUNK_HEADER: usize = 40;
/// The most pieces a frame can be: `FRAME_MAX` over `LINE_CHUNK`, rounded up.
pub const CHUNKS_MAX: u32 = 9;

/// A frame cut for the line: the binary messages, in order.
pub fn chunks(id: &str, frame: &[u8]) -> Vec<Vec<u8>> {
    let raw = unhex32(id).unwrap_or([0; 32]);
    let of = frame.len().div_ceil(LINE_CHUNK) as u32;
    frame
        .chunks(LINE_CHUNK)
        .enumerate()
        .map(|(n, data)| {
            let mut m = Vec::with_capacity(CHUNK_HEADER + data.len());
            m.extend_from_slice(&raw);
            m.extend_from_slice(&(n as u32).to_le_bytes());
            m.extend_from_slice(&of.to_le_bytes());
            m.extend_from_slice(data);
            m
        })
        .collect()
}

/// One piece, as it came down the line.
pub struct Chunk<'a> {
    pub id: [u8; 32],
    pub n: u32,
    pub of: u32,
    pub data: &'a [u8],
}

impl<'a> Chunk<'a> {
    /// The header read; `None` for anything that is not a piece.
    pub fn parse(m: &'a [u8]) -> Option<Chunk<'a>> {
        if m.len() < CHUNK_HEADER {
            return None;
        }
        let n = u32::from_le_bytes(m[32..36].try_into().unwrap());
        let of = u32::from_le_bytes(m[36..40].try_into().unwrap());
        if of == 0 || n >= of || of > CHUNKS_MAX || m.len() - CHUNK_HEADER > LINE_CHUNK {
            return None;
        }
        Some(Chunk {
            id: m[..32].try_into().unwrap(),
            n,
            of,
            data: &m[CHUNK_HEADER..],
        })
    }
}

/// Frames being put back together from their pieces, by id. At most
/// `ASSEMBLING_MAX` at a time: a piece for a third frame drops the oldest,
/// and its sender sends it again when no ack comes.
#[derive(Default)]
pub struct Assembly {
    frames: Vec<Assembling>,
}

/// One frame's id, how many pieces it has, and the pieces in hand.
type Assembling = ([u8; 32], u32, Vec<Option<Vec<u8>>>);

const ASSEMBLING_MAX: usize = 2;

impl Assembly {
    /// A piece in; the whole frame out when it was the last one missing.
    pub fn take(&mut self, c: &Chunk) -> Option<(String, Vec<u8>)> {
        let at = match self.frames.iter().position(|(id, _, _)| *id == c.id) {
            Some(i) if self.frames[i].1 == c.of => i,
            Some(i) => {
                self.frames.remove(i);
                self.start(c)
            }
            None => self.start(c),
        };
        let parts = &mut self.frames[at].2;
        parts[c.n as usize] = Some(c.data.to_vec());
        if parts.iter().any(Option::is_none) {
            return None;
        }
        let (id, _, parts) = self.frames.remove(at);
        let mut whole =
            Vec::with_capacity(parts.iter().map(|p| p.as_ref().map_or(0, Vec::len)).sum());
        for p in parts.into_iter().flatten() {
            whole.extend_from_slice(&p);
        }
        Some((hex(&id), whole))
    }

    fn start(&mut self, c: &Chunk) -> usize {
        while self.frames.len() >= ASSEMBLING_MAX {
            self.frames.remove(0);
        }
        self.frames.push((c.id, c.of, vec![None; c.of as usize]));
        self.frames.len() - 1
    }
}

/// What the line says, as text. Anything else is ignored.
#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum LineSaid {
    /// The friend is away; the line keeps the frame for them: Sent.
    Held(String),
    /// The friend acked the frame: Sent, and arrived.
    Arrived(String),
    /// The line lost part of it: from the start.
    Resend(String),
    /// The line holds as much as it may for them: later.
    Full(String),
    /// Not a frame: dropped there, failed here.
    Failed { id: String, why: String },
    /// The friend's socket opened or closed.
    Friend { on: bool },
    /// The relay is nearly out for the day: read receipts wait until then.
    Quiet { until: i64 },
}

/// Close code the relay uses when an address has opened its daily share of
/// sockets; the reason says when to come back, as `until:<ms>`.
pub const CLOSE_BUDGET: u16 = 4429;

/// The moment a `CLOSE_BUDGET` reason names, in seconds; midnight UTC when
/// it names none.
pub fn until_of(reason: &str) -> i64 {
    let now = crate::store::now();
    reason
        .strip_prefix("until:")
        .and_then(|ms| ms.trim().parse::<i64>().ok())
        .map(|ms| ms / 1000)
        .filter(|t| *t > now && *t < now + 2 * 86_400)
        .unwrap_or(now - now % 86_400 + 86_400)
}

fn unhex32(s: &str) -> Option<[u8; 32]> {
    if s.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, b) in out.iter_mut().enumerate() {
        *b = u8::from_str_radix(&s[2 * i..2 * i + 2], 16).ok()?;
    }
    Some(out)
}

/// How long to wait before the `attempt`th try at the relay: 1, 2, 4 … up
/// to `BACKOFF_MAX` seconds, with up to thirty per cent on top so that a
/// thousand daemons coming back from the same outage do not knock at once.
pub fn backoff(attempt: u32) -> Duration {
    let base = Duration::from_secs(1u64 << attempt.clamp(0, 20)).min(BACKOFF_MAX);
    let mut b = [0u8; 1];
    let _ = getrandom::fill(&mut b);
    base + base.mul_f64(f64::from(b[0]) / 255.0 * 0.3)
}

// ---- the store -----------------------------------------------------------------

/// A friend: keys pinned at pairing, a name the reader may change.
#[derive(Clone, Debug, Default, Serialize, PartialEq, Eq)]
pub struct Peer {
    pub id: i64,
    /// The address: their Ed25519 public key, as the relay spells it.
    pub sign_key: String,
    pub box_key: String,
    pub name: String,
    pub paired_at: i64,
    /// Muted: what arrives is kept but not announced.
    pub muted: bool,
    /// ✕: out of the list, keys kept, a Restore away.
    #[serde(skip_serializing_if = "is_zero")]
    pub removed_at: i64,
    pub last_from: i64,
    pub last_to: i64,
    /// The desk their things land on: their documents in its project, their
    /// lines as suggestions on its list. 0 is their own row, From Trapti,
    /// and the lines on Home. A desk that is closed or parked when something
    /// arrives counts as 0, so nothing lands out of sight.
    pub desk_id: i64,
    /// The `v` their last frame said (`CONTENT_V`): what their snyvi reads.
    pub v: u32,
    /// Whether they are told when the reader opens what they sent: off
    /// until the reader turns it on for them.
    pub read_receipts: bool,
}

fn is_zero(n: &i64) -> bool {
    *n == 0
}

impl Peer {
    fn verifying_key(&self) -> Result<VerifyingKey> {
        let b = unb64(&self.sign_key)
            .filter(|b| b.len() == 32)
            .ok_or_else(|| anyhow!("a pinned key that is not one"))?;
        VerifyingKey::from_bytes(b.as_slice().try_into().unwrap())
            .map_err(|_| anyhow!("a pinned key that is not one"))
    }
    fn box_bytes(&self) -> Result<[u8; 32]> {
        let b = unb64(&self.box_key)
            .filter(|b| b.len() == 32)
            .ok_or_else(|| anyhow!("a pinned box key that is not one"))?;
        Ok(b.as_slice().try_into().unwrap())
    }
    /// The project a friend's documents land in: a root no folder has.
    pub fn project_root(&self) -> String {
        format!("peer:{}", self.sign_key)
    }
    /// Their row in the sidebar: `From Trapti`, always from their one name.
    pub fn project_name(&self) -> String {
        from_name(&self.name)
    }
}

/// `From Trapti`: the one place a friend's row is spelled.
pub fn from_name(name: &str) -> String {
    format!("From {name}")
}

/// What the reader meant as the friend's name when they renamed the row:
/// one leading `From ` is the row's, not theirs.
pub fn name_from_project(row: &str) -> &str {
    let row = row.trim();
    match row.get(..5) {
        Some(p) if p.eq_ignore_ascii_case("from ") => row[5..].trim(),
        _ => row,
    }
}

/// A line a friend sent, waiting for the reader to put it on a desk.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct PeerNote {
    pub id: i64,
    pub peer_id: i64,
    pub from: String,
    pub text: String,
    pub arrived_at: i64,
    /// The frame it came in, so a tick on the desk it is kept on can be
    /// told back (`Content::Done`).
    #[serde(skip)]
    pub frame: String,
}

/// An agent's offer to send a document, waiting for the reader's Send.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct Offer {
    pub id: i64,
    pub peer_id: i64,
    pub to: String,
    pub doc_id: String,
    pub title: String,
    pub by: String,
    pub pane: String,
    pub offered_at: i64,
    /// A line offered instead of a document (`offer_line`): what would go.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub text: String,
}

pub const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS peers (
  id INTEGER PRIMARY KEY,
  sign_key TEXT NOT NULL UNIQUE,
  box_key TEXT NOT NULL,
  name TEXT NOT NULL,
  paired_at INTEGER NOT NULL,
  muted INTEGER NOT NULL DEFAULT 0,
  removed_at INTEGER NOT NULL DEFAULT 0,
  last_from INTEGER NOT NULL DEFAULT 0,
  last_to INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS peer_outbox (
  id TEXT PRIMARY KEY,
  peer_id INTEGER NOT NULL REFERENCES peers(id),
  doc_id TEXT NOT NULL,
  queued_at INTEGER NOT NULL,
  sent_at INTEGER NOT NULL DEFAULT 0,
  tries INTEGER NOT NULL DEFAULT 0,
  error TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS peer_notes (
  id INTEGER PRIMARY KEY,
  peer_id INTEGER NOT NULL REFERENCES peers(id),
  text TEXT NOT NULL,
  arrived_at INTEGER NOT NULL,
  taken_at INTEGER NOT NULL DEFAULT 0,
  removed_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS peer_offers (
  id INTEGER PRIMARY KEY,
  peer_id INTEGER NOT NULL REFERENCES peers(id),
  doc_id TEXT NOT NULL,
  pane TEXT NOT NULL DEFAULT '',
  by TEXT NOT NULL DEFAULT '',
  offered_at INTEGER NOT NULL,
  answered_at INTEGER NOT NULL DEFAULT 0,
  sent INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS peer_taken (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS peer_held (
  id TEXT PRIMARY KEY,
  peer_id INTEGER NOT NULL REFERENCES peers(id),
  bytes BLOB NOT NULL,
  held_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS peer_replies (
  id INTEGER PRIMARY KEY,
  peer_id INTEGER NOT NULL REFERENCES peers(id),
  doc_id TEXT NOT NULL,
  text TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS peer_replies_doc ON peer_replies(doc_id, at);
"#;

/// 1.22: each folder's fingerprint (`crate::git::print`) and when it was
/// read, and who sent a friend's document, by key: what `unfile` moves it
/// back under. Version 10 of `store::MIGRATIONS`.
pub const COLUMNS_1_22: [&str; 4] = [
    "ALTER TABLE projects ADD COLUMN repo TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE projects ADD COLUMN remote TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE projects ADD COLUMN printed_at INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE docs ADD COLUMN peer_key TEXT NOT NULL DEFAULT ''",
];

/// How long a frame of a kind this snyvi cannot read is held for an update
/// that can: a month, then it goes.
pub const HELD_KEPT: i64 = 30 * 86_400;

/// 1.19: the desk a friend's things land on (0: their own row), and a line
/// in the outbox. Version 7 of `store::MIGRATIONS`, not in `SCHEMA`: that
/// step runs once and takes an error as one, so a table made new must not
/// have them before it adds them.
pub const COLUMNS_1_19: [&str; 2] = [
    "ALTER TABLE peers ADD COLUMN desk_id INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE peer_outbox ADD COLUMN text TEXT NOT NULL DEFAULT ''",
];

const PEER_COLS: &str =
    "id, sign_key, box_key, name, paired_at, muted, removed_at, last_from, last_to, desk_id, v, read_receipts";

/// 1.23: what a friend's snyvi reads and whether they hear of a read; what
/// a frame in the outbox is (`kind`: '' a document or a line, `receipt`,
/// `reply`, `done`), what it is about (`re`) and what else it carries
/// (`extra`, a done line's commit), and what came back about it; the frame
/// a friend's line or document came in, so a tick or an open can answer it;
/// the line an agent offers. Version 11 of `store::MIGRATIONS`.
pub const COLUMNS_1_23: [&str; 16] = [
    "ALTER TABLE peers ADD COLUMN v INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE peers ADD COLUMN read_receipts INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE peer_outbox ADD COLUMN kind TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE peer_outbox ADD COLUMN re TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE peer_outbox ADD COLUMN extra TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE peer_outbox ADD COLUMN arrived_at INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE peer_outbox ADD COLUMN read_at INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE peer_outbox ADD COLUMN done_at INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE peer_outbox ADD COLUMN done_commit TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE peer_notes ADD COLUMN frame TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE peer_offers ADD COLUMN text TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE docs ADD COLUMN peer_frame TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE docs ADD COLUMN peer_ref TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE desk_notes ADD COLUMN sent_peer INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE desk_notes ADD COLUMN sent_frame TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE desk_notes ADD COLUMN told_at INTEGER NOT NULL DEFAULT 0",
];

/// 1.25: when a waiting frame is next due and how many times running the
/// relay said "not now" (`waiting`, `unsent`), the index the outbox is read
/// by, and the one a note's thread is looked up by (a column from version 8,
/// so the index cannot be in `SCHEMA`).
pub const COLUMNS_1_25: [&str; 4] = [
    "ALTER TABLE peer_outbox ADD COLUMN next_at INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE peer_outbox ADD COLUMN later INTEGER NOT NULL DEFAULT 0",
    "CREATE INDEX IF NOT EXISTS peer_outbox_unsent ON peer_outbox(queued_at) WHERE sent_at = 0",
    "CREATE INDEX IF NOT EXISTS desk_notes_thread ON desk_notes(thread_id) WHERE thread_id != 0",
];

/// A reply is one line, as a note is.
pub const REPLY_CHARS: usize = NOTE_CHARS;
/// How many replies a document's head shows, the newest.
pub const REPLIES_SHOWN: usize = 20;

fn row_peer(r: &rusqlite::Row) -> rusqlite::Result<Peer> {
    Ok(Peer {
        id: r.get(0)?,
        sign_key: r.get(1)?,
        box_key: r.get(2)?,
        name: r.get(3)?,
        paired_at: r.get(4)?,
        muted: r.get::<_, i64>(5)? != 0,
        removed_at: r.get(6)?,
        last_from: r.get(7)?,
        last_to: r.get(8)?,
        desk_id: r.get(9)?,
        v: r.get(10)?,
        read_receipts: r.get::<_, i64>(11)? != 0,
    })
}

/// What a friend's snyvi said it reads, from the frame just in.
pub fn set_v(conn: &Connection, id: i64, v: u32) -> Result<()> {
    conn.execute("UPDATE peers SET v = ?2 WHERE id = ?1", params![id, v])?;
    Ok(())
}

/// Whether a friend hears when the reader opens what they sent.
pub fn set_read_receipts(conn: &Connection, id: i64, on: bool) -> Result<bool> {
    Ok(conn.execute(
        "UPDATE peers SET read_receipts = ?2 WHERE id = ?1",
        params![id, on as i64],
    )? > 0)
}

/// Every friend, removed ones last, by name.
pub fn list(conn: &Connection) -> Result<Vec<Peer>> {
    let rows = conn
        .prepare(&format!(
            "SELECT {PEER_COLS} FROM peers ORDER BY removed_at != 0, LOWER(name), id"
        ))?
        .query_map([], row_peer)?
        .collect::<std::result::Result<_, _>>()?;
    Ok(rows)
}

pub fn get(conn: &Connection, id: i64) -> Result<Option<Peer>> {
    Ok(conn
        .query_row(
            &format!("SELECT {PEER_COLS} FROM peers WHERE id = ?1"),
            params![id],
            row_peer,
        )
        .optional()?)
}

pub fn by_sign_key(conn: &Connection, key: &str) -> Result<Option<Peer>> {
    Ok(conn
        .query_row(
            &format!("SELECT {PEER_COLS} FROM peers WHERE sign_key = ?1"),
            params![key],
            row_peer,
        )
        .optional()?)
}

/// A friend by the name an agent said, among those on the list.
pub fn by_name(conn: &Connection, name: &str) -> Result<Option<Peer>> {
    Ok(conn
        .query_row(
            &format!("SELECT {PEER_COLS} FROM peers WHERE removed_at = 0 AND LOWER(name) = LOWER(?1) ORDER BY id LIMIT 1"),
            params![name.trim()],
            row_peer,
        )
        .optional()?)
}

/// Pin a friend's keys. Pairing again with someone already here keeps the
/// row and takes the new keys and name: a friend who reinstalled.
pub fn pin(conn: &Connection, p: &Peer, now: i64) -> Result<Peer> {
    conn.execute(
        "INSERT INTO peers(sign_key, box_key, name, paired_at) VALUES(?1, ?2, ?3, ?4)
         ON CONFLICT(sign_key) DO UPDATE SET box_key = excluded.box_key, paired_at = excluded.paired_at, removed_at = 0",
        params![p.sign_key, p.box_key, p.name, now],
    )?;
    Ok(by_sign_key(conn, &p.sign_key)?.expect("just pinned"))
}

pub fn rename(conn: &Connection, id: i64, name: &str) -> Result<bool> {
    let name: String = name.trim().chars().take(60).collect();
    if name.is_empty() {
        return Ok(false);
    }
    Ok(conn.execute(
        "UPDATE peers SET name = ?2 WHERE id = ?1",
        params![id, name],
    )? > 0)
}

/// A friend's row takes their name, whatever it was labelled: one name
/// everywhere. The project's id, for the `renamed` event, if it has one.
pub fn rename_project(conn: &Connection, root: &str, name: &str) -> Result<Option<i64>> {
    Ok(conn
        .query_row(
            "UPDATE projects SET name = ?2, renamed = 0 WHERE root = ?1 RETURNING id",
            params![root, name],
            |r| r.get(0),
        )
        .optional()?)
}

pub fn mute(conn: &Connection, id: i64, muted: bool) -> Result<bool> {
    Ok(conn.execute(
        "UPDATE peers SET muted = ?2 WHERE id = ?1",
        params![id, muted as i64],
    )? > 0)
}

pub fn remove(conn: &Connection, id: i64, now: i64) -> Result<bool> {
    Ok(conn.execute(
        "UPDATE peers SET removed_at = ?2 WHERE id = ?1 AND removed_at = 0",
        params![id, now],
    )? > 0)
}

pub fn restore(conn: &Connection, id: i64) -> Result<bool> {
    Ok(conn.execute(
        "UPDATE peers SET removed_at = 0 WHERE id = ?1 AND removed_at != 0",
        params![id],
    )? > 0)
}

/// Where a friend's things land from now on: a desk, or 0 for their own
/// row. What already arrived stays where it is.
pub fn set_desk(conn: &Connection, id: i64, desk_id: i64) -> Result<bool> {
    Ok(conn.execute(
        "UPDATE peers SET desk_id = ?2 WHERE id = ?1",
        params![id, desk_id.max(0)],
    )? > 0)
}

pub fn touch(conn: &Connection, id: i64, from: bool, now: i64) -> Result<()> {
    let col = if from { "last_from" } else { "last_to" };
    conn.execute(
        &format!("UPDATE peers SET {col} = ?2 WHERE id = ?1"),
        params![id, now],
    )?;
    Ok(())
}

/// A document queued for a friend; the same document for the same friend is
/// the same row, queued again.
pub fn queue(conn: &Connection, peer: &Peer, doc_id: &str, now: i64) -> Result<String> {
    let id = frame_id(doc_id, &peer.sign_key);
    conn.execute(
        "INSERT INTO peer_outbox(id, peer_id, doc_id, queued_at) VALUES(?1, ?2, ?3, ?4)
         ON CONFLICT(id) DO UPDATE SET queued_at = excluded.queued_at, sent_at = 0, tries = 0, later = 0, next_at = 0, error = ''",
        params![id, peer.id, doc_id, now],
    )?;
    // The reader believes they are there: whatever else waits for them goes too.
    due_now(conn, peer.id)?;
    Ok(id)
}

/// A line queued for a friend, as a document is: said once, so each is its
/// own row under a fresh id, and it goes when the relay can be reached.
pub fn queue_note(conn: &Connection, peer: &Peer, text: &str, now: i64) -> Result<String> {
    let text: String = text.trim().chars().take(NOTE_CHARS).collect();
    let mut nonce = [0u8; 16];
    getrandom::fill(&mut nonce)
        .map_err(|e| anyhow!("reading random bytes for a line's id: {e}"))?;
    let id = blake3::hash(&nonce).to_hex().to_string();
    conn.execute(
        "INSERT INTO peer_outbox(id, peer_id, doc_id, text, queued_at) VALUES(?1, ?2, '', ?3, ?4)",
        params![id, peer.id, text, now],
    )?;
    due_now(conn, peer.id)?;
    Ok(id)
}

/// One of the kinds that answer a frame (`Content::Receipt`, `Reply`,
/// `Done`), queued: `re` is what it answers, `extra` a done line's commit.
/// A receipt's id is the frame and the state it says, so the same receipt
/// twice is one row; a reply or a done is said once, and is its own.
pub fn queue_kind(
    conn: &Connection,
    peer: &Peer,
    kind: &str,
    re: &str,
    text: &str,
    extra: &str,
    now: i64,
) -> Result<String> {
    let id = if kind == "receipt" {
        blake3::hash(format!("receipt {re} {text} {}", peer.sign_key).as_bytes())
            .to_hex()
            .to_string()
    } else {
        let mut nonce = [0u8; 16];
        getrandom::fill(&mut nonce)
            .map_err(|e| anyhow!("reading random bytes for a frame's id: {e}"))?;
        blake3::hash(&nonce).to_hex().to_string()
    };
    let text: String = text.trim().chars().take(REPLY_CHARS).collect();
    conn.execute(
        "INSERT INTO peer_outbox(id, peer_id, doc_id, text, kind, re, extra, queued_at) VALUES(?1, ?2, '', ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(id) DO NOTHING",
        params![id, peer.id, text, kind, re, extra, now],
    )?;
    Ok(id)
}

/// A frame waiting in the outbox: a document (`doc_id`), a line (`text`),
/// or one that answers a frame (`kind`, with `re` and `extra`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Unsent {
    pub id: String,
    pub peer_id: i64,
    pub doc_id: String,
    pub text: String,
    pub tries: i64,
    pub kind: String,
    pub re: String,
    pub extra: String,
    /// How many times running the relay said "not now" (`waiting`).
    pub later: i64,
}

/// What has not gone yet and is due at `now`, oldest first. A frame the
/// relay said "not now" to waits until its `next_at` (`waiting`); a new one
/// has none and goes first. Every flush -- the ten-minute tick, a wake, a
/// link opening -- reads this, so a wake sends only what is due.
pub fn unsent(conn: &Connection, now: i64) -> Result<Vec<Unsent>> {
    let mut st = conn.prepare(&format!(
        "{UNSENT_SQL} WHERE o.sent_at = 0 AND p.removed_at = 0 AND o.next_at <= ?1 ORDER BY o.queued_at, o.id"
    ))?;
    let rows = st
        .query_map(params![now], row_unsent)?
        .collect::<std::result::Result<_, _>>()?;
    Ok(rows)
}

/// One frame by id, due or not: the reader pressing Send loads one row, not
/// every unsent one.
pub fn unsent_one(conn: &Connection, id: &str) -> Result<Option<Unsent>> {
    let mut st = conn.prepare(&format!(
        "{UNSENT_SQL} WHERE o.id = ?1 AND o.sent_at = 0 AND p.removed_at = 0"
    ))?;
    let row = st.query_row(params![id], row_unsent).optional()?;
    Ok(row)
}

const UNSENT_SQL: &str =
    "SELECT o.id, o.peer_id, o.doc_id, o.text, o.tries, o.kind, o.re, o.extra, o.later
    FROM peer_outbox o JOIN peers p ON p.id = o.peer_id";

fn row_unsent(r: &rusqlite::Row) -> rusqlite::Result<Unsent> {
    Ok(Unsent {
        id: r.get(0)?,
        peer_id: r.get(1)?,
        doc_id: r.get(2)?,
        text: r.get(3)?,
        tries: r.get(4)?,
        kind: r.get(5)?,
        re: r.get(6)?,
        extra: r.get(7)?,
        later: r.get(8)?,
    })
}

pub fn sent(conn: &Connection, id: &str, now: i64) -> Result<()> {
    conn.execute(
        "UPDATE peer_outbox SET sent_at = ?2, error = '' WHERE id = ?1",
        params![id, now],
    )?;
    Ok(())
}

pub fn failed(conn: &Connection, id: &str, why: &str) -> Result<()> {
    conn.execute(
        "UPDATE peer_outbox SET tries = tries + 1, error = ?2 WHERE id = ?1",
        params![id, why.chars().take(200).collect::<String>()],
    )?;
    Ok(())
}

/// Not sent, and nothing wrong (`Deposit::Later`): the row says why it
/// waits, and keeps its tries, so a friend away for a week does not leave
/// it stranded at `TRIES_MAX`. When the relay named the moment (`until`:
/// a Retry-After, or a busy relay's minute) the row waits exactly that
/// long and the wait is the relay's, not the friend's, so `later` stays.
/// Otherwise the friend is away: `later` counts the run of "not now"s and
/// the wait doubles from ten minutes, 20, 40, 80, 160, 320, to six hours
/// (`LATER_MAX` of them, thirty days at six hours, and the frame stops,
/// with Retry). The power is capped, so no run of misses overflows.
pub fn waiting(conn: &Connection, id: &str, why: &str, now: i64, until: Option<i64>) -> Result<()> {
    let why: String = why.chars().take(200).collect();
    match until {
        Some(at) => conn.execute(
            "UPDATE peer_outbox SET error = ?2, next_at = ?3 WHERE id = ?1",
            params![id, why, at.max(now)],
        )?,
        None => conn.execute(
            "UPDATE peer_outbox SET error = ?2, later = later + 1,
                next_at = ?3 + min(600 * (1 << min(later, 6)), 21600) WHERE id = ?1",
            params![id, why, now],
        )?,
    };
    Ok(())
}

/// Sent down the line, waiting for the friend's ack: tried again in ten
/// minutes if none comes, and a try is spent, so a line that never acks
/// ends at `TRIES_MAX` like a relay that never answers.
pub fn pending(conn: &Connection, id: &str, now: i64) -> Result<()> {
    conn.execute(
        "UPDATE peer_outbox SET tries = tries + 1, error = '', next_at = ?2 + 600 WHERE id = ?1",
        params![id, now],
    )?;
    Ok(())
}

/// A friend is here -- something came from them, their snyvi updated, their
/// line opened, the reader sent them something new -- so what waits for
/// them is due now, and its run of "not now"s starts over.
pub fn due_now(conn: &Connection, peer_id: i64) -> Result<usize> {
    Ok(conn.execute(
        "UPDATE peer_outbox SET next_at = 0, later = 0 WHERE peer_id = ?1 AND sent_at = 0 AND (next_at != 0 OR later != 0)",
        params![peer_id],
    )?)
}

/// "Not now" answers in a row after which a frame stops: thirty days at
/// the six-hour wait.
pub const LATER_MAX: i64 = 124;

/// What waits in the outbox, for the friends list to show: each frame not
/// gone, what it is, how often it failed and why. A frame at `stopped` tries
/// is not tried again until the reader says Retry.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct Outgoing {
    pub id: String,
    pub peer_id: i64,
    /// The document's title, or the line.
    pub what: String,
    pub queued_at: i64,
    pub tries: i64,
    pub error: String,
    /// The run of "not now" answers (`waiting`): the Friends card says
    /// stopped at `LATER_MAX` of them.
    pub later: i64,
}

pub fn outgoing(conn: &Connection) -> Result<Vec<Outgoing>> {
    let rows = conn
        .prepare(
            "SELECT o.id, o.peer_id, COALESCE(d.title, o.text), o.queued_at, o.tries, o.error, o.later
             FROM peer_outbox o JOIN peers p ON p.id = o.peer_id LEFT JOIN docs d ON d.id = o.doc_id AND o.doc_id != ''
             WHERE o.sent_at = 0 AND p.removed_at = 0 AND o.kind != 'receipt' ORDER BY o.queued_at, o.id",
        )?
        .query_map([], |r| {
            Ok(Outgoing {
                id: r.get(0)?,
                peer_id: r.get(1)?,
                what: r.get(2)?,
                queued_at: r.get(3)?,
                tries: r.get(4)?,
                error: r.get(5)?,
                later: r.get(6)?,
            })
        })?
        .collect::<std::result::Result<_, _>>()?;
    Ok(rows)
}

/// A document or a line that went, and what came back about it: the Sent
/// list in a friend's row. Newest first.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct Sent {
    pub id: String,
    pub peer_id: i64,
    /// The document's id, or empty for a line.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub doc_id: String,
    /// The document's title, or the line.
    pub what: String,
    pub sent_at: i64,
    #[serde(skip_serializing_if = "is_zero")]
    pub arrived_at: i64,
    #[serde(skip_serializing_if = "is_zero")]
    pub read_at: i64,
    #[serde(skip_serializing_if = "is_zero")]
    pub done_at: i64,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub done_commit: String,
}

/// The last `limit` that went to each friend.
pub fn sent_recent(conn: &Connection, limit: i64) -> Result<Vec<Sent>> {
    let rows = conn
        .prepare(
            "SELECT id, peer_id, doc_id, what, sent_at, arrived_at, read_at, done_at, done_commit FROM (
               SELECT o.id, o.peer_id, o.doc_id, COALESCE(d.title, o.text) AS what, o.sent_at, o.arrived_at, o.read_at,
                      o.done_at, o.done_commit,
                      ROW_NUMBER() OVER (PARTITION BY o.peer_id ORDER BY o.sent_at DESC, o.id) AS n
               FROM peer_outbox o JOIN peers p ON p.id = o.peer_id
               LEFT JOIN docs d ON d.id = o.doc_id AND o.doc_id != ''
               WHERE o.sent_at != 0 AND o.kind = '' AND p.removed_at = 0)
             WHERE n <= ?1 ORDER BY sent_at DESC, id",
        )?
        .query_map(params![limit], |r| {
            Ok(Sent {
                id: r.get(0)?,
                peer_id: r.get(1)?,
                doc_id: r.get(2)?,
                what: r.get(3)?,
                sent_at: r.get(4)?,
                arrived_at: r.get(5)?,
                read_at: r.get(6)?,
                done_at: r.get(7)?,
                done_commit: r.get(8)?,
            })
        })?
        .collect::<std::result::Result<_, _>>()?;
    Ok(rows)
}

/// A friend says a frame this snyvi sent arrived, or was read. Only a frame
/// that went to that friend: a receipt for anything else is nothing.
pub fn receipt(conn: &Connection, peer_id: i64, of: &str, state: &str, now: i64) -> Result<bool> {
    let n = match state {
        "arrived" => conn.execute(
            "UPDATE peer_outbox SET arrived_at = ?3 WHERE id = ?1 AND peer_id = ?2 AND kind = '' AND arrived_at = 0",
            params![of, peer_id, now],
        )?,
        "read" => conn.execute(
            "UPDATE peer_outbox SET read_at = ?3, arrived_at = CASE WHEN arrived_at = 0 THEN ?3 ELSE arrived_at END
             WHERE id = ?1 AND peer_id = ?2 AND kind = '' AND doc_id != '' AND read_at = 0",
            params![of, peer_id, now],
        )?,
        _ => 0,
    };
    Ok(n > 0)
}

/// A friend ticked a line this snyvi sent them, and said so. The line's
/// row, and its text, for the reader to be told.
pub fn done(
    conn: &Connection,
    peer_id: i64,
    of: &str,
    commit: &str,
    now: i64,
) -> Result<Option<String>> {
    // A hash as the tick said it, and nothing after it: never letters
    // gathered from the words around one.
    let commit: String = commit
        .trim()
        .chars()
        .take_while(char::is_ascii_hexdigit)
        .take(40)
        .collect();
    let n = conn.execute(
        "UPDATE peer_outbox SET done_at = ?3, done_commit = ?4, arrived_at = CASE WHEN arrived_at = 0 THEN ?3 ELSE arrived_at END
         WHERE id = ?1 AND peer_id = ?2 AND kind = '' AND doc_id = '' AND done_at = 0",
        params![of, peer_id, now, commit],
    )?;
    if n == 0 {
        return Ok(None);
    }
    Ok(conn
        .query_row(
            "SELECT text FROM peer_outbox WHERE id = ?1",
            params![of],
            |r| r.get(0),
        )
        .optional()?)
}

/// Whether this snyvi sent `doc_id` to that friend: a reply to anything
/// else is nothing.
pub fn sent_doc(conn: &Connection, peer_id: i64, doc_id: &str) -> Result<bool> {
    Ok(conn
        .query_row(
            "SELECT 1 FROM peer_outbox WHERE peer_id = ?1 AND doc_id = ?2 AND kind = ''",
            params![peer_id, doc_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

/// A friend's one-line reply to a document, kept under it.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct Reply {
    pub from: String,
    pub text: String,
    pub at: i64,
}

pub fn add_reply(
    conn: &Connection,
    peer_id: i64,
    doc_id: &str,
    text: &str,
    now: i64,
) -> Result<Option<String>> {
    let text: String = text.trim().chars().take(REPLY_CHARS).collect();
    if text.is_empty() {
        return Ok(None);
    }
    conn.execute(
        "INSERT INTO peer_replies(peer_id, doc_id, text, at) VALUES(?1, ?2, ?3, ?4)",
        params![peer_id, doc_id, text, now],
    )?;
    Ok(Some(text))
}

/// The replies to any of `doc_ids` -- every version of a document is one
/// conversation -- oldest first.
pub fn replies(conn: &Connection, doc_ids: &[String]) -> Result<Vec<Reply>> {
    let mut out = Vec::new();
    let mut stmt = conn.prepare(
        "SELECT p.name, r.text, r.at FROM peer_replies r JOIN peers p ON p.id = r.peer_id
         WHERE r.doc_id = ?1 AND p.removed_at = 0",
    )?;
    for id in doc_ids {
        let rows = stmt.query_map(params![id], |r| {
            Ok(Reply {
                from: r.get(0)?,
                text: r.get(1)?,
                at: r.get(2)?,
            })
        })?;
        for row in rows {
            out.push(row?);
        }
    }
    out.sort_by_key(|r| r.at);
    // The head shows the last of them: a conversation longer than this is
    // a document's to hold.
    let cut = out.len().saturating_sub(REPLIES_SHOWN);
    Ok(out.split_off(cut))
}

/// Try a frame again from the start: Retry, on one that stopped.
pub fn retry(conn: &Connection, id: &str) -> Result<bool> {
    Ok(conn.execute(
        "UPDATE peer_outbox SET tries = 0, later = 0, next_at = 0, error = '' WHERE id = ?1 AND sent_at = 0",
        params![id],
    )? > 0)
}

/// A frame that opened as a kind this snyvi does not know (`Content::Other`),
/// held as it came -- sealed, as the relay had it -- for a newer snyvi to
/// open. The same frame twice is one row.
pub fn hold(conn: &Connection, id: &str, peer_id: i64, bytes: &[u8], now: i64) -> Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO peer_held(id, peer_id, bytes, held_at) VALUES(?1, ?2, ?3, ?4)",
        params![id, peer_id, bytes, now],
    )?;
    Ok(())
}

/// Every held frame: (id, friend, the sealed bytes), oldest first.
pub fn held(conn: &Connection) -> Result<Vec<(String, i64, Vec<u8>)>> {
    let rows = conn
        .prepare("SELECT id, peer_id, bytes FROM peer_held ORDER BY held_at, id")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<std::result::Result<_, _>>()?;
    Ok(rows)
}

/// A held frame read at last, or one too old to wait for: gone.
pub fn unhold(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM peer_held WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn prune_held(conn: &Connection, before: i64) -> Result<usize> {
    Ok(conn.execute("DELETE FROM peer_held WHERE held_at < ?1", params![before])?)
}

/// A friend's line arrives.
pub fn note_arrived(
    conn: &Connection,
    peer_id: i64,
    text: &str,
    frame: &str,
    now: i64,
) -> Result<i64> {
    let text: String = text.trim().chars().take(NOTE_CHARS).collect();
    conn.execute(
        "INSERT INTO peer_notes(peer_id, text, frame, arrived_at) VALUES(?1, ?2, ?3, ?4)",
        params![peer_id, text, frame, now],
    )?;
    Ok(conn.last_insert_rowid())
}

/// Lines waiting for the reader, from friends still on the list.
pub fn notes_waiting(conn: &Connection) -> Result<Vec<PeerNote>> {
    let rows = conn
        .prepare(
            "SELECT n.id, n.peer_id, p.name, n.text, n.arrived_at, n.frame FROM peer_notes n JOIN peers p ON p.id = n.peer_id
             WHERE n.taken_at = 0 AND n.removed_at = 0 AND p.removed_at = 0 ORDER BY n.arrived_at, n.id",
        )?
        .query_map([], |r| {
            Ok(PeerNote {
                id: r.get(0)?,
                peer_id: r.get(1)?,
                from: r.get(2)?,
                text: r.get(3)?,
                arrived_at: r.get(4)?,
                frame: r.get(5)?,
            })
        })?
        .collect::<std::result::Result<_, _>>()?;
    Ok(rows)
}

/// What became of a waiting line: kept on a desk, put away, or back.
pub fn settle_note(conn: &Connection, id: i64, what: &str, now: i64) -> Result<bool> {
    let n = match what {
        "taken" => conn.execute(
            "UPDATE peer_notes SET taken_at = ?2 WHERE id = ?1 AND taken_at = 0",
            params![id, now],
        )?,
        "remove" => conn.execute(
            "UPDATE peer_notes SET removed_at = ?2 WHERE id = ?1 AND removed_at = 0",
            params![id, now],
        )?,
        // No time to set: SQLite refuses a parameter the statement has no place for.
        "restore" => conn.execute(
            "UPDATE peer_notes SET removed_at = 0, taken_at = 0 WHERE id = ?1 AND (removed_at != 0 OR taken_at != 0)",
            params![id],
        )?,
        _ => return Ok(false),
    };
    Ok(n > 0)
}

/// An agent offers a document to a friend; the reader answers.
pub fn offer(
    conn: &Connection,
    peer_id: i64,
    doc_id: &str,
    text: &str,
    pane: &str,
    by: &str,
    now: i64,
) -> Result<i64> {
    conn.execute(
        "INSERT INTO peer_offers(peer_id, doc_id, text, pane, by, offered_at) VALUES(?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            peer_id,
            doc_id,
            text.trim().chars().take(NOTE_CHARS).collect::<String>(),
            pane,
            by.chars().take(60).collect::<String>(),
            now
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn offers_open(conn: &Connection) -> Result<Vec<Offer>> {
    let rows = conn
        .prepare(
            "SELECT o.id, o.peer_id, p.name, o.doc_id, COALESCE(d.title, ''), o.by, o.pane, o.offered_at, o.text
             FROM peer_offers o JOIN peers p ON p.id = o.peer_id LEFT JOIN docs d ON d.id = o.doc_id
             WHERE o.answered_at = 0 AND p.removed_at = 0 ORDER BY o.offered_at, o.id",
        )?
        .query_map([], |r| {
            Ok(Offer {
                id: r.get(0)?,
                peer_id: r.get(1)?,
                to: r.get(2)?,
                doc_id: r.get(3)?,
                title: r.get(4)?,
                by: r.get(5)?,
                pane: r.get(6)?,
                offered_at: r.get(7)?,
                text: r.get(8)?,
            })
        })?
        .collect::<std::result::Result<_, _>>()?;
    Ok(rows)
}

pub fn offer_get(conn: &Connection, id: i64) -> Result<Option<Offer>> {
    Ok(offers_open(conn)?.into_iter().find(|o| o.id == id))
}

/// The reader said Send or Not now. Either way the offer is answered; an
/// unanswered one is answered No when its pane's session ends.
pub fn answer_offer(conn: &Connection, id: i64, sent: bool, now: i64) -> Result<bool> {
    Ok(conn.execute(
        "UPDATE peer_offers SET answered_at = ?2, sent = ?3 WHERE id = ?1 AND answered_at = 0",
        params![id, now, sent as i64],
    )? > 0)
}

/// Not now, taken back: open again, when it was answered No and its pane
/// has not since been swept (`drop_offers_of` answers No too, so the
/// caller asks only within its Undo's few seconds).
pub fn reopen_offer(conn: &Connection, id: i64) -> Result<bool> {
    Ok(conn.execute(
        "UPDATE peer_offers SET answered_at = 0 WHERE id = ?1 AND answered_at != 0 AND sent = 0",
        params![id],
    )? > 0)
}

/// Offers from a pane whose program ended are dropped unsent.
pub fn drop_offers_of(conn: &Connection, pane: &str, now: i64) -> Result<usize> {
    Ok(conn.execute(
        "UPDATE peer_offers SET answered_at = ?2, sent = 0 WHERE pane = ?1 AND answered_at = 0",
        params![pane, now],
    )?)
}

/// Whether a frame by this id was brought in already. The relay pushes a
/// frame again when the link dropped between the push and the ack, and a
/// restart loses nothing in memory, so the id of every frame kept is kept
/// too -- a document sent twice is still one row, but a line would be two.
pub fn taken(conn: &Connection, id: &str) -> Result<bool> {
    Ok(conn
        .query_row(
            "SELECT 1 FROM peer_taken WHERE id = ?1",
            params![id],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

pub fn take(conn: &Connection, id: &str, now: i64) -> Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO peer_taken (id, at) VALUES (?1, ?2)",
        params![id, now],
    )?;
    Ok(())
}

/// Forget ids taken before `before`: how many went.
pub fn prune_taken(conn: &Connection, before: i64) -> Result<usize> {
    Ok(conn.execute("DELETE FROM peer_taken WHERE at < ?1", params![before])?)
}

pub fn clear(conn: &Connection) -> Result<()> {
    conn.execute_batch("DELETE FROM peer_held; DELETE FROM peer_taken; DELETE FROM peer_offers; DELETE FROM peer_notes; DELETE FROM peer_outbox; DELETE FROM peers;")?;
    Ok(())
}

// ---- bytes ----------------------------------------------------------------------

/// base64url without padding: what the relay spells keys in.
pub fn b64(bytes: &[u8]) -> String {
    const A: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = chunk.iter().fold(0u32, |acc, b| (acc << 8) | *b as u32) << (8 * (3 - chunk.len()));
        for i in 0..chunk.len() + 1 {
            out.push(A[((n >> (18 - 6 * i)) & 63) as usize] as char);
        }
    }
    out
}

pub fn unb64(s: &str) -> Option<Vec<u8>> {
    let val = |c: u8| -> Option<u32> {
        Some(match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'-' => 62,
            b'_' => 63,
            _ => return None,
        } as u32)
    };
    let s = s.trim_end_matches('=').as_bytes();
    if s.len() % 4 == 1 {
        return None;
    }
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    for chunk in s.chunks(4) {
        let mut n = 0u32;
        for &c in chunk {
            n = (n << 6) | val(c)?;
        }
        n <<= 6 * (4 - chunk.len());
        for i in 0..chunk.len() - 1 {
            out.push(((n >> (16 - 8 * i)) & 255) as u8);
        }
    }
    Some(out)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests;
