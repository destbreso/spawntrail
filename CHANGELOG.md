# Changelog

## 2.5.1

Documentation. No runtime change: the code is 2.5.0's.

- **"Where the fields end up"**, on the half of the pipeline that starts where
  this package stops: that a logger-level winston format enriches every
  transport including one carrying a format of its own, what reaches CloudWatch
  Logs Insights and Kibana and how to query it there, and which serializations
  drop the fields again.
- **"Beyond logging" covers the records you write yourself**, an audit table or
  an outbox, where `bindings()` being a publish is the wrong read and a named
  `get()` is the right one, plus carrying the correlation id to the next service
  over a header.
- **`trace_id` and `span_id` are OpenTelemetry's names, not ECS's.** The docs
  claimed both conventions agreed, so the one recommendation aimed at Elastic
  readers was the wrong one. The Elastic Common Schema spells them `trace.id`
  and `span.id`, which `otel()` has always been able to emit and now says so. A
  test pins what makes that work: a contributed key is a KEY, so a dot in it
  stays literal instead of nesting.

## 2.5.0

An optional shape. The open bag is right for the first three lines and wrong for
the system that matured around it: once an audit log auto-fills its actor from
the context, that consumer needs to know `actor.companyId` is there and is a
string. This is that, opt in, with the bag still the default.

### Added

- **`SpawnTrail<B>`**, generic over the shape of its context and defaulting to
  today's open bag. `put`, `get`, `del`, `run`, `setDefaults`, the `defaults`
  option and the `express` mapper all check against `B`. `ContextPath<B>`,
  `ValueAt<B, P>`, `WritableAt<B, P>` and `ContextSeed<B>` are exported for
  anyone building on top: reads take `ValueAt`, writes take `WritableAt`,
  because a union of keys is a union on the way out and an intersection on the
  way in.
- **`tsconfig.test.json`**, and `npm run typecheck` now covers `test` and
  `scripts` as well as `src`. `exactOptionalPropertyTypes` is on, since the
  types are the product here.

### How it behaves, and why

- **Declare the interface on its own, not as `extends Bindings`.** Inheriting a
  string index signature turns `keyof` into `string`, so every key type checks
  and every value is `unknown`: the feature is silently off while looking like
  it works. For the same reason `B` is constrained to `object` and not to
  `Bindings`, since an interface without an index signature is not assignable to
  `Record<string, unknown>`.
- **Only top-level keys are typed.** A dot is the only thing separating "a path
  into a value" from "a key I forgot to declare", so anything containing one
  stays open, and a top-level key the shape does not declare is a compile error.
- **The shape comes from the type argument or not at all.** The `defaults`
  option is in a `NoInfer` position, so `new SpawnTrail({ defaults: { service:
  "api" } })` stays an open bag instead of silently inferring a one-key contract
  that then rejects the next `put`.
- **`bindings()` and `snapshot()` are deliberately not typed as the shape.**
  Contributors add keys it never mentioned, a redaction policy replaces a
  declared object with a censor string, and a snapshot arrives off a wire nobody
  validated. Those are the three places an erased parameter would stop being a
  convenience and start being a lie.
- **The parameter is erased, so it is a contract with the compiler, not a
  validator.** A generic library holding the untyped type can still write
  whatever it likes into an application's typed instance, which is interop
  rather than a leak.

### Fixed

- **`winston.format.combine(trail.winston(), ...)` did not compile** in a
  TypeScript project. `WinstonFormatLike.transform` returned
  `Record<string, unknown>`, which is not assignable to winston's
  `TransformableInfo | boolean`, so the example at the top of the README was a
  type error for anyone who tried it. It now takes and returns the record it is
  handed, widened with the keys it adds.
- **A `censor` written inline had an implicitly `any` parameter**, which is an
  error under `noImplicitAny`. `censor?: unknown | Censor` collapses to
  `unknown`, so nothing gave the function a contextual type. The fixed
  alternatives are now spelled out.
- **`unstamp()` and the violation event declared optional properties the code
  sets to `undefined`**, which is a compile error for anyone with
  `exactOptionalPropertyTypes` on, and inaccurate for everyone else.
- **`bind()` could not be called with a real logger.** `ChildLogger` carried
  `[key: string]: unknown`, and neither `winston.Logger` nor `pino.Logger` has a
  string index signature, so both were refused with "Index signature for type
  'string' is missing". The universal fallback was the one integration that did
  not typecheck, from 1.0.0 onward, and this repo's tests hid it by casting.
- **The minimum TypeScript is 5.3 and is now verified.** The first cut of the
  typed context used `NoInfer`, which TypeScript only added in 5.4, and it
  landed in the published declarations: every consumer below that version got
  `TS2304: Cannot find name 'NoInfer'` from inside `node_modules`. It is
  spelled out locally instead. `verify-package` could not have caught this and
  now can: it compiles the consumers a second time on the oldest supported
  compiler with `skipLibCheck` off, which is the only configuration that reads
  the file under test.

Both of those had been shipping for versions, and neither was caught because
`tsconfig.json` excluded `test`, so `tsc` had never once looked at the file that
uses this package the way a consumer does.

## 2.4.1

**Upgrade from 2.4.0 if you use `redact()`.** In 2.4.0 the policy could publish
the value it was installed to hide. Four defects, three of them one cause:
masking rebuilt the spine down to each matched value and carried every unmatched
branch across by reference, over the live store.

### Fixed

- **A back-reference published the raw value one level below its own mask.** The
  partial rebuild left the unmatched branch pointing at the ORIGINAL node, so a
  plain-object graph that refers back to itself (a tree with parent pointers, a
  `.lean()` result with a populated back-reference) put `"[redacted]"` and the
  secret on the same record, on every surface including the wire. Declaring the
  derived path only moved it a level down, since a cycle supplies another and
  "declared paths only" has no fixed point there.
- **A censor was handed the live store node**, so the ordinary way to write one
  for a subtree path, `(v) => { delete v.pan; return v }`, deleted from the
  context itself: `get()` returned `undefined` afterwards and nothing was
  reported. The rule that a bug in a censor costs a masked log line rather than
  a lost value was exactly inverted.
- **The spine copies were not charged to the work budget**, so one declared path
  over a large context turned a bounded one-millisecond log call into eighty
  milliseconds of blocked event loop, growing linearly and unbounded above, to
  emit a three-key line.
- **A path naming something about a container threw out of the log call.**
  `paths: ["items.length"]` is well typed and `hasOwn(array, "length")` is true,
  so the write became `arr.length = "[redacted]"`, a `RangeError` raised inside
  the winston format, the pino mixin and the queue adapter. Whether it fired
  depended on whether a request happened to make the value an array.

### How it behaves now

- **Masking happens on the copy being published**, not on a view over the store,
  and it copies nothing itself. That is what makes a back-reference safe: the
  context keeps `user.account.owner === user` as ONE node, so masking
  `user.email` masks it by every route to it. It is also why a censor may write
  into the value it is handed: it is changing that record and nothing else.
- **A path that names something about a container** rather than a field in it
  matches nothing.
- **It costs a copy, and almost nothing for the matching.** `pino()`,
  `bindings()` and `bind()` were already copying, so ~230 ns becomes ~300 ns on
  a flat context and ~750 ns becomes ~1.0 µs on a request-shaped one. The
  winston format pays more, because without a policy it merges into the record
  without copying the context at all: ~150 ns to ~460 ns, ~690 ns to ~1.6 µs.
  Whether the policy matches is worth 25 to 100 ns, and it can grow without
  moving the number.

## 2.4.0

Redaction. The thing that makes this package useful is also its risk: a field
put in scope once is stamped onto every line for the rest of the request,
including lines written by code that never intended to publish it, and the
fields people naturally put in context are the sensitive ones.

### Added

- **`redact({ paths, censor?, remove? })`**, and the equivalent `redact` option
  on the constructor. `*` matches exactly one segment, an object key or an array
  index. Declared paths only: no detector, no heuristic, because guessing
  produces false negatives that give false comfort and false positives that
  quietly destroy the data somebody is debugging with.
- **`REDACTED`** (`"[redacted]"`), the default censor, and the `RedactOptions`
  and `Censor` types.
- `"redaction-failed"` as a violation reason.

### How it behaves, and why

- **It masks on the way out and never touches the store.** `get("user.email")`
  still returns the email, so application code keeps working and a bug in a
  censor costs a masked log line rather than a lost value. The whole-context
  reads (`bindings()`, `get()` with no argument) are publishes and are masked;
  naming a path is a deliberate read and is not.
- **A queue is a publish**, so `snapshot()` and `stamp()` carry the masked
  value. A broker has its own retention window and its own access list, and a
  token sitting in a topic for a week is the leak rather than a step towards
  one. Leaving it to the consumer would also fail open, since the consumer may
  be a different service with no policy configured.
- **It covers what this package injects, and says so.** A field passed at a
  `logger.info` call site was a decision somebody made at that line, and
  `bind()` cannot see those fields at all, so covering them would mean covering
  a different amount depending on which integration you picked. Contributors
  are covered, because a leak does not care where the value was computed.
- **The policy only grows.** A path already declared keeps the rule it was
  declared with, and a conflicting redeclaration is refused and reported. A
  policy that could be narrowed at runtime is one any later line of code could
  switch off.
- **A censor that throws fails closed**, yielding the default censor rather than
  the value. It is the one place in this package where the safe answer is to
  lose data. A censor that returns `undefined` drops the key.
Superseded by 2.4.1, which is where this behaves as described above. Use that.

## 2.3.0

Context that survives a queue. `AsyncLocalStorage` follows any async
continuation inside one process and stops dead at a serialization boundary, so
a worker picks a job up on a fresh chain with no idea which request caused it.
Nothing else in this category covers that.

### Added

- **`snapshot()`**, **`stamp(payload)`**, **`unstamp(data)`** and
  **`restore(snapshot, boundary, fn)`**. Wired into the one place a payload
  crosses, not into call sites, so a publisher written later gets provenance
  without knowing this exists.
- **`ENVELOPE_KEY`** (`__spawntrail`), exported because it is wire surface
  between a producer and a consumer that may be on different versions of this
  package. Configurable per instance with `envelopeKey`.
- **`jsonSafe(bindings)`**: the projection a snapshot uses, exported for anyone
  who wants the same rule elsewhere.
- `"not-serializable"` as a violation reason.

### How it behaves, and why

- **The correlation id is reused, never minted** when a snapshot carries one.
  One id spans the HTTP call and everything it set in motion; a fresh id per job
  would give every line a context and still leave nothing to join on.
- **No scope at stamp time leaves the payload untouched.** Work that no request
  caused should say so rather than borrow an identity.
- **Restoring without a snapshot still opens a scope**, with a fresh id and the
  boundary named, so system-initiated work correlates with itself while the
  absence of upstream provenance stays visible.
- **Stamping an already-stamped payload is a no-op**, so a handler that
  republishes cannot claim to be the start of the chain.
- **Only what survives JSON travels.** An `Error`, a `Date`, a `Map`, a function
  or a pooled client is dropped and reported; a `BigInt` or a cycle would
  otherwise take the publish call down. A container that became empty because
  everything in it was dropped does not travel either, while one that was empty
  to begin with does.
- **Contributors do not travel.** A process id or a span id describes the side
  that is running, and the consumer computes its own.
- `unstamp()` returns the payload without the envelope, so a handler cannot
  spread it into an entity, a response, or the next event.

## 2.2.0

Ambient values that the context should not own.

### Added

- **`use(contributor)`**: register a function read when a line is written and
  stored nowhere. A contributed value is reported, never stored, so the
  write-once rule does not apply to it, which is the point: a span id is
  different for every span of one request, and a value that cannot be stored
  correctly should not be stored at all. Anything actually in the context wins
  over a contributor, and earlier registrations win over later ones. A
  contributor that throws contributes nothing and is otherwise ignored.
- **`spawntrail/otel`**: a contributor that puts `trace_id` and `span_id` on
  every record, in the snake-case convention log backends auto-detect, with both
  key names configurable and the W3C trace flags available on request. An
  all-zero span context reports nothing, because a trace id of zeros looks like
  a trace you can open and is not one.
  - `@opentelemetry/api` is an **optional** peer dependency and lives behind a
    separate entry point, so the main entry stays dependency-free and a project
    that does not run OpenTelemetry never loads it.

Contributors appear on winston records, pino records, `bind()` children,
`bindings()`, and a `get(path)` the store cannot answer. On a read the store can
answer, no contributor runs.

## 2.1.0

Documentation and one small addition, both aimed at the same thing: the question
every `AsyncLocalStorage` library gets asked first, which is why the context is
empty.

### Added

- `inScope()`: whether a scope is open here. Outside one, `put()` writes a
  process-wide default that every later scope inherits, which is deliberate for
  a service name and almost never what a request handler meant.

### Documentation

- **"When the context is empty"**, with the five causes and their fixes: a
  callback registered outside the scope, a `run()` that was not awaited, work
  that crossed a process boundary, a library re-entering from its own chain, and
  a write that was a process default all along.
- **Fastify and Koa** shown as real adapters rather than a one-line sketch,
  including the `await` inside `run()` that the Koa shape needs.
- **A Sentry `beforeSend` recipe.** `bindings()` is an ordinary read, so every
  `captureException` in the process can carry the identity of the request it
  happened in without a single call site passing it.

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
