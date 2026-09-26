<p align="center">
  <img src="icons/icon.svg" width="80" alt="">
</p>

<h1 align="center">snyvi</h1>

<p align="center"><b>All your passion projects, in one calm place.</b></p>

<p align="center">
  <a href="https://github.com/snymrova/snyvi/releases/latest"><img src="https://img.shields.io/github/v/release/snymrova/snyvi?style=flat-square&color=c8420f&label=release" alt="latest release"></a>
  <a href="https://github.com/snymrova/snyvi/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/snymrova/snyvi/ci.yml?style=flat-square&label=ci" alt="ci"></a>
  <img src="https://img.shields.io/badge/linux%20%C2%B7%20macos%20%C2%B7%20windows-one%20static%20binary-555?style=flat-square" alt="Linux, macOS and Windows, one static binary">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-555?style=flat-square" alt="MIT"></a>
</p>

<!-- The film is docs/media/demo.mp4, cut in film/ -- see film/README.md.
     GitHub plays a video inline only from a user-attachments URL, so after a
     re-cut the file is dropped into a comment box once and the link it gives
     replaces this one.

     The desk pictures below (desk, over, notes, switch) are the film's own
     frames: film/shoot.mjs, live Claude Code in every panel. -->

https://github.com/user-attachments/assets/fb6ee0de-a5ce-437c-b2a3-d354081ca727

You have more passion projects than hours in the day. With coding agents,
you can finally build them all, at the same time.

But the work scatters. Plans get lost in terminal scrollback. What's left to
do lives in your head. And every project pulls you away from the last.

**snyvi keeps it all in order.** One desk for each project, its agents side
by side, and everything they write kept where you can read it. It runs on
your machine, with no account and nothing to configure.

## Install

```
curl -fsSL https://raw.githubusercontent.com/snymrova/snyvi/main/install.sh | sh
```

Linux and macOS. It checks every download against its checksum and connects
Claude Code if it finds it. [Read it first](install.sh); run it again to update.

**Windows**: `scoop bucket add snyvi https://github.com/snymrova/scoop-snyvi`
then `scoop install snyvi`, or the [installer][win].

Homebrew, `.deb`, `cargo install snyvi` and the rest: [install guide](docs/GUIDE.md#install).

[win]: https://github.com/snymrova/snyvi/releases/latest/download/snyvi-windows-x64-setup.exe

## One desk for each project

A project's folder with up to four real shells in it: Claude Code, Codex,
your tests, a `git log`. Every agent on the project works in view.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/media/desk-dark.webp">
    <img src="docs/media/desk-light.webp" width="900" alt="The ledger desk in snyvi: four Claude Code sessions working side by side in their own panels, the projects in the sidebar, and the desk's documents and notes in the rail">
  </picture>
</p>

## Nothing scrolls away

Plans and reviews land as clean pages, filed under their project and kept
with every earlier version. `c` shows what changed.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/media/over-dark.webp">
    <img src="docs/media/over-light.webp" width="900" alt="A plan open over the ledger desk: the document in the middle, and the rail still listing the desk's four panels, what they sent, and its notes">
  </picture>
</p>

## Out of your head

Each desk keeps its own notes, so what's left to do stays with the project.
The agents at that desk can read them too, and only read them.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/media/notes-dark.webp">
    <img src="docs/media/notes-light.webp" width="900" alt="The ledger desk's notes in the rail: one open question left, two ticked off and struck through">
  </picture>
</p>

## Just as you left it

Switch projects and each desk is exactly as you left it. The agents you
walked away from keep working. `⌘K` searches everything any agent ever sent.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/media/switch-dark.webp">
    <img src="docs/media/switch-light.webp" width="900" alt="The gateway desk: two Claude Code sessions on a different project, with its own documents and notes in the rail">
  </picture>
</p>

## Any agent

```
snyvi init-claude --auto   # Claude Code
snyvi init codex           # also cursor, claude-desktop, gemini, windsurf, vscode, zed
```

## Private, and fast

One static binary, listening on 127.0.0.1 only. No account, no telemetry.
Up in 11 ms, and [every budget is checked](docs/GUIDE.md#measured-so-far) on every push.

---

[Guide](docs/GUIDE.md) · [Desks](docs/DESK.md) · [Roadmap](docs/ROADMAP.md) · [The film](film/README.md) · MIT
