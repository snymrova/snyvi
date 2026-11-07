//! A page's files: copied in, never linked (plan 48ca2d5b9e, step 1).
//!
//! A logo, a cover or a moment's picture or clip is copied into
//! `data/pages/` under the first 16 hex of its blake3, so the page shows
//! what the builder had when they chose it, a later edit in the folder
//! changes nothing that is up, and `/pages/{file}` serves those names and
//! nothing else. Each role has a cap, and a page has one for all of them;
//! over a cap is refused with the size named, as a sentence for the reader
//! or the agent.

use anyhow::{bail, Context, Result};
use std::io::{Read, Write};
use std::path::Path;

/// The folder under the data directory a page's files are in.
pub const DIR: &str = "pages";

pub const LOGO_MAX: u64 = 400 * 1024;
pub const PICTURE_MAX: u64 = 1536 * 1024;
pub const CLIP_MAX: u64 = 20 << 20;
/// Everything one page holds, its moments' files with its own.
pub const PAGE_MAX: u64 = 50 << 20;

/// What a file is on a page: its mark, a picture, or a clip.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    Logo,
    Picture,
    Clip,
}

impl Role {
    fn exts(self) -> &'static [&'static str] {
        match self {
            Role::Logo => &["svg", "png", "jpg", "webp"],
            Role::Picture => &["png", "jpg", "webp", "gif", "avif"],
            Role::Clip => &["mp4", "webm"],
        }
    }
    fn cap(self) -> u64 {
        match self {
            Role::Logo => LOGO_MAX,
            Role::Picture => PICTURE_MAX,
            Role::Clip => CLIP_MAX,
        }
    }
    fn word(self) -> &'static str {
        match self {
            Role::Logo => "a logo",
            Role::Picture => "a picture",
            Role::Clip => "a clip",
        }
    }
    /// The role an extension plays when nothing says (a moment's file).
    pub fn of_ext(ext: &str) -> Option<Role> {
        [Role::Picture, Role::Clip]
            .into_iter()
            .find(|r| r.exts().contains(&ext))
    }
}

/// Every extension a page file may have.
fn any_ext(ext: &str) -> bool {
    [Role::Logo, Role::Picture, Role::Clip]
        .iter()
        .any(|r| r.exts().contains(&ext))
}

/// `<16 hex>.<ext>`: the only names `/pages/{file}` serves.
pub fn file_name_ok(name: &str) -> bool {
    let Some((hash, ext)) = name.split_once('.') else {
        return false;
    };
    hash.len() == 16
        && hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        && any_ext(ext)
}

fn size(n: u64) -> String {
    if n >= 1 << 20 {
        format!("{:.1} MB", n as f64 / (1 << 20) as f64)
    } else {
        format!("{} KB", n.div_ceil(1024))
    }
}

/// Copy `from` into `dir` as `role`, named by its content, unless it is
/// there already. `held` is what the page holds before this file, for
/// `PAGE_MAX`. The name it is kept under.
pub fn copy_in(dir: &Path, from: &Path, role: Role, held: u64) -> Result<String> {
    let mut ext = crate::render::ext_of(&from.to_string_lossy());
    if ext == "jpeg" {
        ext = "jpg".into();
    }
    if !role.exts().contains(&ext.as_str()) {
        bail!(
            "{} on a page is {}, not .{ext}",
            role.word(),
            role.exts().join(", ")
        );
    }
    let f = std::fs::File::open(from).with_context(|| format!("reading {}", from.display()))?;
    let mut bytes = Vec::new();
    f.take(role.cap() + 1).read_to_end(&mut bytes)?;
    let n = bytes.len() as u64;
    if n == 0 {
        bail!("{} is empty", from.display());
    }
    if n > role.cap() {
        bail!(
            "{} is over {}; {} on a page is up to {}",
            from.display(),
            size(role.cap()),
            role.word(),
            size(role.cap())
        );
    }
    if held + n > PAGE_MAX {
        bail!(
            "the page holds {} and this is {}; a page is up to {} in all",
            size(held),
            size(n),
            size(PAGE_MAX)
        );
    }
    let hash = blake3::hash(&bytes).to_hex();
    let name = format!("{}.{ext}", &hash[..16]);
    std::fs::create_dir_all(dir)?;
    let to = dir.join(&name);
    if !to.exists() {
        // Two copies at once each have their own, then one rename wins.
        static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let k = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let tmp = dir.join(format!(".copy-{}-{k}", std::process::id()));
        let mut out = std::fs::File::create(&tmp)?;
        out.write_all(&bytes)?;
        out.sync_all()?;
        drop(out);
        std::fs::rename(&tmp, &to)?;
    }
    Ok(name)
}

/// What the named files take on disk, each counted once.
pub fn held(dir: &Path, names: &[&str]) -> u64 {
    let mut seen: Vec<&str> = names.iter().copied().filter(|n| !n.is_empty()).collect();
    seen.sort_unstable();
    seen.dedup();
    seen.iter()
        .filter(|n| file_name_ok(n))
        .filter_map(|n| std::fs::metadata(dir.join(n)).ok())
        .map(|m| m.len())
        .sum()
}
