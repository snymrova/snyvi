# Spike: can we do statements without a nightly job?

**Timebox:** two days · **Answer:** yes, for 94% of accounts

The nightly statement job is the last thing in the stack that has to finish
before 06:00, and it has missed twice this quarter. This asks whether a
statement can simply be computed when someone asks for it.

## What I measured

I replayed a month of real statement requests against a query that builds the
statement from the ledger on demand.

| Accounts | Rows in period | Build time p50 | p99 |
|---|---|---|---|
| 0–1k rows | under 1,000 | 34 ms | 120 ms |
| 1k–10k | under 10,000 | 210 ms | 640 ms |
| 10k–100k | under 100,000 | 1.9 s | 4.4 s |
| over 100k | — | 14 s | 41 s |

94% of accounts are in the first two rows. The tail is 300-odd merchant
accounts, and every one of them already has a data export.

## What I would do

Compute on demand under 10,000 rows. Keep the nightly job for the rest, and
let it run at any hour it likes, because nothing waits for it any more.

## What I did not test

Concurrency. One request at a time on a warm cache is the friendly case, and
month-end is not the friendly case.
