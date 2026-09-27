//! The daemon updates itself.
//!
//! At three or four releases a day, "run the installer again" is not an
//! update process. So the daemon is the updater: it reads `latest.json` off
//! the newest GitHub release a few times a day, stages the downloads for its
//! own channel under `<data>/updates/<version>/`, checks every sha256 the
//! manifest names, and -- once a day, at a quiet moment, through the doors in
//! `door` below -- swaps the files by `rename` and hands off to the new binary
//! with the planned restart of `server.rs`. The window shows a pill and
//! clicks it; the CLI has a manual twin in `snyvi update`; the page never
//! talks to GitHub.
//!
//! What is trusted: the manifest is signed with minisign and the public key
//! is compiled in (`packaging/minisign.pub`), so a manifest that did not come
//! from the release job is refused before a byte is downloaded. The sha256 in
//! the manifest is checked as each download lands and once more on the file
//! just placed, so a truncated download or a full disk is a retry, never a
//! half-written binary. The old file stays beside the new one as `.prev`, and
//! `snyvi update --back` or a successor that never answers puts it back.
//!
//! What is silent: every channel where the files are the reader's own -- a
//! tarball anywhere, the bundle in Applications, the folder Inno or Scoop
//! made on Windows. Told, never touched: a `.deb` (root owns it) and a cargo
//! build (the reader chose to compile). Off: a dev build, which is anything
//! under a `target/` directory or a daemon serving `ui/` off disk.
//!
//! Two clocks. Checks are every six hours or so on a monotonic timer, since
//! they cost one small GET and mostly a 304. Applies are at most one a day,
//! counted from `last_applied` on the wall clock and written to disk, so a
//! restart does not open a second slot and a crash-restart does not move it:
//! only the planned restart's marker says an apply happened. The
//! `hotfix_below` field in the manifest is the one thing that moves a machine
//! sooner, and it is set by hand in the release job.

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

/// The release key. Its private half is a repository secret the release job
/// signs with; a manifest anyone else wrote fails here.
pub const PUBLIC_KEY: &str = include_str!("../packaging/minisign.pub");

/// Where the newest release's manifest is, and where a release's downloads
/// are. GitHub serves both as static files with no rate limit.
const REPO: &str = "snymrova/snyvi";

/// The floor: an automatic apply at most this long after the last one, plus
/// up to `SLOT_JITTER` so a fleet does not move at once.
const SLOT: i64 = 24 * 3600;
const SLOT_JITTER: i64 = 3600;
/// Between checks, on a monotonic timer, give or take `CHECK_JITTER`.
pub const CHECK_EVERY: Duration = Duration::from_secs(6 * 3600);
pub const CHECK_JITTER: Duration = Duration::from_secs(30 * 60);
/// The first check after a start: late enough not to race the window's first
/// paint, early enough that `Check now` finds an answer from this morning.
pub const FIRST_CHECK: Duration = Duration::from_secs(30);
pub const FIRST_CHECK_JITTER: Duration = Duration::from_secs(60);
/// A window that has been in the background this long, with the panes
/// quiet, is one nobody is reading: door 2.
pub const BACKGROUND: Duration = Duration::from_secs(10 * 60);
/// A staged update the pill has shown for a day without a click is one the
/// reader is not going to click: the pill turns amber, and says why.
pub const PILL_AMBER: i64 = 24 * 3600;
/// A download larger than this is not one of ours.
const DOWNLOAD_MAX: u64 = 256 << 20;
/// A manifest larger than this is not one either.
const MANIFEST_MAX: u64 = 1 << 20;

// ---------- the channel ----------

/// How this snyvi was installed, and so what an update can do to it.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Channel {
    /// A tarball anywhere: the files are the reader's own, and are swapped.
    Tar,
    /// `snyvi.app`, in Applications or wherever it was dragged; the cask too.
    Mac,
    /// The folder the Inno installer or Scoop made; a zip unpacked anywhere.
    Win,
    /// `/usr/bin/snyvi` from the package: root owns it, so the reader is told.
    Deb,
    /// `~/.cargo/bin`: the reader chose to compile, and is told.
    Cargo,
    /// A tarball or a zip in a folder this user cannot write -- copied into
    /// /usr/local/bin with sudo, say: told, since a swap would only fail.
    Locked,
    /// A build under `target/`, or a daemon serving `ui/` off disk: never
    /// checked, never touched.
    Dev,
}

impl Channel {
    /// The table in the plan, as one pure function. `receipt` is what
    /// `install.sh` wrote to `<config>/install.json`, when it wrote one;
    /// `dev_env` says `SNYVI_UI_DIR` is set.
    pub fn detect(exe: &Path, receipt: Option<&str>, dev_env: bool) -> Channel {
        if dev_env || exe.components().any(|c| c.as_os_str() == "target") {
            return Channel::Dev;
        }
        if let Some(ch) = receipt.and_then(Channel::named) {
            return ch;
        }
        let s = exe.to_string_lossy().replace('\\', "/");
        if s.contains("/.cargo/bin/") {
            return Channel::Cargo;
        }
        if s.contains(".app/Contents/MacOS/") {
            return Channel::Mac;
        }
        if cfg!(windows) || s.as_bytes().get(1) == Some(&b':') {
            return Channel::Win;
        }
        if ["/usr/bin/", "/usr/sbin/", "/usr/lib/", "/usr/libexec/"]
            .iter()
            .any(|p| s.starts_with(p))
        {
            return Channel::Deb;
        }
        Channel::Tar
    }

    pub fn named(name: &str) -> Option<Channel> {
        Some(match name {
            "tar" => Channel::Tar,
            "mac" => Channel::Mac,
            "win" => Channel::Win,
            "deb" => Channel::Deb,
            "cargo" => Channel::Cargo,
            "locked" => Channel::Locked,
            "dev" => Channel::Dev,
            _ => return None,
        })
    }

    pub fn name(self) -> &'static str {
        match self {
            Channel::Tar => "tar",
            Channel::Mac => "mac",
            Channel::Win => "win",
            Channel::Deb => "deb",
            Channel::Cargo => "cargo",
            Channel::Locked => "locked",
            Channel::Dev => "dev",
        }
    }

    /// Whether an update is applied here without asking, or only told of.
    pub fn silent(self) -> bool {
        matches!(self, Channel::Tar | Channel::Mac | Channel::Win)
    }

    /// The lines a told-only channel's reader runs, for About and the CLI.
    pub fn how(self, arch: &str) -> Vec<String> {
        match self {
            Channel::Deb => vec![
                format!("curl -fsSLO https://github.com/{REPO}/releases/latest/download/snyvi-linux-{arch}.deb"),
                format!("sudo dpkg -i snyvi-linux-{arch}.deb"),
            ],
            Channel::Cargo => vec!["cargo install snyvi".into()],
            _ => vec![],
        }
    }
}

/// What the release names its downloads by.
#[derive(Clone, Copy, Debug)]
pub struct Platform {
    pub os: &'static str,
    pub arch: &'static str,
}

impl Platform {
    pub const fn here() -> Platform {
        let os = if cfg!(target_os = "linux") {
            "linux"
        } else if cfg!(target_os = "macos") {
            "macos"
        } else if cfg!(windows) {
            "windows"
        } else {
            ""
        };
        let arch = if cfg!(target_arch = "x86_64") {
            "x64"
        } else if cfg!(target_arch = "aarch64") {
            "arm64"
        } else {
            ""
        };
        Platform { os, arch }
    }

    /// The manifest's key for this channel here: `linux-x64`, `macos-arm64`,
    /// `windows-x64`, `deb-x64`.
    pub fn key(&self, channel: Channel) -> String {
        match channel {
            Channel::Deb => format!("deb-{}", self.arch),
            _ => format!("{}-{}", self.os, self.arch),
        }
    }
}

// ---------- the manifest ----------

/// `latest.json`, as `packaging/manifest.py` writes it.
#[derive(Clone, Debug, Deserialize)]
pub struct Manifest {
    pub version: String,
    // `channel` ("daily") is in the file for a slower train later; nothing
    // reads it yet, and serde passes over a field it is not asked for.
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub app_min: Option<String>,
    #[serde(default)]
    pub hotfix_below: Option<String>,
    /// `platform key -> role -> [name, sha256]`.
    #[serde(default)]
    pub assets: BTreeMap<String, BTreeMap<String, (String, String)>>,
}

/// One download the manifest names for this machine.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Asset {
    pub role: String,
    pub name: String,
    pub sha256: String,
}

impl Manifest {
    pub fn parse(bytes: &[u8]) -> Result<Manifest> {
        let m: Manifest = serde_json::from_slice(bytes).context("reading latest.json")?;
        semver::Version::parse(&m.version).with_context(|| {
            format!(
                "latest.json names a version that is not one: {:?}",
                m.version
            )
        })?;
        Ok(m)
    }

    pub fn version(&self) -> semver::Version {
        semver::Version::parse(&self.version).expect("checked in parse")
    }

    /// The downloads a channel takes on a platform. `with_app` says a
    /// `snyvi-app` sits beside the daemon on Linux, so the window is swapped
    /// too. A told-only channel takes nothing.
    pub fn wanted(
        &self,
        channel: Channel,
        platform: &Platform,
        with_app: bool,
    ) -> Result<Vec<Asset>> {
        let roles: Vec<&str> = match channel {
            Channel::Tar if with_app => vec!["snyvi", "app"],
            Channel::Tar => vec!["snyvi"],
            Channel::Mac => vec!["bundle"],
            Channel::Win => vec!["zip"],
            _ => return Ok(vec![]),
        };
        let key = platform.key(channel);
        let table = self
            .assets
            .get(&key)
            .ok_or_else(|| anyhow!("{} names no downloads for {key}", self.version))?;
        roles
            .into_iter()
            .map(|role| -> Result<Asset> {
                let (name, sha256) = table.get(role).ok_or_else(|| {
                    anyhow!("{} names no {role} download for {key}", self.version)
                })?;
                if sha256.len() != 64 || !sha256.bytes().all(|b| b.is_ascii_hexdigit()) {
                    bail!("{name}: the manifest's checksum is not a sha256");
                }
                Ok(Asset {
                    role: role.into(),
                    name: name.clone(),
                    sha256: sha256.to_ascii_lowercase(),
                })
            })
            .collect()
    }
}

// ---------- the network, behind a seam ----------

/// What a GET came back with.
pub enum Got {
    /// The ETag sent matched: nothing has changed since.
    NotModified,
    Body {
        bytes: Vec<u8>,
        etag: Option<String>,
    },
}

/// The network, so tests never reach GitHub.
pub trait Fetch: Send + Sync {
    /// A small file, with `If-None-Match` when an ETag is known.
    fn get(&self, url: &str, etag: Option<&str>) -> Result<Got>;
    /// A large one, streamed to `to`. Returns the bytes written.
    fn download(&self, url: &str, to: &Path) -> Result<u64>;
}

/// The real one: `ureq`, five seconds to connect, a `snyvi/<version>` user
/// agent, and nothing else in the request.
pub struct Http;

fn user_agent() -> String {
    format!("snyvi/{}", crate::server::VERSION)
}

impl Fetch for Http {
    fn get(&self, url: &str, etag: Option<&str>) -> Result<Got> {
        let mut req = ureq::get(url)
            .header("User-Agent", &user_agent())
            .config()
            .timeout_global(Some(Duration::from_secs(15)))
            .http_status_as_error(false)
            .build();
        if let Some(e) = etag {
            req = req.header("If-None-Match", e);
        }
        let mut r = req.call().with_context(|| format!("GET {url}"))?;
        match r.status().as_u16() {
            304 => Ok(Got::NotModified),
            200 => {
                let etag = r
                    .headers()
                    .get("etag")
                    .and_then(|v| v.to_str().ok())
                    .map(str::to_string);
                let bytes = r
                    .body_mut()
                    .with_config()
                    .limit(MANIFEST_MAX)
                    .read_to_vec()
                    .with_context(|| format!("reading {url}"))?;
                Ok(Got::Body { bytes, etag })
            }
            s => bail!("GET {url}: HTTP {s}"),
        }
    }

    fn download(&self, url: &str, to: &Path) -> Result<u64> {
        let mut r = ureq::get(url)
            .header("User-Agent", &user_agent())
            .config()
            .timeout_connect(Some(Duration::from_secs(5)))
            .timeout_recv_body(Some(Duration::from_secs(300)))
            .http_status_as_error(false)
            .build()
            .call()
            .with_context(|| format!("GET {url}"))?;
        if r.status().as_u16() != 200 {
            bail!("GET {url}: HTTP {}", r.status().as_u16());
        }
        let mut file =
            fs::File::create(to).with_context(|| format!("creating {}", to.display()))?;
        let mut reader = r.body_mut().with_config().limit(DOWNLOAD_MAX).reader();
        let n =
            std::io::copy(&mut reader, &mut file).with_context(|| format!("downloading {url}"))?;
        file.sync_all().ok();
        Ok(n)
    }
}

/// Where the manifest and the downloads are. GitHub's layout, or a flat
/// directory for the bench (`SNYVI_UPDATE_URL`).
#[derive(Clone, Debug)]
pub enum Source {
    GitHub,
    Flat(String),
}

impl Source {
    pub fn from_env() -> Source {
        match std::env::var("SNYVI_UPDATE_URL") {
            Ok(u) if !u.is_empty() => {
                Source::Flat(if u.ends_with('/') { u } else { format!("{u}/") })
            }
            _ => Source::GitHub,
        }
    }
    /// The newest release's manifest.
    pub fn manifest(&self) -> String {
        match self {
            Source::GitHub => {
                format!("https://github.com/{REPO}/releases/latest/download/latest.json")
            }
            Source::Flat(base) => format!("{base}latest.json"),
        }
    }
    /// One release's manifest, for `snyvi update --to`.
    pub fn manifest_for(&self, version: &str) -> String {
        match self {
            Source::GitHub => {
                format!("https://github.com/{REPO}/releases/download/v{version}/latest.json")
            }
            Source::Flat(base) => format!("{base}v{version}/latest.json"),
        }
    }
    pub fn asset(&self, version: &str, name: &str) -> String {
        match self {
            Source::GitHub => {
                format!("https://github.com/{REPO}/releases/download/v{version}/{name}")
            }
            Source::Flat(base) => format!("{base}{name}"),
        }
    }
}

// ---------- the state ----------

/// What the updater knows, in memory and mirrored to
/// `<data>/updates/state.json`. Every timestamp is wall time, in seconds,
/// because the floor has to survive a restart.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct State {
    /// When the manifest was last read, and its ETag for the next read.
    pub checked_at: Option<i64>,
    pub etag: Option<String>,
    /// A newer version the manifest named, whether or not it can be applied.
    pub available: Option<String>,
    /// The version staged and verified, ready to apply.
    pub ready: Option<String>,
    /// A version that was applied and did not come up, so is not tried again,
    /// and when: the pill says so for a day, About for as long as it is so.
    pub failed: Option<String>,
    pub failed_at: Option<i64>,
    /// A version the reader went back from (`snyvi update --back`): not
    /// staged again on its own either, and not called a failure.
    pub skipped: Option<String>,
    /// When `ready` first became so, for the pill's ageing.
    pub since: Option<i64>,
    /// When the last update was applied, by the daemon that came up on it.
    pub last_applied: Option<i64>,
    /// When the next automatic apply may happen.
    pub slot: Option<i64>,
    /// A manual check or `snyvi update` asked: the floor does not apply.
    pub asked: bool,
    /// The version being applied at a planned exit, and the sha256 of the
    /// daemon file placed, so the daemon that comes up can tell the swap held.
    pub applying: Option<String>,
    pub applying_sha: Option<String>,
    /// The version the last apply landed and the sha256 of the file it
    /// placed: what `--back` remembers as the one not to stage again, and
    /// what `current` reads.
    pub applied: Option<String>,
    pub applied_sha: Option<String>,
    /// The oldest window the applied version wants; a running window older
    /// than it is relaunched once.
    pub app_min: Option<String>,
    /// From the last manifest read.
    pub latest_app_min: Option<String>,
    pub hotfix_below: Option<String>,
    pub notes: Option<String>,
    /// The last check's failure, if it failed; shown in About and by the CLI,
    /// never as a pill.
    pub error: Option<String>,
}

/// One file the stager unpacked and hashed, in `<version>/staged.json`.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct StagedFile {
    pub role: String,
    pub path: PathBuf,
    pub sha256: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Staged {
    pub version: String,
    pub app_min: Option<String>,
    pub files: Vec<StagedFile>,
}

// ---------- the updater ----------

pub struct Updater {
    pub channel: Channel,
    pub platform: Platform,
    /// The daemon's file, by the path recorded at start, and the window's
    /// beside it when there is one (Linux); the bundle on macOS is found
    /// from the daemon's path.
    exe: PathBuf,
    app: Option<PathBuf>,
    /// `<data>/updates`.
    dir: PathBuf,
    /// `<config>/updates.json`, the off switch.
    switch: PathBuf,
    source: Source,
    fetch: Box<dyn Fetch>,
    key: minisign_verify::PublicKey,
    running: semver::Version,
    /// `current`, worked out once per start.
    current: Mutex<Option<semver::Version>>,
    state: Mutex<State>,
    /// Whether the automatic path runs at all. `SNYVI_UPDATES=off` wins over
    /// the file, for CI, packagers and the dev loop.
    auto: AtomicBool,
    env_off: bool,
    /// One check at a time.
    checking: Mutex<()>,
}

impl Updater {
    /// The daemon's updater. `exe` is the path recorded at start.
    pub fn new(paths: &crate::config::Paths, exe: &Path, fetch: Box<dyn Fetch>) -> Updater {
        // The installer's receipt, when it describes the folder this binary
        // is in: a receipt left by a per-user install says nothing about a
        // package installed over it later, and a daemon that believed it
        // would try to rename /usr/bin/snyvi.
        let receipt = fs::read_to_string(paths.config_dir.join("install.json"))
            .ok()
            .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
            .filter(|v| match v["bin_dir"].as_str() {
                Some(dir) => {
                    let dir = Path::new(dir);
                    let dir = dir.canonicalize().unwrap_or_else(|_| dir.to_path_buf());
                    exe.parent() == Some(dir.as_path())
                }
                None => true,
            })
            .and_then(|v| v["channel"].as_str().map(str::to_string));
        let mut channel = Channel::detect(
            exe,
            receipt.as_deref(),
            std::env::var_os("SNYVI_UI_DIR").is_some(),
        );
        // A swap is two renames in the folder the file is in (the bundle's,
        // on a Mac), so that folder has to be this user's to write.
        let folder = match channel {
            Channel::Mac => bundle_of(exe).and_then(|b| b.parent().map(Path::to_path_buf)),
            _ => exe.parent().map(Path::to_path_buf),
        };
        if channel.silent() && !folder.as_deref().is_some_and(writable) {
            channel = Channel::Locked;
        }
        let app = exe
            .parent()
            .map(|d| d.join(crate::platform::exe("snyvi-app")))
            .filter(|p| p.is_file());
        let key = match std::env::var("SNYVI_UPDATE_KEY") {
            // The bench's key, and only with the bench's source: a key from
            // the environment against the real release would be a way to
            // make a daemon take anyone's manifest.
            Ok(k) if matches!(Source::from_env(), Source::Flat(_)) => {
                minisign_verify::PublicKey::from_base64(k.trim())
                    .expect("SNYVI_UPDATE_KEY is a minisign public key")
            }
            _ => minisign_verify::PublicKey::decode(PUBLIC_KEY)
                .expect("packaging/minisign.pub is a minisign public key"),
        };
        let dir = paths.data_dir.join("updates");
        let switch = paths.config_dir.join("updates.json");
        let state = fs::read_to_string(dir.join("state.json"))
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        let env_off = std::env::var("SNYVI_UPDATES")
            .is_ok_and(|v| matches!(v.as_str(), "off" | "0" | "false"));
        let file_on = fs::read_to_string(&switch)
            .ok()
            .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
            .and_then(|v| v["auto"].as_bool())
            .unwrap_or(true);
        Updater {
            channel,
            platform: Platform::here(),
            exe: exe.to_path_buf(),
            app,
            dir,
            switch,
            source: Source::from_env(),
            fetch,
            key,
            running: semver::Version::parse(crate::server::VERSION)
                .expect("CARGO_PKG_VERSION is semver"),
            current: Mutex::new(None),
            state: Mutex::new(state),
            auto: AtomicBool::new(file_on && !env_off),
            env_off,
            checking: Mutex::new(()),
        }
    }

    /// The version at the recorded path: the one compiled into this process,
    /// or -- when the updater placed a newer-numbered file there and it is
    /// still that file -- the one it placed. They differ only when a release
    /// is the same build under another number, which is what the bench
    /// ships; the file is hashed only then, and once per start.
    fn current(&self) -> semver::Version {
        let mut c = self.current.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(v) = &*c {
            return v.clone();
        }
        let s = self.state();
        let mut v = self.running.clone();
        if let (Some(applied), Some(sha)) = (s.applied.as_deref(), s.applied_sha.as_deref()) {
            if let Ok(a) = semver::Version::parse(applied) {
                if a > v && sha256_file(&self.exe).ok().as_deref() == Some(sha) {
                    v = a;
                }
            }
        }
        *c = Some(v.clone());
        v
    }

    fn forget_current(&self) {
        *self.current.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }

    pub fn state(&self) -> State {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    fn edit(&self, f: impl FnOnce(&mut State)) {
        let mut s = self.state.lock().unwrap_or_else(|e| e.into_inner());
        f(&mut s);
        let _ = fs::create_dir_all(&self.dir);
        if let Ok(text) = serde_json::to_string_pretty(&*s) {
            let _ = fs::write(self.dir.join("state.json"), text);
        }
    }

    /// The lines a told-only install's reader runs.
    pub fn how(&self) -> Vec<String> {
        match self.channel {
            Channel::Locked => {
                let dir = self
                    .exe
                    .parent()
                    .unwrap_or(Path::new("."))
                    .display()
                    .to_string();
                let arch = self.platform.arch;
                vec![
                    format!("curl -fsSLO https://github.com/{REPO}/releases/latest/download/snyvi-{}-{arch}.tar.gz", self.platform.os),
                    format!("sudo tar -xzf snyvi-{}-{arch}.tar.gz --strip-components=1 -C {dir} --wildcards '*/snyvi'", self.platform.os),
                ]
            }
            ch => ch.how(self.platform.arch),
        }
    }

    /// A failure outside a check -- an apply or a rollback that could not
    /// swap -- kept where About and the CLI show it.
    pub fn fail(&self, what: String) {
        self.edit(|s| s.error = Some(what));
    }

    /// Whether the checker runs: the file says on, and the environment does
    /// not say off, and this is not a dev build.
    pub fn auto(&self) -> bool {
        self.auto.load(Ordering::Relaxed) && self.channel != Channel::Dev
    }

    /// `snyvi update on|off`, and the switch in About. The environment's
    /// `off` cannot be turned on from here, and says so.
    pub fn set_auto(&self, on: bool) -> Result<bool> {
        if let Some(dir) = self.switch.parent() {
            fs::create_dir_all(dir)?;
        }
        fs::write(&self.switch, format!("{{ \"auto\": {on} }}\n"))
            .with_context(|| format!("writing {}", self.switch.display()))?;
        self.auto.store(on && !self.env_off, Ordering::Relaxed);
        Ok(self.auto())
    }

    /// Whether the daily floor holds right now: not asked, no hotfix above
    /// what runs, and the slot still in the future.
    pub fn floor_holds(&self, now: i64) -> bool {
        let current = self.current();
        let s = self.state();
        !s.asked
            && !hotfix_wanted(s.hotfix_below.as_deref(), &current)
            && s.slot.is_some_and(|slot| now < slot)
    }

    /// Whether a staged version should be applied now, given who is here.
    pub fn should_apply(&self, now: i64, doors: &Doors) -> Option<Reason> {
        if self.state().ready.is_none() || !self.auto() || self.floor_holds(now) {
            return None;
        }
        door(doors)
    }

    /// The `update` block of health and About, and the `update` event.
    pub fn json(&self, now: i64, stale: bool) -> serde_json::Value {
        let s = self.state();
        let slot_open = !self.floor_holds(now);
        let told = !self.channel.silent() && self.channel != Channel::Dev;
        let failed_recent = s.failed.is_some() && s.failed_at.is_some_and(|t| now - t < PILL_AMBER);
        // A dev build is stale after every `cargo build`; that is not news.
        let stale = stale && self.channel != Channel::Dev;
        // What the pill draws: a version staged behind the floor is not news
        // yet; one that failed to start is, for a day.
        let show = failed_recent
            || ((s.asked || slot_open) && (s.ready.is_some() || (told && s.available.is_some())))
            || stale;
        serde_json::json!({
            "channel": self.channel.name(),
            "auto": self.auto(),
            "env_off": self.env_off,
            "checked": s.checked_at,
            "available": s.available,
            "ready": s.ready,
            "failed": s.failed,
            "failed_recent": failed_recent,
            "skipped": s.skipped,
            "since": s.since,
            "amber": s.since.is_some_and(|t| now - t > PILL_AMBER),
            "last_applied": s.last_applied,
            "slot": s.slot,
            "slot_open": slot_open,
            "asked": s.asked,
            "notes": s.notes,
            "error": s.error,
            "how": self.how(),
            "show": show,
            "stale": stale,
            "prev": self.can_go_back(),
        })
    }

    // ----- checking -----

    /// Read the manifest, and stage what it names when it is newer. `asked`
    /// is `Check now` or `snyvi update`: it ignores the floor from here on
    /// and reads the manifest even when the ETag says nothing changed. `to`
    /// is one release's manifest, for `--to`, and may go down.
    pub fn check(&self, asked: bool, to: Option<&str>) -> Result<Checked> {
        let Ok(_one) = self.checking.try_lock() else {
            bail!("a check is already running");
        };
        if self.channel == Channel::Dev {
            bail!("a development build does not update itself");
        }
        let now = crate::store::now();
        let result = self.check_inner(asked, to, now);
        match &result {
            Ok(_) => self.edit(|s| s.error = None),
            Err(e) => {
                let text = format!("{e:#}");
                self.edit(|s| {
                    s.checked_at = Some(now);
                    s.error = Some(text);
                });
            }
        }
        result
    }

    fn check_inner(&self, asked: bool, to: Option<&str>, now: i64) -> Result<Checked> {
        let url = match to {
            Some(v) => self.source.manifest_for(v),
            None => self.source.manifest(),
        };
        let etag = if asked || to.is_some() {
            None
        } else {
            self.state().etag
        };
        let (bytes, etag) = match self.fetch.get(&url, etag.as_deref())? {
            Got::NotModified => {
                self.edit(|s| s.checked_at = Some(now));
                let s = self.state();
                let current = self.current();
                let latest = s
                    .available
                    .as_deref()
                    .and_then(|v| semver::Version::parse(v).ok())
                    .unwrap_or_else(|| current.clone());
                return Ok(Checked {
                    running: current,
                    latest,
                    ready: s.ready,
                    told: !self.channel.silent(),
                });
            }
            Got::Body { bytes, etag } => (bytes, etag),
        };
        let sig = match self.fetch.get(&format!("{url}.minisig"), None)? {
            Got::Body { bytes, .. } => bytes,
            Got::NotModified => bail!("{url}.minisig: not modified, with no ETag sent"),
        };
        verify(&self.key, &bytes, &sig)?;
        let m = Manifest::parse(&bytes)?;
        let latest = m.version();
        let current = self.current();
        let newer = latest > current;
        let wanted = match to {
            Some(_) => latest != current,
            None => newer,
        };
        // A version that did not come up is not staged again, checked on a
        // timer or asked; `--to` names it, and that is another matter.
        let failed_before = to.is_none() && {
            let s = self.state();
            s.failed.as_deref() == Some(m.version.as_str())
                || s.skipped.as_deref() == Some(m.version.as_str())
        };
        self.edit(|s| {
            s.checked_at = Some(now);
            if to.is_none() {
                s.etag = etag;
            }
            s.notes = Some(m.notes.clone()).filter(|n| !n.is_empty());
            s.latest_app_min = m.app_min.clone();
            s.hotfix_below = m.hotfix_below.clone();
            s.available = wanted.then(|| m.version.clone());
            if asked {
                s.asked = true;
            }
            if !wanted {
                s.ready = None;
                s.since = None;
            }
        });
        let mut ready = None;
        if wanted && self.channel.silent() && !failed_before {
            self.stage(&m)?;
            ready = Some(m.version.clone());
            self.edit(|s| {
                s.ready = ready.clone();
                s.since = Some(s.since.unwrap_or(now));
                if s.failed.as_deref() == Some(m.version.as_str()) {
                    s.failed = None;
                }
            });
        } else if !wanted {
            // Nothing newer: what was staged is not wanted any more (an
            // apply landed, or the release was pulled), and neither is what
            // the last apply left behind.
            self.drop_staged();
            self.clean_prev();
        }
        Ok(Checked {
            running: current,
            latest,
            ready,
            told: !self.channel.silent(),
        })
    }

    // ----- staging -----

    /// Download every asset for this channel into `<dir>/<version>/`, verify
    /// each sha256 as it lands, unpack, and write `staged.json`. Any other
    /// staged version goes first: one at a time. Idempotent: a version
    /// already staged and intact is not fetched again.
    fn stage(&self, m: &Manifest) -> Result<()> {
        let wanted = m.wanted(self.channel, &self.platform, self.app.is_some())?;
        if wanted.is_empty() {
            bail!("nothing to stage on the {} channel", self.channel.name());
        }
        let vdir = self.dir.join(&m.version);
        if let Ok(entries) = fs::read_dir(&self.dir) {
            for e in entries.flatten() {
                if e.path().is_dir() && e.file_name() != m.version.as_str() {
                    let _ = fs::remove_dir_all(e.path());
                }
            }
        }
        if let Some(staged) = self.staged() {
            if staged.version == m.version
                && staged
                    .files
                    .iter()
                    .all(|f| sha256_file(&f.path).ok().as_deref() == Some(f.sha256.as_str()))
            {
                return Ok(());
            }
        }
        fs::create_dir_all(&vdir).with_context(|| format!("creating {}", vdir.display()))?;
        let _ = fs::remove_file(vdir.join("staged.json"));
        for a in &wanted {
            let path = vdir.join(&a.name);
            if path.is_file() && sha256_file(&path).ok().as_deref() == Some(a.sha256.as_str()) {
                continue;
            }
            let url = self.source.asset(&m.version, &a.name);
            let landed = self.fetch.download(&url, &path);
            let sum = landed.and_then(|_| sha256_file(&path));
            match sum {
                Ok(sum) if sum == a.sha256 => {}
                Ok(sum) => {
                    let _ = fs::remove_file(&path);
                    bail!(
                        "{}: sha256 {} does not match the manifest's {}",
                        a.name,
                        &sum[..12],
                        &a.sha256[..12]
                    );
                }
                Err(e) => {
                    let _ = fs::remove_file(&path);
                    return Err(e);
                }
            }
        }
        let unpacked = vdir.join("unpacked");
        let _ = fs::remove_dir_all(&unpacked);
        fs::create_dir_all(&unpacked)?;
        let mut files = Vec::new();
        for a in &wanted {
            let archive = vdir.join(&a.name);
            let into = unpacked.join(&a.role);
            fs::create_dir_all(&into)?;
            if a.name.ends_with(".zip") {
                unzip(&archive, &into)?;
            } else {
                untar(&archive, &into)?;
            }
            match a.role.as_str() {
                "snyvi" => {
                    let path = find(&into, &crate::platform::exe("snyvi"), false)?;
                    files.push(StagedFile {
                        role: "snyvi".into(),
                        sha256: sha256_file(&path)?,
                        path,
                    });
                }
                "app" => {
                    let path = find(&into, &crate::platform::exe("snyvi-app"), false)?;
                    files.push(StagedFile {
                        role: "app".into(),
                        sha256: sha256_file(&path)?,
                        path,
                    });
                }
                "bundle" => {
                    let path = find(&into, "snyvi.app", true)?;
                    let bin = path.join("Contents/MacOS/snyvi");
                    files.push(StagedFile {
                        role: "bundle".into(),
                        sha256: sha256_file(&bin)?,
                        path,
                    });
                }
                "zip" => {
                    let path = find(&into, "snyvi.exe", false)?;
                    files.push(StagedFile {
                        role: "snyvi".into(),
                        sha256: sha256_file(&path)?,
                        path,
                    });
                    if let Ok(app) = find(&into, "snyvi-app.exe", false) {
                        files.push(StagedFile {
                            role: "app".into(),
                            sha256: sha256_file(&app)?,
                            path: app,
                        });
                    }
                }
                other => bail!("no such role {other}"),
            }
        }
        let staged = Staged {
            version: m.version.clone(),
            app_min: m.app_min.clone(),
            files,
        };
        fs::write(
            vdir.join("staged.json"),
            serde_json::to_string_pretty(&staged)?,
        )?;
        Ok(())
    }

    /// What is staged, if a version is and its record is whole.
    pub fn staged(&self) -> Option<Staged> {
        let version = self.state().ready?;
        let text = fs::read_to_string(self.dir.join(&version).join("staged.json")).ok()?;
        serde_json::from_str(&text).ok()
    }

    /// Forget what is staged and remove it; the next check stages afresh.
    pub fn drop_staged(&self) {
        if let Ok(entries) = fs::read_dir(&self.dir) {
            for e in entries.flatten() {
                if e.path().is_dir() {
                    let _ = fs::remove_dir_all(e.path());
                }
            }
        }
        self.edit(|s| {
            s.ready = None;
            s.since = None;
        });
    }

    // ----- applying -----

    /// The files an apply replaces here, and where the old ones go.
    fn targets(&self) -> Vec<(String, PathBuf)> {
        match self.channel {
            Channel::Mac => bundle_of(&self.exe)
                .map(|b| vec![("bundle".to_string(), b)])
                .unwrap_or_default(),
            _ => {
                let mut t = vec![("snyvi".to_string(), self.exe.clone())];
                if let Some(app) = &self.app {
                    t.push(("app".to_string(), app.clone()));
                }
                t
            }
        }
    }

    /// Swap the staged files in. The old ones become `.prev`; each file
    /// placed is hashed again before the next is touched. Called at the
    /// planned exit, before the successor is started.
    pub fn apply(&self) -> Result<String> {
        if !self.channel.silent() {
            bail!(
                "the {} channel is told, not updated in place",
                self.channel.name()
            );
        }
        let staged = self.staged().ok_or_else(|| anyhow!("nothing is staged"))?;
        let targets = self.targets();
        let mut daemon_sha = None;
        for f in &staged.files {
            let Some((_, target)) = targets.iter().find(|(role, _)| *role == f.role) else {
                // A window in the zip when none is installed here: not ours
                // to place.
                continue;
            };
            if f.role == "bundle" {
                swap_dir(&f.path, target, &f.sha256)?;
            } else {
                swap_file(&f.path, target, &f.sha256)?;
            }
            if f.role != "app" {
                daemon_sha = Some(f.sha256.clone());
            }
        }
        if daemon_sha.is_none() {
            bail!("the staged files do not include the daemon");
        }
        #[cfg(windows)]
        set_display_version(&staged.version);
        self.edit(|s| {
            s.applying = Some(staged.version.clone());
            s.applying_sha = daemon_sha;
            s.app_min = staged.app_min.clone();
        });
        Ok(staged.version)
    }

    /// Whether `.prev` is there to go back to.
    pub fn can_go_back(&self) -> bool {
        self.targets().iter().any(|(_, t)| prev_of(t).exists())
    }

    /// Put `.prev` back, if there is one. What `snyvi update --back` asks
    /// for (`asked`), and what a successor that never answered gets. Either
    /// way the version left is not staged again on its own; only the second
    /// is called a failure.
    pub fn rollback(&self, asked: bool) -> Result<bool> {
        let mut any = false;
        for (_, target) in self.targets() {
            let prev = prev_of(&target);
            if !prev.exists() {
                continue;
            }
            let bad = with_suffix(&target, ".bad");
            let _ = remove_any(&bad);
            let _ = fs::rename(&target, &bad);
            fs::rename(&prev, &target)
                .with_context(|| format!("putting {} back", prev.display()))?;
            let _ = remove_any(&bad);
            any = true;
        }
        if any {
            let now = crate::store::now();
            self.edit(|s| {
                let v = s.applying.take().or_else(|| s.applied.take());
                s.applying_sha = None;
                s.applied_sha = None;
                if asked {
                    s.skipped = v;
                } else {
                    s.failed = v;
                    s.failed_at = Some(now);
                }
                s.ready = None;
                s.since = None;
            });
            self.forget_current();
        }
        Ok(any)
    }

    /// `.prev` is deleted on the next successful check, not at once: on
    /// Windows the old window holds its file open for as long as it is up,
    /// and a file that will not go is left for the check after.
    fn clean_prev(&self) {
        for (_, target) in self.targets() {
            let _ = remove_any(&prev_of(&target));
        }
    }

    /// The daemon that comes up says what the last exit did. `planned_apply`
    /// is the marker's word; only then can this be an update, so a crash
    /// never writes `last_applied` and a flapping daemon never moves its
    /// slot. Success is the file at the recorded path hashing to what was
    /// placed; the version alone would not tell a swap that held from one
    /// that did not when the numbers are the same, which the bench relies on.
    pub fn note_started(&self, planned_apply: bool, now: i64) -> Option<Started> {
        let s = self.state();
        let applying = s.applying.clone()?;
        let held = planned_apply
            && (s
                .applying_sha
                .as_deref()
                .is_some_and(|sha| sha256_file(&self.exe).ok().as_deref() == Some(sha))
                || self.running.to_string() == applying);
        if held {
            let slot = now + SLOT + jitter(SLOT_JITTER);
            self.edit(|s| {
                s.applied = Some(applying.clone());
                s.applied_sha = s.applying_sha.take();
                s.applying = None;
                s.last_applied = Some(now);
                s.slot = Some(slot);
                s.ready = None;
                s.available = None;
                s.since = None;
                s.asked = false;
                s.failed = None;
            });
            self.drop_staged();
            self.forget_current();
            Some(Started::Applied(applying))
        } else {
            self.edit(|s| {
                s.applying = None;
                s.applying_sha = None;
                s.failed = Some(applying.clone());
                s.failed_at = Some(now);
                s.ready = None;
                s.since = None;
            });
            self.drop_staged();
            self.forget_current();
            Some(Started::Failed(applying))
        }
    }

    /// Whether a window of this version is older than the update that was
    /// applied wants, so the daemon should relaunch it. Answered once: the
    /// wish is cleared here.
    pub fn window_is_too_old(&self, window: Option<&str>) -> bool {
        let Some(min) = self.state().app_min else {
            return false;
        };
        let Some(v) = window.and_then(|v| semver::Version::parse(v).ok()) else {
            return false;
        };
        let Ok(min) = semver::Version::parse(&min) else {
            return false;
        };
        let old = v < min;
        self.edit(|s| s.app_min = None);
        old
    }

    /// Where the window binary is, for the relaunch.
    pub fn app_path(&self) -> Option<PathBuf> {
        match self.channel {
            Channel::Mac => bundle_of(&self.exe).map(|b| b.join("Contents/MacOS/snyvi-app")),
            _ => self.app.clone(),
        }
    }
}

/// What a check found.
#[derive(Clone, Debug)]
pub struct Checked {
    pub running: semver::Version,
    pub latest: semver::Version,
    pub ready: Option<String>,
    /// A told-only channel: nothing was staged, the reader runs a command.
    pub told: bool,
}

impl Checked {
    pub fn newer(&self) -> bool {
        self.latest > self.running
    }
}

/// What the daemon that came up learned of the last exit.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Started {
    Applied(String),
    Failed(String),
}

// ---------- the policy ----------

/// Who is here, for the doors.
#[derive(Clone, Copy, Debug)]
pub struct Doors {
    pub windows: usize,
    /// Streams that are pages, not agents.
    pub pages: usize,
    /// Since a page last said it was in front.
    pub focus_age: Duration,
    /// A pane with an agent mid-turn or a program printing.
    pub busy: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reason {
    /// No window, no page, nothing busy.
    NobodyHere,
    /// A window or a page is open, and has been in the background a while.
    InBackground,
}

impl Reason {
    pub fn say(self) -> &'static str {
        match self {
            Reason::NobodyHere => "nobody is here",
            Reason::InBackground => "the window has been in the background a while",
        }
    }
}

/// The doors an update goes through once the floor is open. A window in
/// front is not one: that is the pill, and a click. The floor itself is
/// `Updater::floor_holds`, kept apart so this stays a function of who is
/// here and nothing else.
pub fn door(d: &Doors) -> Option<Reason> {
    if d.busy {
        return None;
    }
    if d.windows == 0 && d.pages == 0 {
        return Some(Reason::NobodyHere);
    }
    if d.focus_age >= BACKGROUND {
        return Some(Reason::InBackground);
    }
    None
}

/// `hotfix_below` above what runs: the floor does not apply.
fn hotfix_wanted(below: Option<&str>, running: &semver::Version) -> bool {
    below
        .and_then(|v| semver::Version::parse(v).ok())
        .is_some_and(|v| *running < v)
}

/// Up to `max` seconds, from the OS.
fn jitter(max: i64) -> i64 {
    let mut b = [0u8; 8];
    if getrandom::fill(&mut b).is_err() {
        return 0;
    }
    (u64::from_le_bytes(b) % (max as u64 + 1)) as i64
}

/// A duration up to `max`, for the checker's timer.
pub fn jitter_d(max: Duration) -> Duration {
    Duration::from_secs(jitter(max.as_secs() as i64) as u64)
}

// ---------- verifying ----------

/// The manifest against the release key. Prehashed and legacy signatures
/// both: they are the same key either way.
pub fn verify(key: &minisign_verify::PublicKey, manifest: &[u8], signature: &[u8]) -> Result<()> {
    let sig_text = std::str::from_utf8(signature).context("latest.json.minisig is not text")?;
    let sig = minisign_verify::Signature::decode(sig_text)
        .map_err(|e| anyhow!("latest.json.minisig: {e}"))?;
    key.verify(manifest, &sig, true)
        .map_err(|e| anyhow!("latest.json is not signed by the release key ({e}); refusing it"))
}

pub fn sha256_file(path: &Path) -> Result<String> {
    use sha2::Digest;
    let mut f = fs::File::open(path).with_context(|| format!("opening {}", path.display()))?;
    let mut h = sha2::Sha256::new();
    let mut buf = vec![0u8; 1 << 16];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(format!("{:x}", h.finalize()))
}

// ---------- the files ----------

fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut s = path.as_os_str().to_os_string();
    s.push(suffix);
    PathBuf::from(s)
}

fn prev_of(path: &Path) -> PathBuf {
    with_suffix(path, ".prev")
}

fn remove_any(path: &Path) -> std::io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(m) if m.is_dir() => fs::remove_dir_all(path),
        Ok(_) => fs::remove_file(path),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

/// Whether this process may create a file in `dir`: asked by doing it,
/// since permission bits do not know about read-only mounts or ACLs.
fn writable(dir: &Path) -> bool {
    let probe = dir.join(format!(".snyvi-write-{}", std::process::id()));
    match fs::File::create(&probe) {
        Ok(_) => {
            let _ = fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

/// The `.app` a path inside a bundle belongs to.
fn bundle_of(exe: &Path) -> Option<PathBuf> {
    exe.ancestors()
        .find(|p| p.extension().is_some_and(|e| e == "app"))
        .map(Path::to_path_buf)
}

/// Bring `staged` beside `target` (a rename on one filesystem, a copy
/// across two), check it, move the old file to `.prev`, and move the new one
/// in. The running process keeps its file: a rename moves the name, not the
/// inode, and on Windows a running executable can be renamed though never
/// overwritten. Any failure leaves the old file where it was.
fn swap_file(staged: &Path, target: &Path, sha256: &str) -> Result<()> {
    let incoming = with_suffix(target, ".new");
    let _ = remove_any(&incoming);
    if fs::rename(staged, &incoming).is_err() {
        fs::copy(staged, &incoming)
            .with_context(|| format!("copying {} beside {}", staged.display(), target.display()))?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&incoming, fs::Permissions::from_mode(0o755))?;
    }
    if sha256_file(&incoming)? != sha256 {
        let _ = remove_any(&incoming);
        bail!("{}: not the file that was verified", incoming.display());
    }
    let prev = prev_of(target);
    let _ = remove_any(&prev);
    if target.exists() {
        fs::rename(target, &prev).with_context(|| format!("moving {} aside", target.display()))?;
    }
    if let Err(e) = fs::rename(&incoming, target) {
        let _ = fs::rename(&prev, target);
        return Err(e).with_context(|| format!("moving {} in", incoming.display()));
    }
    if sha256_file(target)? != sha256 {
        let _ = remove_any(target);
        let _ = fs::rename(&prev, target);
        bail!("{}: not the file that was placed", target.display());
    }
    Ok(())
}

/// The same for a bundle: `snyvi.app` → `snyvi.app.prev`, the staged one in.
fn swap_dir(staged: &Path, target: &Path, sha256: &str) -> Result<()> {
    let incoming = with_suffix(target, ".new");
    let _ = remove_any(&incoming);
    if fs::rename(staged, &incoming).is_err() {
        copy_dir(staged, &incoming)?;
    }
    let bin = incoming.join("Contents/MacOS/snyvi");
    if sha256_file(&bin)? != sha256 {
        let _ = remove_any(&incoming);
        bail!("{}: not the bundle that was verified", incoming.display());
    }
    let prev = prev_of(target);
    let _ = remove_any(&prev);
    if target.exists() {
        fs::rename(target, &prev).with_context(|| format!("moving {} aside", target.display()))?;
    }
    if let Err(e) = fs::rename(&incoming, target) {
        let _ = fs::rename(&prev, target);
        return Err(e).with_context(|| format!("moving {} in", incoming.display()));
    }
    Ok(())
}

fn copy_dir(from: &Path, to: &Path) -> Result<()> {
    fs::create_dir_all(to)?;
    for e in fs::read_dir(from)? {
        let e = e?;
        let dest = to.join(e.file_name());
        let m = e.metadata()?;
        if m.is_dir() {
            copy_dir(&e.path(), &dest)?;
        } else if m.file_type().is_symlink() {
            #[cfg(unix)]
            std::os::unix::fs::symlink(fs::read_link(e.path())?, &dest)?;
            #[cfg(not(unix))]
            fs::copy(e.path(), &dest)?;
        } else {
            fs::copy(e.path(), &dest)?;
        }
    }
    Ok(())
}

/// A file or directory of that name under `dir`, a few levels down: the
/// tarballs hold a versioned top directory, the zip a folder.
fn find(dir: &Path, name: &str, want_dir: bool) -> Result<PathBuf> {
    fn walk(dir: &Path, name: &str, want_dir: bool, depth: u8) -> Option<PathBuf> {
        let mut dirs = Vec::new();
        for e in fs::read_dir(dir).ok()?.flatten() {
            let p = e.path();
            let is_dir = p.is_dir();
            if e.file_name() == name && is_dir == want_dir {
                return Some(p);
            }
            if is_dir {
                dirs.push(p);
            }
        }
        if depth == 0 {
            return None;
        }
        dirs.into_iter()
            .find_map(|d| walk(&d, name, want_dir, depth - 1))
    }
    walk(dir, name, want_dir, 3).ok_or_else(|| anyhow!("no {name} in the download"))
}

fn untar(archive: &Path, into: &Path) -> Result<()> {
    let f = fs::File::open(archive).with_context(|| format!("opening {}", archive.display()))?;
    let gz = flate2::read::GzDecoder::new(std::io::BufReader::new(f));
    let mut tar = tar::Archive::new(gz);
    tar.set_preserve_permissions(true);
    tar.unpack(into)
        .with_context(|| format!("unpacking {}", archive.display()))
}

/// A zip as `Compress-Archive` writes one: stored or deflated entries, no
/// zip64, read through the central directory so a data descriptor after an
/// entry changes nothing. Small enough to be here rather than a crate that
/// would bring its own compressors along.
pub fn unzip(archive: &Path, into: &Path) -> Result<()> {
    let mut f =
        fs::File::open(archive).with_context(|| format!("opening {}", archive.display()))?;
    let len = f.metadata()?.len();
    let tail_len = len.min(66 << 10);
    f.seek(SeekFrom::Start(len - tail_len))?;
    let mut tail = vec![0u8; tail_len as usize];
    f.read_exact(&mut tail)?;
    let eocd = tail
        .windows(4)
        .rposition(|w| w == [0x50, 0x4b, 0x05, 0x06])
        .ok_or_else(|| anyhow!("{}: not a zip", archive.display()))?;
    fn u16at(b: &[u8], i: usize) -> usize {
        u16::from_le_bytes([b[i], b[i + 1]]) as usize
    }
    fn u32at(b: &[u8], i: usize) -> u64 {
        u32::from_le_bytes([b[i], b[i + 1], b[i + 2], b[i + 3]]) as u64
    }
    let entries = u16at(&tail, eocd + 10);
    let cd_size = u32at(&tail, eocd + 12);
    let cd_off = u32at(&tail, eocd + 16);
    if cd_off == 0xffff_ffff || entries == 0xffff {
        bail!("{}: zip64 is not read here", archive.display());
    }
    f.seek(SeekFrom::Start(cd_off))?;
    let mut cd = vec![0u8; cd_size as usize];
    f.read_exact(&mut cd)?;
    let mut at = 0;
    for _ in 0..entries {
        if cd.len() < at + 46 || cd[at..at + 4] != [0x50, 0x4b, 0x01, 0x02] {
            bail!(
                "{}: central directory is not as expected",
                archive.display()
            );
        }
        let method = u16at(&cd, at + 10);
        let csize = u32at(&cd, at + 20);
        let usize_ = u32at(&cd, at + 24);
        let (n, m, k) = (
            u16at(&cd, at + 28),
            u16at(&cd, at + 30),
            u16at(&cd, at + 32),
        );
        let local = u32at(&cd, at + 42);
        let name = String::from_utf8_lossy(&cd[at + 46..at + 46 + n]).replace('\\', "/");
        at += 46 + n + m + k;
        if name.split('/').any(|p| p == "..") || name.starts_with('/') {
            bail!(
                "{}: refuses a path outside the folder: {name}",
                archive.display()
            );
        }
        let dest = into.join(&name);
        if name.ends_with('/') {
            fs::create_dir_all(&dest)?;
            continue;
        }
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)?;
        }
        f.seek(SeekFrom::Start(local))?;
        let mut lh = [0u8; 30];
        f.read_exact(&mut lh)?;
        if lh[..4] != [0x50, 0x4b, 0x03, 0x04] {
            bail!(
                "{}: entry {name} is not where the directory says",
                archive.display()
            );
        }
        let skip = u16at(&lh, 26) + u16at(&lh, 28);
        f.seek(SeekFrom::Current(skip as i64))?;
        let mut out = fs::File::create(&dest)?;
        let mut raw = (&mut f).take(csize);
        let written = match method {
            0 => std::io::copy(&mut raw, &mut out)?,
            8 => std::io::copy(&mut flate2::read::DeflateDecoder::new(raw), &mut out)?,
            other => bail!(
                "{}: entry {name} uses compression method {other}",
                archive.display()
            ),
        };
        if written != usize_ {
            bail!(
                "{}: entry {name} is {written} bytes, not {usize_}",
                archive.display()
            );
        }
    }
    Ok(())
}

/// Settings > Apps shows the number the installer wrote; after a swap it is
/// this one. Best effort, and nothing depends on it.
#[cfg(windows)]
fn set_display_version(version: &str) {
    let _ = std::process::Command::new("reg")
        .args([
            "add",
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\{77914D41-28F1-4AB8-AA82-692BB637B9B2}_is1",
            "/v",
            "DisplayVersion",
            "/d",
            version,
            "/f",
        ])
        .creation_flags(crate::platform::CREATE_NO_WINDOW)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
}
#[cfg(windows)]
use std::os::windows::process::CommandExt;

// ---------- tests ----------

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::sync::Mutex as StdMutex;

    fn p(s: &str) -> PathBuf {
        PathBuf::from(s)
    }

    #[test]
    fn the_channel_is_read_off_the_path_and_the_receipt() {
        let d = |s: &str| Channel::detect(&p(s), None, false);
        assert_eq!(d("/home/a/.local/bin/snyvi"), Channel::Tar);
        assert_eq!(d("/opt/snyvi/snyvi"), Channel::Tar);
        assert_eq!(d("/usr/local/bin/snyvi"), Channel::Tar);
        assert_eq!(d("/usr/bin/snyvi"), Channel::Deb);
        assert_eq!(d("/usr/lib/snyvi/snyvi"), Channel::Deb);
        assert_eq!(d("/home/a/.cargo/bin/snyvi"), Channel::Cargo);
        assert_eq!(
            d("/Applications/snyvi.app/Contents/MacOS/snyvi"),
            Channel::Mac
        );
        assert_eq!(
            d("/Users/a/Applications/snyvi.app/Contents/MacOS/snyvi"),
            Channel::Mac
        );
        assert_eq!(
            d(r"C:\Users\a\AppData\Local\Programs\snyvi\snyvi.exe"),
            Channel::Win
        );
        assert_eq!(
            d(r"C:\Users\a\scoop\apps\snyvi\current\snyvi.exe"),
            Channel::Win
        );
        assert_eq!(
            d("/home/a/Projects/snyvi/target/release/snyvi"),
            Channel::Dev
        );
        assert_eq!(
            Channel::detect(&p("/home/a/.local/bin/snyvi"), None, true),
            Channel::Dev
        );
        // The receipt wins over the path, except for a dev build.
        assert_eq!(
            Channel::detect(&p("/opt/snyvi/snyvi"), Some("deb"), false),
            Channel::Deb
        );
        assert_eq!(
            Channel::detect(&p("/home/a/snyvi/target/debug/snyvi"), Some("tar"), false),
            Channel::Dev
        );
        assert_eq!(
            Channel::detect(&p("/opt/snyvi/snyvi"), Some("nonsense"), false),
            Channel::Tar
        );
        assert!(Channel::Tar.silent() && Channel::Mac.silent() && Channel::Win.silent());
        assert!(!Channel::Deb.silent() && !Channel::Cargo.silent() && !Channel::Dev.silent());
    }

    const MANIFEST: &str = r#"{
      "version": "1.7.0", "channel": "daily", "notes": "https://x/v1.7.0", "app_min": "1.6.0", "hotfix_below": null,
      "assets": {
        "linux-x64": { "snyvi": ["snyvi-linux-x64.tar.gz", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"], "app": ["snyvi-app-linux-x64.tar.gz", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"] },
        "macos-arm64": { "bundle": ["snyvi-macos-arm64.tar.gz", "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"] },
        "windows-x64": { "zip": ["snyvi-windows-x64.zip", "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"], "setup": ["snyvi-windows-x64-setup.exe", "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"] },
        "deb-x64": { "snyvi": ["snyvi-linux-x64.deb", "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"] }
      }
    }"#;

    #[test]
    fn the_manifest_names_each_channels_downloads() {
        let m = Manifest::parse(MANIFEST.as_bytes()).unwrap();
        let linux = Platform {
            os: "linux",
            arch: "x64",
        };
        let names = |w: Vec<Asset>| w.into_iter().map(|a| a.name).collect::<Vec<_>>();
        assert_eq!(
            names(m.wanted(Channel::Tar, &linux, false).unwrap()),
            ["snyvi-linux-x64.tar.gz"]
        );
        assert_eq!(
            names(m.wanted(Channel::Tar, &linux, true).unwrap()),
            ["snyvi-linux-x64.tar.gz", "snyvi-app-linux-x64.tar.gz"]
        );
        assert_eq!(
            names(
                m.wanted(
                    Channel::Mac,
                    &Platform {
                        os: "macos",
                        arch: "arm64"
                    },
                    false
                )
                .unwrap()
            ),
            ["snyvi-macos-arm64.tar.gz"]
        );
        assert_eq!(
            names(
                m.wanted(
                    Channel::Win,
                    &Platform {
                        os: "windows",
                        arch: "x64"
                    },
                    true
                )
                .unwrap()
            ),
            ["snyvi-windows-x64.zip"]
        );
        // Told channels take nothing; a platform the release does not build
        // for is an error, not an empty list, so the check says so.
        assert!(m.wanted(Channel::Deb, &linux, false).unwrap().is_empty());
        assert!(m.wanted(Channel::Cargo, &linux, false).unwrap().is_empty());
        assert!(m
            .wanted(
                Channel::Tar,
                &Platform {
                    os: "linux",
                    arch: "riscv"
                },
                false
            )
            .is_err());
        assert!(m
            .wanted(
                Channel::Mac,
                &Platform {
                    os: "macos",
                    arch: "x64"
                },
                false
            )
            .is_err());
        assert!(Manifest::parse(br#"{"version": "one"}"#).is_err());
    }

    #[test]
    fn the_doors_open_for_nobody_and_for_a_window_left_behind() {
        let d = |windows, pages, mins: u64, busy| {
            door(&Doors {
                windows,
                pages,
                focus_age: Duration::from_secs(mins * 60),
                busy,
            })
        };
        assert_eq!(d(0, 0, 0, false), Some(Reason::NobodyHere));
        assert_eq!(d(0, 0, 0, true), None, "busy panes hold every door");
        assert_eq!(
            d(1, 1, 0, false),
            None,
            "a window in front is the pill, not a door"
        );
        assert_eq!(d(1, 1, 9, false), None);
        assert_eq!(d(1, 1, 10, false), Some(Reason::InBackground));
        assert_eq!(
            d(0, 1, 0, false),
            None,
            "a browser tab in front counts as someone here"
        );
        assert_eq!(d(0, 1, 30, false), Some(Reason::InBackground));
        assert_eq!(d(1, 1, 30, true), None);
    }

    #[test]
    fn a_hotfix_above_what_runs_opens_the_floor() {
        let v = semver::Version::parse("1.6.2").unwrap();
        assert!(hotfix_wanted(Some("1.6.3"), &v));
        assert!(!hotfix_wanted(Some("1.6.2"), &v));
        assert!(!hotfix_wanted(Some("1.6.0"), &v));
        assert!(!hotfix_wanted(None, &v));
        assert!(!hotfix_wanted(Some("soon"), &v));
    }

    // ----- the stager and the swap, against a fake network -----

    /// A `Fetch` over a map of URLs, counting what was asked for. A download
    /// may be cut short, to see that nothing is marked ready from it.
    struct Fake {
        files: StdMutex<BTreeMap<String, Vec<u8>>>,
        truncate: StdMutex<Option<String>>,
        asked: StdMutex<Vec<String>>,
    }

    impl Fake {
        fn new() -> Fake {
            Fake {
                files: Default::default(),
                truncate: Default::default(),
                asked: Default::default(),
            }
        }
        fn put(&self, name: &str, bytes: Vec<u8>) {
            self.files.lock().unwrap().insert(name.to_string(), bytes);
        }
    }

    impl Fetch for Fake {
        fn get(&self, url: &str, _etag: Option<&str>) -> Result<Got> {
            self.asked.lock().unwrap().push(url.to_string());
            let name = url.rsplit('/').next().unwrap();
            match self.files.lock().unwrap().get(name) {
                Some(b) => Ok(Got::Body {
                    bytes: b.clone(),
                    etag: Some(format!("\"{}\"", b.len())),
                }),
                None => bail!("GET {url}: HTTP 404"),
            }
        }
        fn download(&self, url: &str, to: &Path) -> Result<u64> {
            self.asked.lock().unwrap().push(url.to_string());
            let name = url.rsplit('/').next().unwrap();
            let files = self.files.lock().unwrap();
            let Some(b) = files.get(name) else {
                bail!("GET {url}: HTTP 404")
            };
            let cut = self.truncate.lock().unwrap().as_deref() == Some(name);
            let bytes = if cut { &b[..b.len() / 2] } else { &b[..] };
            fs::write(to, bytes)?;
            Ok(bytes.len() as u64)
        }
    }

    /// The test key pair's public half, and a manifest it signed; see
    /// `tests/fixtures/update/README`. The release key is not used here.
    const TEST_PUB: &str = include_str!("../tests/fixtures/update/test.pub");
    const SIGNED: &[u8] = include_bytes!("../tests/fixtures/update/latest.json");
    const SIGNATURE: &[u8] = include_bytes!("../tests/fixtures/update/latest.json.minisig");
    /// What that manifest's `linux-x64` daemon download is: a tarball whose
    /// `snyvi` is a line of text.
    const TARBALL: &[u8] = include_bytes!("../tests/fixtures/update/snyvi-linux-x64.tar.gz");

    #[test]
    fn a_manifest_is_taken_from_the_key_and_from_nobody_else() {
        let key = minisign_verify::PublicKey::decode(TEST_PUB).unwrap();
        verify(&key, SIGNED, SIGNATURE).unwrap();
        let mut tampered = SIGNED.to_vec();
        let at = tampered
            .windows(5)
            .position(|w| w == b"1.9.9")
            .expect("the fixture names 1.9.9");
        tampered[at + 4] = b'8';
        assert!(
            verify(&key, &tampered, SIGNATURE).is_err(),
            "a changed byte fails"
        );
        let release = minisign_verify::PublicKey::decode(PUBLIC_KEY).unwrap();
        assert!(
            verify(&release, SIGNED, SIGNATURE).is_err(),
            "the release key does not vouch for the test key's manifest"
        );
        assert!(verify(&key, SIGNED, b"untrusted comment: nothing\n").is_err());
    }

    fn sha(bytes: &[u8]) -> String {
        use sha2::Digest;
        format!("{:x}", sha2::Sha256::digest(bytes))
    }

    /// A gzipped tarball holding `<top>/<name>` with the given bytes.
    fn tarball(top: &str, name: &str, bytes: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        {
            let gz = flate2::write::GzEncoder::new(&mut out, flate2::Compression::fast());
            let mut tar = tar::Builder::new(gz);
            let mut h = tar::Header::new_gnu();
            h.set_size(bytes.len() as u64);
            h.set_mode(0o755);
            h.set_cksum();
            tar.append_data(&mut h, format!("{top}/{name}"), bytes)
                .unwrap();
            tar.into_inner().unwrap().finish().unwrap();
        }
        out
    }

    /// A zip holding `<top>/<name>` stored, and `<top>/<other>` deflated.
    fn zip(top: &str, entries: &[(&str, &[u8], bool)]) -> Vec<u8> {
        let mut out = Vec::new();
        let mut cd = Vec::new();
        let crc = |b: &[u8]| {
            // CRC-32, the plain table-less way: it is a test.
            let mut c = 0xffff_ffffu32;
            for &x in b {
                c ^= x as u32;
                for _ in 0..8 {
                    c = if c & 1 != 0 {
                        (c >> 1) ^ 0xedb8_8320
                    } else {
                        c >> 1
                    };
                }
            }
            !c
        };
        for &(name, bytes, deflate) in entries {
            let name = format!("{top}/{name}");
            let data = if deflate {
                let mut e =
                    flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
                e.write_all(bytes).unwrap();
                e.finish().unwrap()
            } else {
                bytes.to_vec()
            };
            let off = out.len() as u32;
            let method: u16 = if deflate { 8 } else { 0 };
            let mut lh = Vec::new();
            lh.extend_from_slice(&[0x50, 0x4b, 0x03, 0x04, 20, 0, 0, 0]);
            lh.extend_from_slice(&method.to_le_bytes());
            lh.extend_from_slice(&[0; 4]);
            lh.extend_from_slice(&crc(bytes).to_le_bytes());
            lh.extend_from_slice(&(data.len() as u32).to_le_bytes());
            lh.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
            lh.extend_from_slice(&(name.len() as u16).to_le_bytes());
            lh.extend_from_slice(&[0, 0]);
            lh.extend_from_slice(name.as_bytes());
            out.extend_from_slice(&lh);
            out.extend_from_slice(&data);
            cd.extend_from_slice(&[0x50, 0x4b, 0x01, 0x02, 20, 0, 20, 0, 0, 0]);
            cd.extend_from_slice(&method.to_le_bytes());
            cd.extend_from_slice(&[0; 4]);
            cd.extend_from_slice(&crc(bytes).to_le_bytes());
            cd.extend_from_slice(&(data.len() as u32).to_le_bytes());
            cd.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
            cd.extend_from_slice(&(name.len() as u16).to_le_bytes());
            cd.extend_from_slice(&[0; 12]);
            cd.extend_from_slice(&off.to_le_bytes());
            cd.extend_from_slice(name.as_bytes());
        }
        let cd_off = out.len() as u32;
        out.extend_from_slice(&cd);
        out.extend_from_slice(&[0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0]);
        out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
        out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
        out.extend_from_slice(&(cd.len() as u32).to_le_bytes());
        out.extend_from_slice(&cd_off.to_le_bytes());
        out.extend_from_slice(&[0, 0]);
        out
    }

    /// A signed manifest is fixed by the fixture, so the stager is tested
    /// below the signature: `stage` and `apply` take the parsed manifest.
    fn updater(dir: &Path, exe: &Path, fetch: Fake) -> Updater {
        let paths = crate::config::Paths {
            data_dir: dir.join("data"),
            config_dir: dir.join("config"),
            docs_dir: dir.join("data/docs"),
            db_path: dir.join("data/snyvi.db"),
            token_path: dir.join("config/token"),
        };
        let mut u = Updater::new(&paths, exe, Box::new(fetch));
        u.source = Source::Flat("http://fake/".into());
        u.channel = Channel::Tar;
        u.platform = Platform {
            os: "linux",
            arch: "x64",
        };
        u
    }

    fn manifest_for(version: &str, tar_sha: &str) -> Manifest {
        Manifest::parse(
            format!(
                r#"{{ "version": "{version}", "app_min": "1.0.0", "assets": {{ "linux-x64": {{ "snyvi": ["snyvi-linux-x64.tar.gz", "{tar_sha}"] }} }} }}"#
            )
            .as_bytes(),
        )
        .unwrap()
    }

    #[test]
    fn a_tarball_is_staged_verified_swapped_in_and_rolled_back() {
        let tmp = tempdir();
        let bin = tmp.join("bin");
        fs::create_dir_all(&bin).unwrap();
        let exe = bin.join("snyvi");
        fs::write(&exe, b"old daemon").unwrap();
        let new = b"new daemon".to_vec();
        let tgz = tarball("snyvi-9.9.9-x86_64-unknown-linux-musl", "snyvi", &new);
        let fake = Fake::new();
        fake.put("snyvi-linux-x64.tar.gz", tgz.clone());
        let u = updater(&tmp, &exe, fake);
        let m = manifest_for("9.9.9", &sha(&tgz));

        u.stage(&m).unwrap();
        u.edit(|s| s.ready = Some("9.9.9".into()));
        let staged = u.staged().expect("staged.json is written");
        assert_eq!(staged.files.len(), 1);
        assert_eq!(
            staged.files[0].sha256,
            sha(&new),
            "the unpacked binary is hashed, not the tarball"
        );
        assert!(staged.files[0]
            .path
            .starts_with(tmp.join("data/updates/9.9.9")));

        assert_eq!(u.apply().unwrap(), "9.9.9");
        assert_eq!(fs::read(&exe).unwrap(), new, "the new file is at the path");
        assert_eq!(
            fs::read(bin.join("snyvi.prev")).unwrap(),
            b"old daemon",
            "the old one is beside it"
        );
        let s = u.state();
        assert_eq!(s.applying.as_deref(), Some("9.9.9"));
        assert_eq!(s.applying_sha.as_deref(), Some(sha(&new).as_str()));
        assert!(u.can_go_back());

        // The daemon that comes up on the new file: the swap held.
        assert_eq!(
            u.note_started(true, 1_000_000),
            Some(Started::Applied("9.9.9".into()))
        );
        let s = u.state();
        assert_eq!(s.last_applied, Some(1_000_000));
        assert!(
            s.slot.unwrap() >= 1_000_000 + SLOT
                && s.slot.unwrap() <= 1_000_000 + SLOT + SLOT_JITTER
        );
        assert!(s.ready.is_none() && s.applying.is_none() && !s.asked);
        assert!(
            !tmp.join("data/updates/9.9.9").exists(),
            "the staged copy is gone"
        );
        assert!(u.floor_holds(1_000_000 + 3600), "the next day's slot holds");
        assert!(!u.floor_holds(1_000_000 + SLOT + SLOT_JITTER + 1));

        // Back, asked for: the old file returns, and the version that was
        // applied is remembered so it is not staged again on its own --
        // skipped, not failed, since nothing went wrong with it.
        assert!(u.rollback(true).unwrap());
        assert_eq!(fs::read(&exe).unwrap(), b"old daemon");
        assert!(!bin.join("snyvi.prev").exists());
        let s = u.state();
        assert_eq!(s.skipped.as_deref(), Some("9.9.9"));
        assert!(s.failed.is_none());
        assert!(!u.rollback(true).unwrap(), "nothing to go back to twice");
    }

    #[test]
    fn the_version_at_the_path_is_the_one_placed_while_the_file_is_that_file() {
        let tmp = tempdir();
        let exe = tmp.join("bin/snyvi");
        fs::create_dir_all(exe.parent().unwrap()).unwrap();
        fs::write(&exe, b"placed").unwrap();
        let u = updater(&tmp, &exe, Fake::new());
        let compiled = u.running.clone();
        let higher = format!(
            "{}.{}.{}",
            compiled.major,
            compiled.minor,
            compiled.patch + 5
        );
        u.edit(|s| {
            s.applied = Some(higher.clone());
            s.applied_sha = Some(sha(b"placed"));
        });
        assert_eq!(
            u.current().to_string(),
            higher,
            "the file placed is still there"
        );
        fs::write(&exe, b"something else").unwrap();
        u.forget_current();
        assert_eq!(
            u.current(),
            compiled,
            "a file the updater did not place is only what it says it is"
        );
        // A hotfix is measured against the version at the path.
        u.edit(|s| {
            s.slot = Some(i64::MAX);
            s.hotfix_below = Some(higher.clone());
        });
        assert!(!u.floor_holds(0), "below the hotfix: the floor opens");
    }

    #[test]
    fn a_cut_download_stages_nothing_and_leaves_no_file() {
        let tmp = tempdir();
        let exe = tmp.join("bin/snyvi");
        fs::create_dir_all(exe.parent().unwrap()).unwrap();
        fs::write(&exe, b"old daemon").unwrap();
        let tgz = tarball("top", "snyvi", b"new daemon");
        let fake = Fake::new();
        fake.put("snyvi-linux-x64.tar.gz", tgz.clone());
        *fake.truncate.lock().unwrap() = Some("snyvi-linux-x64.tar.gz".into());
        let u = updater(&tmp, &exe, fake);
        let err = u.stage(&manifest_for("9.9.9", &sha(&tgz))).unwrap_err();
        assert!(err.to_string().contains("does not match"), "{err}");
        assert!(
            !tmp.join("data/updates/9.9.9/snyvi-linux-x64.tar.gz")
                .exists(),
            "the partial file is removed"
        );
        assert!(u.staged().is_none());
        assert_eq!(fs::read(&exe).unwrap(), b"old daemon");
    }

    #[test]
    fn a_swap_whose_file_is_not_the_one_verified_leaves_the_old_one() {
        let tmp = tempdir();
        let exe = tmp.join("bin/snyvi");
        fs::create_dir_all(exe.parent().unwrap()).unwrap();
        fs::write(&exe, b"old daemon").unwrap();
        let staged = tmp.join("staged");
        fs::write(&staged, b"something else").unwrap();
        let err = swap_file(&staged, &exe, &sha(b"new daemon")).unwrap_err();
        assert!(
            err.to_string().contains("not the file that was verified"),
            "{err}"
        );
        assert_eq!(fs::read(&exe).unwrap(), b"old daemon");
        assert!(!tmp.join("bin/snyvi.prev").exists() && !tmp.join("bin/snyvi.new").exists());
    }

    #[test]
    fn a_crash_restart_does_not_count_as_an_apply() {
        let tmp = tempdir();
        let exe = tmp.join("bin/snyvi");
        fs::create_dir_all(exe.parent().unwrap()).unwrap();
        fs::write(&exe, b"new daemon").unwrap();
        let u = updater(&tmp, &exe, Fake::new());
        assert_eq!(u.note_started(false, 5), None, "nothing was being applied");
        u.edit(|s| {
            s.applying = Some("9.9.9".into());
            s.applying_sha = Some(sha(b"new daemon"));
        });
        // The file is right, but the exit was not planned: whatever put it
        // there, this daemon cannot say an update landed, and it says failed
        // rather than opening a slot it did not earn.
        assert_eq!(
            u.note_started(false, 5),
            Some(Started::Failed("9.9.9".into()))
        );
        assert_eq!(u.state().last_applied, None);
        assert_eq!(u.state().failed.as_deref(), Some("9.9.9"));
    }

    #[test]
    fn a_zip_is_read_through_its_directory() {
        let tmp = tempdir();
        let z = zip(
            "snyvi-1.0.0-x86_64-pc-windows-msvc",
            &[
                ("snyvi.exe", &b"daemon bytes"[..], false),
                (
                    "snyvi-app.exe",
                    &b"window bytes, deflated, longer than the rest"[..],
                    true,
                ),
                ("README.md", &b"# hi"[..], true),
            ],
        );
        let path = tmp.join("a.zip");
        fs::write(&path, &z).unwrap();
        let into = tmp.join("out");
        unzip(&path, &into).unwrap();
        assert_eq!(
            fs::read(into.join("snyvi-1.0.0-x86_64-pc-windows-msvc/snyvi.exe")).unwrap(),
            b"daemon bytes"
        );
        assert_eq!(
            fs::read(into.join("snyvi-1.0.0-x86_64-pc-windows-msvc/snyvi-app.exe")).unwrap(),
            b"window bytes, deflated, longer than the rest"
        );
        assert_eq!(
            find(&into, "snyvi.exe", false).unwrap(),
            into.join("snyvi-1.0.0-x86_64-pc-windows-msvc/snyvi.exe")
        );
        let bad = zip("..", &[("snyvi.exe", &b"x"[..], false)]);
        fs::write(&path, &bad).unwrap();
        assert!(
            unzip(&path, &into).is_err(),
            "a path that climbs out is refused"
        );
    }

    #[test]
    fn the_check_stages_a_newer_version_and_drops_a_staged_one_that_is_not_newer() {
        // The fixture manifest says 1.9.9 and names linux-x64 assets whose
        // hashes are of the bytes below, so a whole check runs against the
        // fake: signature, parse, compare, stage.
        let tmp = tempdir();
        let exe = tmp.join("bin/snyvi");
        fs::create_dir_all(exe.parent().unwrap()).unwrap();
        fs::write(&exe, b"old daemon").unwrap();
        let fake = Fake::new();
        fake.put("latest.json", SIGNED.to_vec());
        fake.put("latest.json.minisig", SIGNATURE.to_vec());
        fake.put("snyvi-linux-x64.tar.gz", TARBALL.to_vec());
        let mut u = updater(&tmp, &exe, fake);
        u.key = minisign_verify::PublicKey::decode(TEST_PUB).unwrap();
        let c = u.check(false, None).unwrap();
        assert!(c.newer());
        assert_eq!(c.ready.as_deref(), Some("1.9.9"));
        let s = u.state();
        assert_eq!(s.available.as_deref(), Some("1.9.9"));
        assert_eq!(s.ready.as_deref(), Some("1.9.9"));
        assert!(s.since.is_some() && !s.asked && s.error.is_none());
        assert_eq!(s.latest_app_min.as_deref(), Some("1.6.0"));
        // Asked: the floor no longer applies, and a check without a newer
        // version drops what was staged.
        u.running = semver::Version::parse("1.9.9").unwrap();
        u.forget_current();
        let c = u.check(true, None).unwrap();
        assert!(!c.newer() && c.ready.is_none());
        let s = u.state();
        assert!(s.asked && s.ready.is_none() && s.available.is_none());
        assert!(!tmp.join("data/updates/1.9.9").exists());
        // A dev build never checks.
        u.channel = Channel::Dev;
        assert!(u.check(true, None).is_err());
    }

    fn tempdir() -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "snyvi-update-{}-{}",
            std::process::id(),
            jitter(1 << 30)
        ));
        fs::create_dir_all(&d).unwrap();
        d
    }
}
