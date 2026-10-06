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

/// A fresh code: `ocean-ladder-fish-kpm`.
pub fn mint_code() -> Result<String> {
    let list = words();
    let mut r = [0u8; 8];
    getrandom::fill(&mut r).map_err(|e| anyhow!("reading random bytes for the code: {e}"))?;
    let n = u64::from_le_bytes(r);
    // Sixteen bits a word over 1,296: the bias is one part in a thousand.
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
    if parts.len() != 4 {
        return Err("a code is three words and three letters, like ocean-ladder-fish-kpm");
    }
    let list = words();
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

/// What travels inside a frame.
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
    },
    /// A line for the reader's notes, with the sender's name.
    Note { text: String, name: String },
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
}

/// The HTTP client the relay is spoken to with. Blocking, like `client.rs`'s:
/// every call here runs under `spawn_blocking`.
fn http() -> ureq::Agent {
    ureq::config::Config::builder()
        .timeout_global(Some(HTTP_TIMEOUT))
        .http_status_as_error(false)
        .build()
        .new_agent()
}

/// One side of a pairing, start to finish. Symmetric: whoever minted the code
/// and whoever typed it run the same steps. Returns the hello the other side
/// sent, verified to open under the SPAKE2 key, and the emoji.
pub fn pair(me: &Identity, code: &str, my_name: &str, until: i64) -> Result<(Peer, String)> {
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
    let theirs = exchange(&agent, &base, &room, "spake", &side, &msg, until)?;
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
    let theirs = exchange(&agent, &base, &room, "hello", &side, &sealed, until)?;
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
    };
    // The keys have to be keys, or nothing is pinned.
    let their_sign = peer.verifying_key()?;
    peer.box_bytes()?;
    if peer.sign_key == me.address() {
        bail!("that is this snyvi's own code");
    }
    let glyphs = emoji(me.sign.verifying_key().as_bytes(), their_sign.as_bytes());
    Ok((peer, glyphs))
}

/// Leave `mine` in the room's `stage` and wait for the other side's, until
/// the code's time is up.
fn exchange(
    agent: &ureq::Agent,
    base: &str,
    room: &str,
    stage: &str,
    side: &str,
    mine: &[u8],
    until: i64,
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
        409 => bail!("someone else already used this code"),
        410 => bail!("this code was already used"),
        s => bail!("the relay answered {s} to the pairing"),
    }
    loop {
        let left = until - crate::store::now();
        if left <= 0 {
            bail!("the code ran out before the other side typed it");
        }
        let wait = left.min(25);
        let mut resp = agent
            .get(&format!("{url}?wait={wait}"))
            .header("x-snyvi-side", side)
            .call()
            .context("reaching the relay")?;
        match resp.status().as_u16() {
            200 => return read_all(&mut resp),
            204 => continue,
            410 => bail!("this code was already used"),
            s => bail!("the relay answered {s} to the pairing"),
        }
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

/// Leave a frame for `to` (an address). The relay's id makes a resend a
/// replacement. `Ok(false)` is the relay saying the mailbox is full.
pub fn deposit(to: &str, id: &str, frame: &[u8]) -> Result<bool> {
    let mut resp = http()
        .post(&format!("{}/to/{to}", relay()))
        .header("x-snyvi-id", id)
        .send(frame)
        .context("reaching the relay")?;
    match resp.status().as_u16() {
        200 | 201 => Ok(true),
        429 => Ok(false),
        s => bail!(
            "the relay answered {s}: {}",
            String::from_utf8_lossy(&read_all(&mut resp)?).trim()
        ),
    }
}

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
    let base = if let Some(rest) = relay.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = relay.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        relay.to_string()
    };
    format!("{base}/inbox/{address}")
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
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
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
    pub fn project_name(&self) -> String {
        format!("From {}", self.name)
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
"#;

const PEER_COLS: &str =
    "id, sign_key, box_key, name, paired_at, muted, removed_at, last_from, last_to";

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
    })
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
         ON CONFLICT(id) DO UPDATE SET queued_at = excluded.queued_at, sent_at = 0, tries = 0, error = ''",
        params![id, peer.id, doc_id, now],
    )?;
    Ok(id)
}

/// What has not gone yet, oldest first: `(frame id, peer id, doc id, tries)`.
pub fn unsent(conn: &Connection) -> Result<Vec<(String, i64, String, i64)>> {
    let rows = conn
        .prepare(
            "SELECT o.id, o.peer_id, o.doc_id, o.tries FROM peer_outbox o JOIN peers p ON p.id = o.peer_id
             WHERE o.sent_at = 0 AND p.removed_at = 0 ORDER BY o.queued_at, o.id",
        )?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
        .collect::<std::result::Result<_, _>>()?;
    Ok(rows)
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

/// A friend's line arrives.
pub fn note_arrived(conn: &Connection, peer_id: i64, text: &str, now: i64) -> Result<i64> {
    let text: String = text.trim().chars().take(NOTE_CHARS).collect();
    conn.execute(
        "INSERT INTO peer_notes(peer_id, text, arrived_at) VALUES(?1, ?2, ?3)",
        params![peer_id, text, now],
    )?;
    Ok(conn.last_insert_rowid())
}

/// Lines waiting for the reader, from friends still on the list.
pub fn notes_waiting(conn: &Connection) -> Result<Vec<PeerNote>> {
    let rows = conn
        .prepare(
            "SELECT n.id, n.peer_id, p.name, n.text, n.arrived_at FROM peer_notes n JOIN peers p ON p.id = n.peer_id
             WHERE n.taken_at = 0 AND n.removed_at = 0 AND p.removed_at = 0 ORDER BY n.arrived_at, n.id",
        )?
        .query_map([], |r| {
            Ok(PeerNote {
                id: r.get(0)?,
                peer_id: r.get(1)?,
                from: r.get(2)?,
                text: r.get(3)?,
                arrived_at: r.get(4)?,
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
    pane: &str,
    by: &str,
    now: i64,
) -> Result<i64> {
    conn.execute(
        "INSERT INTO peer_offers(peer_id, doc_id, pane, by, offered_at) VALUES(?1, ?2, ?3, ?4, ?5)",
        params![
            peer_id,
            doc_id,
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
            "SELECT o.id, o.peer_id, p.name, o.doc_id, COALESCE(d.title, ''), o.by, o.pane, o.offered_at
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
    conn.execute_batch("DELETE FROM peer_taken; DELETE FROM peer_offers; DELETE FROM peer_notes; DELETE FROM peer_outbox; DELETE FROM peers;")?;
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
mod tests {
    use super::*;

    fn two() -> (Identity, Identity) {
        let mut a = [7u8; 64];
        a[0] = 1;
        let mut b = [9u8; 64];
        b[0] = 2;
        (Identity::from_seed(&a), Identity::from_seed(&b))
    }

    fn as_peer(id: &Identity, name: &str) -> Peer {
        Peer {
            id: 1,
            sign_key: id.address(),
            box_key: b64(&id.box_public()),
            name: name.into(),
            paired_at: 0,
            muted: false,
            removed_at: 0,
            last_from: 0,
            last_to: 0,
        }
    }

    #[test]
    fn base64url_round_trips_and_is_what_the_relay_spells() {
        for n in 0..70 {
            let v: Vec<u8> = (0..n).map(|i| (i * 37 % 256) as u8).collect();
            let s = b64(&v);
            assert!(!s.contains('='), "{s}");
            assert_eq!(unb64(&s).unwrap(), v, "{n}");
        }
        assert_eq!(b64(b"hello"), "aGVsbG8");
        assert_eq!(unb64("aGVsbG8=").unwrap(), b"hello");
        assert!(unb64("a").is_none());
        assert!(unb64("a+b/").is_none());
        assert_eq!(b64(&[0u8; 32]).len(), 43, "an address is 43 characters");
    }

    #[test]
    fn a_frame_opens_for_its_recipient_and_for_nobody_else() {
        let (sunny, trapti) = two();
        let content = Content::Document {
            title: "Plan for the garden".into(),
            lang: Some("md".into()),
            file: None,
            name: "Sunny".into(),
            id: "abc123".into(),
        };
        let frame = seal(
            &sunny,
            &as_peer(&trapti, "Trapti"),
            &content,
            b"# the plan\n",
        )
        .unwrap();
        assert_eq!(frame[0], VERSION);
        assert_eq!(sender_of(&frame).as_deref(), Some(sunny.address().as_str()));

        let (got, body) = open(&trapti, &as_peer(&sunny, "Sunny"), &frame).unwrap();
        assert_eq!(got, content);
        assert_eq!(body, b"# the plan\n");

        // A flipped byte in the box: the signature fails first.
        let mut bad = frame.clone();
        bad[60] ^= 1;
        let e = open(&trapti, &as_peer(&sunny, "Sunny"), &bad)
            .unwrap_err()
            .to_string();
        assert!(e.contains("signature"), "{e}");
        // A flipped byte in the signature.
        let mut bad = frame.clone();
        let n = bad.len() - 1;
        bad[n] ^= 1;
        assert!(open(&trapti, &as_peer(&sunny, "Sunny"), &bad).is_err());
        // Pinned keys of someone else: the frame names another sender.
        let stranger = Identity::from_seed(&[3u8; 64]);
        let e = open(&trapti, &as_peer(&stranger, "X"), &frame)
            .unwrap_err()
            .to_string();
        assert!(e.contains("another sender"), "{e}");
        // The wrong recipient has the right pinned sender and still cannot open it.
        assert!(open(&stranger, &as_peer(&sunny, "Sunny"), &frame).is_err());
        // Too short, wrong version.
        assert!(open(&trapti, &as_peer(&sunny, "Sunny"), &frame[..100]).is_err());
        let mut v = frame.clone();
        v[0] = 2;
        assert!(sender_of(&v).is_none());
        assert!(open(&trapti, &as_peer(&sunny, "Sunny"), &v).is_err());
    }

    #[test]
    fn a_note_travels_too_and_the_id_is_one_per_document_and_friend() {
        let (sunny, trapti) = two();
        let frame = seal(
            &sunny,
            &as_peer(&trapti, "Trapti"),
            &Content::Note {
                text: "water the beans".into(),
                name: "Sunny".into(),
            },
            b"",
        )
        .unwrap();
        let (got, body) = open(&trapti, &as_peer(&sunny, "Sunny"), &frame).unwrap();
        assert!(matches!(got, Content::Note { ref text, .. } if text == "water the beans"));
        assert!(body.is_empty());
        assert_eq!(
            frame_id("d1", &trapti.address()),
            frame_id("d1", &trapti.address())
        );
        assert_ne!(
            frame_id("d1", &trapti.address()),
            frame_id("d1", &sunny.address())
        );
        assert_eq!(frame_id("d1", "k").len(), 64);
    }

    #[test]
    fn a_code_is_three_words_a_check_and_ten_minutes_of_room() {
        let code = mint_code().unwrap();
        let parts: Vec<&str> = code.split('-').collect();
        assert_eq!(parts.len(), 4, "{code}");
        assert_eq!(parts[3].len(), 3);
        assert_eq!(normalize_code(&code).unwrap(), code);
        assert_eq!(
            normalize_code(&format!("  {} ", code.to_uppercase().replace('-', " "))).unwrap(),
            code
        );
        assert!(normalize_code("ocean ladder").is_err());
        assert!(
            normalize_code("ocean-ladder-xyzzy-abc").is_err(),
            "not a word"
        );
        let mut wrong = parts[..3].join("-");
        wrong.push_str(if parts[3] == "bbb" { "-ccc" } else { "-bbb" });
        assert!(normalize_code(&wrong).unwrap_err().contains("heard wrong"));
        assert_eq!(room_of(&code).len(), 64);
        assert_ne!(room_of(&code), room_of("acid-acorn-acre-bbb"));
        assert_eq!(words().len(), 1296);
    }

    #[test]
    fn the_emoji_are_four_and_the_same_from_either_side() {
        let (a, b) = two();
        let x = emoji(
            a.sign.verifying_key().as_bytes(),
            b.sign.verifying_key().as_bytes(),
        );
        let y = emoji(
            b.sign.verifying_key().as_bytes(),
            a.sign.verifying_key().as_bytes(),
        );
        assert_eq!(x, y);
        assert_eq!(x.split(' ').count(), 4, "{x}");
        let c = Identity::from_seed(&[5u8; 64]);
        assert_ne!(
            x,
            emoji(
                a.sign.verifying_key().as_bytes(),
                c.sign.verifying_key().as_bytes()
            )
        );
    }

    #[test]
    fn the_identity_is_kept_once_and_read_back_the_same() {
        let dir = crate::store::tempdir::Dir::new("snyvi-peer-id");
        let s = crate::secrets::Secrets::file_only(dir.path.join("keys.json"));
        assert!(
            Identity::load(&s).is_none(),
            "nothing minted before anyone pairs"
        );
        let a = Identity::load_or_mint(&s).unwrap();
        let b = Identity::load_or_mint(&s).unwrap();
        assert_eq!(a.address(), b.address());
        assert_eq!(a.box_public(), b.box_public());
        assert_eq!(Identity::load(&s).unwrap().address(), a.address());
        let auth = a.relay_auth("GET", "/inbox/x");
        let (secs, sig) = auth.split_once('.').unwrap();
        assert!(secs.parse::<i64>().is_ok());
        assert_eq!(unb64(sig).unwrap().len(), 64);
    }

    #[test]
    fn friends_are_pinned_listed_renamed_muted_removed_and_restored() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE docs (id TEXT PRIMARY KEY, title TEXT NOT NULL);")
            .unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        let (sunny, trapti) = two();
        let t = pin(&conn, &as_peer(&trapti, "Trapti"), 100).unwrap();
        assert_eq!(t.name, "Trapti");
        assert_eq!(t.paired_at, 100);
        assert_eq!(list(&conn).unwrap().len(), 1);
        assert!(by_name(&conn, " trapti ").unwrap().is_some());
        assert!(rename(&conn, t.id, "T").unwrap());
        assert!(
            !rename(&conn, t.id, "   ").unwrap(),
            "a name is not nothing"
        );
        assert!(mute(&conn, t.id, true).unwrap());
        assert!(get(&conn, t.id).unwrap().unwrap().muted);
        assert!(remove(&conn, t.id, 200).unwrap());
        assert!(
            by_name(&conn, "T").unwrap().is_none(),
            "removed is off the list"
        );
        assert!(restore(&conn, t.id).unwrap());
        assert!(by_name(&conn, "T").unwrap().is_some());
        // Pairing again with the same friend who got new keys keeps the row.
        let mut again = as_peer(&trapti, "Trapti");
        again.box_key = b64(&sunny.box_public());
        let t2 = pin(&conn, &again, 300).unwrap();
        assert_eq!(t2.id, t.id);
        assert_eq!(t2.name, "T", "the reader's name for them stands");
        assert_eq!(t2.box_key, b64(&sunny.box_public()));

        // The outbox: one row per document and friend, queued again on a resend.
        let fid = queue(&conn, &t2, "doc1", 400).unwrap();
        assert_eq!(queue(&conn, &t2, "doc1", 401).unwrap(), fid);
        assert_eq!(unsent(&conn).unwrap().len(), 1);
        failed(&conn, &fid, "offline").unwrap();
        assert_eq!(unsent(&conn).unwrap()[0].3, 1);
        sent(&conn, &fid, 402).unwrap();
        assert!(unsent(&conn).unwrap().is_empty());

        // Notes wait, are taken, put away, brought back.
        let n = note_arrived(&conn, t2.id, "  water the beans  ", 500).unwrap();
        assert_eq!(notes_waiting(&conn).unwrap()[0].text, "water the beans");
        assert!(settle_note(&conn, n, "taken", 501).unwrap());
        assert!(notes_waiting(&conn).unwrap().is_empty());
        assert!(settle_note(&conn, n, "restore", 502).unwrap());
        assert!(settle_note(&conn, n, "remove", 503).unwrap());
        assert!(!settle_note(&conn, n, "eat", 503).unwrap());

        // Offers: open until answered, dropped with their pane.
        conn.execute("INSERT INTO docs VALUES('doc1', 'Plan')", [])
            .unwrap();
        let o = offer(&conn, t2.id, "doc1", "pane-a", "Claude", 600).unwrap();
        let open = offers_open(&conn).unwrap();
        assert_eq!(open[0].title, "Plan");
        assert_eq!(open[0].to, "T");
        assert!(answer_offer(&conn, o, true, 601).unwrap());
        assert!(!answer_offer(&conn, o, true, 601).unwrap(), "answered once");
        offer(&conn, t2.id, "doc1", "pane-a", "Claude", 602).unwrap();
        assert_eq!(drop_offers_of(&conn, "pane-a", 603).unwrap(), 1);
        assert!(offers_open(&conn).unwrap().is_empty());

        // What was brought in is remembered, until it is too old to recur.
        assert!(!taken(&conn, "f1").unwrap());
        take(&conn, "f1", 700).unwrap();
        take(&conn, "f1", 701).unwrap();
        take(&conn, "f2", 800).unwrap();
        assert!(taken(&conn, "f1").unwrap());
        assert_eq!(prune_taken(&conn, 750).unwrap(), 1);
        assert!(!taken(&conn, "f1").unwrap());
        assert!(taken(&conn, "f2").unwrap());
        clear(&conn).unwrap();
        assert!(list(&conn).unwrap().is_empty());
        assert!(!taken(&conn, "f2").unwrap());
    }

    #[test]
    fn the_link_knows_its_address_and_its_messages() {
        let (a, _) = two();
        assert_eq!(
            ws_of("http://127.0.0.1:8799", &a.address()),
            format!("ws://127.0.0.1:8799/inbox/{}", a.address())
        );
        assert_eq!(
            ws_of(RELAY, &a.address()),
            format!("wss://relay.snyvi.com/inbox/{}", a.address())
        );
        assert!(relay_ws(&a.address()).starts_with("ws"));

        let pushed: Pushed = serde_json::from_str(
            r#"{"frame":{"id":"ab","sender":"k","size":12,"at":1700000000000}}"#,
        )
        .unwrap();
        let Pushed::Frame(w) = pushed;
        assert_eq!((w.id.as_str(), w.sender.as_str(), w.size), ("ab", "k", 12));
        assert!(
            serde_json::from_str::<Pushed>(r#"{"hello":{}}"#).is_err(),
            "a message this daemon does not know is not a frame"
        );
        assert!(serde_json::from_str::<Pushed>("pong").is_err());
        assert_eq!(ack_message("ab"), r#"{"ack":"ab"}"#);
    }

    #[test]
    fn the_backoff_climbs_and_stops() {
        let mut last = Duration::ZERO;
        for attempt in 0..12 {
            let b = backoff(attempt);
            let base = Duration::from_secs(1 << attempt).min(BACKOFF_MAX);
            assert!(
                b >= base && b <= base.mul_f64(1.3),
                "attempt {attempt}: {b:?}"
            );
            // Monotone in its base, jitter aside.
            assert!(base >= last);
            last = base;
        }
        assert!(
            backoff(40) <= BACKOFF_MAX.mul_f64(1.3),
            "capped, not overflowed"
        );
    }
}
