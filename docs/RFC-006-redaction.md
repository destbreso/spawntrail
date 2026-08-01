# RFC-006: Redaction (keeping secrets out of the lines context writes)

**Status**: proposed, not started. General, compliance-driven, and specifically a consequence of what this package makes easy.

## 1. The pain

Ambient context is convenient precisely because it flows everywhere without anyone thinking about it, and that is also the risk: a field put in scope once is stamped onto every log line for the rest of the request, including lines written by code that never intended to publish it. The fields people naturally put in context are the sensitive ones: user email, phone, an authorization header, a session or API token, an account or card identifier, and whatever a `bindings(req)` mapper copied wholesale off a request.

The failure is not hypothetical or exotic. It is the ordinary path: someone seeds context from the request for convenience, logs ship to a third-party backend, and the organization now has PII or credentials in a system with a different retention policy and a different access list than the database it worked so hard to protect. Under GDPR-style regimes that is a reportable class of problem, and it is discovered months later by an auditor rather than by a test.

`pino` ships `redact` for exactly this reason, and its existence there is the proof that the need is general rather than a single team's policy. spawntrail is arguably more exposed than a plain logger, because its whole value proposition is that fields propagate without call sites deciding.

## 2. Proposal

A redaction policy on the instance, applied at injection time.

```ts
const trail = new SpawnTrail({
  redact: {
    paths: ["user.email", "authorization", "*.token"],
    censor: "[redacted]",       // or a function (value, path) => unknown
    remove: false,              // true drops the key instead of masking it
  },
});
```

- **Applied at injection**, so the value stays readable in-process through `get()` (application code may legitimately need the email it put there) while never reaching a log record. This split is the crux of the design: redaction is about what is PUBLISHED, not about what is stored.
- **Paths are dot-paths** with a single wildcard segment (`*`), matching the mental model `put()` already uses. Full glob support is not worth the complexity.
- **`censor` accepts a function** so teams can partially mask (`a***@b.com`, last four digits) instead of erasing, which is what makes redacted logs still useful for debugging and therefore what makes teams keep the policy on.

## 3. Design rules

1. **Redact on the way out, never in the store.** Two reasons: application code keeps working, and a redaction bug then costs a masked log line rather than a lost value.
2. **Compile the path set once**, at construction. Redaction runs on every log line; it cannot be a per-line parse of path strings.
3. **A redaction failure fails CLOSED.** If the policy throws on a value, emit the censor, not the value. This is the one place in the package where the safe default is to lose data.
4. **The policy is per-instance, not global.** Different instances legitimately publish to different destinations with different rules.
5. **It composes with everything downstream.** Contributors ([RFC-005](./RFC-005-otel-correlation.md)) are subject to the same policy, and a snapshot crossing a boundary ([RFC-001](./RFC-001-boundary-snapshot-restore.md)) needs an explicit decision: redact at snapshot time or at the far side's injection? Recommended: snapshot carries the raw value and the consuming instance applies its own policy, because the consumer knows its own destination. Document it either way; a silent mismatch here is a leak.

## 4. What this is not

Not a PII detector or classifier. No heuristics, no scanning for things that look like emails or card numbers. Declared paths only. Guessing produces both false negatives (which give false comfort) and false positives (which quietly destroy debugging data), and a security feature that lies about its coverage is worse than none.

## 5. Sequencing note

Lower priority than [RFC-004](./RFC-004-store-hardening.md) (which fixes live defects) and than [RFC-005](./RFC-005-otel-correlation.md) (which drives adoption), but higher than it looks: redaction is the kind of feature that gates approval in regulated shops. Its absence is a reason a platform team says no, and unlike most features it is one a reviewer checks for by name before reading anything else.
