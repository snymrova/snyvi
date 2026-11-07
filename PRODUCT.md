# Product

<!-- impeccable:product-schema 1 -->

## Platform

web (the marketing site, snyvi.com). The product itself is a desktop app: a Rust daemon on 127.0.0.1 and a window that opens it, on Linux, macOS and Windows.

## Stack

Site: static HTML/CSS plus a small build script that renders `docs/*.md` and the release notes, in this repo under `site/`, served as Cloudflare Workers static assets on snyvi.com (the zone is already on Cloudflare beside `relay.snyvi.com`). Confirmed 2026-10-12.

## Users

Makers with more passion projects than hours in the day, who now run coding agents (Claude Code first, also Codex, Cursor, Gemini) on several of them at once. They live in terminals, judge tools by craft and speed, and distrust accounts, telemetry and hype. They reach the site from Product Hunt, Hacker News, a friend's link or the GitHub README, usually on a laptop and sometimes on a phone.

## Product Purpose

snyvi gives each project a desk: its agents side by side in real shells, everything they write kept as a readable, versioned page, and the project's notes, so work no longer scatters into scrollback and memory. Success for the site: a visitor understands that in one viewport and installs it with one copied line.

## Positioning

The agents work where you can see them, and what they write lands where you can read it, on your machine. One static binary on 127.0.0.1, no account, and nothing leaves your machine unless you press. A document goes sealed to a paired friend. A page goes to the wall, in the clear, signed by you, and you can take it down. What others say comes back to you as words you read; it never reaches an agent unless you make it a note (docs/WALL.md).

## Operating Context

Installed by brew, winget, scoop, a curl one-liner, .deb or `cargo install snyvi`; first run asks "What are you working on?" and makes that project's first desk. Agents talk to it over MCP (`send_document`, desk notes, `leave_off`) and Claude Code hooks. It updates itself, signed.

## Capabilities and Constraints

Desks with up to four panels; documents (Markdown with Mermaid, HTML, images, diffs) versioned and searchable (⌘K); desk notes agents read and tick; Home showing where each desk was left; a friend's snyvi (pairing, Send to…); widgets; 8 themes × 8 accents. Free, MIT, no paid tier. mrova.rocks/snyvi stays as the maker's page; snyvi.com is the product's home beside it.

## Brand Commitments

- Name always lowercase: snyvi. Mascot face from `icons/icon.svg`, never redrawn freehand.
- Headline: "All your passion projects, in one calm place." Answer line: "Agents make it easy to start. snyvi helps you finish."
- Who we work for is passionate people and their passion projects; Claude Code is how, never who (2026-10-12). The hero names Claude Code only in the lede ("where your Claude Code sessions run side by side"), never as a "For Claude Code" label or in the title. Other agents get one line lower down, under "Any agent".
- What snyvi is comes before how it feels (2026-11-02, stranger test): the home page opens with a category kicker, "A free desktop app for your AI coding agents", which names what it is, not who it's for. The title, description and share picture say "where your coding agents work". Under the headline come the reader's problem in their words (terminal tabs, scrollback, your head, every switch), what a desk is, and what they bring (their own agent; snyvi is free, local, no account).
- The passion-projects story leads: more projects than hours; work scatters (scrollback, your head, every switch); story-beat headers (Nothing scrolls away / Out of your head / Just as you left it).
- Persona: a calm workshop, warm, dry and quick, precise like an instrument, on your side; never streaks, badges, confetti, hype. Voice and look rules in `docs/DESIGN.md`; the film's web-facing rendition (dark ground, Passion red, Archivo) in `film/DESIGN.md`.

## Evidence on Hand

- The film `docs/media/demo.mp4` (117 s, narrated); a 30 s cut is planned.
- Stills of the real window, light and dark, in `docs/media/*.webp` (desk, focus, over, home, switch, search, versions, diff, plan, diagram, arrival, connect, palette, filed, source); `docs/media/faces.svg`.
- Measured facts: up in 11 ms; first paint ≤ 56 KB; budgets checked on every push (`docs/GUIDE.md#measured-so-far`).
- No testimonials, user counts, star counts or press yet. Do not invent them.

## Product Principles

1. Their project, not our plumbing: every claim is about the maker's work.
2. Prove with the real window, never a mockup.
3. Local, private and free are facts to state plainly, not slogans.
4. Calm beats loud: the site earns attention with craft, not urgency.
