//! Token buckets for the gateway: one per API key, one per organisation.
//!
//! A request costs one token from each. Both buckets live in Redis and are
//! refilled lazily: the stored value is the level and the time it was last
//! read, and the current level is computed on the way in. Nothing runs on a
//! timer and a key that is never used costs nothing.

use std::time::{Duration, Instant};

use crate::redis::{Conn, Script};
use crate::Plan;

/// How long a client should wait before trying again, in whole seconds,
/// because that is what `Retry-After` carries and what every SDK parses.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RetryAfter(pub u32);

#[derive(Debug, Clone, Copy)]
pub struct Bucket {
    /// Tokens per second.
    pub rate: f64,
    /// The most the bucket holds: how far a quiet client may burst.
    pub burst: u32,
}

impl Bucket {
    pub fn for_plan(plan: Plan) -> (Bucket, Bucket) {
        match plan {
            Plan::Free => (Bucket { rate: 10.0, burst: 30 }, Bucket { rate: 20.0, burst: 30 }),
            Plan::Team => (Bucket { rate: 100.0, burst: 400 }, Bucket { rate: 400.0, burst: 400 }),
            Plan::Enterprise { key, org } => (key, org),
        }
    }

    /// The level now, given the level then. Never above `burst`: a bucket
    /// that has been idle for an hour is full, not owed an hour's tokens.
    pub fn level(&self, then: u32, elapsed: Duration) -> f64 {
        (then as f64 + elapsed.as_secs_f64() * self.rate).min(self.burst as f64)
    }

    /// Take `cost` tokens, or say how long until there would be enough.
    pub fn take(&self, then: u32, updated_at: Instant, now: Instant, cost: u32) -> Result<u32, RetryAfter> {
        let level = self.level(then, now.saturating_duration_since(updated_at));
        if level < cost as f64 {
            let wait = (cost as f64 - level) / self.rate;
            return Err(RetryAfter(wait.ceil() as u32));
        }
        Ok((level - cost as f64) as u32)
    }
}

/// What a request costs. Writes are 4% of requests and 70% of pool time,
/// which is the whole reason the pool times out; anything finer than two
/// weights waits for more logs.
pub fn cost(method: &http::Method) -> u32 {
    if method.is_safe() { 1 } else { 5 }
}

/// One round trip when the answer is yes, two when it is no. The script
/// decrements both buckets and returns both levels; a refund on the failure
/// path is cheaper than a check on the success path, because the no is the
/// rare case.
pub async fn take(conn: &mut Conn, key: &str, org: &str, cost: u32) -> Result<Headers, RetryAfter> {
    static TAKE: Script = Script::new(include_str!("take.lua"));
    let (k, o): (i64, i64) = TAKE.key(key).key(org).arg(cost).invoke_async(conn).await.map_err(fail_open)?;
    if k >= 0 && o >= 0 {
        return Ok(Headers { remaining: k.min(o) as u32, reset: reset_in(k.min(o)) });
    }
    let _ = conn.incr_by(key, cost).await;
    let _ = conn.incr_by(org, cost).await;
    Err(RetryAfter(((-k.min(o)) as f64 / 10.0).ceil().max(1.0) as u32))
}

/// A Redis outage lets everything through and pages the on-call: today's
/// behaviour plus a page. Failing closed would make a cache outage into an
/// API outage, and there have been two of the first this year and none of
/// the second.
fn fail_open(e: crate::redis::Error) -> RetryAfter {
    metrics::counter!("gateway.limit.redis_error").increment(1);
    tracing::error!(error = %e, "rate limiter failing open");
    RetryAfter(0)
}

pub struct Headers {
    pub remaining: u32,
    /// Absolute, not relative: a client that batches wants a time, not a countdown.
    pub reset: std::time::SystemTime,
}

fn reset_in(level: i64) -> std::time::SystemTime {
    std::time::SystemTime::now() + Duration::from_secs(if level > 0 { 0 } else { 1 })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_full_bucket_takes_and_refills() {
        let b = Bucket { rate: 10.0, burst: 30 };
        let t0 = Instant::now();
        assert_eq!(b.take(30, t0, t0, 5), Ok(25));
        assert_eq!(b.take(25, t0, t0 + Duration::from_millis(500), 30), Ok(0));
        assert_eq!(b.take(0, t0, t0, 1), Err(RetryAfter(1)));
    }

    #[test]
    fn the_clock_going_backwards_costs_nothing() {
        let b = Bucket { rate: 10.0, burst: 30 };
        let t0 = Instant::now();
        assert_eq!(b.take(10, t0 + Duration::from_secs(5), t0, 1), Ok(9));
    }
}
