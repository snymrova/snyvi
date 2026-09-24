# Runbook: the pool is timing out

**Page:** `pg_pool_timeout_rate > 0.5% for 5m` · **Severity:** 2

## What you will see

`pool timeout` in the API logs, p99 climbing, and the queue depth on
`/v1/transactions` going up and not coming down. The database itself is
usually fine — check that first so you stop looking at it.

## First three minutes

```
kubectl -n prod get pods -l app=api
kubectl -n prod logs -l app=api --since=5m | grep -c "pool timeout"
psql -c "select count(*), state from pg_stat_activity group by state"
```

If `idle in transaction` is more than a handful, a caller is holding a
connection across an await. That is the bug nine times out of ten.

## What actually fixes it

1. Find the holder: `pg_stat_activity` ordered by `xact_start`.
2. If it is a deploy from the last hour, roll back. Do not debug in prod.
3. If it is not, raise the pool ceiling by 16 and page the owning team.

## What does not fix it

Restarting the API. It clears the symptom for ninety seconds and loses you
the evidence.
