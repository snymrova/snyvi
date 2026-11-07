# wall/

What people are building: the section on every snyvi Home, and each
builder's page at `https://snyvi.page/<slug>`. One Cloudflare Worker at
`https://wall.snyvi.com` (and `snyvi.page`), one D1 database, one R2
bucket. The daemon's side is `src/wall.rs` and `src/server/api_wall.rs`;
what it promises is in `docs/WALL.md`.

## What it holds

What a builder's daemon signed and they pressed Publish on: the page, its
moments and their files, in the clear, under the daemon's public key. The
hearts, by the key that gave them, and the reports, counted. Nothing of the
machine a page was made on, no account, no log of who read what
(observability is off).

## The writes

Every one signed: `x-snyvi-from` (the daemon's address) and
`x-snyvi-auth` (`<seconds>.<signature>` over
`snyvi-wall-v1\n{METHOD}\n{path}\n{seconds}\n{blake3 of the body}`).

| Route | What |
|---|---|
| `PUT /pages/{slug}` | the page; the first key to put a slug owns it, others get 409 |
| `PUT /pages/{slug}/moments/{id}` | a moment |
| `PUT /pages/{slug}/files/{name}` | a file, named by its blake3 (16 hex) |
| `POST /pages/{slug}/check` | read `.snyvi/owner` at the repository's HEAD |
| `DELETE /pages/{slug}` | taken down: rows and files gone within the minute |
| `POST /pages/{slug}/hearts`, `…/moments/{id}/hearts` | a heart, a toggle, one per key |
| `POST /pages/{slug}/report` | counted |

## The reads

`/wall.json` (60 s), `/pages/{slug}/page.json` (5 min), `/files/{name}`
(immutable) and `snyvi.page/{slug}` (5 min), all out of R2 through the
cache: a read runs no query. Each write renders them once.

## The daily line

At 09:00 UTC each page with new hearts gets one `Content::Wall` frame,
sealed to its daemon with the wall's own key (`WALL_SEED`, minted by
`npm run mint`) and left at the relay as any sender leaves one. Its seal is
`src/seal.ts`, checked byte for byte against `src/peer.rs` by
`test/vectors.json`, which `cargo test` writes.

## Running it

    npm install
    npm run check && npm test          # wrangler dev, local, nothing deployed
    npm run mint                       # once: WALL_SEED, and WALL_KEY/WALL_BOX for src/wall.rs
    npm run deploy                     # by hand, with the account's token
    WALL_OPERATOR=… npm run hide -- <slug>   # the operator's takedown
