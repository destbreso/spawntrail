# RFC-003: Occurrence sampling (log the 1st, 10th, 100th, then every 1000th)

**Status**: proposed, not started. Scope caveat in §4: this may belong in spawntrail, in a sibling micro-package, or merely in a README recipe. The pain is real either way; the packaging is the open question.

## 1. The pain (real, measured)

A production multi-tenant API (private codebase, author has access; July 2026) runs shadow-mode security checks: every request evaluates tenant-scoping and authorization rules that do not yet enforce, and each would-be violation emits a log line and a Sentry event. A single misconfigured client, retry loop, or load test turns one root cause into tens of thousands of identical emissions per hour. The naive fixes are both wrong:

- Log every occurrence: the logger becomes the bottleneck, Sentry quota burns, and the signal drowns (issue #47,203 of the same line tells you nothing #1 did not).
- Log only the first: you lose the MAGNITUDE. "Happened once at 09:14" and "happening 40 times/second since 09:14" are different incidents, and only the counter knows which one you have.

The pattern that shipped there and worked: per-key counters with logarithmic-ish sampling. Emit occurrence 1, 10, 100, then every 1000th, each emission carrying the running count. First occurrence alerts fast, the count keeps magnitude visible, and volume is bounded no matter how hot the key gets.

## 2. Proposal

A tiny, logger-agnostic guard, keyed by an arbitrary string:

```ts
const meter = new OccurrenceMeter();          // or trail.meter(), see §4

const n = meter.count("tenant-scope:assets.unscoped-read");
if (meter.sampled(n)) {
  logger.warn("unscoped read detected", { occurrence: n });
}
```

API surface, deliberately minimal:

```ts
class OccurrenceMeter {
  count(key: string): number;              // increment and return the total for key
  sampled(n: number): boolean;             // default policy: n is 1, 10, 100, or n % 1000 === 0
  peek(key: string): number;               // read without incrementing
  reset(key?: string): void;               // one key, or all
}
```

- The policy is a pure function of the count, so it is testable without time and deterministic under resume/replay.
- `count()` and `sampled()` are separate on purpose: the caller always gets the number (to include in the line it DOES emit, or to feed a metric), and decides what "emit" means (a log, a Sentry event, a metric increment).
- Counters are per-process and in-memory. That is the honest scope: after a restart the 1st occurrence logs again, which is fine (arguably good) for the target use case.

## 3. Design rules

1. **Never sample the first occurrence.** Occurrence 1 is the alert; everything else is magnitude maintenance.
2. **The emitted line must carry the count.** A sampled line without `occurrence: n` recreates the "lost magnitude" problem with extra steps.
3. **Keys name the CHECK, not the instance.** `"tenant-scope:assets.unscoped-read"` aggregates; a key containing a userId or document id fragments the counter into a cardinality bomb and defeats sampling. Document this rule prominently; it is the mistake everyone makes first. (Same lesson as Sentry fingerprints.)
4. **Bounded memory.** A `Map<string, number>` grows with key cardinality. Given rule 3 cardinality is small, but a defensive cap (e.g. LRU beyond N keys, or just documenting the assumption) should be decided explicitly.
5. **No timers, no TTLs.** Time-window rate limiting is a different tool with different failure modes. Count-based sampling is deterministic, dependency-free and test-friendly. Resist the feature creep.

## 4. Does it belong in spawntrail?

Arguments for: it is zero-dep, logger-agnostic observability plumbing, the same audience, and pairs naturally with context (`trail.meter()` keyed under the current scope would be a nice ergonomic). Arguments against: spawntrail's wedge statement is "the context layer that feeds your logger", and this is emission POLICY, not context; scope discipline is what keeps small packages trustworthy.

Recommendation: implement it as a standalone module inside the repo first (`spawntrail/sampling` subpath export, zero coupling to SpawnTrail). If it grows users, splitting it out later into its own package is trivial precisely because it will not touch the core. Do not entangle it with ALS.

## 5. Reference

The proven version: a `countOccurrence(key)` / `isSampledOccurrence(count)` pair in the same private codebase referenced by RFC-001, running in production shadow mode inside its security-signal emitter. The 1/10/100/every-1000th policy and the key-names-the-check rule come from there.
