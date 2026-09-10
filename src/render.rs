//! Turn a document into HTML exactly once, at receive time.

use comrak::adapters::SyntaxHighlighterAdapter;
use comrak::nodes::NodeValue;
use comrak::{format_html_with_plugins, parse_document, Arena, Options, Plugins};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{self, Write};
use std::path::Path;
use syntect::parsing::{ParseState, Scope, ScopeStack, SyntaxReference, SyntaxSet};
use syntect::util::LinesWithEndings;

/// Highlight synchronously up to this many bytes; the rest is plain.
const HIGHLIGHT_CAP: usize = 256 * 1024;

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

impl Renderer {
    pub fn new() -> Self {
        Renderer { ss: SyntaxSet::load_defaults_newlines(), classes: ClassMap::new() }
    }

    /// Decide what a document is from its path, an explicit language, and its content.
    pub fn detect(&self, path: Option<&str>, lang: Option<&str>, content: &str) -> (Kind, Option<String>) {
        if let Some(l) = lang.map(|l| l.trim().to_ascii_lowercase()).filter(|l| !l.is_empty()) {
            return match l.as_str() {
                "md" | "markdown" | "mdx" => (Kind::Markdown, None),
                "diff" | "patch" => (Kind::Diff, None),
                "txt" | "text" | "plain" => (Kind::Text, None),
                _ => (Kind::Code, Some(l)),
            };
        }
        if let Some(p) = path {
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
        match kind {
            Kind::Markdown => self.markdown(source),
            Kind::Code => self.code(lang, source),
            Kind::Diff => diff(source),
            Kind::Text => plain(source),
        }
    }

    fn markdown(&self, source: &str) -> String {
        let mut options = Options::default();
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

        let adapter = Highlighter { ss: &self.ss, classes: &self.classes };
        let mut plugins = Plugins::default();
        plugins.render.codefence_syntax_highlighter = Some(&adapter);

        let trace = std::env::var_os("SNYVI_TRACE").is_some();
        let t = std::time::Instant::now();
        let arena = Arena::new();
        let root = parse_document(&arena, source, &options);
        // Raw HTML is rare in agent output. Without it, comrak's safe mode already escapes
        // everything and drops dangerous links, so the (expensive) sanitizer can be skipped.
        let has_raw_html = root
            .descendants()
            .any(|n| matches!(n.data.borrow().value, NodeValue::HtmlBlock(_) | NodeValue::HtmlInline(_)));
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

    fn code(&self, lang: Option<&str>, source: &str) -> String {
        let syntax = lang
            .and_then(|l| self.ss.find_syntax_by_token(l).or_else(|| self.ss.find_syntax_by_extension(l)))
            .or_else(|| self.ss.find_syntax_by_first_line(source))
            .unwrap_or_else(|| self.ss.find_syntax_plain_text());
        let mut out = String::with_capacity(source.len() * 3);
        out.push_str("<pre class=\"code\" data-lang=\"");
        out.push_str(&html_escape::encode_double_quoted_attribute(syntax.name.as_str()));
        out.push_str("\"><code>");
        highlight_lines(&self.ss, &self.classes, syntax, source, &mut out);
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
        ClassMap { table: ENTRIES.iter().filter_map(|(sel, cls)| Scope::new(sel).ok().map(|s| (s, *cls))).collect() }
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
fn highlight_lines(ss: &SyntaxSet, classes: &ClassMap, syntax: &SyntaxReference, source: &str, out: &mut String) {
    let mut state = ParseState::new(syntax);
    let mut stack = ScopeStack::new();
    let mut consumed = 0usize;
    let mut lines = LinesWithEndings::from(source).peekable();
    while let Some(line) = lines.peek() {
        if consumed + line.len() > HIGHLIGHT_CAP && consumed > 0 {
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
                        emit(out, &text[last..idx], classes.class_for(&stack), &mut open);
                        last = idx;
                    }
                    let _ = stack.apply(op);
                }
                if last < text.len() {
                    emit(out, &text[last..], classes.class_for(&stack), &mut open);
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
        out.push_str(&html_escape::encode_text(line.strip_suffix('\n').unwrap_or(line)));
        out.push_str("</span>\n");
    }
}

/// Append a token run, opening/closing a class span only when the class changes.
fn emit(out: &mut String, text: &str, class: Option<&'static str>, open: &mut Option<&'static str>) {
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
        out.push_str(&html_escape::encode_text(line.strip_suffix('\n').unwrap_or(line)));
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
        let class = if l.starts_with("+++") || l.starts_with("---") || l.starts_with("diff ") || l.starts_with("index ") {
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
    head.iter().any(|l| l.starts_with("diff --git") || l.starts_with("@@ "))
        || (head.iter().any(|l| l.starts_with("--- ")) && head.iter().any(|l| l.starts_with("+++ ")))
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
        let h = line.trim().strip_prefix("# ")?.trim().trim_end_matches('#').trim();
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
        .add_tag_attributes("a", ["id", "class", "aria-hidden", "data-footnote-ref", "data-footnote-backref"])
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
    fn write_highlighted(&self, output: &mut dyn Write, lang: Option<&str>, code: &str) -> io::Result<()> {
        let syntax = lang
            .filter(|l| !l.is_empty())
            .and_then(|l| self.ss.find_syntax_by_token(l))
            .unwrap_or_else(|| self.ss.find_syntax_plain_text());
        let mut out = String::with_capacity(code.len() * 3);
        highlight_lines(self.ss, self.classes, syntax, code, &mut out);
        output.write_all(out.as_bytes())
    }

    fn write_pre_tag(&self, output: &mut dyn Write, attributes: HashMap<String, String>) -> io::Result<()> {
        let lang = attributes.get("lang").cloned().unwrap_or_default();
        let name = self
            .ss
            .find_syntax_by_token(&lang)
            .map(|s| s.name.clone())
            .unwrap_or_else(|| if lang.is_empty() { "Text".into() } else { lang.clone() });
        write!(output, "<pre class=\"code\" data-lang=\"{}\">", html_escape::encode_double_quoted_attribute(&name))
    }

    fn write_code_tag(&self, output: &mut dyn Write, attributes: HashMap<String, String>) -> io::Result<()> {
        match attributes.get("class") {
            Some(c) => write!(output, "<code class=\"{}\">", html_escape::encode_double_quoted_attribute(c)),
            None => output.write_all(b"<code>"),
        }
    }
}

/// Unified diff between two sources, for "compare with previous".
pub fn unified(a_name: &str, a: &str, b_name: &str, b: &str) -> String {
    let d = similar::TextDiff::from_lines(a, b);
    d.unified_diff().context_radius(3).header(a_name, b_name).to_string()
}
