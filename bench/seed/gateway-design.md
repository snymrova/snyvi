# Gateway: one door for every API

**Status:** in review · **Scope:** `gateway/` · **Owner:** platform

Today `/v1/*`, `/internal/*` and the webhook receiver each terminate TLS
themselves, each parse their own auth header, and each disagree about what a
401 body looks like. This puts one door in front of all three.

## What moves

| Path | Terminates today | After |
|---|---|---|
| `/v1/*` | `api` pod | gateway |
| `/internal/*` | `admin` pod | gateway, mTLS only |
| `/hooks/*` | `webhook` pod | gateway, signature checked at the edge |

## Auth, once

One middleware reads the key, resolves the organisation, and puts both on the
request. Nothing downstream parses a header again. A key that is revoked stops
working at the edge rather than three services later.

## What this does not do

- It does not do rate limiting. That is `docs/rate-limiting.md`.
- It does not terminate gRPC. The two internal callers keep their own port.
- It does not cache. Caching before auth is how you leak another tenant's data.

## Open questions

1. Do webhooks keep their own timeout, or take the gateway's 30 s?
2. Does `/internal/*` stay on the same hostname once mTLS is required?
