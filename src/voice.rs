//! Voice: the speech helper, fetched when the reader turns voice on, kept warm
//! while it is used, and stopped when it is not.
//!
//! The daemon hears nothing itself. `snyvi-ears` (the `ears/` package, built
//! and released beside snyvi) is a separate program that links a speech
//! runtime; this module downloads it and its model by the release's signed
//! manifest (`update::Updater::fetch_role`), starts it, hands it one take at a
//! time over its stdin, and reads back one line. `ears/src/main.rs` has the
//! frames.
//!
//! **What this module must never do** is act on the words. It returns them to
//! the window that held the key, and the window decides what they mean
//! (`ui/voice.js`). Nothing here reaches a pane, the store or a route; the
//! invariant in `CLAUDE.md` -- snyvi never makes input from content it
//! received -- holds because there is no path from here to anything that acts.
//!
//! On disk, under `<data>/voice/`:
//!
//! | | |
//! |---|---|
//! | `ears/` | the helper, as its download unpacked |
//! | `model/` | the three files of the model |
//! | `installed.json` | which release they came from, and their sums |
//! | `off` | there when the reader turned voice off without removing it |

use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::update::{find, untar, Updater};

/// The helper this daemon speaks to, by the first two parts of its version: a
/// change to the frames or the lines is a change to the second. A helper on
/// disk that is another is not started; the sheet offers to fetch this one.
pub const SPEAKS: &str = "0.1";

/// A helper nobody has spoken to for this long is stopped, and its memory,
/// some 200 MB, given back. The next held key starts it again, in a second.
pub const IDLE: Duration = Duration::from_secs(10 * 60);

/// The most sound one take may be, in bytes of f32: twenty seconds at the
/// highest rate a microphone has. The helper keeps less; this is only what
/// the daemon will hold for a window that never lets go.
pub const LONGEST_TAKE: usize = 20 * 192_000 * 4;

/// Sound goes to the helper in frames of this many bytes at most.
const FRAME: usize = 1 << 16;

#[cfg(windows)]
const HELPER: &str = "snyvi-ears.exe";
#[cfg(not(windows))]
const HELPER: &str = "snyvi-ears";

/// What a model's folder must hold to be one.
const MODEL_FILES: [&str; 3] = [
    "encoder_model.ort",
    "decoder_model_merged.ort",
    "tokens.txt",
];

/// Whether this build offers voice at all. Linux only until the microphone
/// has been tried on a Mac and on Windows; the helper is built and released
/// for all three, so this line is the whole of switching them on.
/// `SNYVI_VOICE=1` offers it anywhere, which is how it is tried there.
pub fn offered() -> bool {
    cfg!(target_os = "linux") || std::env::var_os("SNYVI_VOICE").is_some_and(|v| v == "1")
}

/// `installed.json`.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Receipt {
    /// The release the helper was built beside.
    pub version: String,
    pub ears: String,
    pub model: String,
}

/// The helper, running: started, loaded, and waiting on its stdin.
struct Ears {
    child: Child,
    to: ChildStdin,
    from: BufReader<ChildStdout>,
}

impl Drop for Ears {
    /// Killed, not asked: it holds nothing worth a clean exit, and a helper
    /// stuck in a decode would not hear its stdin close.
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[derive(Default)]
struct Told {
    /// What a fetch is doing, while one runs.
    fetching: Option<String>,
    /// Why the last fetch, or the last start, did not work.
    error: Option<String>,
}

pub struct Voice {
    dir: PathBuf,
    /// Its own lock, so that asking how things stand never waits on a decode.
    told: Mutex<Told>,
    /// The running helper and when it was last spoken to. One take at a time:
    /// a second key held while the first is decoded waits its turn here.
    ears: Mutex<(Option<Ears>, Instant)>,
}

impl Voice {
    pub fn new(data_dir: &Path) -> Voice {
        Voice {
            dir: data_dir.join("voice"),
            told: Mutex::default(),
            ears: Mutex::new((None, Instant::now())),
        }
    }

    fn told(&self) -> std::sync::MutexGuard<'_, Told> {
        self.told.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn ears(&self) -> std::sync::MutexGuard<'_, (Option<Ears>, Instant)> {
        self.ears.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn helper(&self) -> PathBuf {
        self.dir.join("ears").join(HELPER)
    }

    fn model(&self) -> PathBuf {
        self.dir.join("model")
    }

    fn model_whole(&self) -> bool {
        MODEL_FILES.iter().all(|f| self.model().join(f).is_file())
    }

    pub fn receipt(&self) -> Receipt {
        fs::read(self.dir.join("installed.json"))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default()
    }

    /// Both downloads are here, whole.
    pub fn installed(&self) -> bool {
        self.helper().is_file() && self.model_whole()
    }

    /// Installed, and not turned off.
    pub fn on(&self) -> bool {
        self.installed() && !self.dir.join("off").exists()
    }

    /// Off keeps the downloads and stops the helper; on is only the mark gone.
    pub fn set_on(&self, on: bool) -> Result<()> {
        let mark = self.dir.join("off");
        if on {
            let _ = fs::remove_file(mark);
        } else {
            fs::create_dir_all(&self.dir)?;
            fs::write(&mark, b"").with_context(|| format!("writing {}", mark.display()))?;
            self.stop();
        }
        Ok(())
    }

    /// How things stand, for the sheet and the bar.
    pub fn status(&self) -> Value {
        let told = self.told();
        // `try_lock`: a decode holds the other lock for its length, and a
        // helper mid-decode is warm.
        let warm = self.ears.try_lock().map_or(true, |e| e.0.is_some());
        json!({
            "offered": offered(),
            "installed": self.installed(),
            "on": self.on(),
            "fetching": told.fetching,
            "error": told.error,
            "warm": warm,
            "bytes": dir_bytes(&self.dir),
            "version": self.receipt().version,
        })
    }

    // ----- fetching -----

    /// Fetch the helper and the model and put them in place. Blocking, and
    /// minutes long on a slow line: `status` says where it has got to. One at
    /// a time; a second asked for while one runs is refused.
    pub fn fetch(&self, up: &Updater) -> Result<()> {
        {
            let mut told = self.told();
            if told.fetching.is_some() {
                bail!("voice is already being fetched");
            }
            told.fetching = Some("Looking for the download".into());
            told.error = None;
        }
        let done = self.fetch_inner(up);
        let mut told = self.told();
        told.fetching = None;
        told.error = done.as_ref().err().map(|e| format!("{e:#}"));
        done
    }

    fn step(&self, what: &str) {
        self.told().fetching = Some(what.into());
    }

    fn fetch_inner(&self, up: &Updater) -> Result<()> {
        let m = up.manifest_beside()?;
        let tmp = self.dir.join("fetching");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).with_context(|| format!("creating {}", tmp.display()))?;

        self.step("Fetching the helper");
        let ears_tar = tmp.join("ears.tar.gz");
        let ears = up.fetch_role(&m, "ears", &ears_tar)?;

        // The model is the large one, and the same file from release to
        // release until the model itself changes: one already here under the
        // sum the manifest names is not fetched again.
        let model = m.role(&up.platform, "ears-model")?;
        let kept = self.receipt().model == model.sha256 && self.model_whole();
        let model_tar = tmp.join("model.tar.gz");
        if !kept {
            self.step("Fetching the speech model");
            up.fetch_role(&m, "ears-model", &model_tar)?;
        }

        self.step("Putting it in place");
        let receipt = Receipt {
            version: m.version.clone(),
            ears: ears.sha256,
            model: model.sha256,
        };
        self.place(&ears_tar, (!kept).then_some(model_tar.as_path()), &receipt)?;
        let _ = fs::remove_dir_all(&tmp);
        Ok(())
    }

    /// Two checked archives into `ears/` and `model/`, and the receipt that
    /// says what they are. The running helper is stopped first: it is the
    /// file being replaced. With no model archive, the model here is kept.
    fn place(&self, ears_tar: &Path, model_tar: Option<&Path>, receipt: &Receipt) -> Result<()> {
        let tmp = ears_tar
            .parent()
            .ok_or_else(|| anyhow!("the download has no folder"))?;
        let unpacked = tmp.join("ears");
        untar(ears_tar, &unpacked)?;
        let helper = find(&unpacked, HELPER, false)?;
        let new_model = match model_tar {
            Some(tar) => {
                let unpacked = tmp.join("model");
                untar(tar, &unpacked)?;
                let any = find(&unpacked, MODEL_FILES[0], false)?;
                Some(any.parent().map(Path::to_path_buf).unwrap_or(unpacked))
            }
            None => None,
        };
        self.stop();
        let swap = |from: &Path, to: PathBuf| -> Result<()> {
            let _ = fs::remove_dir_all(&to);
            fs::rename(from, &to)
                .with_context(|| format!("moving {} to {}", from.display(), to.display()))
        };
        swap(helper.parent().unwrap_or(&unpacked), self.dir.join("ears"))?;
        if let Some(m) = new_model {
            swap(&m, self.model())?;
        }
        if !self.installed() {
            bail!("the download did not hold a helper and a model");
        }
        fs::write(
            self.dir.join("installed.json"),
            serde_json::to_vec_pretty(receipt)?,
        )?;
        let _ = fs::remove_file(self.dir.join("off"));
        Ok(())
    }

    /// The downloads gone, and the helper with them. Voice is a download and
    /// not a thing the reader made: removing it loses nothing but the fetch.
    pub fn remove(&self) -> Result<()> {
        if self.told().fetching.is_some() {
            bail!("voice is being fetched");
        }
        self.stop();
        match fs::remove_dir_all(&self.dir) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
                Err(e).with_context(|| format!("removing {}", self.dir.display()))
            }
            _ => {
                self.told().error = None;
                Ok(())
            }
        }
    }

    // ----- hearing -----

    /// Start the helper if it is not running, and wait for it to say it is
    /// ready. Called when a key goes down, so the second it takes to load is
    /// spent while the reader is still speaking.
    pub fn wake(&self) -> Result<()> {
        let mut ears = self.ears();
        self.wake_locked(&mut ears).map(|_| ())
    }

    fn wake_locked<'a>(&self, ears: &'a mut (Option<Ears>, Instant)) -> Result<&'a mut Ears> {
        if !self.on() {
            bail!("voice is off");
        }
        ears.1 = Instant::now();
        if ears.0.is_none() {
            let started = self.start();
            self.told().error = started.as_ref().err().map(|e| format!("{e:#}"));
            ears.0 = Some(started?);
        }
        Ok(ears.0.as_mut().expect("just set"))
    }

    fn start(&self) -> Result<Ears> {
        let mut cmd = Command::new(self.helper());
        cmd.arg("--model")
            .arg(self.model())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // The runtime writes a line here per take. Nobody reads it, and a
            // pipe nobody reads fills and stops the helper.
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(crate::platform::CREATE_NO_WINDOW);
        }
        let mut child = cmd
            .spawn()
            .with_context(|| format!("starting {}", self.helper().display()))?;
        let to = child.stdin.take().expect("piped");
        let from = BufReader::new(child.stdout.take().expect("piped"));
        let mut ears = Ears { child, to, from };
        // A helper that cannot run here -- an older libc than it was built
        // for, a model it cannot open -- closes its stdout without this line.
        let ready =
            read_line(&mut ears.from).context("the voice helper stopped before it was ready")?;
        let version = ready["version"].as_str().unwrap_or_default();
        if ready["ready"] != true || !speaks(version) {
            bail!(
                "the voice helper here is {version:?}, and this snyvi speaks {SPEAKS}: fetch voice again"
            );
        }
        Ok(ears)
    }

    /// One take: its rate and its sound as f32 bytes, little end first. Back
    /// comes the helper's line as it wrote it -- `level`, `quiet`, `heard`.
    /// A helper that fails mid-take is dropped, so the next key starts another.
    pub fn hear(&self, rate: u32, sound: &[u8]) -> Result<Value> {
        let mut guard = self.ears();
        let ears = self.wake_locked(&mut guard)?;
        let heard = take(ears, rate, sound);
        if heard.is_err() {
            guard.0 = None;
        }
        guard.1 = Instant::now();
        heard
    }

    /// Stop the helper if nobody has spoken to it for `IDLE`. Asked after
    /// each take, `IDLE` later; a take in between has moved the clock.
    pub fn stop_if_idle(&self) {
        let mut ears = self.ears();
        if ears.1.elapsed() >= IDLE {
            ears.0 = None;
        }
    }

    pub fn stop(&self) {
        self.ears().0 = None;
    }
}

/// `0.1.3` speaks `0.1`; `0.2.0` and `0.10.0` do not.
fn speaks(version: &str) -> bool {
    version
        .strip_prefix(SPEAKS)
        .is_some_and(|rest| rest.is_empty() || rest.starts_with('.'))
}

fn take(ears: &mut Ears, rate: u32, sound: &[u8]) -> Result<Value> {
    let whole = &sound[..sound.len().min(LONGEST_TAKE) / 4 * 4];
    let mut frames = Vec::with_capacity(whole.len() + 64);
    frames.extend(frame(b'S', &rate.to_le_bytes()));
    for piece in whole.chunks(FRAME) {
        frames.extend(frame(b'A', piece));
    }
    frames.extend(frame(b'E', &[]));
    ears.to
        .write_all(&frames)
        .and_then(|_| ears.to.flush())
        .context("the voice helper is gone")?;
    read_line(&mut ears.from).context("the voice helper stopped mid-take")
}

fn frame(tag: u8, body: &[u8]) -> Vec<u8> {
    [&[tag][..], &(body.len() as u32).to_le_bytes(), body].concat()
}

fn read_line(from: &mut impl BufRead) -> Result<Value> {
    let mut line = String::new();
    if from.read_line(&mut line)? == 0 {
        bail!("it closed its output");
    }
    serde_json::from_str(&line).with_context(|| format!("not a line of JSON: {line:?}"))
}

/// What a folder weighs, two levels down, which is all voice's has.
fn dir_bytes(dir: &Path) -> u64 {
    let Ok(entries) = fs::read_dir(dir) else {
        return 0;
    };
    entries
        .flatten()
        .map(|e| match e.metadata() {
            Ok(m) if m.is_dir() => dir_bytes(&e.path()),
            Ok(m) => m.len(),
            Err(_) => 0,
        })
        .sum()
}

#[cfg(test)]
mod tests;
