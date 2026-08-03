# RFC-006: Redaction (keeping secrets out of the lines context writes)

**Status**: shipped in 2.4.0, with three deviations recorded in section 6. General, compliance-driven, and specifically a consequence of what this package makes easy.

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

## 6. What shipped, and where it departs from the above

Sections 1 to 4 shipped as written: a per-instance policy, dot-paths with a single-segment `*`, a `censor` that may be a function, `remove`, redaction at injection with the store left raw, compiled once, failing closed, and no detector of any kind. Three things changed.

**Section 3.5 got the boundary backwards, and the RFC's own section 1 is the argument against it.** The recommendation was that a snapshot carry the raw value so the consuming instance could apply its own policy, "because the consumer knows its own destination". A queue is not a destination that a consumer can decide about later. A broker is a system with its own retention window and its own access list, which is exactly the failure section 1 opens with, and an authorization token sitting in a topic for a week is the leak rather than a step towards one. It also fails open, in a feature whose own rule 3 says fail closed: the consumer may be a different service, on a different version, with no policy configured at all. So `snapshot()` and `stamp()` publish the masked value. The line that makes this comfortable rather than lossy is that what the far side needs in order to DO the work belongs in the payload; the context is what gets logged.

**The policy grows and never narrows, and it can be added to after construction.** Construction-only was implied by rules 2 and 4, and it would have left the shared `trail` singleton, which is how most callers use the package, permanently without a policy. `redact()` therefore exists as a method, and to keep rule 4's guarantee intact it only ever adds: a path already declared keeps the rule it was declared with, and a conflicting redeclaration is refused and reported like any other write to something that already has a value. "When was this switched off" is not a question a compliance review should have to ask.

**The coverage boundary is stated as part of the feature.** The RFC does not say whether a field passed at a `logger.info` call site is subject to the policy. It is not, and the reason is section 4's own principle rather than convenience: `bind()` hands bindings to a logger's `child()` and never sees call-site arguments at all, so a policy that claimed to cover them would cover a different amount depending on which integration a team picked, and a security feature that lies about its coverage is worse than none. What is covered is the store and the contributors from [RFC-005](./RFC-005-otel-correlation.md), which is the part nobody decides per line and therefore the part this package created the exposure for. `pino`'s own `redact` covers the other half, and the README says so in the comparison table.

One implementation note, recorded because the obvious design is wrong and it took four adversarial readers to see it.

The cheap way to build this is to rebuild only the spine down to each matched value and carry every unmatched branch across by reference, so a log line pays for the paths that were declared rather than for the size of the context. That is what shipped first, and it leaked three separate ways. A back-reference in the context (`user.account.owner === user`, an ordinary ORM entity) survived the rebuild still pointing at the ORIGINAL node, so the raw value was published one level below its own mask, on every surface including the wire, and declaring the derived path only moved the leak a level down: a cycle generates infinitely many paths, so "declared paths only" has no fixed point there. The censor was handed the live store node, so the first thing anyone writes for a subtree path, `(v) => { delete v.pan; return v }`, deleted from the context itself and inverted the design rule that a bug in a censor should cost a masked log line rather than a lost value. And those spine copies walked every own key of a node without charging the work budget, so one declared path over a large context turned a bounded one-millisecond log call into eighty milliseconds of blocked event loop, growing linearly and unbounded above, to emit three keys.

What shipped instead masks the copy the caller already pays for, in place, and copies nothing itself. All three go away at once, and it is faster than what it replaces. The reason it is COMPLETE rather than merely better is a property of the store, not of the redaction code: `put()` copies every value independently and `clone()` gives two references to one object two independent copies, so the only aliasing a context can hold is a back-edge to an ancestor, and a back-edge is exactly what `clone()` resolves against the copy being built. One node per node means masking it masks every route to it. The price is that redaction now costs a copy on the one surface that did not already make one, the winston format, which is the trade the section above describes.

There were two ways to get there, and the reviewer who established the mechanism recommended the other one: make the redaction walk itself a redacting deep copy, visiting every own key and resolving a back-reference against the copy being built exactly as `cloneInner` does, then let it REPLACE the caller's copy rather than follow it. That is about two hundred nanoseconds a record cheaper on the three surfaces that already copied, and it was rejected anyway. It means a second deep-copy implementation in a package whose entire defect history is the copy rule being subtle: sparse arrays that densify into millions of own properties, a work budget that has to count properties rather than containers, revoked proxies, getters that throw, a depth ceiling that must not share a node at the bound, `__proto__` as an own key. Every one of those is a bug this package already shipped and fixed once, in `cloneInner`. A second copier is a second place to get all of them wrong, and the first one to drift is the one nobody is looking at. Masking the copy reuses the tested one and costs a walk of the declared paths, which is small enough to measure and not much else.

The reviewer also corrected the claim about what triggers this, and the correction is worth keeping because it narrows the exposure honestly: a `req`/`res` pair, a Mongoose document and an axios error are class instances, which the store keeps by reference and never walks into, so none of them can trigger it. The trigger is a PLAIN-object graph carrying a back-reference: a hand-built entity graph, a tree with parent pointers, a `.lean()` or `.toObject()` result with a populated back-reference.

A fourth defect was independent of that design: a declared path may name something about a container rather than a field in it. `paths: ["items.length"]` is well typed, `hasOwn(array, "length")` is true, and the write became `arr.length = "[redacted]"`, a `RangeError` thrown straight out of the winston format, the pino mixin and the queue adapter. Whether it fired depended on whether a request happened to make the value an array. An array has one kind of field, so anything else declared against it now matches nothing.
