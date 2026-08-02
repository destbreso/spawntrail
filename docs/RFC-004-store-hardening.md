# RFC-004: Store hardening (paths, cycles, and what may live in a context)

**Status**: implemented in 1.1.0 and 2.0.0. Fixes [FINDINGS](./FINDINGS.md) F1, F2, F3 and F4.

Two of the four proposals below were adopted as written (2.1 forbidden segments, 2.4 `bindings()` as a view). Two were not, and the reasons are worth carrying into the next RFC. The 2.3 depth ceiling, implemented literally, kept deep values BY REFERENCE, which broke scope isolation and re-opened the pollution vector eight segments in; the shipped design never shares a container and bounds WORK rather than depth. And 2.2's null-prototype store was rejected in favour of a plain object plus one denylisted key, because the safety comes from the copy rule rather than from the prototype. Section 3's open question (what may live in a context) is settled: non-container values are kept by reference in-process and cannot cross a boundary, which is the projection rule [RFC-001](./RFC-001-boundary-snapshot-restore.md) inherits.

## 1. The pain

A context library is a dependency in every request path of its host, which means two properties matter more than any feature: it must not endanger the host, and it must not crash it. Version 1.0.0 fails both under inputs that ordinary usage produces.

- **`put()` accepts `__proto__` as a path segment**, so a non-literal path pollutes `Object.prototype` process-wide (F1).
- **A `__proto__` key in a seed object reassigns the store's prototype**, after which the context silently reads as empty for the rest of the scope. `JSON.parse` produces exactly that key shape, so a queue payload or webhook body used as a seed is enough (F2).
- **`clone()` has no cycle tracking**, so one circular value (an axios error, a `req`, a mongoose document, a pooled client) turns the next `run()` into a `RangeError` (F3). The values people put in context while debugging are precisely the circular ones.
- **`bindings()` returns the live store**, so any invariant the store gains later can be bypassed by a caller who never calls `put()` (F4).

None of these need an adversary. They need a normal developer having a normal day.

## 2. Proposal

Four changes, none of which alter the public API shape.

### 2.1 Forbidden path segments

`setPath`, `getPath` and `delPath` reject `__proto__`, `prototype` and `constructor` as segments. Rejection means: the operation is a no-op, and (dev-friendly) it emits a one-time warning through a configurable `onViolation` hook, defaulting to nothing in production.

Do not merely guard `isPlainObject` differently; the segment denylist is the property that is easy to state, easy to test, and easy to audit later.

### 2.2 Safe merge

`deepMerge` and any object construction from untrusted keys use a null-prototype accumulator (`Object.create(null)`) internally, or skip the three forbidden keys before assignment. The store's own prototype must be an invariant: after any sequence of `run()`/`put()`/`setDefaults()` calls with arbitrary input, `Object.getPrototypeOf(store)` is still what the library chose.

Decide explicitly whether the store is a plain object or a null-prototype object. Null-prototype is safer and serializes identically through `JSON.stringify`, but breaks code doing `bindings() instanceof Object` or calling `hasOwnProperty` on it directly. Given loggers only enumerate, null-prototype is the better default; the choice belongs in the CHANGELOG either way.

### 2.3 Cycle-safe clone with a depth ceiling

`clone()` carries a `WeakMap` seen-set, so a cycle resolves to the already-cloned reference instead of recursing forever. Add a depth ceiling (suggested 8) beyond which the value is kept by reference rather than copied.

The ceiling matters as much as the cycle fix: a context is meant to hold small correlation values, and deep-cloning a large object graph on every scope entry is a silent performance cliff. The ceiling makes the failure mode "the deep part is shared" instead of "the process stalls".

### 2.4 `bindings()` returns a view, not the store

Return a shallow-frozen object (or a clone; benchmark before choosing) so external mutation cannot bypass `put()`. Internal fast paths (`pino()` mixin, winston format) may keep using the raw store, since they only read.

## 3. Adjacent policy worth deciding at the same time

**What may legitimately live in a context?** Today the answer is "anything", and the three defects above are all downstream of that. The honest answer for a logging context is: values that survive serialization. Non-serializable values (functions, class instances, sockets, streams) are either dropped, kept by reference with a documented "not carried across a boundary" caveat, or rejected loudly.

This decision interacts directly with [RFC-001](./RFC-001-boundary-snapshot-restore.md): a snapshot crossing a process boundary can only carry JSON-safe values, so the boundary needs a projection rule anyway. Deciding it once here, and having RFC-001 inherit it, is cheaper than deciding it twice with two different answers.

Recommended default: keep non-plain values by reference in-process (useful, zero-cost), drop them at snapshot time with a debug-level note. Do not throw. A logging layer that rejects your data is a logging layer people remove.

## 4. Test cases to add (they double as the spec)

- `put("__proto__.x", 1)` does not touch `Object.prototype`, and `get("__proto__.x")` is undefined.
- The same for `constructor` and `prototype` segments.
- `run(JSON.parse('{"__proto__":{"x":1},"ok":2}'), ...)`: `ok` is readable, `x` is not, `put`/`get` still work afterwards, and the store's prototype is unchanged.
- A self-referential value survives `run()`, a nested `run()`, and a log-time injection without throwing.
- An object nested deeper than the ceiling is kept by reference (identity assertion), and everything above it is copied.
- `bindings()` mutation does not change what `get()` returns.
- Regression: a value mutated AFTER a log line was emitted does not retroactively change that line (the property the current cloning exists to provide, which the hardening must not lose).

## 5. Release note

F1 is a security fix and should be released as such: a patch version, a CHANGELOG entry naming prototype pollution explicitly, and (given 1.0.0 is recent and adoption is presumably small) a GitHub advisory is optional but cheap goodwill. Fixing it quietly is the one option that costs credibility later.
