//! Music while you work (#204): the stations snyvi offers, the reader's own
//! streams and music folder, and the relay that plays a station through the
//! daemon.
//!
//! Why a relay: the page's CSP lets media come from the daemon alone (and
//! snyvi.com for the tour), and that stays so -- a `media-src` open to any
//! host would let anything drawn in the page send a request anywhere. So the
//! page asks the daemon for `/api/music/play/{n}`, and the daemon fetches the
//! one stream the reader pressed Play on and passes its bytes along. It
//! relays only a station on this list or a URL the reader added themselves:
//! never a URL a request names. On a Mac it also keeps App Transport
//! Security out of it, which refuses a plain-http stream in the window.
//!
//! The stations were each probed on 2026-11-01 (`ffprobe`): every one sent
//! MP3, which all three window engines play. AIR Raagam was left out: it is
//! HLS, which WebView2 cannot play in an `<audio>`.

use anyhow::{bail, Context, Result};
use serde::Serialize;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

#[derive(Clone, Copy, Debug, Serialize)]
pub struct Station {
    pub name: &'static str,
    pub group: &'static str,
    #[serde(skip)]
    pub url: &'static str,
}

const fn st(group: &'static str, name: &'static str, url: &'static str) -> Station {
    Station { name, group, url }
}

/// In the order the pop shows them, a group's stations together.
pub const STATIONS: &[Station] = &[
    st(
        "Focus",
        "SomaFM Groove Salad",
        "https://ice2.somafm.com/groovesalad-128-mp3",
    ),
    st(
        "Focus",
        "SomaFM Drone Zone",
        "https://ice2.somafm.com/dronezone-128-mp3",
    ),
    st(
        "Focus",
        "SomaFM Deep Space One",
        "https://ice2.somafm.com/deepspaceone-128-mp3",
    ),
    st(
        "Focus",
        "SomaFM Fluid",
        "https://ice2.somafm.com/fluid-128-mp3",
    ),
    st(
        "Focus",
        "freeCodeCamp Code Radio",
        "https://coderadio-admin-v2.freecodecamp.org/listen/coderadio/radio.mp3",
    ),
    st(
        "Lo-fi",
        "REYFM #lofi",
        "https://listen.reyfm.de/lofi_320kbps.mp3",
    ),
    st(
        "Lo-fi",
        "I Love Chillhop",
        "https://ilm.stream27.radiohost.de/ilm_ilovechillhop_mp3-192",
    ),
    st("Lo-fi", "Nightwave Plaza", "http://radio.plaza.one/mp3"),
    st(
        "Lo-fi",
        "0R Lo-Fi",
        "https://0nlineradio.radioho.st/0r-lo-fi",
    ),
    st(
        "Calm",
        "Ambient Sleeping Pill",
        "http://radio.stereoscenic.com/asp-h",
    ),
    st(
        "Calm",
        "Cryosleep",
        "http://streams.echoesofbluemars.org:8000/cryosleep",
    ),
    st(
        "Calm",
        "Your Classical Relax",
        "http://relax.stream.publicradio.org/relax.mp3",
    ),
    st("Calm", "WALM 2", "https://icecast.walmradio.com:8443/walm2"),
    st(
        "Indian classical",
        "Shaiva Lahari",
        "https://24293.live.streamtheworld.com/SP_R2925215_SC",
    ),
    st(
        "Indian classical",
        "Aural Melodics",
        "https://stream-159.zeno.fm/7fmywrmrga0uv",
    ),
    st(
        "Bhajan",
        "Bhakti Sagar Durga Maa",
        "https://stream.zeno.fm/syu0rdutvxhvv",
    ),
    st(
        "Bhajan",
        "Bhakti World Krishna",
        "http://millenniumhits.out.airtime.pro:8000/millenniumhits_a",
    ),
    st(
        "Bhajan",
        "Bhakti World Shri Ram",
        "https://dard.out.airtime.pro/dard_a",
    ),
    st(
        "Bhajan",
        "Bhakti World Shiva",
        "http://hot.out.airtime.pro:8000/hot_a",
    ),
    st(
        "Bhajan",
        "SVBC TTD Radio",
        "https://radio.mslivecdn.com:6278/stream",
    ),
    st(
        "Bhajan",
        "Namasphere 108",
        "https://a4.asurahosting.com:8940/radio.mp3",
    ),
    st(
        "Bhajan",
        "Mahakatha Radio",
        "https://mahakatharadio.com/api/station/live.mp3",
    ),
    st(
        "Bhajan",
        "Radio Sai Gayathri",
        "http://stream.radiosai.net:8006/",
    ),
];

/// The reader's own stream URLs, at most this many: a list to pick from, not
/// a library.
pub const MINE_CAP: usize = 24;

/// What a URL the reader adds must look like: http or https, a host, no
/// credentials, and short. It is fetched only when they press it.
pub fn check_url(raw: &str) -> Result<String> {
    let u = raw.trim();
    if u.len() > 2048 {
        bail!("that address is too long");
    }
    let rest = u
        .strip_prefix("https://")
        .or_else(|| u.strip_prefix("http://"))
        .context("a stream's address starts with http:// or https://")?;
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    if host.is_empty()
        || host.contains('@')
        || u.chars().any(|c| c.is_whitespace() || c.is_control())
    {
        bail!("that isn't a stream's address");
    }
    Ok(u.to_string())
}

/// The URL behind play number `n`: the stations first, then the reader's own.
/// The page names a number, never a URL, so the relay can fetch nothing else.
pub fn url_for(n: usize, mine: &[String]) -> Option<String> {
    match STATIONS.get(n) {
        Some(s) => Some(s.url.to_string()),
        None => mine.get(n - STATIONS.len()).cloned(),
    }
}

/// Audio a folder may hold, by extension.
const AUDIO: &[&str] = &["mp3", "m4a", "aac", "ogg", "oga", "opus", "flac", "wav"];
/// How deep and how many: a music folder, read in a moment, never a disk.
const DEPTH: usize = 2;
pub const FILES_CAP: usize = 2000;

/// The audio files under the folder the reader picked, two levels down at
/// most and no more than `FILES_CAP`, as paths relative to it, in name order
/// (an album's tracks are named in their order). Hidden entries and links
/// are skipped: a link could lead out of the folder.
pub fn list_folder(root: &Path) -> Vec<String> {
    let mut out = Vec::new();
    walk(root, root, 0, &mut out);
    out.sort_by_key(|p| p.to_lowercase());
    out
}

fn walk(root: &Path, dir: &Path, depth: usize, out: &mut Vec<String>) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    let mut ents: Vec<_> = rd.flatten().collect();
    ents.sort_by_key(|e| e.file_name());
    for e in ents {
        if out.len() >= FILES_CAP {
            return;
        }
        let name = e.file_name();
        let Some(name) = name.to_str() else { continue };
        if name.starts_with('.') {
            continue;
        }
        let Ok(ft) = e.file_type() else { continue };
        let p = e.path();
        if ft.is_dir() && depth < DEPTH {
            walk(root, &p, depth + 1, out);
        } else if ft.is_file() && is_audio(&p) {
            if let Ok(rel) = p.strip_prefix(root) {
                out.push(rel.to_string_lossy().replace('\\', "/"));
            }
        }
    }
}

fn is_audio(p: &Path) -> bool {
    p.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| AUDIO.contains(&e.to_ascii_lowercase().as_str()))
}

/// The file behind folder track `n`, listed afresh so a request can only
/// ever reach a file the listing would show.
pub fn track(root: &Path, n: usize) -> Option<PathBuf> {
    list_folder(root).get(n).map(|rel| root.join(rel))
}

/// The media type a browser needs to play a folder track.
pub fn mime(p: &Path) -> &'static str {
    match p
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("mp3") => "audio/mpeg",
        Some("m4a") => "audio/mp4",
        Some("aac") => "audio/aac",
        Some("ogg" | "oga") => "audio/ogg",
        Some("opus") => "audio/ogg; codecs=opus",
        Some("flac") => "audio/flac",
        Some("wav") => "audio/wav",
        _ => "application/octet-stream",
    }
}

/// Open a station's stream. Connecting and the first answer each have a few
/// seconds; the body has no timeout at all, since a station never ends --
/// ureq's body timeout is for the whole body, and cut every station at its
/// twentieth second. A station that stalls stalls the page's player, which
/// says so, and Stop or another station lets it go. A reply that is not
/// audio (a web page, a playlist file) is refused, so the page says it
/// couldn't play rather than waiting.
pub fn open(url: &str) -> Result<(String, Box<dyn Read + Send>)> {
    let agent = ureq::Agent::new_with_config(
        ureq::config::Config::builder()
            .timeout_connect(Some(Duration::from_secs(8)))
            .timeout_recv_response(Some(Duration::from_secs(10)))
            .user_agent(concat!("snyvi/", env!("CARGO_PKG_VERSION")))
            .build(),
    );
    let resp = agent.get(url).call().context("the station didn't answer")?;
    let ty = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    let ty = ty.split(';').next().unwrap_or("").trim().to_string();
    let audio = ty.starts_with("audio/") && !ty.contains("mpegurl") && !ty.contains("scpls");
    if !(audio || ty == "application/ogg" || ty == "application/octet-stream") {
        bail!(
            "that address sends {}, not a stream",
            if ty.is_empty() {
                "nothing playable"
            } else {
                &ty
            }
        );
    }
    let ty = if ty == "application/octet-stream" {
        "audio/mpeg".to_string()
    } else {
        ty
    };
    Ok((ty, Box::new(resp.into_body().into_reader())))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_play_number_names_a_station_or_the_readers_own_and_nothing_else() {
        let mine = vec!["https://example.org/a.mp3".to_string()];
        assert_eq!(url_for(0, &mine).as_deref(), Some(STATIONS[0].url));
        assert_eq!(
            url_for(STATIONS.len(), &mine).as_deref(),
            Some("https://example.org/a.mp3")
        );
        assert_eq!(url_for(STATIONS.len() + 1, &mine), None);
    }

    #[test]
    fn an_added_address_is_a_plain_http_url() {
        assert!(check_url(" https://ice2.somafm.com/x ").is_ok());
        assert!(check_url("http://h:8000/").is_ok());
        for bad in [
            "file:///etc/passwd",
            "javascript:x",
            "https://",
            "https://u:p@h/",
            "https://h/a b",
        ] {
            assert!(check_url(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_folder_lists_its_audio_two_deep_and_skips_the_rest() {
        let d = std::env::temp_dir().join(format!("snyvi-music-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        for p in [
            "b.mp3",
            "A/1.flac",
            "A/x.txt",
            "A/B/2.ogg",
            "A/B/C/deep.mp3",
            ".hid/h.mp3",
        ] {
            let f = d.join(p);
            std::fs::create_dir_all(f.parent().unwrap()).unwrap();
            std::fs::write(f, b"x").unwrap();
        }
        assert_eq!(list_folder(&d), ["A/1.flac", "A/B/2.ogg", "b.mp3"]);
        assert_eq!(track(&d, 2), Some(d.join("b.mp3")));
        assert_eq!(track(&d, 3), None);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn every_station_is_a_plain_url_with_a_known_group() {
        for s in STATIONS {
            assert!(check_url(s.url).is_ok(), "{}", s.name);
            assert!(
                ["Focus", "Lo-fi", "Calm", "Indian classical", "Bhajan"].contains(&s.group),
                "{}",
                s.name
            );
        }
    }
}
