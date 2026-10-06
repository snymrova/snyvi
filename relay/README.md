# relay/

The mailbox two snyvis leave sealed documents in for each other. One
Cloudflare Worker at `https://relay.snyvi.com`, two Durable Object classes:
a `Room` for the minute of pairing and a `Mailbox` per address. The daemon's
side is `src/peer.rs`; the frame, the pairing and the threat model are in
`docs/PEER.md`. The routes are at the top of `src/index.ts`.

## What it sees

Two public keys, a size, and when. A frame is sealed to the recipient's box
key and signed by the sender before it leaves the sender's machine; the
relay reads its first 33 bytes (version, sender) and nothing more. A room
holds SPAKE2 messages, worthless without the spoken code, and hellos sealed
under the key SPAKE2 made.

Nothing is kept past its use. A frame goes when the recipient acks it, or
after seven days by the mailbox's alarm, and its tables go with the last
one. A mailbox keeps when its owner last signed in, and nothing at all once
it has held nothing for ninety days with its owner away; an address nobody
has signed in as takes nothing. A room goes when both sides have read the
last message, or after ten minutes. Workers Logs are off: a line per
request would be a list of who talks to whom. An IP is only ever a key in
the rate limiter's counters.

## Who may do what

A mailbox is read by its own key. A deposit is signed by its sender
(`x-snyvi-from`, `x-snyvi-auth`), and the same id is replaced only by the
same sender; 1.18.0 daemons cannot sign, so unsigned deposits are taken
until `REQUIRE_SIGNED` in `src/index.ts` is turned on (about two weeks
after 1.19.0), and never replace a signed one.

| Limit | Counted by | Per minute, per Cloudflare location |
|---|---|---|
| `LIMIT_FLOOD` | IP | 600 calls of any kind: a backstop |
| `LIMIT_FIRST` | IP | 5 first sign-ins of a mailbox or first messages of a room |
| `LIMIT_ROOM` | room | 30 calls (a pairing is 4 to 8) |
| `LIMIT_INBOX` | address | 120 signed reads |
| `LIMIT_SEND`, `_BIG` | signed sender | 30 deposits, 8 of them over 1 MB |
| `LIMIT_UNSIGNED`, `_BIG` | IP | the same, for 1.18.0's unsigned deposits |

An IP is a key only where nothing else is, because many people share one:
a carrier's NAT, an office, a VPN. What is refused is a 429 the daemon
waits out: a document stays in its outbox, a link backs off, a pairing says
the relay is busy.

## Running it

```
npm install
npm test            # wrangler dev --env test on a spare port, every route driven as the daemon drives it
npm run check       # tsc
npm run deploy      # wrangler deploy, by hand, once per change
```

Deploys go to the Cloudflare account that holds the `snyvi.com` zone, with a
token in the desk's keys as `CLOUDFLARE_API_TOKEN`:

```
CLOUDFLARE_API_TOKEN=$(snyvi key CLOUDFLARE_API_TOKEN) npm run deploy
```

CI runs `npm test` on every push and never deploys. `[env.test]` in
`wrangler.toml` is the tests' Worker -- the IP limits out of the way, and
`RELAY_TEST`, which opens two `/_test` routes into a mailbox -- and is never
deployed. The daemon reads the
relay's host from one constant in `src/peer.rs`, `SNYVI_RELAY` overrides it
for tests and for anyone running their own copy of this.

## What it costs

Requests, and nothing while idle. A daemon with a friend holds one
WebSocket to its mailbox; the mailbox hibernates with the socket open, the
daemon's "ping" is answered by the runtime, and nothing is billed until a
frame moves. A document sent is one request to leave it and, at the other
end, one wake to push it and one for the ack (two more when it is over
128 KB and fetched); opening the link is one request plus a wake. On the
free plan -- 100,000 requests a day, Durable Objects on SQLite, 5 GB --
that is about 1,500 to 2,500 daily-active people before the request count
is the bound; past it, about $2 per thousand people a month, and the
writes are what cost. Twenty frames may wait in a mailbox, five from one
sender, 40 MB in all, before a sender is told to try later. A pairing waits
on a doorbell that hibernates, so a code nobody types costs nothing.
