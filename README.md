# spawntrail

[![npm version](https://img.shields.io/npm/v/spawntrail.svg)](https://www.npmjs.com/package/spawntrail)
[![minzipped size](https://img.shields.io/bundlephobia/minzip/spawntrail)](https://bundlephobia.com/package/spawntrail)
[![types included](https://img.shields.io/npm/types/spawntrail.svg)](https://www.npmjs.com/package/spawntrail)
[![zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](https://www.npmjs.com/package/spawntrail?activeTab=dependencies)
[![license](https://img.shields.io/npm/l/spawntrail.svg)](./LICENSE)

> Attach request-scoped context to every log line, automatically. Built on `AsyncLocalStorage`, works with any logger (winston, pino) and any framework (express, fastify, koa). Zero dependencies, TypeScript-first.

---

## What this is

A server handles many requests at the same time, and its log file interleaves all of them. When one customer reports that their payment failed at 14:02, you have a few thousand lines written by a hundred different requests and no way to pick out the twelve that belong to theirs.

The fix everyone reaches for is to stamp an identifier on every line: a request id, the user, the tenant, the route. The hard part is not deciding to do it, it is getting those values to the place where the line is written. The id is known at the edge, in the middleware that read the header. The line is written forty stack frames deeper, in a pricing helper or a retry wrapper or a database module that has never heard of `req` and should not have to. So the id becomes an extra parameter on every function between those two points, or a preconfigured logger object threaded along the same path, and one function that forgets to pass it along cuts the trail for everything below it.

There is a well-known kind of tool for exactly this, and it has a name: **Mapped Diagnostic Context** (MDC), the pattern Java's Log4j and SLF4J have had for years. The idea is a per-unit-of-work bag of key/value pairs that the logging layer merges into every record, so the code that writes a line never has to know what is in the bag. Node has the primitive to do the same thing without patching anything: `AsyncLocalStorage`. A value stored inside a callback stays visible to everything that callback goes on to do, across `await`s, timers and nested callbacks, and stays invisible to the other requests running concurrently in the same process.

spawntrail is that bag plus the wiring into your logger, and nothing else:

```ts
import { trail } from "spawntrail";

app.use(trail.express({ idHeader: "x-request-id" })); // one scope per request

// ...forty stack frames deep, in code that has never heard of "req":
logger.info("charge captured"); // -> { requestId: "…", userId: 42, message: "charge captured" }
```

Two decisions shape everything below. The context is injected **at log time**, through the logger's own hook (a winston format, a pino mixin), rather than by handing you a wrapped logger to carry around: whatever is in the bag at the instant a line is written lands on that line, so a `userId` that authentication adds after the request started shows up in lines written by code that was already running. And this is not a logger. It is the context layer that feeds the logger you already have, so your call sites, transports and formats stay as they are.

---

## Install

```bash
npm install spawntrail
```

Node >= 16. No runtime dependencies: it uses `node:async_hooks` and `node:crypto`. `winston`, `pino` and `express` are yours to bring, and spawntrail does not depend on any of them; each is reached through a small structural interface (`{ transform(info) }`, a mixin function, `{ headers }`), so nothing is pinned to a version of theirs.

---

## Quick start

The context lives in a `SpawnTrail`. The exported `trail` (aliased `spawntrail`) is a shared instance; use `new SpawnTrail()` for an isolated one. The context is injected into your logs **at log time**, through each logger's own hook, so a value you add in the middle of a request still shows up in later lines.

### With winston

```ts
import winston from "winston";
import { trail } from "spawntrail";

const logger = winston.createLogger({
  format: winston.format.combine(trail.winston(), winston.format.json()),
  transports: [new winston.transports.Console()],
});

app.use(trail.express({ idHeader: "x-request-id" }));
app.use((req, res, next) => { trail.put("userId", req.user?.id); next(); });

logger.info("hello"); // { requestId, userId, message: "hello", level: "info" }
```

The ordering there is the point: the scope opens at the edge, before authentication has run, and `userId` joins it a middleware later. Injection at log time is what puts both fields on the same line.

### With pino

```ts
import pino from "pino";
import { trail } from "spawntrail";

const logger = pino({ mixin: trail.pino() });

app.use(trail.express());
logger.info("hello"); // carries the current context
```

### Any framework, and any unit of work

There is one express adapter because express middleware has a shape worth
adapting to. Everything else is `run()`, which is four lines wherever you put
them.

```ts
import { trail } from "spawntrail";

// Fastify
fastify.addHook("onRequest", (req, reply, done) => {
  trail.run({ route: req.routeOptions?.url }, () => {
    reply.header("x-request-id", trail.ensureId(req.headers["x-request-id"] as string));
    done();
  });
});

// Koa
app.use(async (ctx, next) => {
  await trail.run({ route: ctx.path }, async () => {
    ctx.set("x-request-id", trail.ensureId(ctx.get("x-request-id")));
    await next();
  });
});

// A queue job, a cron tick, a script: the same guarantee, no HTTP involved
await trail.run({ jobId, attempt }, async () => {
  await handle();
});
```

Note the `await` inside `run()` in the Koa hook. `run()` returns whatever its
callback returns, and forgetting to await it is the most common way to end up
with an empty context downstream.

### Any other logger (`.child()` fallback)

For a logger without a format/mixin hook, `bind()` wraps anything with a `.child()` method (bunyan, roarr, ...):

```ts
export const log = trail.bind(baseLogger);
log.info("carries context"); // a child with the live context is used per call
```

### Trace ids, and anything else ambient

Some values are ambient but are not the context's to own: a trace id changes per
span inside one request, a process id never changes at all, and neither is
something a request handler should be writing. `use()` registers a function that
is read when a line is written and stored nowhere.

```ts
import { trail } from "spawntrail";
import { otel } from "spawntrail/otel";

trail.use(otel());                                   // trace_id + span_id on every line
trail.use(() => ({ pid: process.pid, build: SHA })); // anything else ambient
```

Nothing else changes: `winston()`, `pino()` and `bind()` already inject whatever
the context reports. `trace_id` and `span_id` are snake case by default because
that is the OpenTelemetry and ECS convention every log backend auto-detects, and
both key names are configurable.

`spawntrail/otel` is a separate entry point and `@opentelemetry/api` is an
optional peer, so the main entry stays dependency-free and a project that does
not run OpenTelemetry never loads it.

Two rules. **A contributed value is reported, never stored,** so the write-once
rule does not apply to it: that is exactly why a span id belongs here and not in
`put()`. And **anything actually in the context wins**, with earlier
registrations ahead of later ones. A contributor that throws contributes nothing
and is otherwise ignored, because a log call is the wrong place to find out that
a telemetry SDK is unhappy.

### Across a queue

`AsyncLocalStorage` follows any async continuation inside one process and stops
dead at a serialization boundary. The worker picks the job up on a fresh chain,
and every line it writes has lost the request that caused it: the audit entry
says an image was resized and cannot say for whom, even though the same code
path inline in the request says exactly that.

Four functions, wired into the ONE place a payload crosses:

```ts
// publisher side, in the queue adapter
queue.add(trail.stamp(event));

// consumer side, in the worker
const { snapshot, payload } = trail.unstamp(job.data);
await trail.restore(snapshot, { kind: "queue", name: job.name }, () => handle(payload));
```

That is the whole wiring, and it goes at the transport rather than at call
sites, so a publisher written next year gets provenance without knowing this
exists. A call site that has to remember is a call site that will forget.

**The correlation id is reused, never minted.** One id spans the HTTP call and
everything it set in motion. A fresh id per job would give every line a context
and still leave nothing to join on, and the causal chain is the point.

Four more rules, each of which exists because the alternative lies:

- **No scope at stamp time means the payload is untouched.** A cron tick has no
  originating request, and a log line with no actor because no human caused the
  work is the truth. A synthetic one is not.
- **Restoring without a snapshot still opens a scope**, with a fresh id and the
  boundary named, so system-initiated work correlates with itself while the
  absence of upstream provenance stays visible.
- **A handler that republishes keeps the origin.** Stamping an already-stamped
  payload is a no-op, so an intermediate hop cannot claim to be the start of the
  chain.
- **Only what survives JSON travels.** The context may hold an `Error`, a
  `Date` or a pooled client; none of them arrives as itself, and a `BigInt` or a
  cycle takes the publish call down with it. The snapshot is the JSON-safe
  projection, and every drop is reported with reason `"not-serializable"`.

The envelope rides under `ENVELOPE_KEY` (`__spawntrail`), which is exported
because it is wire surface between a producer and a consumer that may be on
different versions. `unstamp()` strips it, so a handler receives the payload
exactly as published and cannot spread the envelope into an entity or the next
event.

Contributors do not travel: a process id or a span id describes the side that is
running, and the consumer computes its own.

### Keeping secrets off the line

The thing that makes this package useful is also its risk. A field put in scope
once is stamped onto every line for the rest of the request, including lines
written by code that never intended to publish it, and the fields people
naturally put in context are the sensitive ones: an email, an authorization
header, a session token, whatever a `bindings(req)` mapper copied wholesale off
a request. Logs then ship to a backend with a different retention window and a
different access list than the database the same data is so carefully protected
in.

Declare the paths that never get published:

```ts
trail.redact({ paths: ["authorization", "*.token"], remove: true });
trail.redact({
  paths: ["user.email"],
  censor: (value) => String(value).replace(/^[^@]+/, "***"),
});
```

`*` matches exactly one segment, an object key or an array index, so `*.token`
covers `session.token` and `client.token`, and `cards.*.pan` covers every
element of a list. There is no recursive wildcard: a policy you can read off the
page is a policy a reviewer can approve. Declared paths only, with no detector
and no heuristic, because guessing produces false negatives that give false
comfort and false positives that quietly destroy the data somebody is debugging
with.

Four things worth knowing before you rely on it:

- **It masks on the way out and never touches the store.** `get("user.email")`
  still returns the email, so application code keeps working and a bug in a
  censor costs a masked log line rather than a lost value. The whole-context
  reads (`bindings()`, `get()` with no argument) are publishes and are masked;
  naming a path is a deliberate read and is not.
- **A queue is a publish.** `snapshot()` and `stamp()` carry the masked value,
  because a broker is a system with its own retention and its own access list,
  and a token sitting in a topic for a week is the leak rather than a step
  towards one. What the far side needs to DO its work belongs in the payload;
  the context is what gets logged.
- **It covers what this package injects, and says so.** A field the call site
  passed to `logger.info` was a decision somebody made at that line, and
  `bind()` cannot see those fields at all, so claiming to cover them would mean
  covering a different amount depending on which integration you picked. Use
  `pino`'s own `redact` for call sites. What this covers is the part nobody
  decides per line, which is the part this package created the exposure for.
- **The policy only grows.** Calling `redact()` again adds paths; a path already
  declared keeps the rule it was declared with, and a conflicting redeclaration
  is refused and reported. A policy that could be narrowed at runtime is one any
  later line of code could switch off, and "when was this turned off" is not a
  question a compliance review should have to ask of a log pipeline.

A censor that throws yields the default `"[redacted]"` and reports
`reason: "redaction-failed"`. It is the one place in this package where the safe
answer is to lose data. A censor receives a value out of the copy being
published, so `(v) => { delete v.pan; return v }` is a fine way to write one:
it changes that record and nothing else. Contributors are subject to the same
policy, and the policy is per instance, because two instances legitimately
publish to two different places.

Masking happens on the copy rather than on a view over the store, which is what
makes a back-reference safe. `user.account.owner === user` is an ordinary shape
for a plain-object graph (a `.lean()` result with a populated back-reference, a
tree with parent pointers), and the context keeps it, so masking `user.email`
masks it at `user.account.owner.email` too: there is one node, and it carries
the mask by every route. A path that names something about a container rather
than a field in it, `items.length` on an array, matches nothing.

### Beyond logging

`bindings()` is an ordinary read, so anything ambient can use it. The highest
value use found in production is not a log line at all: enriching error reports
centrally instead of at every capture site.

```ts
Sentry.init({
  beforeSend(event) {
    const ctx = trail.bindings();
    event.tags = { ...event.tags, requestId: ctx.requestId as string };
    event.user = { ...(event.user ?? {}), ...(ctx.actor as object) };
    return event;
  },
});
```

Every `captureException` anywhere in the process now carries the identity of the
request it happened in, and no call site had to pass it. The same shape works
for a metrics tagger, an audit log that auto-fills its actor, or anything else
that wants to know which unit of work it is inside.

`bindings()` is a publish, so a redaction policy applies to it. That is the
right answer here: an error tracker is exactly the kind of third-party
destination the policy exists for.

---

## When the context is empty

This is the one problem worth documenting in advance, because it is the number
one support question for every library built on `AsyncLocalStorage` and the
causes are always the same handful. `trail.inScope()` tells you which side of the
line you are on.

**The callback was registered outside the scope.** An `EventEmitter` listener, a
`setInterval`, a connection pool or client constructed at module load: whatever
was created before the scope opened runs on its own async chain and inherits
nothing. Move the registration inside `run()`, or capture what you need and
reopen a scope in the handler with `run({ requestId }, fn)`.

**`run()` was not awaited.** `trail.run(async () => ...)` returns a promise. If
the caller does not await it, the scope closes while the work is still going and
everything after the first await writes to nothing.

**The work crossed a process boundary.** A queue job, a worker thread, an HTTP
call back into yourself. `AsyncLocalStorage` is per process, so the scope does
not follow. See "Across a queue" for the four functions that carry it.

**A library re-entered from its own chain.** Some clients dispatch callbacks from
a connection or a pool created at startup rather than from your call. Same fix as
the first case.

**It was never a scope, it was a default.** `put()` outside any scope writes a
process-wide default rather than failing, which is intentional for a service
name and confusing for anything else. `inScope()` is the check, and in a request
path a `false` there is almost always the bug.

---

## Where this earns its place

The shape to look for is always the same: **one unit of work, many async frames, and log lines written by code that has no idea which unit it is serving.** If your logs already carry the identifiers you need without any plumbing, you do not need this. If they carry them because forty functions take a `requestId` parameter, this is what removes the parameter.

**An HTTP API that has to answer "show me everything that happened in this request".** `express()` opens one scope per request and seeds the correlation id, either generated or read from an incoming header, so an id minted by a gateway or a client survives into your logs instead of being replaced by a second one. `setResponseHeader` echoes the resolved id back, which means a support ticket can quote the id and you can select on it.

**Queue consumers, cron ticks and scripts.** Nothing here is HTTP. `run({ jobId }, fn)` gives a background worker the same guarantee an express request gets, and nested `run()` calls act as segments, so a retry can open a child scope with its own `attempt` while the parent stays clean.

**Multi-tenant services, where the tenant belongs on every line and must never be the wrong one.** The isolation is the whole reason to use `AsyncLocalStorage` rather than a module-level variable, and it is what the test suite exercises hardest: fifty scopes deliberately interleaved on the event loop, each one asserting it sees only its own values.

**Identity that arrives after the scope opened.** Auth resolves partway through, feature flags resolve later still, and the interesting log lines are written after that. Because the merge happens per record, values added mid-request appear from that point on, with no logger to re-create and re-thread.

**A codebase with more than one logger, or one it might replace.** winston in the API, pino in the worker, one context API across both. Swapping logger later is a change to one format or mixin, not to your call sites, because the call sites never mentioned the context in the first place.

**Observability that is not logging.** `bindings()` is a plain read of the current context, so anything ambient can use it: enrich error reports centrally in a Sentry `beforeSend` with the correlation id and the user, instead of passing them at every capture site.

**Modules you want to keep free of request plumbing.** A pricing function, a repository, a retry wrapper: none of them should take a logger or an id to be observable. Under this layer they call `logger.info` and the line comes out correlated.

---

## What a context is, and the two rules about it

A context is the ambient record of one unit of work: the handful of values that say WHICH request, job or tick a log line belongs to. Everything else about the design follows from taking that literally.

### A value that is set, stays

**A key that already holds a value keeps it.** The first write wins, a later write with a different value is refused, and the attempt is reported. This is what makes a context worth reading back: without it, two lines from the same request can disagree about who the actor was, and nothing in either line says which one to believe.

```ts
trail.put("actor", "alice");
trail.put("actor", "bob");     // refused, reported
trail.get("actor");            // "alice", on this line and on every other one
```

Three things that rule deliberately does not do:

- **`undefined` is not a value.** `put("userId", req.user?.id)` before authentication resolves sets nothing, so the real id still lands when it arrives. That is the whole point of injecting at log time, and the rule does not get to break it.
- **A nested scope is a new record, not an edit to this one.** `run({ attempt: 2 }, fn)` seeds a different value for a key the parent holds, the parent is untouched, and the child is free to say something different. This is how a retry or a phase gets its own context.
- **Writing the identical value again is not a change** and passes quietly, which is why `ensureId()` stays idempotent.

A value that genuinely varies line to line is not identity and does not belong here. Put it on the line, `logger.info({ stage }, "charging")`, where a call-site field already wins over the ambient one. `del()` and `clear()` inside a scope are refused for the same reason a second `put()` is: deleting and setting again would be this rule with a door in the back of it. Outside any scope, `clear()` is the one explicit reset, for tests and for reconfiguration.

Observe refusals with `setViolationHandler((e) => ...)`, which reports `reason: "immutable"` along with the value that stayed and the one that was turned away. A refusal is never silent to a listener, and it is never fatal.

### No container in a context is one you also hold

Values are copied on the way in and on the way out, at every level, on every path: `run()`, `put()`, `setDefaults()`, `bindings()`, `get()`, the winston format, the pino mixin and `bind()`. That rule is what makes the rest true. Two scopes cannot share a node, so a write in one request can never appear in another. A dot-path walk only ever steps into objects this library built, so `put()` cannot arrive somewhere that is not your context, whatever the path says. And two paths seeded from the same object stay independent, so `put("user.tier", x)` does not also write `req.user.tier`.

**The exception, stated plainly rather than in the small print: values that are not plain objects or arrays are kept BY REFERENCE.** An `Error`, a `Date`, a `Map`, a class instance, a socket. Copying those would either fail or hand back something that is not the thing you logged. So `put("err", err)` does store your `Error`, and mutating `err.details` afterwards is visible through the context. What the rule buys is that this is the only way it can happen, that it cannot happen by accident through a plain object, and that nothing reached this way is ever walked into.

A circular value is fine, and so is an object graph a caller reaches many ways.

### `__proto__` is the one reserved key name

Refused as a path segment and as a key in any value, because assigning it reassigns a prototype instead of storing data, and `JSON.parse` produces it as an ordinary own key. Every other name, `constructor` and `prototype` included, is ordinary data.

### Copying is bounded by work, not by hope

A copy visits at most `CLONE_WORK_LIMIT` (10,000) properties and array elements and descends at most `CLONE_DEPTH_LIMIT` (32) levels, after which the rest becomes `"[spawntrail: truncated]"` and the handler is notified. A dotted path longer than the depth limit is refused outright. A property that throws when read becomes `"[spawntrail: unreadable]"` rather than an exception out of your log call. Counting work rather than objects is the difference between a bound and a slogan: a two-object context whose second object is a three-million-element array is two objects and a third of a second, paid again on every scope and every record.

---

## What it costs

Node 22, one machine, one run, against two contexts: four flat identifiers, and a request-shaped one (`{ req: { id, headers, user: { id, org } } }`). The second column is the one to plan around if you keep nested objects in context.

| | flat | request-shaped |
|---|---|---|
| `run()`, scope entry | ~270 ns | ~1.1 µs |
| `get("requestId")` | ~44 ns | ~41 ns |
| `put()`, new key | ~450 ns | ~450 ns |
| winston format, per record | ~160 ns | ~940 ns |
| pino mixin, per record | ~230 ns | ~1.1 µs |
| `bindings()` | ~250 ns | ~1.1 µs |

**Opening a scope copies the context.** `run()` deep-merges its seed over the parent bindings and stores the result, which is what makes a child's writes invisible to its parent. The cost tracks the size of the context you keep, so a context of a few identifiers is nothing and a context holding a request object is not. This is the number worth watching, because it is paid once per request plus once per nested segment.

**Injection is a copy per log record**, on both integrations. The winston format merges the context into the record only where the record has no value already, so a field set at the call site wins over the ambient one. The pino mixin returns a copy rather than the store, which is what stops pino's default merge strategy (`Object.assign` into whatever the mixin returned) from turning the fields of one log call into permanent context. Roughly a microsecond per line on a nested context, against the two to three a logger already spends serializing it.

**A redaction policy costs a copy, and almost nothing for the matching.** Masking happens on a copy of the context rather than on a view over the store, so the price is paid by whichever surface was not already making one. `pino()`, `bindings()` and `bind()` were already copying, so they go from ~230 ns to ~300 ns flat and from ~750 ns to ~1.0 µs request-shaped. The winston format pays more, because without a policy it merges into the record without copying the context at all: ~150 ns to ~460 ns flat, ~690 ns to ~1.6 µs request-shaped. Whether the policy actually matches is worth about 25 ns flat and 100 ns request-shaped, and the policy can grow without moving the number, because the walk visits only declared paths. `get()` on a named path is unaffected, since nothing is redacted there.

The earlier design masked a view over the live store instead and was genuinely cheaper, which is the only argument in its favor. It also republished a back-reference pointing at the unmasked original, handed a censor the store's own node, and escaped the work budget. Correctness at a microsecond beats that.

**`bind()` is the expensive path, on purpose.** The proxy calls the wrapped logger's `child()` on every property access, so `log.info(...)` in a loop allocates a child per call, and the real cost depends on how heavy that logger's `child()` is. Prefer `winston()` or `pino()` where they exist; `bind()` buys universality with allocations.

Two behaviors are worth knowing before they surprise you. `put()` called outside any scope writes to the same process-wide bindings `setDefaults()` fills, so the value is visible in every scope opened afterwards; that is intentional for configuration like a service name, and easy to trigger by accident from a call site you thought was inside a request. And `bindings()` is a snapshot, not a live handle: something that grabs it at scope start and reads it later sees the context as it was.

---

## When not to use this

Context propagation in Node is a crowded space, and most tools solve one slice of it. Pick the row that matches what you actually want:

| You want… | Reach for |
|-----------|-----------|
| Just a request id woven into logs | [`cls-rtracer`](https://github.com/puzpuzpuz/cls-rtracer) |
| Get/set request-scoped values, no logger binding | [`express-http-context`](https://github.com/skonves/express-http-context) |
| CLS with a rich API, inside NestJS | [`nestjs-cls`](https://github.com/Papooch/nestjs-cls) |
| To log the request/response themselves | [`express-winston`](https://github.com/bithavoc/express-winston), [`morgan`](https://github.com/expressjs/morgan), [`pino-http`](https://github.com/pinojs/pino-http) |
| Pino, and you will wire the context yourself | `pino` + `AsyncLocalStorage` |
| Redaction of the fields your own call sites pass | [`pino`](https://getpino.io)'s `redact` (spawntrail masks what IT injects, not your call sites) |
| Context to survive a queue or a worker process | **spawntrail** (nothing else in this list does) |
| **MDC (`put`/`get`) auto-injected into winston _or_ pino, framework-agnostic, at log time, zero-dep** | **spawntrail** |

**A correlation id is all you need.** Then most of this API is weight you will not use, and `cls-rtracer` is the smaller answer.

**You want the access log itself.** spawntrail never sees your response: it does not time requests, read status codes or emit a line per request. `pino-http`, `express-winston` and `morgan` do exactly that, and they compose fine with this on top.

**You are all-in on NestJS.** `nestjs-cls` is more idiomatic there, with the module and injection story the framework expects.

**Your context is a typed contract, not a bag.** `Bindings` is `Record<string, unknown>` and `get()` returns `unknown`, so nothing checks at compile time that the field an audit log or an error reporter depends on is actually there. If those consumers need to fail closed on a missing field, a hand-rolled typed store gives you a guarantee this does not.

**You are not on Node.** This needs `node:async_hooks`. It is a server-side tool, not something to ship to a browser.

What is left, and what this package is for: real MDC semantics over your own logs, on the logger you already chose, injected at the moment each line is written, with nothing pinned to a framework and nothing added to your dependency tree.

---

## API

```ts
const scope = new SpawnTrail({ idKey?, idFactory?, defaults?, envelopeKey?, redact? });

// context
scope.run(bindings, fn)   // open a scope (seeded, merged over parent/defaults); returns fn()
scope.put(path, value)    // set a dot-path ("user.id"); a key that has a value keeps it
scope.get(path?)          // read the whole context, or one dot-path
scope.del(path)           // remove a dot-path (refused where there is a value to remove)
scope.clear()             // reset the process defaults (refused inside a scope)
scope.bindings()          // a copy of the full merged context
scope.id() / ensureId(x)  // read / seed the correlation id
scope.inScope()           // is a scope open here? (see "When the context is empty")
scope.use(fn)             // register an ambient source read per record, never stored
scope.redact(policy)      // declare paths never published; grow-only, never touches the store

// crossing a process boundary
scope.snapshot()          // serializable capture of this scope, or undefined outside one
scope.stamp(payload)      // attach it to an object payload (no-op without a scope)
scope.unstamp(data)       // { snapshot, payload }, with the envelope stripped
scope.restore(snap, b, fn) // reopen the scope on the other side; reuses the id
scope.setDefaults(obj)    // process-wide bindings present in every scope

// logger integrations (inject at log time)
scope.winston()           // a winston format
scope.pino()              // a pino mixin
scope.bind(logger)        // wrap any .child() logger (fallback)

// framework
scope.express(options)    // express/connect middleware

// observing refusals
setViolationHandler(fn)   // called with { reason, key?, path?, current?, rejected? } on every refusal
                          // reason: "forbidden-key" | "truncated" | "unreadable" | "invalid-path"
                          //       | "immutable" | "not-serializable" | "redaction-failed"
```

Nested `run()` calls act as **segments**: a child scope inherits the parent context and its own writes do not leak back up.

---

## Lineage

spawntrail is the successor to two of my 2021 experiments in contextual logging, and it exists because each taught the next one something:

- **`@one-broker-services/winston-session`** (Feb 2021) introduced the MDC idea for winston but stored context in a **singleton**, so concurrent requests bled into each other. It was safe only for one-context-per-process (serverless).
- **`express-session-logger`** (Jun 2021) fixed isolation with `AsyncLocalStorage` and became logger-agnostic, but stayed a minimal WIP and childed the logger once at request start, losing mid-request context.

spawntrail merges the good ideas from both onto a modern, tested, zero-dependency core, and injects context at log time. **`express-session-logger` is deprecated in favor of spawntrail.** The full story, problems and fixes and all, is written up as a series (linked from the package page).

---

## License

MIT © David Estevez
