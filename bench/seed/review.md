# Review: `gateway/limit.rs` (PR #142)

Read the whole PR against the plan. Two things to change before merge,
one to think about, and the rest is fine.

## Change before merge

### The bucket can go negative

`take()` subtracts before it checks, so two requests that race on the same
key both see a level above cost and both succeed, and the stored level is
`cost` below zero. The plan's `MULTI` block is what prevents this and it
is not in this PR: the Redis call is a `GET` then a `SET`.

```diff
- let level = r.get(&key).await?;
- if level >= cost { r.set(&key, level - cost).await?; Ok(()) }
+ let (level, _) = r.multi().decrby(&key, cost).pexpire(&key, ttl).exec().await?;
+ if level >= 0 { Ok(()) } else { r.incrby(&key, cost).await?; Err(RetryAfter::from(level)) }
```

Put the refund on the failure path rather than the check on the success
path: one round trip when the answer is yes, two when it is no, and the
no is the rare case.

### `Retry-After` is in milliseconds

`RetryAfter(Duration)` formats as `retry-after: 1500`. The header is
whole seconds (RFC 9110 §10.2.3); every SDK we ship parses it as an
integer and would wait 25 minutes. `wait.ceil()` is already in the plan's
snippet and got lost in the port.

## Think about

The org bucket is keyed on `org_id` from the API key's row, which is one
Postgres read per request on the path we are trying to keep away from
Postgres. The key → org mapping changes about never; cache it in the same
Redis with a day's TTL, or put `org_id` in the key's JWT when we issue it.
Either is a separate PR. Filed as #143.

## Fine

- Lazy refill matches the plan and the test covers the clock going
  backwards, which I did not expect.
- Headers on allowed responses: present, correct, and the reset time is
  absolute rather than relative, which is the right call for clients that
  batch.
- The flag is read once at startup. Fine for now; the rollout plan turns
  it on per partner, which means a restart per partner. Acceptable for
  four partners, not for forty. Note in the plan.
