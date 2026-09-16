# What changed in the dark week

Seven days of the gateway computing limits and enforcing none,
2026-09-08 to 09-15. 31.2 M requests, 1,904 API keys, 212 organisations.

## Would have been refused

| Plan | Requests | Would have got a 429 | Keys affected |
|---|---|---|---|
| Free | 4.1 M | 2.9 % | 41 of 1,388 |
| Team | 26.3 M | 0.06 % | 3 of 502 |
| Enterprise | 0.8 M | 0 % | 0 of 14 |

Of the 41 Free keys, 38 are retry loops with no backoff. The other three
are a CI job, a dashboard that polls every second, and one we could not
identify. The three Team keys all belong to the partner from last Tuesday.

## What the logs changed in the plan

- Burst for Free comes down from 50 to 30. Nobody legitimate used more
  than 22.
- Team's org bucket comes down from 500 to 400 rps. The largest Team
  organisation peaked at 310.
- Writes get a weight of 5. They are 4 % of requests and 70 % of pool time.

## Next

Enforce for the partner on Tuesday. Their limit is set to 120 rps per
key, which is what they asked for and 3× what they use.
