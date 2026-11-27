//! The helper as the daemon will use it: started once, sent takes as frames on
//! stdin, read back a line each, stopped by closing stdin.
//!
//! This needs the real model, which is 140 MB and not in the tree, so it runs
//! only where `SNYVI_EARS_MODEL` names a folder holding it and the clip the
//! model's own release ships beside it (`test_wavs/0.wav`, a public-domain
//! line of a 1961 speech). `.github/workflows/ears.yml` sets it on every
//! platform a release is built for; without it the test says so and passes.

use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Command, Stdio};

use serde_json::Value;

/// A 16-bit PCM file's rate and samples, first channel only.
fn wav(path: &Path) -> (u32, Vec<f32>) {
    let b = std::fs::read(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    assert_eq!(
        (&b[..4], &b[8..12]),
        (&b"RIFF"[..], &b"WAVE"[..]),
        "not a wav"
    );
    let u16at = |i: usize| u16::from_le_bytes([b[i], b[i + 1]]);
    let u32at = |i: usize| u32::from_le_bytes([b[i], b[i + 1], b[i + 2], b[i + 3]]);
    let (mut at, mut rate, mut channels) = (12, 0, 1);
    while at + 8 <= b.len() {
        let len = u32at(at + 4) as usize;
        let body = at + 8;
        match &b[at..at + 4] {
            b"fmt " => {
                assert_eq!((u16at(body), u16at(body + 14)), (1, 16), "16-bit PCM only");
                channels = u16at(body + 2) as usize;
                rate = u32at(body + 4);
            }
            b"data" => {
                let end = (body + len).min(b.len());
                let samples = b[body..end]
                    .chunks_exact(2 * channels)
                    .map(|s| f32::from(i16::from_le_bytes([s[0], s[1]])) / 32768.0)
                    .collect();
                return (rate, samples);
            }
            _ => {}
        }
        at = body + len + (len & 1);
    }
    panic!("{}: no data chunk", path.display());
}

fn frame(tag: u8, body: &[u8]) -> Vec<u8> {
    [&[tag][..], &(body.len() as u32).to_le_bytes(), body].concat()
}

/// One take as the window sends it: the rate, the sound in pieces, the end.
fn take(rate: u32, samples: &[f32]) -> Vec<u8> {
    let mut out = frame(b'S', &rate.to_le_bytes());
    for piece in samples.chunks(2048) {
        let bytes: Vec<u8> = piece.iter().flat_map(|s| s.to_le_bytes()).collect();
        out.extend(frame(b'A', &bytes));
    }
    out.extend(frame(b'E', &[]));
    out
}

#[test]
fn a_warm_helper_hears_a_voice_and_says_nothing_of_silence() {
    let Ok(model) = std::env::var("SNYVI_EARS_MODEL") else {
        eprintln!("SNYVI_EARS_MODEL is not set: the model is not here, so nothing was heard");
        return;
    };
    let model = Path::new(&model);
    let (rate, voice) = wav(&model.join("test_wavs/0.wav"));

    let mut ears = Command::new(env!("CARGO_BIN_EXE_snyvi-ears"))
        .arg("--model")
        .arg(model)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("the helper starts");
    let mut to = ears.stdin.take().unwrap();
    let mut from = BufReader::new(ears.stdout.take().unwrap());
    let mut line = || -> Value {
        let mut s = String::new();
        from.read_line(&mut s).expect("a line from the helper");
        serde_json::from_str(&s).unwrap_or_else(|e| panic!("not a line of JSON ({e}): {s:?}"))
    };

    assert_eq!(line()["ready"], true);

    // The same take twice on one process: the second is the warm one, and
    // what a held key costs.
    for _ in 0..2 {
        to.write_all(&take(rate, &voice)).unwrap();
        to.flush().unwrap();
        let heard = line();
        eprintln!("{heard}");
        assert_eq!(heard["quiet"], false);
        let words = heard["heard"].as_str().unwrap().to_lowercase();
        assert!(
            words.contains("ask not what your country can do for you"),
            "{words:?}"
        );
        assert!(heard["level"].as_f64().unwrap() > 0.1);
    }

    // A key held on a silent room: no words, and the model never asked.
    to.write_all(&take(rate, &vec![0.0; rate as usize * 2]))
        .unwrap();
    to.flush().unwrap();
    let silence = line();
    assert_eq!(
        (&silence["quiet"], &silence["heard"]),
        (&Value::Bool(true), &Value::from(""))
    );

    // The voice far too quiet to be one is the same answer, not a guess.
    let faint: Vec<f32> = voice.iter().map(|s| s * 0.001).collect();
    to.write_all(&take(rate, &faint)).unwrap();
    to.flush().unwrap();
    assert_eq!(line()["quiet"], true);

    // Closing stdin is how it is stopped.
    drop(to);
    assert!(ears.wait().unwrap().success());
}

#[test]
fn a_frame_it_cannot_read_ends_it_with_a_reason() {
    let Ok(model) = std::env::var("SNYVI_EARS_MODEL") else {
        return;
    };
    let mut ears = Command::new(env!("CARGO_BIN_EXE_snyvi-ears"))
        .arg("--model")
        .arg(model)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .expect("the helper starts");
    ears.stdin
        .take()
        .unwrap()
        .write_all(&frame(b'X', &[]))
        .unwrap();
    let out = ears.wait_with_output().unwrap();
    assert_eq!(out.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&out.stderr).contains("unknown frame"));
}
