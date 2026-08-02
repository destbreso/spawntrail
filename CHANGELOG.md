# Changelog

## 2.0.0

A context is now immutable, and every path that hands one out hands out a copy.
Both change behavior, which is why this is a major.

### Changed, and these will affect you

- **A key that already holds a value keeps it.** `put()` no longer overwrites:
  the first write wins, a later write with a different value is refused, and the
  attempt is reported through `setViolationHandler` with both values. A context
  is the record of one unit of work, and a record whose fields change underneath
  it cannot be read back and believed: two lines from one request would disagree
  about who the actor was and neither would say which to trust.
  - `undefined` is not a value, so `put("userId", req.user?.id)` before
    authentication resolves still leaves room for the real id.
  - Writing the identical value again is not a change and passes quietly, which
    keeps `ensureId()` idempotent.
  - A nested `run()` may seed a different value for a key the parent holds. That
    is a new record rather than an edit to this one, and it is how a retry or a
    phase gets its own context.
  - A value that varies line to line belongs on the line
    (`logger.info({ stage }, "...")`), where a call-site field already wins.
- **`del()` is refused where there is a value to remove**, and **`clear()` is
  refused inside a scope**. Removing and setting again would be the rule above
  with a door in the back of it. Outside any scope, `clear()` still resets the
  process defaults, which is the explicit way to start over.
- **`setDefaults()` follows the same rule**: an existing default keeps its value.
- **`get(path)` returns a copy.** It used to hand back the store's own node, so
  `trail.get("user").role = "admin"` changed the context without going through
  `put()`. `get()` with no path already copied; now both do.
- **Two paths seeded from the same object are independent.** A copy no longer
  preserves the input's internal aliasing, so `run({ req: { user }, user })`
  followed by `put("user.tier", x)` leaves `req.user` alone.
- **`exports` declares types per condition.** A single `"types"` entry matched
  first for both, so a CommonJS TypeScript project could not import the package
  at all (TS1479), even though the correct `dist/index.d.cts` was already being
  shipped.
- `CLONE_NODE_LIMIT` is renamed `CLONE_WORK_LIMIT` and counts what it says.

### Fixed

- **The winston format wrote context into the caller's own objects.** winston
  shallow-copies its metadata, so `logger.info("m", { product })` puts your
  object on the record; the format then descended into it and added context
  fields, permanently. A reused object carried the first request's tenant onto
  every later line. A node this library did not build is now copied before
  anything is merged into it.
- **A sparse array threw `RangeError` out of `run()`, `put()`, `bindings()` and
  both integrations**, and short of throwing it materialised every hole: a
  one-element array indexed at five million came out with five million own
  properties. `byId[rowId] = row` is all it takes to build one. Holes are kept.
- **The copy bound counted objects, not work**, so a two-object context holding
  a three-million-element array passed it untouched and cost a third of a second
  on every scope entry and every log record.
- **A dotted path built from data had no bound at all.** A key of a few million
  segments built a store that deep and exhausted the heap, which no copy bound
  could see because nothing was copied. A path longer than `CLONE_DEPTH_LIMIT`
  is refused.
- **A violation handler that threw escaped `run()`**, undoing the property the
  refusal machinery exists to provide.
- The built-in warning no longer prints an unbounded path, which for an
  `"invalid-path"` notice could be megabytes of console output.

### Added

- `deepMergeKeeping(base, patch)`: the merge with the write-once rule applied.
- `"immutable"` as a violation reason, carrying `current` and `rejected`.
- `verify:package` compiles an ESM and a CommonJS TypeScript consumer against
  the published types, resolving by package name so the `exports` map is
  actually exercised, and runs the refusal probe against both bundles.

### Performance

Scope entry and per-record injection are each about twice 1.0.0 for a context
holding nested objects (roughly a microsecond apiece), and unchanged to slightly
better for a context of flat identifiers. The pino mixin went from free to about
the cost of the winston format, because it returns a copy now. Full table in the
README.

## 1.1.0

**This release fixes a prototype pollution vulnerability in 1.0.0. Upgrade.**

In 1.0.0, `put()` accepted `__proto__` as a dot-path segment, so a path built
from data (a generic mapper over a request body, a header list, a queue payload)
could write to `Object.prototype` and affect every object in the process. Three
further defects came from the same place, and none of them needed an attacker.

### Security

- **Prototype pollution through a dot-path.** `put("__proto__.x", v)` reached
  `Object.prototype`. `__proto__` is now refused as a path segment and as a key
  in any value, and the refusal is observable through `setViolationHandler()`.

### Fixed

- **A `__proto__` key in a seed silently killed the context.** `JSON.parse`
  produces that key as an own property, so seeding a scope from a webhook body or
  a queue payload reassigned the store's prototype, after which every read
  returned nothing for the rest of the scope, with no error.
- **A circular value crashed the scope.** `run({ req })`, `put("err", err)` with
  an axios error, a mongoose document or a pooled client threw a `RangeError`.
  Cycles and repeated references are now handled once each, so a heavily shared
  object graph costs what it is rather than what it can be reached by.
- **`bindings()` returned the live store**, so a caller could write context
  without going through `put()`. It now returns a deep copy. It is a snapshot,
  not a live handle.
- **`put()` stored the caller's object rather than a copy**, so
  `put("user", u)` followed by `put("user.role", "admin")` wrote `role` into the
  application's own `u`.
- **`pino()` returned the live store.** pino's default mixin merge strategy
  assigns the fields of each log call into whatever the mixin returns, so a
  single `log.info({ pan }, "...")` became permanent context, and a line logged
  outside any scope wrote into the process defaults for good. The mixin now
  returns a copy, and so does `bind()`, which hands the object to a third-party
  logger that keeps it.
- **A property that throws when read escaped `run()`.** In the express adapter
  that meant a value only ever meant for a log line failed the request before
  the handler ran. Such a property now becomes `"[spawntrail: unreadable]"`.
- **`del()` followed inherited properties** out of the store, unlike `get()` and
  `put()`, which were own-property gated.
- **A dotted write destroyed an array.** `put("items.0.id", 1)` replaced the
  array with an object. Arrays are now part of the path grammar in all three of
  `get`, `put` and `del`.
- **A non-string path threw** a raw `TypeError` out of the log call instead of
  being refused.
- **A large or deeply nested value could exhaust memory.** Copying is now bounded
  at 32 levels and 10,000 objects per operation, beyond which the remainder is
  replaced by `"[spawntrail: truncated]"`.

### Added

- `setViolationHandler(fn)`: observe every refusal, with
  `reason: "forbidden-key" | "truncated" | "unreadable" | "invalid-path"`.
  Silent by default; outside production, an unobserved refusal prints one warning
  per process.
- `clone`, `isForbiddenKey`, `CLONE_DEPTH_LIMIT`, `CLONE_NODE_LIMIT`,
  `TRUNCATED` and `UNREADABLE` are exported.

### Changed

- **A context holds copies, at every level and on every path.** No object in a
  context is an object a caller also holds. This is what makes scopes isolated,
  makes an emitted record a real snapshot, and keeps a dot-path walk inside the
  context whatever the path says.
- **Only `__proto__` is a reserved key name.** `constructor` and `prototype` are
  ordinary data and are stored and read back unchanged.
- **The store is a plain object**, not a null-prototype one. A null prototype is
  the safer default in the abstract, but the safety here comes from the copy
  rule, and a plain object is what `instanceof`, `hasOwnProperty` and every
  logger's inspector expect from the thing they are handed.
- Scope entry costs roughly twice what it did for a request-shaped context
  (about 1 µs against 0.5 µs), and the pino mixin now costs about 390 ns per
  record rather than being free. Both figures are in the README.

## 1.0.0

First release of **spawntrail**, the successor to `express-session-logger` and
`@one-broker-services/winston-session` (both 2021). It merges their ideas onto a
modern core and supersedes them.

### Core
- `SpawnTrail`: an `AsyncLocalStorage`-backed context engine. Per-scope isolation
  with no global singleton (the flaw of winston-session) and no patch-based CLS
  (cls-hooked / continuation-local-storage, which winston-session depended on but
  never actually used).
- Mapped Diagnostic Context API: `put` / `get` / `del` / `clear` with dot-path
  support, `bindings`, `id` / `ensureId`, `setDefaults`.
- `run(bindings, fn)` opens a scope; nested `run()` calls act as segments (child
  inherits parent, child writes do not leak up).

### Logger integrations (inject at **log time**)
- `winston()` returns a winston format.
- `pino()` returns a pino mixin.
- `bind(logger)` wraps any `.child()` logger as a fallback.
- Context added mid-request is reflected in later logs, unlike childing the logger
  once at request start (the limitation of express-session-logger).

### Framework
- `express(options)`: connect-style middleware that opens a scope per request,
  seeds a correlation id (from a header, a mapper, or generated), and can echo it
  back on a response header.

### Packaging
- TypeScript-first, ships ESM + CJS + type declarations.
- Zero runtime dependencies (uses `node:async_hooks` and `node:crypto`).
- ~6 KB.

### Migration from `express-session-logger`
- `contextMiddleware(opts)` becomes `spawntrail.express(opts)`; the `logger` proxy
  becomes any logger configured with `spawntrail.winston()` / `spawntrail.pino()`, or
  `spawntrail.bind(logger)`.
- The single global logger is gone; context is now correctly isolated per request.
