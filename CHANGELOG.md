# Changelog

## 1.0.1

**Security. This fixes a prototype pollution vulnerability in 1.0.0.**

`put()` accepted `__proto__` as a dot-path segment, so a path built from data (a
middleware copying request fields, a generic mapper over a JSON body, a queue
payload) could write to `Object.prototype` and affect every object in the
process:

```js
trail.run(() => trail.put("__proto__.isAdmin", true));
({}).isAdmin; // true, process-wide
```

The same key reached the store from the other direction with no attacker at all.
`JSON.parse` produces `__proto__` as an OWN property, so seeding a scope from a
webhook body or a queue payload reassigned the store's prototype, after which
every read returned nothing for the rest of the scope, with no error and no
warning. Logs silently lost their context.

`__proto__` is now refused as a path segment and as a key in any value, in
`put`, `get`, `del`, the copy and both merges, and through the constructor,
`setDefaults` and the express seed.

This release contains that fix and nothing else, so it is safe to take on the
1.0 line. `constructor` and `prototype` are untouched, because on a plain object
they are ordinary data. Everything else about 1.0.0 behaves as it did, including
overwriting values, `del()`, and `bindings()` returning the live store; those
change in 2.0.0.

**Upgrading further:** 1.1.0 fixes crashes on circular values and stops
`bindings()`, `pino()` and `bind()` handing out the live store. 2.0.0 makes a
context immutable, which is a breaking change worth reading the entry for.

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
