//! What the browser does not read, it does not fetch.
//!
//! `ui/`'s four text assets are 69 KB gzipped and 26 KB of that is comments
//! and indentation -- the prose that says why the code is the way it is, which
//! this codebase keeps deliberately and at length. None of it is read by a
//! browser. Until this existed the reader paid for all of it on every first
//! paint, and the budget in `bench/bytes.mjs` was being spent on paragraphs
//! nothing renders.
//!
//! So the source keeps its comments and the wire does not: `build.rs` runs
//! every asset through here once, and the daemon embeds what comes out.
//! `SNYVI_UI_DIR` still serves the files off disk exactly as written, because
//! the dev loop is where a person reads them.
//!
//! It removes comments, indentation and blank lines and nothing else. Names
//! are left alone, lines are never joined, and so automatic semicolon
//! insertion sees the program it saw before -- every statement keeps its own
//! line. That is a smaller win than a minifier would take and it is the whole
//! risk budget: a mangled identifier is a bug a bench might not catch, while
//! a lost comment cannot be one.
//!
//! The one thing it has to be careful about is what looks like a comment and
//! is not: `"https://example.com"` has `//` in it, a regex may hold `/*`, and
//! a template literal's newlines and indentation are text the page shows. So
//! this is a scanner with a mode stack rather than a pass of replacements --
//! strings, templates and regex literals are copied through untouched, and
//! only code is trimmed.

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Lang {
    Js,
    Css,
}

/// Where the scanner is. `Tpl` is the text part of a template literal, whose
/// every character is content; `${` inside one pushes `Code` back on.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    /// Code, with the brace depth since the `${` that opened it, if any.
    Code {
        tpl_brace: Option<usize>,
    },
    Tpl,
}

/// Comments, indentation and blank lines out; everything else through as
/// written.
pub fn strip(src: &str, lang: Lang) -> String {
    let c: Vec<char> = src.chars().collect();
    let mut out = String::with_capacity(src.len());
    let mut mode = vec![Mode::Code { tpl_brace: None }];
    // Nothing but whitespace has been emitted on this line yet, so leading
    // whitespace is still droppable and a newline would make the line blank.
    let mut fresh = true;
    let mut i = 0;

    while i < c.len() {
        let ch = c[i];

        if *mode.last().unwrap() == Mode::Tpl {
            // Template text: verbatim, including newlines and indentation.
            if ch == '\\' && i + 1 < c.len() {
                out.push(ch);
                out.push(c[i + 1]);
                i += 2;
                continue;
            }
            if ch == '`' {
                out.push(ch);
                mode.pop();
                fresh = false;
                i += 1;
                continue;
            }
            if ch == '$' && i + 1 < c.len() && c[i + 1] == '{' {
                out.push_str("${");
                mode.push(Mode::Code { tpl_brace: Some(0) });
                i += 2;
                continue;
            }
            out.push(ch);
            i += 1;
            continue;
        }

        // ---- code ----
        if fresh && (ch == ' ' || ch == '\t') {
            i += 1;
            continue;
        }

        if ch == '\n' {
            if fresh {
                // A blank line, or one that held only a comment.
                i += 1;
                continue;
            }
            while out.ends_with(' ') || out.ends_with('\t') {
                out.pop();
            }
            out.push('\n');
            fresh = true;
            i += 1;
            continue;
        }

        if ch == '\r' {
            i += 1;
            continue;
        }

        // `//` to the end of the line. CSS has no line comments: `//` there is
        // two division signs or, far more likely, part of a url().
        if lang == Lang::Js && ch == '/' && i + 1 < c.len() && c[i + 1] == '/' {
            while i < c.len() && c[i] != '\n' {
                i += 1;
            }
            continue;
        }

        // `/* ... */`, in both languages.
        if ch == '/' && i + 1 < c.len() && c[i + 1] == '*' {
            i += 2;
            while i + 1 < c.len() && !(c[i] == '*' && c[i + 1] == '/') {
                i += 1;
            }
            i = (i + 2).min(c.len());
            continue;
        }

        if ch == '\'' || ch == '"' {
            let quote = ch;
            out.push(ch);
            i += 1;
            while i < c.len() {
                if c[i] == '\\' && i + 1 < c.len() {
                    out.push(c[i]);
                    out.push(c[i + 1]);
                    i += 2;
                    continue;
                }
                out.push(c[i]);
                i += 1;
                if c[i - 1] == quote || c[i - 1] == '\n' {
                    break;
                }
            }
            fresh = false;
            continue;
        }

        if lang == Lang::Js && ch == '`' {
            out.push(ch);
            mode.push(Mode::Tpl);
            fresh = false;
            i += 1;
            continue;
        }

        if lang == Lang::Js && ch == '/' && regex_here(&out) {
            i = copy_regex(&c, i, &mut out);
            fresh = false;
            continue;
        }

        if lang == Lang::Js && (ch == '{' || ch == '}') {
            if let Mode::Code { tpl_brace: Some(d) } = *mode.last().unwrap() {
                if ch == '{' {
                    *mode.last_mut().unwrap() = Mode::Code {
                        tpl_brace: Some(d + 1),
                    };
                } else if d == 0 {
                    // The `}` that closes `${`: back into the template's text.
                    out.push(ch);
                    mode.pop();
                    fresh = false;
                    i += 1;
                    continue;
                } else {
                    *mode.last_mut().unwrap() = Mode::Code {
                        tpl_brace: Some(d - 1),
                    };
                }
            }
        }

        out.push(ch);
        fresh = false;
        i += 1;
    }

    while out.ends_with('\n') || out.ends_with(' ') {
        out.pop();
    }
    out.push('\n');
    out
}

/// Whether a `/` at this point starts a regex literal rather than a division.
///
/// The question JavaScript cannot answer without a parser, decided the way
/// every scanner decides it: by what came before. After a value -- a name, a
/// number, a closing bracket -- a slash divides; after an operator, a comma,
/// an opening bracket or a keyword, it opens a pattern. Guessing wrong reads
/// code as a literal and would corrupt the file, so `copy_regex` refuses
/// anything that does not close on its own line.
fn regex_here(out: &str) -> bool {
    let Some(prev) = out.chars().rev().find(|c| !c.is_whitespace()) else {
        return true;
    };
    if "(,=:[!&|?{};+-*%<>~^".contains(prev) {
        return true;
    }
    if prev.is_alphanumeric() || prev == '_' || prev == '$' {
        let word: String = out
            .chars()
            .rev()
            .take_while(|c| c.is_alphanumeric() || *c == '_' || *c == '$')
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        return matches!(
            word.as_str(),
            "return"
                | "typeof"
                | "instanceof"
                | "in"
                | "of"
                | "new"
                | "delete"
                | "void"
                | "case"
                | "do"
                | "else"
                | "yield"
                | "await"
        );
    }
    false
}

/// Copy a regex literal through, character class and escapes included. A
/// literal that does not close before the line ends was not one: the slash is
/// emitted alone and scanning goes on as code.
fn copy_regex(c: &[char], start: usize, out: &mut String) -> usize {
    let mut i = start + 1;
    let mut class = false;
    while i < c.len() {
        match c[i] {
            '\n' => break,
            '\\' if i + 1 < c.len() => {
                i += 2;
                continue;
            }
            '[' => class = true,
            ']' => class = false,
            '/' if !class => {
                i += 1;
                // flags
                while i < c.len() && c[i].is_ascii_alphabetic() {
                    i += 1;
                }
                out.extend(&c[start..i]);
                return i;
            }
            _ => {}
        }
        i += 1;
    }
    out.push('/');
    start + 1
}

#[cfg(test)]
mod tests {
    use super::{strip, Lang};

    fn js(s: &str) -> String {
        strip(s, Lang::Js)
    }

    #[test]
    fn comments_go_and_code_stays() {
        assert_eq!(js("// gone\nlet a = 1;\n"), "let a = 1;\n");
        assert_eq!(js("/* gone */let a = 1;\n"), "let a = 1;\n");
        assert_eq!(js("let a = 1; // gone\n"), "let a = 1;\n");
        assert_eq!(js("/** doc\n * lines\n */\nf();\n"), "f();\n");
    }

    #[test]
    fn indentation_and_blank_lines_go() {
        assert_eq!(js("  a();\n\n\n    b();\n"), "a();\nb();\n");
    }

    #[test]
    fn a_url_is_not_a_comment() {
        assert_eq!(
            js("const u = \"https://example.com/x\"; // gone\n"),
            "const u = \"https://example.com/x\";\n"
        );
        assert_eq!(
            js("const s = '/* not a comment */';\n"),
            "const s = '/* not a comment */';\n"
        );
    }

    #[test]
    fn a_template_keeps_its_whitespace() {
        let src = "const t = `line\n  indented\n\n  after a blank`;\n";
        assert_eq!(js(src), src);
    }

    #[test]
    fn a_template_hole_is_code_again() {
        assert_eq!(
            js("const t = `a${ /* gone */ b }c`;\n"),
            "const t = `a${  b }c`;\n"
        );
        // A brace inside the hole must not be read as the hole's end.
        assert_eq!(
            js("const t = `${ f({ x: 1 }) }`; // gone\n"),
            "const t = `${ f({ x: 1 }) }`;\n"
        );
        // A template inside a template's hole.
        assert_eq!(
            js("const t = `${ `in  ner` }`;\n"),
            "const t = `${ `in  ner` }`;\n"
        );
    }

    #[test]
    fn a_regex_survives() {
        assert_eq!(
            js("const r = /^\\s*\\/\\/.*$/;\n"),
            "const r = /^\\s*\\/\\/.*$/;\n"
        );
        assert_eq!(
            js("if (/[/*]/.test(s)) f();\n"),
            "if (/[/*]/.test(s)) f();\n"
        );
        assert_eq!(js("return /a\\/b/g;\n"), "return /a\\/b/g;\n");
        // Division is not a regex: what follows must survive as code.
        assert_eq!(
            js("const n = a / b; // gone\nc();\n"),
            "const n = a / b;\nc();\n"
        );
        assert_eq!(js("const n = (x) / 2 / 3;\n"), "const n = (x) / 2 / 3;\n");
    }

    #[test]
    fn every_statement_keeps_its_line() {
        // Automatic semicolon insertion depends on it.
        let out = js("const a = 1\n// gone\nconst b = 2\n");
        assert_eq!(out, "const a = 1\nconst b = 2\n");
    }

    #[test]
    fn css_keeps_its_slashes() {
        let src = ".a { background: url(//host/x.png); }\n";
        assert_eq!(strip(src, Lang::Css), src);
        assert_eq!(
            strip("/* gone */\n.a {\n  color: red;\n}\n", Lang::Css),
            ".a {\ncolor: red;\n}\n"
        );
        assert_eq!(
            strip(".a::after { content: \"/* kept */\"; }\n", Lang::Css),
            ".a::after { content: \"/* kept */\"; }\n"
        );
    }

    #[test]
    fn stripping_twice_changes_nothing() {
        for src in [
            include_str!("../ui/boot.js"),
            include_str!("../ui/app.js"),
            include_str!("../ui/mmd.js"),
            include_str!("../ui/desk.js"),
            include_str!("../ui/game.js"),
            include_str!("../ui/about.js"),
            include_str!("../ui/find.js"),
            include_str!("../ui/menu.js"),
        ] {
            let once = js(src);
            assert_eq!(js(&once), once);
        }
        let once = strip(include_str!("../ui/app.css"), Lang::Css);
        assert_eq!(strip(&once, Lang::Css), once);
    }

    /// Evidence on the real assets that nothing inside code was touched.
    ///
    /// Counting backticks would prove nothing: this codebase writes
    /// `SNYVI_UI_DIR` in its prose, so comments hold backticks of their own
    /// and losing them changes the parity honestly. What must hold is that
    /// every piece of code survives -- so each of these is counted, and the
    /// count has to match exactly. That an asset still *parses* is a stronger
    /// claim than a scanner should make about itself, and `bench/bytes.mjs`
    /// makes it, against what the daemon serves.
    #[test]
    fn the_real_assets_keep_their_code() {
        for src in [
            include_str!("../ui/app.js"),
            include_str!("../ui/desk.js"),
            include_str!("../ui/mmd.js"),
            include_str!("../ui/boot.js"),
            include_str!("../ui/game.js"),
            include_str!("../ui/about.js"),
            include_str!("../ui/find.js"),
            include_str!("../ui/menu.js"),
        ] {
            let out = strip(src, Lang::Js);
            // Deletion and nothing else: every character of the output is in
            // the source, in order. A scanner that mangled, reordered or
            // invented anything fails here, and none of it depends on the
            // scanner's own idea of what a comment is.
            assert!(
                subsequence(&out, src),
                "the output is not the source minus parts"
            );
            // And it did not delete code: these appear in none of the four
            // files' prose, so every one of them has to come through.
            for needle in [
                "addEventListener(",
                "querySelector(",
                "await ",
                "\"/api/",
                "=> ",
            ] {
                assert_eq!(
                    src.matches(needle).count(),
                    out.matches(needle).count(),
                    "{needle}: the code lost one"
                );
            }
            // It did the work: a tenth of these files at least is prose and
            // indentation. Which lines are left indented is not checkable
            // here -- a multi-line template's own lines are content.
            assert!(out.len() * 10 < src.len() * 9, "nothing much came out");
        }
    }

    /// Whether `a` is what is left of `b` after deleting characters.
    fn subsequence(a: &str, b: &str) -> bool {
        let mut it = b.chars();
        a.chars().all(|c| it.any(|d| d == c))
    }
}
