//! Turn a document into HTML exactly once, at receive time.

use comrak::adapters::SyntaxHighlighterAdapter;
use comrak::nodes::NodeValue;
use comrak::{format_html_with_plugins, parse_document, Arena, Options, Plugins};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{self, Write};
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use syntect::parsing::{ParseState, Scope, ScopeStack, SyntaxReference, SyntaxSet};
use syntect::util::LinesWithEndings;

mod pictures;
#[cfg(test)]
use pictures::picture_size;
use pictures::sized;

/// Source scanned for an outline, and the most entries returned.
const OUTLINE_CAP: usize = 512 * 1024;
const OUTLINE_ITEMS: usize = 1200;

/// One declaration in a source file.
#[derive(Debug, Clone, Serialize)]
pub struct Outline {
    pub name: String,
    /// fn | type | impl | mod
    pub kind: &'static str,
    /// 1-based, so the client can scroll to the matching line span.
    pub line: usize,
    pub depth: usize,
}

/// Sublime grammars mark a declared name with an `entity.name.*` scope. Call sites
/// and builtins use `support.*` and `variable.*`, so they stay out of the outline.
fn definition_kind(stack: &ScopeStack) -> Option<&'static str> {
    const DEFS: &[(&str, &str)] = &[
        ("entity.name.function", "fn"),
        ("entity.name.macro", "fn"),
        ("entity.name.struct", "type"),
        ("entity.name.enum", "type"),
        ("entity.name.union", "type"),
        ("entity.name.class", "type"),
        ("entity.name.interface", "type"),
        ("entity.name.trait", "type"),
        ("entity.name.type", "type"),
        ("entity.name.impl", "impl"),
        ("entity.name.namespace", "mod"),
        ("entity.name.module", "mod"),
        ("entity.name.package", "mod"),
    ];
    // Built once: Scope::new parses a string on every call otherwise.
    static TABLE: std::sync::OnceLock<Vec<(Scope, &'static str)>> = std::sync::OnceLock::new();
    let table = TABLE.get_or_init(|| {
        DEFS.iter()
            .filter_map(|(sel, kind)| Scope::new(sel).ok().map(|s| (s, *kind)))
            .collect()
    });
    for scope in stack.as_slice().iter().rev() {
        for (prefix, kind) in table {
            if prefix.is_prefix_of(*scope) {
                return Some(kind);
            }
        }
    }
    None
}

/// Highlight synchronously up to this many bytes per document; the rest is
/// plain, marked `data-hl="pending"`, until a background pass replaces it.
///
/// Per document and not per block: a plan quoting two hundred Rust blocks is
/// one document, and the reader waits for one render of it. Inside a Markdown
/// document the budget is spent block by block; a code file is one block. The
/// same number caps any single block as a second guard.
pub const HIGHLIGHT_CAP: usize = 256 * 1024;

/// Whether a render stopped highlighting before the end: `true` when any
/// block was left plain for the background pass to finish. The mark is on
/// the `<pre>`, so this is a substring test on the stored HTML and nothing
/// has to be rendered twice to know.
pub fn has_pending_highlight(html: &str) -> bool {
    html.contains(PENDING)
}

/// The attribute a plain-for-now block carries, as written.
const PENDING: &str = " data-hl=\"pending\"";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Markdown,
    Code,
    Diff,
    Text,
    /// Displayed from its bytes rather than rendered from text.
    Image,
    /// Not text at all: described, never decoded.
    Binary,
    /// Delimited text, laid out as a table.
    Table,
    /// Played from its bytes, which are streamed a range at a time.
    Video,
    Audio,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Markdown => "markdown",
            Kind::Code => "code",
            Kind::Diff => "diff",
            Kind::Text => "text",
            Kind::Image => "image",
            Kind::Binary => "binary",
            Kind::Table => "table",
            Kind::Video => "video",
            Kind::Audio => "audio",
        }
    }
    pub fn parse(s: &str) -> Option<Kind> {
        match s {
            "markdown" => Some(Kind::Markdown),
            "code" => Some(Kind::Code),
            "diff" => Some(Kind::Diff),
            "text" => Some(Kind::Text),
            "image" => Some(Kind::Image),
            "binary" => Some(Kind::Binary),
            "table" => Some(Kind::Table),
            "video" => Some(Kind::Video),
            "audio" => Some(Kind::Audio),
            _ => None,
        }
    }
}

pub struct Renderer {
    ss: SyntaxSet,
    classes: ClassMap,
}

/// syntect's bundled grammars plus the extras in `syntaxes/`, packed by the ignored
/// test `build_syntax_pack`. Empty until that test has run; then the defaults are used.
const SYNTAX_PACK: &[u8] = include_bytes!("../syntaxes/pack.bin");

fn load_syntaxes() -> SyntaxSet {
    if SYNTAX_PACK.is_empty() {
        return SyntaxSet::load_defaults_newlines();
    }
    syntect::dumps::from_binary(SYNTAX_PACK)
}

/// Extensions the grammars do not list under their own names.
fn alias(ext: &str) -> &str {
    match ext {
        "tsx" | "mts" | "cts" => "ts",
        "jsx" | "mjs" | "cjs" => "js",
        "kts" => "kt",
        "h" => "c",
        "hpp" | "hh" | "cc" | "cxx" => "cpp",
        "zsh" | "bash" | "ksh" => "sh",
        "yml" => "yaml",
        "htm" | "xhtml" => "html",
        "markdown" | "mdx" => "md",
        "jsonc" | "json5" => "json",
        "pyi" | "pyw" => "py",
        "rake" | "gemspec" => "rb",
        "mk" => "makefile",
        "cmake" => "cmake",
        "ini" | "cfg" | "conf" | "toml" | "env" | "properties" => ext,
        _ => ext,
    }
}

impl Renderer {
    pub fn new() -> Self {
        Renderer {
            ss: load_syntaxes(),
            classes: ClassMap::new(),
        }
    }

    /// Names of every language this build can highlight.
    pub fn languages(&self) -> Vec<String> {
        let mut v: Vec<String> = self
            .ss
            .syntaxes()
            .iter()
            .filter(|s| !s.hidden)
            .map(|s| s.name.clone())
            .collect();
        v.sort();
        v
    }

    /// Decide what a document is from its path, an explicit language, and its content.
    pub fn detect(
        &self,
        path: Option<&str>,
        lang: Option<&str>,
        content: &str,
    ) -> (Kind, Option<String>) {
        if let Some(l) = lang
            .map(|l| l.trim().to_ascii_lowercase())
            .filter(|l| !l.is_empty())
        {
            return match l.as_str() {
                "md" | "markdown" | "mdx" => (Kind::Markdown, None),
                "diff" | "patch" => (Kind::Diff, None),
                "txt" | "text" | "plain" => (Kind::Text, None),
                "csv" | "tsv" => (Kind::Table, Some(l)),
                _ => (Kind::Code, Some(l)),
            };
        }
        if let Some(p) = path {
            let name = Path::new(p)
                .file_name()
                .map(|n| n.to_string_lossy().to_ascii_lowercase())
                .unwrap_or_default();
            if name == "dockerfile" || name.starts_with("dockerfile.") {
                return (Kind::Code, Some("dockerfile".into()));
            }
            if name == "makefile" || name == "gnumakefile" {
                return (Kind::Code, Some("makefile".into()));
            }
            let ext = Path::new(p)
                .extension()
                .map(|e| e.to_string_lossy().to_ascii_lowercase())
                .unwrap_or_default();
            return match ext.as_str() {
                "md" | "markdown" | "mdx" | "mdown" => (Kind::Markdown, None),
                "diff" | "patch" => (Kind::Diff, None),
                "txt" | "log" | "" => {
                    if looks_like_diff(content) {
                        (Kind::Diff, None)
                    } else {
                        (Kind::Text, None)
                    }
                }
                "csv" | "tsv" => (Kind::Table, Some(ext.clone())),
                e if is_image_ext(e) => (Kind::Image, Some(ext.clone())),
                e => match media_kind(e) {
                    Some("video") => (Kind::Video, Some(ext)),
                    Some(_) => (Kind::Audio, Some(ext)),
                    None => (Kind::Code, Some(ext)),
                },
            };
        }
        if looks_like_diff(content) {
            return (Kind::Diff, None);
        }
        (Kind::Markdown, None)
    }

    pub fn render(&self, kind: Kind, lang: Option<&str>, source: &str) -> String {
        self.render_with_base(kind, lang, source, None)
    }

    /// `file_base` is the URL prefix for relative image paths (`/files/<id>/`), given when
    /// the document came from a file on disk.
    pub fn render_with_base(
        &self,
        kind: Kind,
        lang: Option<&str>,
        source: &str,
        file_base: Option<&str>,
    ) -> String {
        self.render_with_files(kind, lang, source, file_base, None)
    }

    /// `render_with_base`, with the document's folder on disk beside the
    /// prefix: what lets a picture in the page be given its size and loaded
    /// lazily (`players`). Without the folder a picture stays eager.
    pub fn render_with_files(
        &self,
        kind: Kind,
        lang: Option<&str>,
        source: &str,
        file_base: Option<&str>,
        file_dir: Option<&Path>,
    ) -> String {
        match kind {
            Kind::Markdown => self.markdown(source, file_base, file_dir, HIGHLIGHT_CAP),
            Kind::Code => self.code(lang, source, HIGHLIGHT_CAP),
            Kind::Diff => diff(source),
            Kind::Text => plain(source),
            Kind::Table => table(source, lang),
            // Both are built from bytes, by whoever holds them; there is no text to render.
            Kind::Image | Kind::Binary | Kind::Video | Kind::Audio => placeholder(source),
        }
    }

    /// Full highlight with no cap, for the background pass on large files.
    pub fn render_code_uncapped(&self, lang: Option<&str>, source: &str) -> String {
        self.code(lang, source, usize::MAX)
    }

    /// The same for a Markdown document whose code blocks ran past the budget.
    pub fn render_markdown_uncapped(
        &self,
        source: &str,
        file_base: Option<&str>,
        file_dir: Option<&Path>,
    ) -> String {
        self.markdown(source, file_base, file_dir, usize::MAX)
    }

    /// `budget` is the bytes of code this document may highlight before the
    /// rest goes in plain: `HIGHLIGHT_CAP` at receive time, no limit for the
    /// background pass.
    fn markdown(
        &self,
        source: &str,
        file_base: Option<&str>,
        file_dir: Option<&Path>,
        budget: usize,
    ) -> String {
        let mut options = Options::default();
        if let Some(base) = file_base {
            let base = base.to_string();
            options.extension.image_url_rewriter =
                Some(Arc::new(move |url: &str| rewrite_image_url(&base, url)));
        }
        let ext = &mut options.extension;
        ext.strikethrough = true;
        ext.table = true;
        ext.autolink = true;
        ext.tasklist = true;
        ext.footnotes = true;
        ext.description_lists = true;
        ext.multiline_block_quotes = true;
        ext.alerts = true;
        ext.header_ids = Some(String::new());
        options.render.github_pre_lang = true;
        options.render.full_info_string = false;

        let adapter = Highlighter {
            ss: &self.ss,
            classes: &self.classes,
            left: AtomicUsize::new(budget),
            held: Mutex::new(HeldTags::default()),
        };
        let mut plugins = Plugins::default();
        plugins.render.codefence_syntax_highlighter = Some(&adapter);

        let trace = std::env::var_os("SNYVI_TRACE").is_some();
        let t = std::time::Instant::now();
        let arena = Arena::new();
        let root = parse_document(&arena, source, &options);
        // Raw HTML is rare in agent output. Without it, comrak's safe mode already escapes
        // everything and drops dangerous links, so the (expensive) sanitizer can be skipped.
        let has_raw_html = root.descendants().any(|n| {
            matches!(
                n.data.borrow().value,
                NodeValue::HtmlBlock(_) | NodeValue::HtmlInline(_)
            )
        });
        options.render.unsafe_ = has_raw_html;
        let mut raw = Vec::with_capacity(source.len() * 2);
        let _ = format_html_with_plugins(root, &options, &mut raw, &plugins);
        let raw = String::from_utf8(raw).unwrap_or_default();
        // comrak writes each heading's anchor `inert`, which makes the `#` the
        // stylesheet shows beside a heading a thing that cannot be clicked --
        // and the sanitizer strips the attribute, so a document with raw HTML
        // in it had a working link where one without had a dead one. Out of
        // the tab order instead, since it is aria-hidden: the heading's own
        // text is what a screen reader reads, and the client makes a click on
        // the mark copy the section's link.
        let raw = raw.replace("<a inert href=\"#", "<a tabindex=\"-1\" href=\"#");
        let raw = mark_links(&raw);
        let t_md = t.elapsed();
        let out = if has_raw_html { sanitize(&raw) } else { raw };
        // After the sanitizer, which keeps `<img>` and would drop a player:
        // what turns into one here is only what survived it.
        let out = players(out, file_base.zip(file_dir));
        if trace {
            eprintln!(
                "  markdown: comrak+highlight {:.1} ms, sanitize {:.1} ms{} ({} KB -> {} KB)",
                t_md.as_secs_f64() * 1e3,
                (t.elapsed() - t_md).as_secs_f64() * 1e3,
                if has_raw_html { "" } else { " (skipped)" },
                source.len() / 1024,
                out.len() / 1024
            );
        }
        out
    }

    fn syntax_for(&self, lang: Option<&str>, source: &str) -> &SyntaxReference {
        lang.and_then(|l| {
            let l = alias(l);
            self.ss
                .find_syntax_by_token(l)
                .or_else(|| self.ss.find_syntax_by_extension(l))
        })
        .or_else(|| self.ss.find_syntax_by_first_line(source))
        .unwrap_or_else(|| self.ss.find_syntax_plain_text())
    }

    /// Definitions in a source file, for the rail: the same parse the highlighter
    /// does, keeping the tokens the grammar marks as names of declared things.
    pub fn outline(&self, lang: Option<&str>, source: &str) -> Vec<Outline> {
        let syntax = self.syntax_for(lang, source);
        let mut state = ParseState::new(syntax);
        let mut stack = ScopeStack::new();
        let mut found: Vec<(usize, &'static str, String, usize)> = vec![];
        let mut consumed = 0usize;
        for (n, line) in LinesWithEndings::from(source).enumerate() {
            consumed += line.len();
            if consumed > OUTLINE_CAP || found.len() >= OUTLINE_ITEMS {
                break;
            }
            let text = line.strip_suffix('\n').unwrap_or(line);
            let Ok(ops) = state.parse_line(line, &self.ss) else {
                continue;
            };
            // The first run of definition-scoped tokens on a line names what it declares.
            let mut last = 0usize;
            let mut run: Option<(&'static str, String)> = None;
            let mut done: Option<(&'static str, String)> = None;
            for (idx, op) in &ops {
                let idx = (*idx).min(text.len());
                if idx > last {
                    let seg = &text[last..idx];
                    match (definition_kind(&stack), run.take()) {
                        (Some(k), Some((rk, mut name))) if rk == k => {
                            name.push_str(seg);
                            run = Some((k, name));
                        }
                        (Some(k), _) => run = Some((k, seg.to_string())),
                        (None, Some(r)) => {
                            done = Some(r);
                            break;
                        }
                        (None, None) => {}
                    }
                    last = idx;
                }
                let _ = stack.apply(op);
            }
            let item = done.or_else(|| {
                run.map(|(k, mut name)| {
                    if last < text.len() && definition_kind(&stack).is_some() {
                        name.push_str(&text[last..]);
                    }
                    (k, name)
                })
            });
            if let Some((kind, name)) = item {
                let name = name.trim().to_string();
                if !name.is_empty()
                    && name
                        .chars()
                        .all(|c| c.is_alphanumeric() || c == '_' || c == '$' || c == '.')
                {
                    let indent: usize = text
                        .chars()
                        .take_while(|c| *c == ' ' || *c == '\t')
                        .map(|c| if c == '\t' { 4 } else { 1 })
                        .sum();
                    found.push((n + 1, kind, name, indent));
                }
            }
        }
        // Turn raw indent columns into nesting levels, so 4-space and 2-space files agree.
        let mut widths: Vec<usize> = found.iter().map(|(_, _, _, i)| *i).collect();
        widths.sort_unstable();
        widths.dedup();
        found
            .into_iter()
            .map(|(line, kind, name, indent)| Outline {
                depth: widths.iter().position(|w| *w == indent).unwrap_or(0).min(3),
                line,
                kind,
                name,
            })
            .collect()
    }

    fn code(&self, lang: Option<&str>, source: &str, cap: usize) -> String {
        let syntax = self.syntax_for(lang, source);
        let mut body = String::with_capacity(source.len() * 3);
        let (_, cut) = highlight_lines(&self.ss, &self.classes, syntax, source, cap, &mut body);
        let mut out = String::with_capacity(body.len() + 64);
        out.push_str("<pre class=\"code\" data-lang=\"");
        out.push_str(&html_escape::encode_double_quoted_attribute(
            syntax.name.as_str(),
        ));
        out.push('"');
        if cut {
            out.push_str(PENDING);
        }
        out.push_str("><code>");
        out.push_str(&body);
        out.push_str("</code></pre>");
        out
    }
}

/// Maps syntect scopes to a handful of short CSS classes. One span per token run,
/// instead of one nested span per scope, keeps the HTML small and the CSS simple.
pub struct ClassMap {
    table: Vec<(Scope, &'static str)>,
}

impl ClassMap {
    fn new() -> Self {
        // Order matters: more specific prefixes first.
        const ENTRIES: &[(&str, &str)] = &[
            ("comment", "c"),
            ("string", "s"),
            ("constant.numeric", "n"),
            ("constant.language", "n"),
            ("constant.character", "n"),
            ("constant.other", "n"),
            ("storage.type", "t"),
            ("storage", "k"),
            ("keyword", "k"),
            ("entity.name.function", "f"),
            ("support.function", "f"),
            ("entity.name.type", "t"),
            ("entity.name.class", "t"),
            ("entity.name.struct", "t"),
            ("entity.name.enum", "t"),
            ("entity.name.trait", "t"),
            ("entity.name.namespace", "t"),
            ("support.type", "t"),
            ("support.class", "t"),
            ("entity.name.tag", "tg"),
            ("entity.other.attribute-name", "at"),
            ("entity.other.inherited-class", "t"),
            ("entity.name", "f"),
            ("variable.parameter", "v"),
            ("variable.other.member", "v"),
            ("variable.language", "k"),
            ("support.constant", "n"),
            ("support.variable", "v"),
            ("punctuation.definition.comment", "c"),
            ("punctuation.definition.string", "s"),
            ("punctuation", "p"),
            ("markup.heading", "hd"),
            ("markup.bold", "b"),
            ("markup.italic", "i"),
            ("markup.raw", "raw"),
            ("markup.inserted", "ins"),
            ("markup.deleted", "del"),
            ("markup.underline.link", "lnk"),
            ("invalid", "inv"),
        ];
        ClassMap {
            table: ENTRIES
                .iter()
                .filter_map(|(sel, cls)| Scope::new(sel).ok().map(|s| (s, *cls)))
                .collect(),
        }
    }

    /// The class the innermost scope with one resolves to.
    ///
    /// `seen` remembers what each scope resolved to: a grammar puts a few
    /// hundred distinct scopes on the stack over a whole document and the
    /// same handful on nearly every token, so after the first lines this is
    /// one lookup per stack entry rather than a scan of the table for each.
    /// Owned by the render, so no lock is taken per token.
    fn class_for(
        &self,
        stack: &ScopeStack,
        seen: &mut HashMap<Scope, Option<&'static str>>,
    ) -> Option<&'static str> {
        for scope in stack.as_slice().iter().rev() {
            let cls = *seen.entry(*scope).or_insert_with(|| self.scan(*scope));
            if cls.is_some() {
                return cls;
            }
        }
        None
    }

    fn scan(&self, scope: Scope) -> Option<&'static str> {
        self.table
            .iter()
            .find(|(prefix, _)| prefix.is_prefix_of(scope))
            .map(|(_, cls)| *cls)
    }
}

/// Emit one `<span class="ln">` per line, highlighted up to the cap.
///
/// Returns the bytes highlighted and whether any line past them was written
/// plain: the first is what a document's budget is charged, the second is
/// what marks the block for the background pass.
fn highlight_lines(
    ss: &SyntaxSet,
    classes: &ClassMap,
    syntax: &SyntaxReference,
    source: &str,
    cap: usize,
    out: &mut String,
) -> (usize, bool) {
    let mut state = ParseState::new(syntax);
    let mut stack = ScopeStack::new();
    let mut seen = HashMap::new();
    let mut consumed = 0usize;
    let mut lines = LinesWithEndings::from(source).peekable();
    while let Some(line) = lines.peek() {
        if consumed + line.len() > cap && consumed > 0 {
            break;
        }
        consumed += line.len();
        let text = line.strip_suffix('\n').unwrap_or(line);
        out.push_str("<span class=\"ln\">");
        match state.parse_line(line, ss) {
            Ok(ops) => {
                let mut last = 0usize;
                let mut open: Option<&'static str> = None;
                for (idx, op) in &ops {
                    let idx = (*idx).min(text.len());
                    if idx > last {
                        let seg = &text[last..idx];
                        emit(
                            out,
                            seg,
                            refine(classes.class_for(&stack, &mut seen), seg),
                            &mut open,
                        );
                        last = idx;
                    }
                    let _ = stack.apply(op);
                }
                if last < text.len() {
                    let seg = &text[last..];
                    emit(
                        out,
                        seg,
                        refine(classes.class_for(&stack, &mut seen), seg),
                        &mut open,
                    );
                }
                if open.is_some() {
                    out.push_str("</span>");
                }
            }
            Err(_) => out.push_str(&html_escape::encode_text(text)),
        }
        out.push_str("</span>\n");
        lines.next();
    }
    let cut = lines.peek().is_some();
    plain_lines(lines, out);
    (consumed, cut)
}

/// The same line spans with no highlighting at all: the tail past a cap, or
/// a whole block past a document's budget.
fn plain_lines<'a>(lines: impl Iterator<Item = &'a str>, out: &mut String) {
    for line in lines {
        out.push_str("<span class=\"ln\">");
        out.push_str(&html_escape::encode_text(
            line.strip_suffix('\n').unwrap_or(line),
        ));
        out.push_str("</span>\n");
    }
}

/// Sublime grammars file declaration keywords (`let`, `fn`, `def`, `class`, ...) under
/// `storage.type`, the same scope as real type names. Colour the words as keywords.
fn refine(class: Option<&'static str>, text: &str) -> Option<&'static str> {
    if class == Some("t") {
        let w = text.trim();
        if matches!(
            w,
            "let"
                | "const"
                | "static"
                | "var"
                | "fn"
                | "func"
                | "function"
                | "def"
                | "class"
                | "struct"
                | "enum"
                | "impl"
                | "trait"
                | "interface"
                | "type"
                | "mod"
                | "module"
                | "namespace"
                | "union"
                | "typedef"
                | "extends"
                | "implements"
                | "new"
                | "abstract"
                | "final"
                | "override"
                | "declare"
                | "package"
                | "import"
                | "export"
                | "async"
                | "await"
        ) {
            return Some("k");
        }
    }
    class
}

/// Append a token run, opening/closing a class span only when the class changes.
fn emit(
    out: &mut String,
    text: &str,
    class: Option<&'static str>,
    open: &mut Option<&'static str>,
) {
    if text.is_empty() {
        return;
    }
    if *open != class {
        if open.is_some() {
            out.push_str("</span>");
        }
        if let Some(c) = class {
            out.push_str("<span class=\"");
            out.push_str(c);
            out.push_str("\">");
        }
        *open = class;
    }
    out.push_str(&html_escape::encode_text(text));
}

/// Extensions snyvi displays as a picture rather than as source.
pub const IMAGE_EXTS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp", "ico",
];

pub fn is_image_ext(ext: &str) -> bool {
    IMAGE_EXTS.contains(&ext)
}

/// What a browser can play: video, then audio. `.ogg` is usually audio, and an
/// `<audio>` element plays it; `.ogv` is the video one.
pub const MEDIA_EXTS: &[(&str, &str)] = &[
    ("mp4", "video"),
    ("webm", "video"),
    ("mov", "video"),
    ("m4v", "video"),
    ("ogv", "video"),
    ("mp3", "audio"),
    ("wav", "audio"),
    ("m4a", "audio"),
    ("ogg", "audio"),
    ("oga", "audio"),
    ("flac", "audio"),
    ("opus", "audio"),
    ("aac", "audio"),
];

/// "video" or "audio" for an extension a player can take, else None.
pub fn media_kind(ext: &str) -> Option<&'static str> {
    MEDIA_EXTS.iter().find(|(e, _)| *e == ext).map(|(_, k)| *k)
}

/// The player for a media document or file, pointed at wherever its bytes are
/// served. `preload="metadata"` asks for the first range only, so opening one
/// fetches its duration and first frame and nothing more until play is pressed.
///
/// Styled inline rather than in app.css: app.css is first paint, which is at
/// its budget, and a player is only ever inside a document body.
pub fn media_body(src_url: &str, ext: &str) -> String {
    let src = html_escape::encode_double_quoted_attribute(src_url);
    match media_kind(ext) {
        Some("video") => format!(
            "<p class=\"doc-image doc-media\"><video controls preload=\"metadata\" src=\"{src}\" \
             style=\"max-width:100%;max-height:70vh;border-radius:var(--radius)\"></video></p>"
        ),
        _ => format!(
            "<p class=\"doc-image doc-media\"><audio controls preload=\"metadata\" src=\"{src}\" \
             style=\"width:100%\"></audio></p>"
        ),
    }
}

/// The lowercased extension of a path, or "" when it has none.
pub fn ext_of(path: &str) -> String {
    std::path::Path::new(path)
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default()
}

/// A null byte in the first block is the usual signal, and what git uses. SVG is
/// text and is caught by `is_image_ext` before this ever sees it.
pub fn looks_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8000).any(|b| *b == 0)
}

/// A one-line note standing in for a body that cannot be shown.
pub fn placeholder(msg: &str) -> String {
    format!("<p class=\"empty\">{}</p>", html_escape::encode_text(msg))
}

/// Describe a file snyvi will not decode, in the units a reader thinks in.
pub fn describe_bytes(name: &str, size: u64) -> String {
    if size >= 1_048_576 {
        format!(
            "{name} is a binary file ({:.1} MB).",
            size as f64 / 1_048_576.0
        )
    } else {
        format!("{name} is a binary file ({} KB).", (size / 1024).max(1))
    }
}

/// What a file can be shown as beyond its source: "html" for a page the browser
/// can lay out, "pdf" for one it has a viewer for. Both are framed with an opaque
/// origin, never rendered into snyvi's own page.
pub fn preview_kind(ext: &str) -> Option<&'static str> {
    match ext {
        "html" | "htm" | "xhtml" => Some("html"),
        "pdf" => Some("pdf"),
        _ => None,
    }
}

/// The `<img>` body for an image document, pointed at wherever its bytes are served.
pub fn image_body(src_url: &str, alt: &str) -> String {
    format!(
        "<p class=\"doc-image\"><img src=\"{}\" alt=\"{}\" loading=\"lazy\" decoding=\"async\"></p>",
        html_escape::encode_double_quoted_attribute(src_url),
        html_escape::encode_double_quoted_attribute(alt)
    )
}

/// Lines per chunk of a long code block, and the length a block must pass to
/// be cut at all.
const CHUNK_LINES: usize = 200;
const CHUNK_ABOVE: usize = 400;

/// Cut every long `pre.code` into blocks of `CHUNK_LINES` lines, so the page
/// lays out only the ones near the screen.
///
/// `.prose > *` skips whatever is off screen, but a code file is one block: a
/// 15,000-line file was 15,000 lines laid out before the first paint, and a
/// 2.3 s frozen frame on a click. A chunk is `content-visibility: auto`, which
/// brings style containment with it, and a counter does not cross that line --
/// so each chunk says where its numbering starts. The line spans themselves are
/// untouched, so everything that walks `.ln` still sees every line in order.
///
/// Done where the HTML is served, not where it is rendered, so the library's
/// existing documents are cut too. A line is a `\n` inside the code element:
/// every emitter writes one span per line and escapes the text, so a newline
/// never appears anywhere else.
pub fn chunk_code(html: &str) -> std::borrow::Cow<'_, str> {
    if !html.contains("<pre class=\"code") {
        return std::borrow::Cow::Borrowed(html);
    }
    let mut out = String::new();
    let mut rest = html;
    let mut cut = false;
    while let Some(at) = rest.find("<pre class=\"code") {
        // The body starts after the `<code ...>` that opens it.
        let Some(open) = rest[at..].find("<code").map(|i| at + i) else {
            break;
        };
        let Some(body) = rest[open..].find('>').map(|i| open + i + 1) else {
            break;
        };
        let Some(end) = rest[body..].find("</code>").map(|i| body + i) else {
            break;
        };
        let inner = &rest[body..end];
        let lines = inner.as_bytes().iter().filter(|b| **b == b'\n').count();
        if lines <= CHUNK_ABOVE || !inner.starts_with("<span class=\"ln") {
            out.push_str(&rest[..end]);
            rest = &rest[end..];
            continue;
        }
        cut = true;
        out.reserve(inner.len() + lines / CHUNK_LINES * 80);
        out.push_str(&rest[..body]);
        for (i, line) in inner.split_inclusive('\n').enumerate() {
            if i % CHUNK_LINES == 0 {
                if i > 0 {
                    out.push_str("</span>");
                }
                out.push_str(&format!(
                    "<span class=\"lc\" style=\"counter-reset:ln {i}\">"
                ));
            }
            out.push_str(line);
        }
        out.push_str("</span>");
        rest = &rest[end..];
    }
    if !cut {
        return std::borrow::Cow::Borrowed(html);
    }
    out.push_str(rest);
    std::borrow::Cow::Owned(out)
}

fn plain(source: &str) -> String {
    let mut out = String::with_capacity(source.len() + 64);
    out.push_str("<pre class=\"code plain\" data-lang=\"Text\"><code>");
    for line in source.split_inclusive('\n') {
        out.push_str("<span class=\"ln\">");
        out.push_str(&html_escape::encode_text(
            line.strip_suffix('\n').unwrap_or(line),
        ));
        out.push_str("</span>\n");
    }
    out.push_str("</code></pre>");
    out
}

/// Rows past this are dropped. A spreadsheet of any size still opens instantly, and
/// nobody reads row 3000 of a table in a viewer; `o` opens the whole file.
const MAX_TABLE_ROWS: usize = 2000;
/// A column whose longest cell exceeds this is prose, not an identifier.
const PROSE_COLUMN_CHARS: usize = 44;

/// Split delimited text into rows, honouring RFC 4180 quoting: a field wrapped in
/// quotes may contain the delimiter, a newline, or a doubled quote standing for one.
fn parse_delimited(source: &str, delim: char, max_rows: usize) -> (Vec<Vec<String>>, bool) {
    let mut rows = Vec::new();
    let mut row = Vec::new();
    let mut field = String::new();
    let mut quoted = false;
    let mut chars = source.chars().peekable();
    while let Some(c) = chars.next() {
        if quoted {
            if c == '"' {
                if chars.peek() == Some(&'"') {
                    chars.next();
                    field.push('"');
                } else {
                    quoted = false;
                }
            } else {
                field.push(c);
            }
            continue;
        }
        match c {
            '"' if field.is_empty() => quoted = true,
            c if c == delim => row.push(std::mem::take(&mut field)),
            '\r' => {}
            '\n' => {
                row.push(std::mem::take(&mut field));
                // A trailing newline is a line ending, not an empty final row.
                if !(row.len() == 1 && row[0].is_empty()) {
                    rows.push(std::mem::take(&mut row));
                } else {
                    row.clear();
                }
                if rows.len() >= max_rows {
                    return (rows, chars.peek().is_some());
                }
            }
            c => field.push(c),
        }
    }
    if !field.is_empty() || !row.is_empty() {
        row.push(field);
        rows.push(row);
    }
    (rows, false)
}

/// A number, so it can be aligned like one. Deliberately narrow: a value that merely
/// starts with a digit is still text.
fn is_numeric(s: &str) -> bool {
    let t = s.trim().trim_start_matches(['-', '+']).replace(',', "");
    !t.is_empty()
        && t.chars()
            .all(|c| c.is_ascii_digit() || c == '.' || c == '%' || c == 'e' || c == 'E')
        && t.chars().any(|c| c.is_ascii_digit())
}

/// Lay delimited text out as a table, first row as the head.
pub fn table(source: &str, lang: Option<&str>) -> String {
    let delim = if lang == Some("tsv") { '\t' } else { ',' };
    let (rows, truncated) = parse_delimited(source, delim, MAX_TABLE_ROWS);
    if rows.is_empty() {
        return placeholder("This file has no rows.");
    }
    // Ragged rows are common in hand-edited files; pad them so the columns line up.
    let width = rows.iter().map(|r| r.len()).max().unwrap_or(0);
    // Identifiers and numbers are scanned down a column and must not wrap; prose
    // columns are read across and must, or they get cut off at the pane edge.
    let prose: Vec<bool> = (0..width)
        .map(|i| {
            rows.iter()
                .skip(1)
                .filter_map(|r| r.get(i))
                .map(|c| c.trim().len())
                .max()
                .unwrap_or(0)
                > PROSE_COLUMN_CHARS
        })
        .collect();
    let class_for = |i: usize, s: &str| match (prose[i], is_numeric(s)) {
        (true, _) => " class=\"wrap\"",
        (_, true) => " class=\"num\"",
        _ => "",
    };

    let mut out = String::with_capacity(source.len() * 2);
    out.push_str("<table class=\"data\"><thead><tr>");
    for (i, wraps) in prose.iter().enumerate() {
        let head = rows[0].get(i).map(|s| s.trim()).unwrap_or("");
        out.push_str(&format!(
            "<th{}>{}</th>",
            if *wraps { " class=\"wrap\"" } else { "" },
            html_escape::encode_text(head)
        ));
    }
    out.push_str("</tr></thead><tbody>");
    for row in rows.iter().skip(1) {
        out.push_str("<tr>");
        for i in 0..width {
            let v = row.get(i).map(String::as_str).unwrap_or("");
            out.push_str(&format!(
                "<td{}>{}</td>",
                class_for(i, v),
                html_escape::encode_text(v.trim())
            ));
        }
        out.push_str("</tr>");
    }
    out.push_str("</tbody></table>");
    if truncated {
        out.push_str(&placeholder(&format!(
            "Showing the first {MAX_TABLE_ROWS} rows. Open the source for the rest."
        )));
    }
    out
}

pub fn diff(source: &str) -> String {
    let mut out = String::with_capacity(source.len() * 2);
    out.push_str("<pre class=\"code diff\" data-lang=\"Diff\"><code>");
    for line in source.split_inclusive('\n') {
        let l = line.strip_suffix('\n').unwrap_or(line);
        let class = if l.starts_with("+++")
            || l.starts_with("---")
            || l.starts_with("diff ")
            || l.starts_with("index ")
        {
            "meta"
        } else if l.starts_with("@@") {
            "hunk"
        } else if l.starts_with('+') {
            "add"
        } else if l.starts_with('-') {
            "del"
        } else {
            "ctx"
        };
        out.push_str("<span class=\"ln ");
        out.push_str(class);
        out.push_str("\">");
        out.push_str(&html_escape::encode_text(l));
        out.push_str("</span>\n");
    }
    out.push_str("</code></pre>");
    out
}

fn looks_like_diff(content: &str) -> bool {
    let head: Vec<&str> = content.lines().take(6).collect();
    head.iter()
        .any(|l| l.starts_with("diff --git") || l.starts_with("@@ "))
        || (head.iter().any(|l| l.starts_with("--- "))
            && head.iter().any(|l| l.starts_with("+++ ")))
}

/// Title: explicit, else first Markdown H1, else file name, else "Untitled".
pub fn title_for(explicit: Option<&str>, kind: Kind, path: Option<&str>, content: &str) -> String {
    if let Some(t) = explicit.map(str::trim).filter(|t| !t.is_empty()) {
        return t.to_string();
    }
    if kind == Kind::Markdown {
        for line in content.lines().take(40) {
            let l = line.trim();
            if let Some(h) = l.strip_prefix("# ") {
                let h = h.trim().trim_end_matches('#').trim();
                if !h.is_empty() {
                    return h.to_string();
                }
            }
        }
    }
    if let Some(p) = path {
        if let Some(name) = Path::new(p).file_name() {
            return name.to_string_lossy().to_string();
        }
    }
    "Untitled".to_string()
}

/// If the first non-blank line is an H1 equal to `title`, return the content without it.
pub fn strip_leading_h1(content: &str, _title: &str) -> Option<String> {
    let mut lines = content.split_inclusive('\n');
    let mut prefix_len = 0usize;
    for line in lines.by_ref() {
        if line.trim().is_empty() {
            prefix_len += line.len();
            continue;
        }
        let h = line
            .trim()
            .strip_prefix("# ")?
            .trim()
            .trim_end_matches('#')
            .trim();
        if h.is_empty() {
            return None;
        }
        // The viewer prints the title above the body, so a leading H1 is a second
        // copy of it whether or not the words match.
        let rest_start = prefix_len + line.len();
        return Some(content[rest_start..].to_string());
    }
    None
}

/// The scheme of an absolute URL, if it has one: `[a-zA-Z][a-zA-Z0-9+.-]*`
/// followed by a colon, before any `/`, `?` or `#`. A relative path with a
/// colon somewhere in it -- `notes/2024:draft.md` -- is not absolute, which
/// is the case a plain `find(':')` gets wrong.
fn scheme_of(u: &str) -> Option<&str> {
    let end = u.find([':', '/', '?', '#'])?;
    if end == 0 || u.as_bytes()[end] != b':' {
        return None;
    }
    let s = &u[..end];
    let mut c = s.chars();
    if !c.next()?.is_ascii_alphabetic() {
        return None;
    }
    if !c.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.')) {
        return None;
    }
    Some(s)
}

/// Whether a link leaves snyvi, and whether a browser should give it a tab of
/// its own: `Some(true)` for the web, `Some(false)` for a scheme the desktop
/// answers for -- `mailto:`, `file:` -- and `None` for a link that stays here,
/// which is a fragment or anything relative.
fn leaves_snyvi(url: &str) -> Option<bool> {
    let u = url.trim();
    if u.is_empty() || u.starts_with('#') {
        return None;
    }
    // `//host/path` is the page's own scheme and someone else's host.
    if u.starts_with("//") {
        return Some(true);
    }
    match scheme_of(u) {
        Some(s) if s.eq_ignore_ascii_case("http") || s.eq_ignore_ascii_case("https") => Some(true),
        Some(_) => Some(false),
        None => None,
    }
}

/// Stamp every link that leaves snyvi, so following one opens where the web
/// belongs instead of replacing the viewer.
///
/// comrak writes a bare `<a href="…">`, and the viewer is a page in a window
/// with no address bar and no Back button of its own -- Back is the page's own
/// key handler, and a page from somewhere else does not have it. A click on a
/// link to github.com therefore used to leave the reader on github.com with
/// nothing to come home by but the tray. `target="_blank"` makes that a second
/// tab in a browser, and the window reads it as a request for a window it does
/// not grant and hands the URL to the desktop.
///
/// A document's own `#section` links and anything relative are left alone:
/// those stay inside snyvi, and the client resolves them.
///
/// A pass over the rendered string rather than over the AST, because comrak's
/// `Link` node carries a URL and a title and no way to add an attribute -- and
/// because, like everything else here, it runs once per document at receive
/// time and never again.
fn mark_links(html: &str) -> String {
    const OPEN: &str = "<a href=\"";
    if !html.contains(OPEN) {
        return html.to_string();
    }
    let mut out = String::with_capacity(html.len() + 128);
    let mut rest = html;
    while let Some(at) = rest.find(OPEN) {
        let after = &rest[at + OPEN.len()..];
        // An unterminated attribute is not something to rewrite around: leave
        // the rest of the document exactly as it came.
        let Some(end) = after.find('"') else { break };
        out.push_str(&rest[..at]);
        out.push_str("<a ");
        match leaves_snyvi(&after[..end]) {
            Some(true) => {
                out.push_str("target=\"_blank\" rel=\"noopener noreferrer\" data-ext=\"\" ")
            }
            Some(false) => out.push_str("data-ext=\"\" "),
            None => {}
        }
        out.push_str("href=\"");
        rest = after;
    }
    out.push_str(rest);
    out
}

fn sanitize(html: &str) -> String {
    let mut b = ammonia::Builder::default();
    b.add_tags(["input"])
        .add_tag_attributes("input", ["type", "checked", "disabled"])
        .add_tag_attributes(
            "a",
            [
                "id",
                "class",
                "aria-hidden",
                "tabindex",
                "data-footnote-ref",
                "data-footnote-backref",
                // What `mark_links` wrote. ammonia allows neither by default,
                // and a document with raw HTML in it would otherwise be the
                // one kind whose outbound links still opened in the viewer.
                "target",
                "data-ext",
            ],
        )
        .add_tag_attributes("li", ["id", "class"])
        .add_tag_attributes("ul", ["class"])
        .add_tag_attributes("ol", ["class", "start"])
        .add_tag_attributes("section", ["class", "data-footnotes"])
        .add_tag_attributes("div", ["class"])
        .add_tag_attributes("p", ["class"])
        .add_tag_attributes("span", ["class"])
        .add_tag_attributes("pre", ["class", "data-lang", "data-hl"])
        .add_tag_attributes("code", ["class"])
        .add_tag_attributes("table", ["class"])
        .add_tag_attributes("td", ["align", "style"])
        .add_tag_attributes("th", ["align", "style"])
        .add_tag_attributes("img", ["src", "alt", "title", "width", "height", "loading"])
        .add_tags(["section", "details", "summary"])
        .add_tag_attributes("details", ["open"]);
    for h in ["h1", "h2", "h3", "h4", "h5", "h6"] {
        b.add_tag_attributes(h, ["id"]);
    }
    b.link_rel(Some("noopener noreferrer"));
    // A picture carried inside a document -- a friend's, whose pictures
    // travel in it (`crate::server::api_peer`) -- is a `data:` URL. The
    // scheme passes the URL check for every attribute, and the filter then
    // keeps it on an image's `src` alone, and only for the four kinds a
    // picture is: no SVG, which can carry script, and no `data:` link.
    b.add_url_schemes(["data"]);
    b.attribute_filter(|element, attribute, value| {
        let data = value
            .trim_start()
            .get(..5)
            .is_some_and(|p| p.eq_ignore_ascii_case("data:"));
        if !data || (element == "img" && attribute == "src" && data_image_ok(value)) {
            Some(value.into())
        } else {
            None
        }
    });
    b.clean(html).to_string()
}

/// The `data:` URLs an image may have: base64 png, jpeg, gif or webp.
fn data_image_ok(url: &str) -> bool {
    let u = url.trim_start().to_ascii_lowercase();
    ["image/png", "image/jpeg", "image/gif", "image/webp"]
        .iter()
        .any(|m| u.starts_with(&format!("data:{m};base64,")))
}

/// Bytes as a `data:` URL, in the base64 a browser reads there (the
/// standard alphabet, padded).
pub fn data_uri(mime: &str, bytes: &[u8]) -> String {
    const A: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4 + mime.len() + 13);
    out.push_str("data:");
    out.push_str(mime);
    out.push_str(";base64,");
    for chunk in bytes.chunks(3) {
        let n = chunk.iter().fold(0u32, |acc, b| (acc << 8) | *b as u32) << (8 * (3 - chunk.len()));
        for i in 0..4 {
            out.push(if i <= chunk.len() {
                A[((n >> (18 - 6 * i)) & 63) as usize] as char
            } else {
                '='
            });
        }
    }
    out
}

/// The picture types that travel inside a friend's document, by extension.
pub fn picture_mime(ext: &str) -> Option<&'static str> {
    match ext {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

/// A URL that names a file beside the document: no scheme, not from the
/// root, not a fragment. What `rewrite_image_url` resolves against the file.
pub fn relative_url(url: &str) -> bool {
    let u = url.trim();
    !(u.is_empty()
        || u.starts_with('/')
        || u.starts_with('#')
        || u.contains("://")
        || u.starts_with("data:")
        || u.starts_with("mailto:"))
}

/// Every Markdown picture, `![alt](url "title")`, outside fenced code: `f`
/// is given its alt text and URL and says what the whole of it becomes, or
/// `None` to leave it as written.
pub fn map_md_images(text: &str, mut f: impl FnMut(&str, &str) -> Option<String>) -> String {
    let mut out = String::with_capacity(text.len());
    let mut fence: Option<&str> = None;
    for line in text.split_inclusive('\n') {
        let t = line.trim_start();
        if let Some(open) = fence {
            if t.starts_with(open) {
                fence = None;
            }
            out.push_str(line);
            continue;
        }
        if t.starts_with("```") || t.starts_with("~~~") {
            fence = Some(&t[..3]);
            out.push_str(line);
            continue;
        }
        map_line(line, &mut f, &mut out);
    }
    out
}

fn map_line(line: &str, f: &mut impl FnMut(&str, &str) -> Option<String>, out: &mut String) {
    let mut rest = line;
    while let Some(i) = rest.find("![") {
        out.push_str(&rest[..i]);
        let after = &rest[i + 2..];
        let Some(close) = after.find("](") else {
            out.push_str(&rest[i..]);
            return;
        };
        let alt = &after[..close];
        let tail = &after[close + 2..];
        let end = tail.find(')');
        if alt.contains(']') || end.is_none() {
            out.push_str("![");
            rest = after;
            continue;
        }
        let end = end.unwrap();
        let inner = tail[..end].trim();
        let url = match inner.strip_prefix('<') {
            Some(u) => u.split('>').next().unwrap_or(""),
            None => inner.split_whitespace().next().unwrap_or(""),
        };
        match f(alt, url) {
            Some(r) => out.push_str(&r),
            None => out.push_str(&rest[i..i + 2 + close + 2 + end + 1]),
        }
        rest = &tail[end + 1..];
    }
    out.push_str(rest);
}

/// A friend's Markdown as it is drawn here: a picture that did not travel
/// with it -- a path on their machine, from a snyvi that sent no pictures,
/// or one too large to carry -- says so where it stood, instead of being a
/// broken image.
pub fn stayed_with(text: &str, who: &str) -> String {
    map_md_images(text, |_, url| {
        relative_url(url).then(|| {
            let name = url.rsplit('/').next().unwrap_or(url).replace('`', "");
            format!("*(a picture that stayed with {who}: `{name}`)*")
        })
    })
}

/// comrak adapter: syntect with CSS classes, so code blocks share the page palette.
///
/// One per render, and it holds the document's highlight budget: `left` is
/// how many bytes of code may still be highlighted before the rest goes in
/// plain. A block that starts past it is written plain and marked
/// `data-hl="pending"`, as is one the budget (or the per-block cap under it)
/// cuts short; `spawn_full_highlight` renders such a document again with no
/// budget and swaps the result in behind the reader.
///
/// comrak writes the `<pre>` and `<code>` tags before it hands over the code,
/// and whether a block is pending is known only once the code is in hand, so
/// the two tags are held back and written with the body.
struct Highlighter<'a> {
    ss: &'a SyntaxSet,
    classes: &'a ClassMap,
    left: AtomicUsize,
    held: Mutex<HeldTags>,
}

/// What `write_pre_tag` and `write_code_tag` were asked for, until
/// `write_highlighted` writes all three together.
#[derive(Default)]
struct HeldTags {
    /// The `data-lang` the pre carries.
    name: String,
    mermaid: bool,
    code_class: Option<String>,
}

impl SyntaxHighlighterAdapter for Highlighter<'_> {
    fn write_highlighted(
        &self,
        output: &mut dyn Write,
        lang: Option<&str>,
        code: &str,
    ) -> io::Result<()> {
        let held = std::mem::take(&mut *self.held.lock().unwrap());
        let code_tag = match &held.code_class {
            Some(c) => format!(
                "<code class=\"{}\">",
                html_escape::encode_double_quoted_attribute(c)
            ),
            None => "<code>".to_string(),
        };
        if held.mermaid
            || lang
                .map(|l| l.eq_ignore_ascii_case("mermaid"))
                .unwrap_or(false)
        {
            // Diagram source stays verbatim; the client renders it after first paint.
            output.write_all(b"<pre class=\"mermaid\" data-lang=\"Mermaid\">")?;
            output.write_all(code_tag.as_bytes())?;
            return output.write_all(html_escape::encode_text(code).as_bytes());
        }
        let syntax = lang
            .filter(|l| !l.is_empty())
            .and_then(|l| self.ss.find_syntax_by_token(l))
            .unwrap_or_else(|| self.ss.find_syntax_plain_text());
        let mut body = String::with_capacity(code.len() * 3);
        // One render runs on one thread; the atomic is only so the adapter is
        // Sync, which comrak asks of it.
        let left = self.left.load(Ordering::Relaxed);
        let pending = if left == 0 {
            plain_lines(LinesWithEndings::from(code), &mut body);
            true
        } else {
            let cap = left.min(HIGHLIGHT_CAP);
            let (took, cut) = highlight_lines(self.ss, self.classes, syntax, code, cap, &mut body);
            self.left
                .store(left.saturating_sub(took), Ordering::Relaxed);
            cut
        };
        write!(
            output,
            "<pre class=\"code\" data-lang=\"{}\"{}>",
            html_escape::encode_double_quoted_attribute(&held.name),
            if pending { PENDING } else { "" }
        )?;
        output.write_all(code_tag.as_bytes())?;
        output.write_all(body.as_bytes())
    }

    fn write_pre_tag(
        &self,
        _output: &mut dyn Write,
        attributes: HashMap<String, String>,
    ) -> io::Result<()> {
        let lang = attributes.get("lang").cloned().unwrap_or_default();
        let mut held = self.held.lock().unwrap();
        if lang.eq_ignore_ascii_case("mermaid") {
            held.mermaid = true;
            return Ok(());
        }
        held.name = self
            .ss
            .find_syntax_by_token(&lang)
            .map(|s| s.name.clone())
            .unwrap_or_else(|| {
                if lang.is_empty() {
                    "Text".into()
                } else {
                    lang.clone()
                }
            });
        Ok(())
    }

    fn write_code_tag(
        &self,
        _output: &mut dyn Write,
        attributes: HashMap<String, String>,
    ) -> io::Result<()> {
        self.held.lock().unwrap().code_class = attributes.get("class").cloned();
        Ok(())
    }
}

/// A Markdown image whose path is a video or a song, `![take 2](take2.mp4)`,
/// becomes a player for it, the alt text its title. Done on the finished
/// HTML, where comrak (`<img src=".." alt=".." />`) and ammonia
/// (`<img src=".." alt="..">`) both write the attributes escaped and
/// double-quoted, so they are copied across as they are.
///
/// A video sits in a 16:9 box from the first paint, letterboxed, so the page
/// does not move when the take's own size arrives; a song's controls are one
/// fixed height. Inline styles, as `media_body`: app.css is first paint.
///
/// A picture under the document's own folder (`files`: the `/files/<id>/`
/// prefix its paths carry, and the folder on disk) is given its size from
/// the file's header and `loading="lazy"`: a page of screenshots fetches
/// only the ones in view, and the box of each is there before it is, so
/// nothing moves when one arrives. A picture whose size cannot be read --
/// a remote one, an SVG, a file that is not what its name says -- stays as
/// it was: eager, and never a shift.
fn players(html: String, files: Option<(&str, &Path)>) -> String {
    const IMG: &str = "<img src=\"";
    if !html.contains(IMG) {
        return html;
    }
    let attr = |tag: &str, name: &str| -> Option<String> {
        let at = tag.find(&format!(" {name}=\""))? + name.len() + 3;
        let end = tag[at..].find('"')?;
        Some(tag[at..at + end].to_string())
    };
    let mut out = String::with_capacity(html.len());
    let mut rest = html.as_str();
    while let Some(i) = rest.find(IMG) {
        out.push_str(&rest[..i]);
        let tail = &rest[i..];
        let Some(close) = tail.find('>') else {
            break;
        };
        let tag = &tail[..=close];
        let src = attr(tag, "src").unwrap_or_default();
        let path = src.split(['?', '#']).next().unwrap_or("");
        match media_kind(&ext_of(path)) {
            None => match files.and_then(|(base, dir)| sized(tag, path, base, dir)) {
                Some(t) => out.push_str(&t),
                None => out.push_str(tag),
            },
            Some(kind) => {
                let title = attr(tag, "alt").filter(|a| !a.is_empty());
                let title = title.map(|t| format!(" title=\"{t}\"")).unwrap_or_default();
                if kind == "video" {
                    out.push_str(&format!(
                        "<video controls preload=\"metadata\" src=\"{src}\"{title} \
                         style=\"display:block;width:100%;aspect-ratio:16/9;max-height:70vh;\
                         object-fit:contain;background:#000;border-radius:var(--radius)\"></video>"
                    ));
                } else {
                    out.push_str(&format!(
                        "<audio controls preload=\"metadata\" src=\"{src}\"{title} \
                         style=\"display:block;width:100%;height:54px\"></audio>"
                    ));
                }
            }
        }
        rest = &tail[close + 1..];
    }
    out.push_str(rest);
    out
}

/// Relative image paths resolve against the source document's directory via `/files/<id>/`.
fn rewrite_image_url(base: &str, url: &str) -> String {
    let u = url.trim();
    let absolute = u.starts_with('/')
        || u.starts_with('#')
        || u.contains("://")
        || u.starts_with("data:")
        || u.starts_with("mailto:");
    if absolute || u.is_empty() {
        return u.to_string();
    }
    format!("{base}{}", u.strip_prefix("./").unwrap_or(u))
}

/// Side-by-side rendering of a unified diff with word-level highlights.
pub fn diff_split(source: &str) -> String {
    let mut out = String::with_capacity(source.len() * 3);
    out.push_str("<div class=\"split\">");
    let mut dels: Vec<&str> = vec![];
    let mut adds: Vec<&str> = vec![];
    let e = |s: &str| html_escape::encode_text(s).to_string();
    fn flush(out: &mut String, dels: &mut Vec<&str>, adds: &mut Vec<&str>) {
        let n = dels.len().max(adds.len());
        for i in 0..n {
            match (dels.get(i), adds.get(i)) {
                (Some(d), Some(a)) => {
                    let (dh, ah) = word_diff(&d[1..], &a[1..]);
                    out.push_str(&format!(
                        "<div class=\"l del\">{dh}</div><div class=\"r add\">{ah}</div>"
                    ));
                }
                (Some(d), None) => out.push_str(&format!(
                    "<div class=\"l del\">{}</div><div class=\"r empty\"></div>",
                    html_escape::encode_text(&d[1..])
                )),
                (None, Some(a)) => out.push_str(&format!(
                    "<div class=\"l empty\"></div><div class=\"r add\">{}</div>",
                    html_escape::encode_text(&a[1..])
                )),
                (None, None) => {}
            }
        }
        dels.clear();
        adds.clear();
    }
    for line in source.lines() {
        if line.starts_with("+++")
            || line.starts_with("---")
            || line.starts_with("diff ")
            || line.starts_with("index ")
        {
            flush(&mut out, &mut dels, &mut adds);
            out.push_str(&format!("<div class=\"meta full\">{}</div>", e(line)));
        } else if line.starts_with("@@") {
            flush(&mut out, &mut dels, &mut adds);
            out.push_str(&format!("<div class=\"hunk full\">{}</div>", e(line)));
        } else if let Some(rest) = line.strip_prefix('-') {
            let _ = rest;
            dels.push(line);
        } else if let Some(rest) = line.strip_prefix('+') {
            let _ = rest;
            adds.push(line);
        } else {
            flush(&mut out, &mut dels, &mut adds);
            let text = line.strip_prefix(' ').unwrap_or(line);
            out.push_str(&format!(
                "<div class=\"l ctx\">{0}</div><div class=\"r ctx\">{0}</div>",
                e(text)
            ));
        }
    }
    flush(&mut out, &mut dels, &mut adds);
    out.push_str("</div>");
    out
}

/// Word-level highlight of a changed line pair: (old html, new html).
fn word_diff(a: &str, b: &str) -> (String, String) {
    use similar::{ChangeTag, TextDiff};
    let d = TextDiff::from_words(a, b);
    let (mut oa, mut ob) = (String::new(), String::new());
    for c in d.iter_all_changes() {
        let t = html_escape::encode_text(c.value());
        match c.tag() {
            ChangeTag::Equal => {
                oa.push_str(&t);
                ob.push_str(&t);
            }
            ChangeTag::Delete => oa.push_str(&format!("<mark>{t}</mark>")),
            ChangeTag::Insert => ob.push_str(&format!("<mark>{t}</mark>")),
        }
    }
    (oa, ob)
}

/// Unified diff between two sources, for "compare with previous".
pub fn unified(a_name: &str, a: &str, b_name: &str, b: &str) -> String {
    let d = similar::TextDiff::from_lines(a, b);
    d.unified_diff()
        .context_radius(3)
        .header(a_name, b_name)
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r() -> Renderer {
        Renderer::new()
    }

    /// Regenerate syntaxes/pack.bin: `cargo test --release build_syntax_pack -- --ignored`.
    /// Grammars that syntect cannot compile are reported and skipped.
    #[test]
    #[ignore]
    fn build_syntax_pack() {
        use syntect::parsing::{SyntaxDefinition, SyntaxSetBuilder};
        let mut b: SyntaxSetBuilder = SyntaxSet::load_defaults_newlines().into_builder();
        let mut added = vec![];
        for entry in std::fs::read_dir("syntaxes").unwrap().flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("sublime-syntax") {
                continue;
            }
            let src = std::fs::read_to_string(&path).unwrap();
            match SyntaxDefinition::load_from_str(
                &src,
                true,
                path.file_stem().and_then(|s| s.to_str()),
            ) {
                Ok(def) => {
                    added.push(format!("{} [{}]", def.name, def.file_extensions.join(",")));
                    b.add(def);
                }
                Err(e) => eprintln!("SKIP {}: {e}", path.display()),
            }
        }
        let ss = b.build();
        // Force-compile every grammar now so a broken regex fails here, not at runtime.
        for syn in ss.syntaxes() {
            let mut st = ParseState::new(syn);
            let _ = st.parse_line("x\n", &ss);
        }
        syntect::dumps::dump_to_file(&ss, "syntaxes/pack.bin").unwrap();
        eprintln!("added: {}", added.join("; "));
        eprintln!(
            "pack: {} KB, {} syntaxes",
            std::fs::metadata("syntaxes/pack.bin").unwrap().len() / 1024,
            ss.syntaxes().len()
        );
    }

    #[test]
    fn detects_kind_from_path_lang_and_content() {
        let r = r();
        assert_eq!(r.detect(Some("/x/PLAN.md"), None, "").0, Kind::Markdown);
        assert_eq!(
            r.detect(Some("/x/main.rs"), None, ""),
            (Kind::Code, Some("rs".into()))
        );
        assert_eq!(r.detect(Some("/x/a.patch"), None, "").0, Kind::Diff);
        assert_eq!(r.detect(Some("/x/notes.txt"), None, "hello").0, Kind::Text);
        assert_eq!(
            r.detect(None, Some("py"), ""),
            (Kind::Code, Some("py".into()))
        );
        assert_eq!(
            r.detect(None, None, "diff --git a/x b/x\n--- a/x\n+++ b/x\n")
                .0,
            Kind::Diff
        );
        assert_eq!(r.detect(None, None, "# Heading\n\ntext").0, Kind::Markdown);
    }

    #[test]
    fn csv_becomes_a_table_with_quotes_and_ragged_rows_handled() {
        let src = "name,qty,note\n\"Widget, large\",12,\"he said \"\"hi\"\"\"\nBolt,3\n";
        let html = table(src, Some("csv"));
        assert!(
            html.contains("<th>name</th><th>qty</th><th>note</th>"),
            "{html}"
        );
        // A quoted field keeps its delimiter, and a doubled quote becomes one.
        assert!(html.contains("Widget, large"), "{html}");
        assert!(html.contains("he said \"hi\""), "{html}");
        // Numbers are marked so they can be aligned as numbers.
        assert!(html.contains("<td class=\"num\">12</td>"), "{html}");
        // A short row is padded rather than shifting the columns.
        assert!(
            html.ends_with("<td>Bolt</td><td class=\"num\">3</td><td></td></tr></tbody></table>"),
            "{html}"
        );

        // Tabs when the file says so.
        let tsv = table("a\tb\n1\t2\n", Some("tsv"));
        assert!(tsv.contains("<th>a</th><th>b</th>"), "{tsv}");

        // A cell that merely starts with a digit is still text.
        assert!(!table("h\n3 apples\n", Some("csv")).contains("class=\"num\""));
        assert!(table("", Some("csv")).contains("no rows"));
    }

    #[test]
    fn only_pages_and_pdfs_offer_a_preview() {
        assert_eq!(preview_kind("html"), Some("html"));
        assert_eq!(preview_kind("htm"), Some("html"));
        assert_eq!(preview_kind("xhtml"), Some("html"));
        assert_eq!(preview_kind("pdf"), Some("pdf"));
        for ext in ["md", "rs", "svg", "png", "txt", "json", ""] {
            assert_eq!(preview_kind(ext), None, "{ext} is not previewable");
        }
    }

    #[test]
    fn title_precedence() {
        assert_eq!(
            title_for(Some(" Given "), Kind::Markdown, None, "# H1"),
            "Given"
        );
        assert_eq!(
            title_for(None, Kind::Markdown, Some("/a/b.md"), "\n\n# From H1 #\n"),
            "From H1"
        );
        assert_eq!(
            title_for(None, Kind::Code, Some("/a/main.rs"), "# not a heading"),
            "main.rs"
        );
        assert_eq!(
            title_for(None, Kind::Markdown, None, "no heading"),
            "Untitled"
        );
    }

    #[test]
    fn markdown_fast_path_and_sanitizer() {
        let r = r();
        let safe = r.render(
            Kind::Markdown,
            None,
            "Hello *world*\n\n- [x] done\n\n[js](javascript:alert(1))",
        );
        assert!(safe.contains("<em>world</em>"));
        assert!(safe.contains("type=\"checkbox\""));
        assert!(
            !safe.contains("javascript:"),
            "dangerous link dropped: {safe}"
        );

        let raw = r.render(Kind::Markdown, None, "<details><summary>s</summary>hidden <script>alert(1)</script></details>\n\n<img src=x onerror=alert(1)>");
        assert!(raw.contains("<details>"), "harmless html kept: {raw}");
        assert!(!raw.contains("<script"), "script removed: {raw}");
        assert!(!raw.contains("onerror"), "event handler removed: {raw}");
    }

    #[test]
    fn outbound_links_leave_and_the_rest_stay() {
        let r = r();
        // Both paths: without raw HTML the sanitizer is skipped, with it the
        // sanitizer has to be told to keep what mark_links wrote.
        for (src, why) in [
            (
                "[gh](https://github.com/x) and [up](../notes.md) and [s](#top)",
                "fast",
            ),
            (
                "<b>raw</b>\n\n[gh](https://github.com/x) and [up](../notes.md) and [s](#top)",
                "sanitized",
            ),
        ] {
            let h = r.render(Kind::Markdown, None, src);
            let web = h
                .split("<a ")
                .find(|s| s.contains("github.com"))
                .unwrap_or_default();
            assert!(web.contains("target=\"_blank\""), "{why}: {h}");
            assert!(web.contains("noopener"), "{why}: {h}");
            // A relative link is the client's to resolve, and a fragment is the
            // document's own: neither is sent to a browser.
            let rel = h
                .split("<a ")
                .find(|s| s.contains("notes.md"))
                .unwrap_or_default();
            assert!(!rel.contains("target="), "{why}: {h}");
            assert!(!rel.contains("data-ext"), "{why}: {h}");
            let frag = h
                .split("<a ")
                .find(|s| s.starts_with("href=\"#top\""))
                .unwrap_or_default();
            assert!(!frag.contains("data-ext"), "{why}: {h}");
        }

        // A scheme the desktop answers for is outbound, but a browser should
        // not open a blank tab for it.
        let h = r.render(Kind::Markdown, None, "[mail](mailto:a@b.c)");
        let a = h.split("<a ").nth(1).unwrap_or_default();
        assert!(a.contains("data-ext"), "{h}");
        assert!(!a.contains("target="), "{h}");
    }

    #[test]
    fn a_colon_in_a_relative_path_is_not_a_scheme() {
        assert_eq!(leaves_snyvi("notes/2024:draft.md"), None);
        assert_eq!(leaves_snyvi("./a.md"), None);
        assert_eq!(leaves_snyvi("/b/x/y.md"), None);
        assert_eq!(leaves_snyvi("#sec"), None);
        assert_eq!(leaves_snyvi("HTTPS://x.dev"), Some(true));
        assert_eq!(leaves_snyvi("//cdn.example/x"), Some(true));
        assert_eq!(leaves_snyvi("file:///tmp/x"), Some(false));
    }

    #[test]
    fn heading_anchors_are_clickable_on_both_paths() {
        let r = r();
        for src in ["## Hello there\n\ntext\n", "## Hello there\n\n<b>raw</b>\n"] {
            // The sanitizer rewrites the tag on the raw path, so the check is
            // on the attributes rather than on the exact string.
            let html = r.render(Kind::Markdown, None, src);
            let a = html
                .split("<a ")
                .nth(1)
                .and_then(|s| s.split('>').next())
                .unwrap_or_default();
            assert!(a.contains("tabindex=\"-1\""), "{html}");
            assert!(a.contains("class=\"anchor\""), "{html}");
            assert!(a.contains("href=\"#hello-there\""), "{html}");
            assert!(!html.contains("inert"), "{html}");
        }
    }

    #[test]
    fn code_blocks_get_compact_classes_and_line_spans() {
        let r = r();
        let html = r.render(
            Kind::Markdown,
            None,
            "```rust\nfn main() { let s = \"hi\"; }\n```\n",
        );
        assert!(
            html.contains("<pre class=\"code\" data-lang=\"Rust\">"),
            "{html}"
        );
        assert!(html.contains("<span class=\"k\">fn</span>"), "{html}");
        assert!(html.contains("<span class=\"s\">"), "{html}");
        assert_eq!(html.matches("<span class=\"ln\">").count(), 1);

        let code = r.render(Kind::Code, Some("py"), "def f():\n    return 1\n");
        assert_eq!(code.matches("<span class=\"ln\">").count(), 2);
        assert!(code.contains("data-lang=\"Python\""));
        let esc = r.render(Kind::Code, Some("html"), "<b onclick=\"x()\">hi</b>\n");
        assert!(
            esc.contains("&lt;") && !esc.contains("<b ") && !esc.contains("onclick=\""),
            "source text is escaped: {esc}"
        );
        assert!(esc.contains("data-lang=\"HTML\""));
    }

    #[test]
    fn highlight_cap_leaves_tail_plain_and_uncapped_does_not() {
        let r = r();
        let big: String = (0..20_000).map(|i| format!("let v{i} = {i};\n")).collect();
        assert!(big.len() > HIGHLIGHT_CAP);
        let capped = r.render(Kind::Code, Some("rs"), &big);
        let full = r.render_code_uncapped(Some("rs"), &big);
        assert!(capped.matches("class=\"k\"").count() < full.matches("class=\"k\"").count());
        assert_eq!(capped.matches("<span class=\"ln\">").count(), 20_000);
        assert_eq!(full.matches("<span class=\"ln\">").count(), 20_000);
        // The cut file says so on its <pre>, which is what sends it to the
        // background pass; the full render has nothing left to finish.
        assert!(has_pending_highlight(&capped));
        assert!(
            capped.starts_with("<pre class=\"code\" data-lang=\"Rust\" data-hl=\"pending\"><code>")
        );
        assert!(!has_pending_highlight(&full));
        let small = r.render(Kind::Code, Some("rs"), "let a = 1;\n");
        assert!(!has_pending_highlight(&small), "{small}");
    }

    /// A plan quoting two hundred Rust blocks: the budget is the document's,
    /// so the first blocks are highlighted, the rest are plain and marked,
    /// and the uncapped render finishes every one of them.
    #[test]
    fn markdown_highlight_budget_is_per_document() {
        let r = r();
        let block = |b: usize| {
            let mut s = format!("## Block {b}\n\nProse.\n\n```rust\n");
            for i in 0..26 {
                s.push_str(&format!(
                    "pub fn step_{b}_{i}(x: u32) -> Result<u32, Error> {{ Ok(x + {i}) }} // step\n"
                ));
            }
            s.push_str("```\n\n");
            s
        };
        let md: String = (0..200).map(block).collect();
        let code_bytes: usize = (0..200)
            .map(|b| block(b).len() - block(b).find("```rust\n").unwrap() - 8 - 4)
            .sum();
        assert!(
            code_bytes > HIGHLIGHT_CAP,
            "fixture is {code_bytes} B of code"
        );

        let capped = r.render(Kind::Markdown, None, &md);
        let pending = capped.matches(PENDING).count();
        let highlighted = capped
            .matches("<pre class=\"code\" data-lang=\"Rust\"><code>")
            .count();
        assert_eq!(
            pending + highlighted,
            200,
            "every block is one or the other"
        );
        assert!(has_pending_highlight(&capped));
        // 256 KB of ~2 KB blocks: somewhere past a hundred are highlighted,
        // and the first one certainly is.
        assert!(
            (100..200).contains(&highlighted),
            "{highlighted} highlighted, {pending} pending"
        );
        assert!(
            capped.find("data-hl=\"pending\"").unwrap()
                > capped.find("<pre class=\"code\"").unwrap()
        );
        // A pending block is plain: its lines carry no token classes at all.
        let tail = &capped[capped.rfind("<pre class=\"code\"").unwrap()..];
        assert!(
            tail.contains(PENDING) && !tail.contains("class=\"k\""),
            "{}",
            &tail[..200]
        );

        let full = r.render_markdown_uncapped(&md, None, None);
        assert!(!has_pending_highlight(&full));
        assert_eq!(
            full.matches("<pre class=\"code\" data-lang=\"Rust\"><code>")
                .count(),
            200
        );
        assert!(full.matches("class=\"k\"").count() > capped.matches("class=\"k\"").count());
        // What was highlighted under the budget is highlighted the same way.
        let first = |h: &str| h[..h.find("</pre>").unwrap()].to_string();
        assert_eq!(first(&capped), first(&full));
    }

    /// The everyday document, and the bench's 1 MB one: code well under the
    /// budget, so nothing is pending and nothing changes.
    #[test]
    fn markdown_under_the_budget_is_whole() {
        let r = r();
        // The bench's shape: a code block every couple of kilobytes of prose,
        // so a document far past the budget carries a few percent of code.
        let prose = "A paragraph of ordinary prose with *emphasis*, `inline code` and a [link](https://example.com), which runs on for a few sentences. ".repeat(12);
        let section = format!("## S\n\n{prose}\n\n```rust\nfn main() {{\n    let x = 42;\n    println!(\"{{x}}\");\n}}\n```\n\n");
        let md: String =
            std::iter::repeat_n(section.as_str(), 2 * HIGHLIGHT_CAP / section.len() + 1).collect();
        assert!(md.len() > 2 * HIGHLIGHT_CAP);
        let html = r.render(Kind::Markdown, None, &md);
        assert!(!has_pending_highlight(&html));
        assert_eq!(
            html.matches("<pre class=\"code\" data-lang=\"Rust\"><code>")
                .count(),
            md.matches("```rust").count()
        );
        assert!(html.contains("class=\"k\""));
        // And a Mermaid block takes nothing from the budget and keeps its tag.
        let mixed = r.render(
            Kind::Markdown,
            None,
            "```mermaid\ngraph TD; A-->B\n```\n\n```rust\nfn a() {}\n```\n",
        );
        assert!(mixed.contains("<pre class=\"mermaid\" data-lang=\"Mermaid\">"));
        assert!(mixed.contains("<pre class=\"code\" data-lang=\"Rust\"><code>"));
        assert!(!has_pending_highlight(&mixed));
    }

    /// A single block past the per-block cap is pending inside a document
    /// with budget to spare: the second guard.
    #[test]
    fn one_huge_block_is_pending_too() {
        let r = r();
        let big: String = (0..20_000).map(|i| format!("let v{i} = {i};\n")).collect();
        let md = format!("# T\n\n```rust\n{big}```\n\n```rust\nfn after() {{}}\n```\n");
        let html = r.render(Kind::Markdown, None, &md);
        assert!(has_pending_highlight(&html));
        assert_eq!(html.matches(PENDING).count(), 1);
        // The block after it still gets what budget is left.
        assert!(html.contains("<pre class=\"code\" data-lang=\"Rust\"><code><span class=\"ln\"><span class=\"k\">fn</span>"));
    }

    #[test]
    fn image_urls_rewrite_only_when_relative() {
        assert_eq!(
            rewrite_image_url("/files/abc/", "./img/a.png"),
            "/files/abc/img/a.png"
        );
        assert_eq!(
            rewrite_image_url("/files/abc/", "../x.png"),
            "/files/abc/../x.png"
        );
        assert_eq!(
            rewrite_image_url("/files/abc/", "https://h/x.png"),
            "https://h/x.png"
        );
        assert_eq!(rewrite_image_url("/files/abc/", "/abs.png"), "/abs.png");
        let r = Renderer::new();
        let html = r.render_with_base(
            Kind::Markdown,
            None,
            "![alt](shot.png)",
            Some("/files/abc/"),
        );
        assert!(html.contains("src=\"/files/abc/shot.png\""), "{html}");
        let plain = r.render(Kind::Markdown, None, "![alt](shot.png)");
        assert!(plain.contains("src=\"shot.png\""), "{plain}");
    }

    #[test]
    fn a_video_or_a_song_in_markdown_plays_in_place() {
        let r = Renderer::new();
        let md = |src: &str| r.render_with_base(Kind::Markdown, None, src, Some("/files/abc/"));
        for (file, tag) in [
            (
                "take2.mp4",
                "<video controls preload=\"metadata\" src=\"/files/abc/take2.mp4\"",
            ),
            (
                "cut.webm",
                "<video controls preload=\"metadata\" src=\"/files/abc/cut.webm\"",
            ),
            (
                "song.mp3",
                "<audio controls preload=\"metadata\" src=\"/files/abc/song.mp3\"",
            ),
            (
                "bed.ogg",
                "<audio controls preload=\"metadata\" src=\"/files/abc/bed.ogg\"",
            ),
        ] {
            let html = md(&format!("Here:\n\n![take \"2\"]({file})\n"));
            assert!(html.contains(tag), "{file}: {html}");
            assert!(
                html.contains("title=\"take &quot;2&quot;\""),
                "{file}: {html}"
            );
            assert!(!html.contains("<img"), "{file}: {html}");
        }
        // A video's box is there before its size is known, so nothing moves.
        assert!(md("![a](a.mp4)").contains("aspect-ratio:16/9"));
        // A picture stays a picture, and a query is not an extension.
        assert!(md("![a](a.png)").contains("<img src=\"/files/abc/a.png\""));
        assert!(md("![a](a.mp4?t=3)").contains("<video"));
        // Raw HTML takes the sanitizer's road and still gets its player, but
        // a player written by hand does not get through.
        let raw =
            md("<b>hi</b>\n\n![a](a.mp4)\n\n<video src=\"x.mp4\" onplay=\"alert(1)\"></video>");
        assert_eq!(raw.matches("<video").count(), 1, "{raw}");
        assert!(!raw.contains("onplay"), "{raw}");
    }

    /// A tiny PNG, JPEG, GIF and WebP: only the header each is read for.
    fn png(w: u32, h: u32) -> Vec<u8> {
        let mut v = b"\x89PNG\r\n\x1a\n\0\0\0\x0dIHDR".to_vec();
        v.extend_from_slice(&w.to_be_bytes());
        v.extend_from_slice(&h.to_be_bytes());
        v.extend_from_slice(&[8, 6, 0, 0, 0, 0, 0, 0, 0]);
        v
    }
    fn jpeg(w: u32, h: u32) -> Vec<u8> {
        // SOI, an APP1 segment of filler (EXIF's place), a DHT (which shares
        // the SOF range and must be skipped), then SOF0.
        let mut v = b"\xff\xd8\xff\xe1\x00\x08abcdef".to_vec();
        v.extend_from_slice(b"\xff\xc4\x00\x04\0\0");
        v.extend_from_slice(b"\xff\xc0\x00\x0b\x08");
        v.extend_from_slice(&(h as u16).to_be_bytes());
        v.extend_from_slice(&(w as u16).to_be_bytes());
        v.extend_from_slice(&[3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
        v
    }
    fn gif(w: u32, h: u32) -> Vec<u8> {
        let mut v = b"GIF89a".to_vec();
        v.extend_from_slice(&(w as u16).to_le_bytes());
        v.extend_from_slice(&(h as u16).to_le_bytes());
        v.extend_from_slice(&[0, 0, 0]);
        v
    }
    fn webp_x(w: u32, h: u32) -> Vec<u8> {
        let mut v = b"RIFF\0\0\0\0WEBPVP8X\x0a\0\0\0\0\0\0\0".to_vec();
        v.extend_from_slice(&(w - 1).to_le_bytes()[..3]);
        v.extend_from_slice(&(h - 1).to_le_bytes()[..3]);
        v
    }

    #[test]
    fn a_pictures_size_is_read_from_its_header() {
        assert_eq!(picture_size(&png(1280, 720)), Some((1280, 720)));
        assert_eq!(picture_size(&jpeg(640, 480)), Some((640, 480)));
        assert_eq!(picture_size(&gif(12, 34)), Some((12, 34)));
        assert_eq!(picture_size(&webp_x(1920, 1080)), Some((1920, 1080)));
        // Lossy WebP: the frame tag, the start code, then 14 bits each.
        let mut lossy = b"RIFF\0\0\0\0WEBPVP8 \0\0\0\0\0\0\0\x9d\x01\x2a".to_vec();
        lossy.extend_from_slice(&[0x20, 0x03, 0x58, 0x02]);
        assert_eq!(picture_size(&lossy), Some((800, 600)));
        // Lossless: 14 + 14 bits minus one, packed little-endian.
        let mut ll = b"RIFF\0\0\0\0WEBPVP8L\0\0\0\0\x2f".to_vec();
        ll.extend_from_slice(&[0x1f, 0xc3, 0x3b, 0x00]);
        assert_eq!(picture_size(&ll), Some((800, 240)));
        // Short, odd, or not a picture: None, never a panic.
        for bad in [
            &b""[..],
            b"\x89PNG",
            b"\xff\xd8\xff",
            b"GIF89a\x01",
            b"RIFF\0\0\0\0WEBPVP8Y",
            b"<svg/>",
        ] {
            assert_eq!(picture_size(bad), None, "{bad:?}");
        }
        assert_eq!(picture_size(&png(0, 10)), None);
        let mut cut = jpeg(1, 1);
        cut.truncate(12);
        assert_eq!(picture_size(&cut), None);
    }

    #[test]
    fn a_picture_in_the_documents_folder_is_lazy_with_its_size() {
        let dir = std::env::temp_dir().join(format!("snyvi-lazy-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("img")).unwrap();
        std::fs::write(dir.join("img/a.png"), png(300, 200)).unwrap();
        std::fs::write(dir.join("b.jpg"), jpeg(64, 48)).unwrap();
        std::fs::write(dir.join("c.svg"), b"<svg/>").unwrap();
        std::fs::write(dir.join("d.png"), b"not a png").unwrap();
        let r = Renderer::new();
        let md = "![a](img/a.png)\n\n![b](./b.jpg)\n\n![c](c.svg)\n\n![d](d.png)\n\n![e](https://h/e.png)\n\n![f](../up.png)\n";
        let html = r.render_with_files(Kind::Markdown, None, md, Some("/files/abc/"), Some(&dir));
        assert!(
            html.contains("<img src=\"/files/abc/img/a.png\" alt=\"a\" width=\"300\" height=\"200\" loading=\"lazy\" decoding=\"async\">"),
            "{html}"
        );
        assert!(
            html.contains("<img src=\"/files/abc/b.jpg\" alt=\"b\" width=\"64\" height=\"48\" loading=\"lazy\""),
            "{html}"
        );
        // An SVG, a file that is not a picture, a remote one, one outside
        // the folder: as they were, eager.
        for tag in [
            "<img src=\"/files/abc/c.svg\" alt=\"c\" />",
            "<img src=\"/files/abc/d.png\" alt=\"d\" />",
            "<img src=\"https://h/e.png\" alt=\"e\" />",
            "<img src=\"/files/abc/../up.png\" alt=\"f\" />",
        ] {
            assert!(html.contains(tag), "{tag}: {html}");
        }
        assert_eq!(html.matches("loading=\"lazy\"").count(), 2, "{html}");
        // Without the folder, nothing is lazy: no size can be read.
        let plain = r.render_with_base(Kind::Markdown, None, md, Some("/files/abc/"));
        assert!(!plain.contains("loading="), "{plain}");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn mermaid_blocks_keep_source_verbatim() {
        let html =
            Renderer::new().render(Kind::Markdown, None, "```mermaid\ngraph TD; A-->B\n```\n");
        assert!(
            html.contains("<pre class=\"mermaid\" data-lang=\"Mermaid\">"),
            "{html}"
        );
        assert!(html.contains("A--&gt;B"), "{html}");
        assert!(!html.contains("class=\"ln\""), "{html}");
    }

    #[test]
    fn split_diff_pairs_lines_and_marks_words() {
        let html = diff_split(
            "--- a\n+++ b\n@@ -1,2 +1,2 @@\n ctx\n-the old value\n+the new value\n+extra\n",
        );
        assert!(html.contains("<div class=\"hunk full\">"));
        assert!(html.contains("<div class=\"l del\">the <mark>old</mark> value</div><div class=\"r add\">the <mark>new</mark> value</div>"), "{html}");
        assert!(
            html.contains("<div class=\"l empty\"></div><div class=\"r add\">extra</div>"),
            "{html}"
        );
        assert_eq!(html.matches("class=\"l ctx\"").count(), 1);
    }

    #[test]
    fn long_code_is_cut_into_chunks_that_keep_their_numbering() {
        let r = Renderer::new();
        let src: String = (0..1000).map(|i| format!("let v{i} = {i};\n")).collect();
        let html = r.render(Kind::Code, Some("rs"), &src);
        let cut = chunk_code(&html);
        assert_eq!(cut.matches("<span class=\"lc\"").count(), 5);
        assert!(cut.contains("<span class=\"lc\" style=\"counter-reset:ln 0\">"));
        assert!(cut.contains("<span class=\"lc\" style=\"counter-reset:ln 800\">"));
        assert_eq!(cut.matches("<span class=\"ln\">").count(), 1000);
        // Every chunk is closed before the code is.
        assert_eq!(cut.matches("<span").count(), cut.matches("</span>").count());
        assert!(cut.ends_with("</code></pre>"));
        // Short blocks, and pages with none, come back as they were.
        let short = r.render(Kind::Code, Some("rs"), "fn main() {}\n");
        assert!(matches!(chunk_code(&short), std::borrow::Cow::Borrowed(_)));
        assert!(matches!(
            chunk_code("<p>hi</p>"),
            std::borrow::Cow::Borrowed(_)
        ));
    }

    #[test]
    fn outline_finds_declarations_not_call_sites() {
        let r = r();
        let src = "use std::io;\n\npub struct Config {\n    pub name: String,\n}\n\nimpl Config {\n    pub fn load() -> Self {\n        println!(\"x\");\n        Self::default()\n    }\n}\n\nfn main() {\n    load();\n}\n";
        let rust = r.outline(Some("rs"), src);
        let got: Vec<(&str, &str, usize)> = rust
            .iter()
            .map(|o| (o.name.as_str(), o.kind, o.line))
            .collect();
        assert!(got.contains(&("Config", "type", 3)), "{got:?}");
        assert!(got.contains(&("load", "fn", 8)), "{got:?}");
        assert!(got.contains(&("main", "fn", 14)), "{got:?}");
        assert!(
            !got.iter().any(|(n, _, l)| *n == "load" && *l == 15),
            "call sites excluded: {got:?}"
        );
        let depth = |name: &str, line: usize| {
            rust.iter()
                .find(|o| o.name == name && o.line == line)
                .map(|o| o.depth)
        };
        assert_eq!(depth("main", 14), Some(0));
        assert!(depth("load", 8) > Some(0), "nested one level: {rust:?}");

        let py = r.outline(Some("py"), "import os\n\nclass Store:\n    def get(self, k):\n        return os.path.join(k)\n\ndef main():\n    pass\n");
        let got: Vec<(&str, &str)> = py.iter().map(|o| (o.name.as_str(), o.kind)).collect();
        assert!(got.contains(&("Store", "type")), "{got:?}");
        assert!(got.contains(&("get", "fn")), "{got:?}");
        assert!(got.contains(&("main", "fn")), "{got:?}");
        assert!(
            !got.iter().any(|(n, _)| *n == "join"),
            "method calls excluded: {got:?}"
        );

        assert!(r
            .outline(Some("txt"), "just words\nmore words\n")
            .is_empty());
    }

    #[test]
    fn a_leading_h1_is_dropped_even_when_it_differs_from_the_title() {
        assert_eq!(
            strip_leading_h1("\n# Its own heading\n\nbody", "A different title").as_deref(),
            Some("\nbody")
        );
        assert_eq!(
            strip_leading_h1("# Same\n\nbody", "Same").as_deref(),
            Some("\nbody")
        );
        assert!(
            strip_leading_h1("intro\n# Later\n", "x").is_none(),
            "only a leading H1"
        );
        assert!(strip_leading_h1("## Smaller\n", "x").is_none());
    }

    #[test]
    fn prose_columns_wrap_and_identifier_columns_do_not() {
        let long = "Configure firewalls and proxy servers so that inbound traffic is filtered";
        let src =
            format!("id,status,description\nKSI-CNA-2,modified,{long}\nKSI-CNA-4,same,short\n");
        let html = table(&src, Some("csv"));
        assert!(
            html.contains("<th class=\"wrap\">description</th>"),
            "{html}"
        );
        assert!(
            html.contains("<th>id</th>"),
            "identifier header stays rigid: {html}"
        );
        assert!(
            html.contains(&format!("<td class=\"wrap\">{long}</td>")),
            "{html}"
        );
        assert!(html.contains("<td>KSI-CNA-2</td>"), "{html}");
    }

    #[test]
    fn diff_lines_are_classified() {
        let html = diff("--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new\n ctx\n");
        for c in ["meta", "hunk", "del", "add", "ctx"] {
            assert!(
                html.contains(&format!("class=\"ln {c}\"")),
                "missing {c}: {html}"
            );
        }
        let u = unified("a", "x\ny\n", "b", "x\nz\n");
        assert!(u.contains("-y") && u.contains("+z"));
    }

    /// A picture inside a document keeps its `data:` URL through the
    /// sanitizer -- the four picture types, on an image -- and nothing else
    /// does: no SVG, no page, no `data:` link.
    #[test]
    fn a_carried_picture_survives_the_sanitizer_and_nothing_else_does() {
        let png = "data:image/png;base64,iVBORw0KGgo=";
        let out = sanitize(&format!(
            "<p><img src=\"{png}\" alt=\"shot\"><img src=\"data:image/svg+xml;base64,PHN2Zz4=\"><img src=\"data:text/html;base64,PGI+\"><a href=\"data:image/png;base64,iVBO\">x</a></p>"
        ));
        assert!(out.contains(png), "{out}");
        assert!(!out.contains("svg+xml"), "{out}");
        assert!(!out.contains("text/html"), "{out}");
        assert!(!out.contains("href=\"data:"), "{out}");
        assert!(
            sanitize("<a href=\"https://x.dev\">x</a>").contains("https://x.dev"),
            "other links are as they were"
        );
    }

    #[test]
    fn data_uris_are_the_base64_a_browser_reads() {
        assert_eq!(data_uri("image/png", b"Man"), "data:image/png;base64,TWFu");
        assert_eq!(data_uri("image/png", b"Ma"), "data:image/png;base64,TWE=");
        assert_eq!(data_uri("image/png", b"M"), "data:image/png;base64,TQ==");
        assert_eq!(
            data_uri("image/png", &[0xfb, 0xff]),
            "data:image/png;base64,+/8="
        );
    }

    /// The pictures of a Markdown page, found where Markdown has them and
    /// not in its code; one that names a file on a friend's machine says it
    /// stayed there.
    #[test]
    fn a_pages_pictures_are_found_and_a_missing_one_says_so() {
        let md = "# Plan\n\n![shot](img/shot.png) and ![web](https://x.dev/a.png \"t\")\n\n```\n![in code](c.png)\n```\n![<sp>](<my shot.png>) ![](#x)\n";
        let mut seen = vec![];
        let same = map_md_images(md, |alt, url| {
            seen.push((alt.to_string(), url.to_string()));
            None
        });
        assert_eq!(same, md, "None leaves it as written");
        assert_eq!(
            seen,
            [
                ("shot", "img/shot.png"),
                ("web", "https://x.dev/a.png"),
                ("<sp>", "my shot.png"),
                ("", "#x"),
            ]
            .map(|(a, u)| (a.to_string(), u.to_string()))
        );
        let shown = stayed_with(md, "Trapti");
        assert!(
            shown.contains("*(a picture that stayed with Trapti: `shot.png`)*"),
            "{shown}"
        );
        assert!(
            shown.contains("![web](https://x.dev/a.png \"t\")"),
            "a link out is left"
        );
        assert!(shown.contains("![in code](c.png)"), "code is code");
        assert!(shown.contains("![](#x)"));
        assert!(relative_url("a/b.png") && !relative_url("data:image/png;base64,x"));
    }
}
