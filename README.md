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

### Any framework (manual scope)

```ts
import { trail } from "spawntrail";

// fastify
fastify.addHook("onRequest", (req, reply, done) => trail.run(() => { trail.ensureId(); done(); }));

// or wrap any unit of work: a queue job, a cron tick, a script
await trail.run({ jobId }, async () => {
  trail.put("attempt", 1);
  await handle();
});
```

### Any other logger (`.child()` fallback)

For a logger without a format/mixin hook, `bind()` wraps anything with a `.child()` method (bunyan, roarr, ...):

```ts
export const log = trail.bind(baseLogger);
log.info("carries context"); // a child with the live context is used per call
```

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

## What it costs

**Opening a scope copies the context.** `run()` deep-merges its seed over the parent bindings and stores the result, which is what makes a child's writes invisible to its parent. The cost tracks the size of the context you keep, so a context of a few identifiers is nothing, and a context holding a large object is copied on every nested scope.

**Injection is a merge per log record.** The winston format merges the context into the record only where the record has no value already, so a field set at the call site wins over the ambient one, and it copies each value as it goes rather than sharing it: mutating the context later cannot retroactively change a record that was already emitted. The pino mixin is the cheap one, since pino asks for the object and serializes it itself.

**`bind()` is the expensive path, on purpose.** The proxy calls the wrapped logger's `child()` on every property access, so `log.info(...)` in a loop allocates a child per call, and the real cost depends on how heavy that logger's `child()` is. Prefer `winston()` or `pino()` where they exist; `bind()` buys universality with allocations.

Two behaviors are worth knowing before they surprise you. `put()` called outside any scope writes to the same process-wide bindings `setDefaults()` fills, so the value is visible in every scope opened afterwards; that is intentional for configuration like a service name, and easy to trigger by accident from a call site you thought was inside a request. And `clear()` inside a scope empties everything visible there, process defaults included, until that scope ends.

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
| **MDC (`put`/`get`) auto-injected into winston _or_ pino, framework-agnostic, at log time, zero-dep** | **spawntrail** |

**A correlation id is all you need.** Then most of this API is weight you will not use, and `cls-rtracer` is the smaller answer.

**You want the access log itself.** spawntrail never sees your response: it does not time requests, read status codes or emit a line per request. `pino-http`, `express-winston` and `morgan` do exactly that, and they compose fine with this on top.

**You are all-in on NestJS.** `nestjs-cls` is more idiomatic there, with the module and injection story the framework expects.

**Your context has to survive a process boundary.** `AsyncLocalStorage` is per-process, so publishing to a queue drops the scope. Carry the ids in the message payload yourself and reopen a scope on the consumer with `run({ jobId, requestId }, fn)`, which works today and is honest about what it is: manual at the boundary.

**Your context is a typed contract, not a bag.** `Bindings` is `Record<string, unknown>` and `get()` returns `unknown`, so nothing checks at compile time that the field an audit log or an error reporter depends on is actually there. If those consumers need to fail closed on a missing field, a hand-rolled typed store gives you a guarantee this does not.

**You are not on Node.** This needs `node:async_hooks`. It is a server-side tool, not something to ship to a browser.

What is left, and what this package is for: real MDC semantics over your own logs, on the logger you already chose, injected at the moment each line is written, with nothing pinned to a framework and nothing added to your dependency tree.

---

## API

```ts
const scope = new SpawnTrail({ idKey?, idFactory?, defaults? });

// context
scope.run(bindings, fn)   // open a scope (seeded, merged over parent/defaults); returns fn()
scope.put(path, value)    // set a dot-path ("user.id"); scope-local inside run(), process-default outside
scope.get(path?)          // read the whole context, or one dot-path
scope.del(path)           // remove a dot-path
scope.clear()             // empty the current scope
scope.bindings()          // the full merged context object
scope.id() / ensureId(x)  // read / seed the correlation id
scope.setDefaults(obj)    // process-wide bindings present in every scope

// logger integrations (inject at log time)
scope.winston()           // a winston format
scope.pino()              // a pino mixin
scope.bind(logger)        // wrap any .child() logger (fallback)

// framework
scope.express(options)    // express/connect middleware
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
