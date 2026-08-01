# RFC-001: Context across process boundaries (snapshot / restore)

**Status**: proposed, not started. This document is the full context needed to implement it later.

## 1. The gap

spawntrail's context lives in `AsyncLocalStorage`, so it survives any async continuation *inside one process*: awaits, timers, promise chains. It does NOT survive a serialization boundary: a queue job (BullMQ, SQS), a worker process, a webhook you call back into yourself. The consumer runs on a fresh async chain, `als.getStore()` returns `undefined`, and every log line downstream of the boundary loses the requestId and everything else the request had put in scope.

No package in the category solves this today. `cls-rtracer`, `express-http-context` and `nestjs-cls` all stop at the process edge. This is the differentiator row this feature adds to the README comparison table.

## 2. Production evidence (why this is worth building)

This exact problem was hit, measured and solved in a production multi-tenant API (private codebase, author has access) in July 2026:

- The audit log auto-fills `actor` and `requestId` from ALS. Entries written during the HTTP request carried both. Entries written by the SAME action when driven by the post-upload event chain (image resize, AI evaluation, notification email) carried neither. Same code path, same logical operation, different async origin.
- Observed on a live UAT environment 2026-07-31: file-upload audit entries appeared WITH an actor when inline in the request and WITHOUT one when consumed from the domain-events queue.

The fix shipped there as a small job-context module and is the reference implementation for this RFC (see §7). It works and its design rules were validated under load. This RFC is the generalization of that solution into spawntrail.

## 3. The design, proven in the reference implementation

Symmetric, and at the TRANSPORT rather than at call sites:

```
publish side:  payload' = stamp(payload)     // snapshot of current context under a reserved key
consume side:  { snapshot, payload } = unstamp(payload')
               restore(snapshot, descriptor, handler)   // rebuilds the ALS scope, then runs handler
```

Two properties follow, and both are the point:

1. **No call site changes, and none can forget.** Publishers and handlers stay untouched; a new event type gets provenance for free. Instrument the one queue adapter, not the N publishers.
2. **The correlation id is REUSED, never regenerated.** Background work shares the id of the request that caused it, so one id spans the HTTP call AND everything it set in motion. A fresh id per job would give each log line context and still no way to connect them. The causal chain is the value.

## 4. Proposed API

```ts
// Serializable snapshot of the current scope. `undefined` outside any scope.
trail.snapshot(): Snapshot | undefined

// Stamp/strip helpers for object payloads (the envelope pattern).
trail.stamp<T>(payload: T): T
trail.unstamp<T>(data: T): { snapshot?: Snapshot; payload: T }

// Rebuild a scope from a snapshot and run fn inside it.
trail.restore<T>(snapshot: Snapshot | undefined, boundary: BoundaryDescriptor, fn: () => T): T
```

```ts
interface Snapshot {
  bindings: Bindings;        // JSON-safe subset of the captured scope (see rule 6)
  // id travels inside bindings under idKey; no separate field, no drift
}

interface BoundaryDescriptor {
  kind: string;              // "queue" | "cron" | "webhook" | free-form
  name: string;              // "orders/order.created"
}
```

`snapshot()`/`restore()` are the primitives; `stamp()`/`unstamp()` are the convenience pair for the overwhelmingly common case (an object payload traveling through a queue). Adapters for specific queues (a BullMQ wrapper, for instance) can come later or never; the four functions are enough.

## 5. Design rules (each one was learned the hard way; keep them all)

1. **Reuse the id, never mint one across the boundary.** `restore()` must NOT call `ensureId()`-style generation when the snapshot carries an id.
2. **No context at stamp time means payload untouched.** An event published from a cron, boot, or a bare worker has no scope. `stamp()` returns the payload as-is. Nothing is invented: a log line with no actor because no human caused the work is the truth, and a synthetic one makes the trail lie.
3. **Restore without a snapshot still opens a scope**, with a FRESH id and the boundary descriptor as bindings (`{ boundary: "queue", name: "..." }` or similar). System-initiated work has no originating request, but its own log lines should still correlate with each OTHER. The absence of upstream provenance stays visible rather than faked.
4. **The envelope is stripped before the handler runs.** `unstamp()` returns a payload without the reserved key, byte-identical to what was published. A handler must never be able to spread the envelope into an entity, a response, or another event.
5. **First writer wins on re-publish.** A handler running inside a restored scope that publishes again must NOT overwrite the chain's origin with its own intermediate hop. `stamp()` on an already-stamped payload is a no-op.
6. **Snapshot only what serializes.** `Bindings` is `Record<string, unknown>` and may hold class instances, functions, circular refs. The snapshot must be the JSON-safe projection (drop or JSON-clone; decide and document). A snapshot that throws inside a queue serializer is worse than no feature.
7. **Primitives and arrays pass through `stamp()` unchanged.** Only plain-object payloads can carry an envelope.
8. **The reserved key is configurable with a collision-resistant default** (the reference uses `__ctx`; something namespaced like `__spawntrail` may be better for a public package). It must be exported as a constant so tests and adapters can reference it.

## 6. Spec, ready to port

The reference implementation has a 19-case test suite that doubles as the spec. The cases worth porting verbatim (renamed to spawntrail vocabulary):

- stamp: captures id + bindings + origin; passthrough when no scope; passthrough for primitives/arrays; already-stamped keeps ORIGINAL provenance.
- unstamp: payload returned WITHOUT the reserved key; no-op for data without an envelope.
- restore: id and bindings readable again inside; id reused not regenerated (two restores from one snapshot agree); no snapshot still yields a fresh id and NO invented identity; boundary named in the restored scope; survives async work (`await` inside the restored fn).
- ambient keys: values `put()` after the scope opened but before `stamp()` travel across (that mid-request enrichment surviving the hop is half the point).

## 7. Reference implementation

- A private production codebase the author has access to: a `job-context` module exposing `attachJobContext` / `detachJobContext` / `runWithJobContext`, plus its 19-case test suite (the spec in §6 mirrors it).
- Wiring examples there: the Redis event publisher stamps at `enqueue`, the queue worker unstamps and restores around dispatch, and the in-memory publisher deliberately does NOT stamp (same async chain, ALS still live; an envelope there would be risk with no benefit). That last decision generalizes: adapters should stamp only across REAL boundaries.

Differences to respect when generalizing: the reference has a typed, closed context shape (`actor`, `method`, `path`) because it feeds an audit log; spawntrail's is an open `Bindings` bag. The generalization is: snapshot the bindings, keep the id special (rule 1), name the boundary (rule 3), and leave shape contracts to the application.

## 8. Out of scope (deliberately)

- Queue-specific adapters as shipped code (document the wiring pattern instead; two lines per adapter).
- Hop counting, TTLs, size limits on the snapshot. YAGNI until a real payload-size problem shows up; note in docs that bindings travel with every job.
- Cross-service propagation over HTTP headers (W3C traceparent territory; different problem, different tool).
