//! Turn a document into HTML exactly once, at receive time.

use comrak::adapters::SyntaxHighlighterAdapter;
use comrak::nodes::NodeValue;
use comrak::{format_html_with_plugins, parse_document, Arena, Options, Plugins};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{self, Write};
use std::path::Path;
use std::sync::Arc;
use syntect::parsing::{ParseState, Scope, ScopeStack, SyntaxReference, SyntaxSet};
use syntect::util::LinesWithEndings;

/// Highlight synchronously up to this many bytes; the rest is plain until a
/// background pass replaces it.
pub const HIGHLIGHT_CAP: usize = 256 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Markdown,
    Code,
    Diff,
    Text,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Markdown => "markdown",
            Kind::Code => "code",
            Kind::Diff => "diff",
            Kind::Text => "text",
        }
    }
    pub fn parse(s: &str) -> Option<Kind> {
        match s {
            "markdown" => Some(Kind::Markdown),
            "code" => Some(Kind::Code),
            "diff" => Some(Kind::Diff),
            "text" => Some(Kind::Text),
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
                _ => (Kind::Code, Some(ext)),
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
        match kind {
            Kind::Markdown => self.markdown(source, file_base),
            Kind::Code => self.code(lang, source, HIGHLIGHT_CAP),
            Kind::Diff => diff(source),
            Kind::Text => plain(source),
        }
    }

    /// Full highlight with no cap, for the background pass on large files.
    pub fn render_code_uncapped(&self, lang: Option<&str>, source: &str) -> String {
        self.code(lang, source, usize::MAX)
    }

    fn markdown(&self, source: &str, file_base: Option<&str>) -> String {
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
        let t_md = t.elapsed();
        let out = if has_raw_html { sanitize(&raw) } else { raw };
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

    fn code(&self, lang: Option<&str>, source: &str, cap: usize) -> String {
        let syntax = lang
            .and_then(|l| {
                let l = alias(l);
                self.ss
                    .find_syntax_by_token(l)
                    .or_else(|| self.ss.find_syntax_by_extension(l))
            })
            .or_else(|| self.ss.find_syntax_by_first_line(source))
            .unwrap_or_else(|| self.ss.find_syntax_plain_text());
        let mut out = String::with_capacity(source.len() * 3);
        out.push_str("<pre class=\"code\" data-lang=\"");
        out.push_str(&html_escape::encode_double_quoted_attribute(
            syntax.name.as_str(),
        ));
        out.push_str("\"><code>");
        highlight_lines(&self.ss, &self.classes, syntax, source, cap, &mut out);
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

    fn class_for(&self, stack: &ScopeStack) -> Option<&'static str> {
        for scope in stack.as_slice().iter().rev() {
            for (prefix, cls) in &self.table {
                if prefix.is_prefix_of(*scope) {
                    return Some(cls);
                }
            }
        }
        None
    }
}

/// Emit one `<span class="ln">` per line, highlighted up to the cap.
fn highlight_lines(
    ss: &SyntaxSet,
    classes: &ClassMap,
    syntax: &SyntaxReference,
    source: &str,
    cap: usize,
    out: &mut String,
) {
    let mut state = ParseState::new(syntax);
    let mut stack = ScopeStack::new();
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
                        emit(out, seg, refine(classes.class_for(&stack), seg), &mut open);
                        last = idx;
                    }
                    let _ = stack.apply(op);
                }
                if last < text.len() {
                    let seg = &text[last..];
                    emit(out, seg, refine(classes.class_for(&stack), seg), &mut open);
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
pub fn strip_leading_h1(content: &str, title: &str) -> Option<String> {
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
        if h != title {
            return None;
        }
        let rest_start = prefix_len + line.len();
        return Some(content[rest_start..].to_string());
    }
    None
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
                "data-footnote-ref",
                "data-footnote-backref",
            ],
        )
        .add_tag_attributes("li", ["id", "class"])
        .add_tag_attributes("ul", ["class"])
        .add_tag_attributes("ol", ["class", "start"])
        .add_tag_attributes("section", ["class", "data-footnotes"])
        .add_tag_attributes("div", ["class"])
        .add_tag_attributes("p", ["class"])
        .add_tag_attributes("span", ["class"])
        .add_tag_attributes("pre", ["class", "data-lang"])
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
    b.clean(html).to_string()
}

/// comrak adapter: syntect with CSS classes, so code blocks share the page palette.
struct Highlighter<'a> {
    ss: &'a SyntaxSet,
    classes: &'a ClassMap,
}

impl SyntaxHighlighterAdapter for Highlighter<'_> {
    fn write_highlighted(
        &self,
        output: &mut dyn Write,
        lang: Option<&str>,
        code: &str,
    ) -> io::Result<()> {
        if lang
            .map(|l| l.eq_ignore_ascii_case("mermaid"))
            .unwrap_or(false)
        {
            // Diagram source stays verbatim; the client renders it after first paint.
            return output.write_all(html_escape::encode_text(code).as_bytes());
        }
        let syntax = lang
            .filter(|l| !l.is_empty())
            .and_then(|l| self.ss.find_syntax_by_token(l))
            .unwrap_or_else(|| self.ss.find_syntax_plain_text());
        let mut out = String::with_capacity(code.len() * 3);
        highlight_lines(self.ss, self.classes, syntax, code, HIGHLIGHT_CAP, &mut out);
        output.write_all(out.as_bytes())
    }

    fn write_pre_tag(
        &self,
        output: &mut dyn Write,
        attributes: HashMap<String, String>,
    ) -> io::Result<()> {
        let lang = attributes.get("lang").cloned().unwrap_or_default();
        if lang.eq_ignore_ascii_case("mermaid") {
            return output.write_all(b"<pre class=\"mermaid\" data-lang=\"Mermaid\">");
        }
        let name = self
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
        write!(
            output,
            "<pre class=\"code\" data-lang=\"{}\">",
            html_escape::encode_double_quoted_attribute(&name)
        )
    }

    fn write_code_tag(
        &self,
        output: &mut dyn Write,
        attributes: HashMap<String, String>,
    ) -> io::Result<()> {
        match attributes.get("class") {
            Some(c) => write!(
                output,
                "<code class=\"{}\">",
                html_escape::encode_double_quoted_attribute(c)
            ),
            None => output.write_all(b"<code>"),
        }
    }
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
    fn strips_only_a_matching_leading_h1() {
        assert_eq!(
            strip_leading_h1("\n# T\n\nbody", "T").as_deref(),
            Some("\nbody")
        );
        assert!(strip_leading_h1("# Other\n\nbody", "T").is_none());
        assert!(strip_leading_h1("intro\n# T\n", "T").is_none());
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
}
