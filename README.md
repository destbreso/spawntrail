# spawntrail

[![npm version](https://img.shields.io/npm/v/trail.svg)](https://www.npmjs.com/package/spawntrail)
[![minzipped size](https://img.shields.io/bundlephobia/minzip/spawntrail)](https://bundlephobia.com/package/spawntrail)
[![types included](https://img.shields.io/npm/types/trail.svg)](https://www.npmjs.com/package/spawntrail)
[![zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](https://www.npmjs.com/package/spawntrail?activeTab=dependencies)
[![license](https://img.shields.io/npm/l/trail.svg)](./LICENSE)

> Attach request-scoped context to every log line, automatically. Built on `AsyncLocalStorage`, works with any logger (winston, pino) and any framework (express, fastify, koa). Zero dependencies, TypeScript-first.

---

You set some context once, at the edge of a request, and every log written anywhere downstream carries it, without threading a logger through your call stack or re-passing metadata on every call:

```ts
import { trail } from "spawntrail";

app.use(trail.express({ idHeader: "x-request-id" })); // one scope per request

// ...forty stack frames deep, in code that has never heard of "req":
logger.info("charge captured"); // -> { requestId: "…", userId: 42, message: "charge captured" }
```

That is **Mapped Diagnostic Context** (MDC), the pattern Java's Log4j/SLF4J have had for years, done with the Node primitive built for it: `AsyncLocalStorage`.

---

## Install

```bash
npm install spawntrail
```

Node >= 16. No runtime dependencies. `winston` / `pino` / `express` are yours to bring (peer, optional).

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
fastify.addHook("onRequest", (req, reply, done) => trail.run({}, () => { trail.ensureId(); done(); }));

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

## Why spawntrail (and where it does not fit)

Context propagation in Node is a crowded space, and most tools solve one slice of it. Pick the row that matches what you actually want:

| You want… | Reach for |
|-----------|-----------|
| Just a request id woven into logs | [`cls-rtracer`](https://github.com/puzpuzpuz/cls-rtracer) |
| Get/set request-scoped values, no logger binding | [`express-http-context`](https://github.com/skonves/express-http-context) |
| CLS with a rich API, inside NestJS | [`nestjs-cls`](https://github.com/Papooch/nestjs-cls) |
| To log the request/response themselves | [`express-winston`](https://github.com/bithavoc/express-winston), [`morgan`](https://github.com/expressjs/morgan), [`pino-http`](https://github.com/pinojs/pino-http) |
| Pino, and you will wire the context yourself | `pino` + `AsyncLocalStorage` |
| **MDC (`put`/`get`) auto-injected into winston _or_ pino, framework-agnostic, at log time, zero-dep** | **spawntrail** |

spawntrail's wedge is the last row. It is not a logger and it is not an HTTP logger: it is the **context layer** that feeds the logger you already have. It stays out of the way (no wrapper you thread around, no client to adopt), injects at log time (mid-request `put`s show up), and is not tied to winston, to pino, or to express.

It is **not** the tool when you want request/response access logging (use `pino-http` or `express-winston`), when you are all-in on NestJS (`nestjs-cls` is more idiomatic), or when a plain request id is all you need (`cls-rtracer` is smaller). It is preferable when you want real MDC semantics across your own logs, on your own logger, without lock-in.

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
