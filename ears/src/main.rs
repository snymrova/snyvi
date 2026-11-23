//! snyvi's ears: sound in, level and words out.
//!
//! The daemon starts this when voice is turned on and keeps it warm, so the
//! model is loaded once and a held key costs only the decode. It speaks to
//! nothing but its own stdin and stdout: no socket, no file written, no
//! network. The sound is held in memory for one take and dropped.
//!
//! In, on stdin, frames of `tag, length (u32 LE), payload`:
//!
//! | tag | payload | means |
//! |---|---|---|
//! | `S` | sample rate, u32 LE | a key went down: a new take at this rate |
//! | `A` | mono samples, f32 LE | sound, as it comes |
//! | `E` | nothing | the key came up: say what was heard |
//!
//! Out, on stdout, one line of JSON each:
//!
//! - once, when the model is loaded: `{"ready":true,"load_ms":…}`
//! - per take: `{"level":…,"quiet":…,"speech_ms":…,"heard":"…","ms":…}`
//!
//! `level` is the take's peak before any lift, which is what a meter should
//! show. `quiet` is true when there was nothing loud enough to be a voice; then
//! `heard` is empty and the model was never asked. `ms` is `E` to this line.
//!
//! Stdin closing is how it is told to stop. A frame it cannot read is the end
//! too, with a line on stderr: the daemon is the only writer, so a bad frame is
//! a bug to be seen, not a thing to recover from.
//!
//! `--wav FILE` reads one take from a file and exits: what CI and the bench
//! use, and the way to try a model by hand.

mod sound;

use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Instant;

use serde_json::{json, Value};
use sherpa_onnx::{OfflineRecognizer, OfflineRecognizerConfig, Wave};

/// Two, not one per core: on a four-core machine with agents running, two
/// threads decoded faster than four, which fought the agents for the cores.
const THREADS: i32 = 2;

/// No frame is larger than this. The window sends sound in pieces of a few
/// thousand samples; a length past this is a stream out of step.
const LARGEST_FRAME: u32 = 1 << 20;

const USAGE: &str = "usage: snyvi-ears --model DIR [--threads N] [--wav FILE]";

struct Args {
    model: PathBuf,
    threads: i32,
    wav: Option<String>,
}

fn args() -> Result<Args, String> {
    let (mut model, mut threads, mut wav) = (None, THREADS, None);
    let mut it = std::env::args().skip(1);
    while let Some(a) = it.next() {
        let mut value = || it.next().ok_or(format!("{a} needs a value\n{USAGE}"));
        match a.as_str() {
            "--model" => model = Some(PathBuf::from(value()?)),
            "--threads" => threads = value()?.parse().map_err(|_| USAGE.to_string())?,
            "--wav" => wav = Some(value()?),
            "--version" => {
                println!("{}", env!("CARGO_PKG_VERSION"));
                std::process::exit(0);
            }
            _ => return Err(USAGE.to_string()),
        }
    }
    Ok(Args {
        model: model.ok_or(USAGE)?,
        threads: threads.max(1),
        wav,
    })
}

/// The model, loaded. `DIR` holds the three files of a Moonshine build as its
/// release names them; the daemon checks their sums before it starts this.
fn open(dir: &Path, threads: i32) -> Result<OfflineRecognizer, String> {
    let file = |name: &str| {
        let p = dir.join(name);
        if p.is_file() {
            Ok(Some(p.to_string_lossy().into_owned()))
        } else {
            Err(format!("no {name} in {}", dir.display()))
        }
    };
    let mut c = OfflineRecognizerConfig::default();
    c.model_config.moonshine.encoder = file("encoder_model.ort")?;
    c.model_config.moonshine.merged_decoder = file("decoder_model_merged.ort")?;
    c.model_config.tokens = file("tokens.txt")?;
    c.model_config.num_threads = threads;
    OfflineRecognizer::create(&c)
        .ok_or_else(|| format!("the model in {} would not load", dir.display()))
}

/// One take, from the key going down to it coming up.
#[derive(Default)]
struct Take {
    rate: u32,
    samples: Vec<f32>,
}

impl Take {
    fn start(&mut self, rate: u32) {
        self.rate = rate;
        self.samples.clear();
    }

    /// Sound past `LONGEST_S` is dropped, not kept: the take's start is where
    /// a command is.
    fn add(&mut self, more: &[f32]) {
        let room = (self.rate as usize * sound::LONGEST_S).saturating_sub(self.samples.len());
        self.samples
            .extend_from_slice(&more[..more.len().min(room)]);
    }
}

/// What a take was: its level always, its words when there was a voice in it.
fn hear(ears: &OfflineRecognizer, rate: u32, samples: &[f32]) -> Value {
    let from = Instant::now();
    let level = sound::peak(samples);
    let part = (level >= sound::QUIET)
        .then(|| sound::spoken(samples, rate))
        .flatten();
    let Some(part) = part else {
        return json!({ "level": level, "quiet": true, "speech_ms": 0, "heard": "", "ms": ms(from) });
    };
    let speech_ms = part.len() as u64 * 1000 / u64::from(rate.max(1));
    let stream = ears.create_stream();
    // The stream resamples to what the model wants; the rate goes with it.
    stream.accept_waveform(rate as i32, &sound::lift(&samples[part]));
    ears.decode(&stream);
    let heard = stream
        .get_result()
        .map(|r| r.text.trim().to_string())
        .unwrap_or_default();
    json!({ "level": level, "quiet": false, "speech_ms": speech_ms, "heard": heard, "ms": ms(from) })
}

fn ms(from: Instant) -> u64 {
    from.elapsed().as_millis() as u64
}

#[derive(Debug, PartialEq)]
enum Frame {
    Start(u32),
    Sound(Vec<f32>),
    End,
}

/// The next frame, or `None` when stdin closed between two frames.
fn read_frame(r: &mut impl Read) -> io::Result<Option<Frame>> {
    let bad = |why: &str| io::Error::new(io::ErrorKind::InvalidData, why.to_string());
    let mut head = [0u8; 5];
    match r.read(&mut head[..1])? {
        0 => return Ok(None),
        _ => r.read_exact(&mut head[1..])?,
    }
    let len = u32::from_le_bytes([head[1], head[2], head[3], head[4]]);
    if len > LARGEST_FRAME {
        return Err(bad("a frame longer than any the window sends"));
    }
    let mut body = vec![0u8; len as usize];
    r.read_exact(&mut body)?;
    match head[0] {
        b'S' => match body.as_slice().try_into() {
            Ok(four) => match u32::from_le_bytes(four) {
                // Any rate a microphone has; the bounds only catch nonsense.
                rate @ 8_000..=192_000 => Ok(Some(Frame::Start(rate))),
                _ => Err(bad("a sample rate no microphone has")),
            },
            Err(_) => Err(bad("S carries one u32")),
        },
        b'A' if len % 4 == 0 => Ok(Some(Frame::Sound(
            body.chunks_exact(4)
                .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
                .collect(),
        ))),
        b'A' => Err(bad("A carries whole f32 samples")),
        b'E' if len == 0 => Ok(Some(Frame::End)),
        _ => Err(bad("an unknown frame")),
    }
}

fn run() -> Result<(), String> {
    let args = args()?;
    let from = Instant::now();
    let ears = open(&args.model, args.threads)?;
    println!(
        "{}",
        json!({ "ready": true, "load_ms": ms(from), "threads": args.threads })
    );

    if let Some(wav) = args.wav {
        let wave = Wave::read(&wav).ok_or(format!("cannot read {wav}"))?;
        println!("{}", hear(&ears, wave.sample_rate() as u32, wave.samples()));
        return Ok(());
    }

    let mut stdin = io::stdin().lock();
    let mut take = Take::default();
    while let Some(frame) = read_frame(&mut stdin).map_err(|e| e.to_string())? {
        match frame {
            Frame::Start(rate) => take.start(rate),
            Frame::Sound(more) => take.add(&more),
            Frame::End => {
                println!("{}", hear(&ears, take.rate, &take.samples));
                // Dropped here, not at the next key: a take is not kept.
                take.start(take.rate);
            }
        }
    }
    Ok(())
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(why) => {
            eprintln!("snyvi-ears: {why}");
            ExitCode::from(2)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(tag: u8, body: &[u8]) -> Vec<u8> {
        [&[tag][..], &(body.len() as u32).to_le_bytes(), body].concat()
    }

    #[test]
    fn a_take_reads_as_start_sound_end_and_then_the_close() {
        let sound: Vec<u8> = [0.5f32, -0.25]
            .iter()
            .flat_map(|s| s.to_le_bytes())
            .collect();
        let bytes = [
            frame(b'S', &48_000u32.to_le_bytes()),
            frame(b'A', &sound),
            frame(b'E', &[]),
        ]
        .concat();
        let mut r = bytes.as_slice();
        assert_eq!(read_frame(&mut r).unwrap(), Some(Frame::Start(48_000)));
        assert_eq!(
            read_frame(&mut r).unwrap(),
            Some(Frame::Sound(vec![0.5, -0.25]))
        );
        assert_eq!(read_frame(&mut r).unwrap(), Some(Frame::End));
        assert_eq!(read_frame(&mut r).unwrap(), None);
    }

    #[test]
    fn a_frame_out_of_step_is_refused_not_guessed_at() {
        for bytes in [
            frame(b'X', &[]),
            frame(b'S', &[1, 2, 3]),
            frame(b'S', &0u32.to_le_bytes()),
            frame(b'A', &[0, 0, 0]),
            frame(b'E', &[0]),
            [&b"A"[..], &(LARGEST_FRAME + 1).to_le_bytes()].concat(),
        ] {
            assert!(read_frame(&mut bytes.as_slice()).is_err(), "{bytes:?}");
        }
    }

    #[test]
    fn a_stream_cut_inside_a_frame_is_an_error_not_a_quiet_end() {
        let whole = frame(b'S', &16_000u32.to_le_bytes());
        assert!(read_frame(&mut &whole[..3]).is_err());
        assert!(read_frame(&mut &whole[..7]).is_err());
    }

    #[test]
    fn a_take_keeps_its_start_and_drops_what_runs_past_the_longest() {
        let mut take = Take::default();
        take.start(8_000);
        take.add(&vec![0.1; 8_000 * sound::LONGEST_S - 10]);
        take.add(&[0.2; 50]);
        assert_eq!(take.samples.len(), 8_000 * sound::LONGEST_S);
        assert_eq!(take.samples[take.samples.len() - 1], 0.2);
        take.start(16_000);
        assert!(take.samples.is_empty());
    }
}
